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
    return await withTenant(tenantOf(user), async (tx) => {
      const contato = await contatoDeTeste(tx, user.orgId, canal, destino)
      if ('erro' in contato) return { erro: contato.erro }

      const resultados = await enfileirarEnvio(tx, {
        orgId: user.orgId,
        contactId: contato.id,
        messageId,
        canais: [canal],
        dados: CONTATO_EXEMPLO,
        teste: true,
      })

      if (resultados.length === 0) return { erro: 'Mensagem não encontrada.' }

      return {
        linhas: resultados.map((r) => ({
          canal: r.canal,
          ok: r.situacao === 'enfileirado' || r.situacao === 'reagendado',
          texto: descrever(r),
        })),
      }
    })
  } catch (erro) {
    log.error('falha no envio de teste', {
      canal,
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível enviar o teste. Confira a configuração do canal.' }
  }
}

function descrever(r: { situacao: string; motivo?: string }): string {
  switch (r.situacao) {
    case 'enfileirado':
      return 'na fila — deve chegar em segundos'
    case 'reagendado':
      return 'reagendado para a abertura da janela de silêncio'
    case 'pulado':
      return MOTIVO_LABELS[r.motivo as MotivoSkip] ?? (r.motivo ?? 'pulado')
    default:
      return r.motivo === 'variavel_ausente'
        ? 'faltou valor para uma variável'
        : r.motivo === 'sem_instancia_disponivel'
          ? 'nenhum número de WhatsApp disponível agora'
          : (r.motivo ?? 'não saiu')
  }
}
