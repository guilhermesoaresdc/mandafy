'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withTenant } from '@/db'
import { contacts } from '@/db/schema'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { normalizePhoneBR } from '@/lib/phone'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { enfileirarEnvio } from '@/lib/delivery/enqueue'
import { processarEnvio, type DesfechoEnvio } from '@/lib/delivery/send'
import { MOTIVO_LABELS, type MotivoSkip } from '@/lib/delivery/guards'

/**
 * Enviar teste (§6.6, entregável da Fase 4).
 *
 * Passa pelo MESMO caminho de um envio de produção — guardas, compilação, fila,
 * adaptador. Um botão de teste que pulasse etapas testaria outra coisa que não
 * o sistema.
 *
 * As duas diferenças são deliberadas e limitadas ao teste: sem teto diário
 * (senão quatro testes travariam a tarde de quem está escrevendo) e sem janela
 * de silêncio (quem clica está esperando a mensagem agora).
 */

const log = createLogger('teste-envio')

export type TesteState = {
  erro?: string
  linhas?: { canal: Channel; texto: string; ok: boolean }[]
}

const schema = z.object({
  messageId: z.uuid(),
  canal: z.enum(CHANNELS),
  destino: z.string().trim().min(3, 'Diga para onde mandar.').max(200),
})

/** Contato descartável de teste, um por destino, reaproveitado entre testes. */
async function contatoDeTeste(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  orgId: string,
  canal: Channel,
  destino: string,
): Promise<{ id: string } | { erro: string }> {
  const campos: Partial<typeof contacts.$inferInsert> = {}

  if (canal === 'whatsapp' || canal === 'sms') {
    const fone = normalizePhoneBR(destino)
    if (!fone.ok) return { erro: 'Esse número não parece válido. Use DDD + número.' }
    campos.phoneE164 = fone.e164
  } else if (canal === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) return { erro: 'Esse e-mail não parece válido.' }
    campos.email = destino
  } else {
    const chatId = Number(destino)
    if (!Number.isInteger(chatId)) {
      return { erro: 'O Telegram precisa do id numérico da conversa com o bot.' }
    }
    campos.telegramChatId = chatId
  }

  const externalId = `teste:${canal}:${destino}`.slice(0, 200)

  const [existente] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.externalId, externalId)))
    .limit(1)

  if (existente) {
    // Reaproveita e garante que o consentimento está registrado: quem digita o
    // próprio endereço aqui está, na prática, pedindo para receber.
    await tx
      .update(contacts)
      .set({ ...campos, optinAt: new Date(), optedOutAt: null, updatedAt: new Date() })
      .where(eq(contacts.id, existente.id))
    return existente
  }

  const [criado] = await tx
    .insert(contacts)
    .values({
      orgId,
      externalId,
      name: 'Teste',
      optinAt: new Date(),
      optinSource: 'api',
      ...campos,
    })
    .returning({ id: contacts.id })

  return criado ?? { erro: 'Não foi possível preparar o contato de teste.' }
}

export async function enviarTesteAction(
  _prev: TesteState,
  formData: FormData,
): Promise<TesteState> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const parsed = schema.safeParse({
    messageId: formData.get('messageId'),
    canal: formData.get('canal'),
    destino: formData.get('destino'),
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const { messageId, canal, destino } = parsed.data

  try {
    const resultados = await withTenant(tenantOf(user), async (tx) => {
      const contato = await contatoDeTeste(tx, user.orgId, canal, destino)
      if ('erro' in contato) return { erro: contato.erro } as const

      return await enfileirarEnvio(tx, {
        orgId: user.orgId,
        contactId: contato.id,
        messageId,
        canais: [canal],
        dados: CONTATO_EXEMPLO,
        teste: true,
      })
    })

    if ('erro' in resultados) return resultados
    if (resultados.length === 0) return { erro: 'Mensagem não encontrada.' }

    /*
     * O teste ENVIA aqui, não deixa na fila.
     *
     * `enfileirarEnvio` só grava a linha em `queued`; quem envia de verdade é
     * `processarEnvio`, chamado pelo worker ou pelo tick periódico. Numa
     * publicação sem worker, o tick é uma requisição agendada — e entre uma e
     * outra a linha fica parada. Para um fluxo isso é o esperado; para o botão
     * "enviar teste" é um defeito: quem clicou está com o telefone na mão
     * esperando, e a tela dizia "deve chegar em segundos" para uma mensagem
     * que só sairia na próxima passagem do tick.
     *
     * Fora da transação de propósito: `processarEnvio` abre a sua, e chamá-lo
     * dentro da nossa manteria a linha invisível para ele — a transição para
     * `sending` é comparação-e-troca contra o que já está gravado.
     *
     * Envio duplo não acontece: se o tick pegar a mesma linha, só um dos dois
     * UPDATEs encontra a notificação ainda pendente.
     */
    const desfechos = await Promise.all(
      resultados.map(async (r) => {
        if (r.situacao !== 'enfileirado') return { r, desfecho: null }
        try {
          const desfecho = await processarEnvio({
            notificationId: r.notificationId,
            createdAt: r.notificationCreatedAt.toISOString(),
            orgId: user.orgId,
          })
          return { r, desfecho }
        } catch (erro) {
          log.error('falha ao enviar o teste na hora', {
            canal: r.canal,
            reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
          })
          return { r, desfecho: null }
        }
      }),
    )

    return {
      linhas: desfechos.map(({ r, desfecho }) => ({
        canal: r.canal,
        ok:
          desfecho === null
            ? r.situacao === 'enfileirado' || r.situacao === 'reagendado'
            : desfecho.desfecho === 'enviado',
        texto: descrever(r, desfecho),
      })),
    }
  } catch (erro) {
    log.error('falha no envio de teste', {
      canal,
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível enviar o teste. Confira a configuração do canal.' }
  }
}

function descrever(
  r: { situacao: string; motivo?: string },
  desfecho?: DesfechoEnvio | null,
): string {
  /*
   * O que o provedor respondeu vale mais que o estado da fila. Dizer "na fila"
   * para uma mensagem que o provedor já recusou é o tipo de mentira que faz
   * alguém procurar o erro no lugar errado por meia hora.
   */
  if (desfecho) {
    switch (desfecho.desfecho) {
      case 'enviado':
        return 'enviado — o provedor aceitou'
      case 'falhou':
        // A frase em português quando existe; o código só como último recurso.
        // "não saiu: sem_credencial" manda a pessoa procurar um termo em inglês
        // que não aparece em tela nenhuma do sistema.
        return desfecho.detalhe
          ? `não saiu — ${desfecho.detalhe}`
          : `não saiu: ${desfecho.codigo}`
      case 'cancelado':
        return 'cancelado antes de sair'
      case 'ja_processado':
        return `já estava em ${desfecho.status}`
      case 'cedo_demais':
        return 'aguardando o horário de envio'
    }
  }

  switch (r.situacao) {
    case 'enfileirado':
      return 'na fila — sai na próxima passagem do envio'
    case 'reagendado':
      return 'reagendado para a abertura da janela de silêncio'
    case 'pulado':
      return MOTIVO_LABELS[r.motivo as MotivoSkip] ?? (r.motivo ?? 'pulado')
    /*
     * Configuração, não contato. A frase já vem pronta de `resolverCanal` —
     * "nenhum número de WhatsApp conectado", "falta a chave do provedor de
     * SMS" — e é ela que diz o que fazer. Nada foi gravado no histórico.
     */
    case 'barrado':
      return `${r.motivo ?? 'canal não configurado'} — ajuste em Canais`
    default:
      return r.motivo === 'variavel_ausente'
        ? 'faltou valor para uma variável'
        : r.motivo === 'sem_instancia_disponivel'
          ? 'nenhum número de WhatsApp disponível agora'
          : (r.motivo ?? 'não saiu')
  }
}
