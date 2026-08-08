'use server'

import { and, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { leads, messages } from '@/db/schema'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { enfileirarEnvio } from '@/lib/delivery/enqueue'
import type { MotivoSkip } from '@/lib/delivery/guards'
import type { Channel } from '@/db/schema/enums'
import { TAMANHO_DA_LEVA } from '@/lib/delivery/lote'

/**
 * Disparo manual para os leads selecionados (§5, §9.1).
 *
 * POR QUE ISTO EXISTE
 *
 * Até aqui a única forma de sair mensagem era evento da plataforma → fluxo.
 * Para uma base importada não chega evento nenhum: ela entrava e ficava
 * parada. Este é o caminho de "avisar a lista agora" — o sorteio das 18h, o
 * resultado que saiu.
 *
 * O QUE ELE NÃO REFAZ
 *
 * Nada da entrega. `enfileirarEnvio` continua sendo o único lugar que decide
 * se uma mensagem sai: opt-out, supressão por canal, teto diário, janela de
 * silêncio, jitter e destino ausente são todos dele (§5.3). Um disparo em
 * massa é exatamente onde alguém teria a tentação de "pular as guardas para
 * ir mais rápido" — e é o lugar onde elas mais importam, porque o erro sai
 * multiplicado por mil.
 *
 * ELE ENFILEIRA, NÃO ENVIA. Quem envia é o batimento (`/api/cron`), no ritmo
 * dele. A tela diz isso com todas as letras.
 */

const log = createLogger('disparo-lote')

const entrada = z.object({
  leadIds: z.array(z.uuid()).min(1).max(TAMANHO_DA_LEVA),
  messageId: z.uuid(),
  /** Valores que o contato não tem: sorteio, milhar, link. Um para a lista toda. */
  variaveis: z.record(z.string().max(60), z.string().max(500)),
  /**
   * Identifica ESTE disparo, e é o que faz clicar duas vezes não mandar duas.
   * Vem da tela e é o mesmo em todas as levas.
   */
  loteId: z.uuid(),
})

export type ResultadoDisparo = {
  enfileirados: number
  /** Motivo → quantos contatos. É o que explica um "enviou menos que o esperado". */
  pulados: Partial<Record<MotivoSkip, number>>
  falhas: number
  /**
   * Canais que nem chegaram a ser tentados: sem credencial, sem número
   * conectado, desligados nas configurações.
   *
   * Vêm uma vez, e não uma por contato — é problema de configuração, igual
   * para todo mundo. Antes disso a mesma informação chegava como mil linhas
   * `skipped` no histórico, o que é o pior dos dois mundos: enterrava a tela
   * de onde se procura um envio e não dizia a ninguém o que consertar.
   */
  barrados: { canal: Channel; motivo: string }[]
}

export type EstadoDisparo = { erro?: string; resultado?: ResultadoDisparo }

export async function dispararLoteAction(bruto: unknown): Promise<EstadoDisparo> {
  const user = await requireUser()
  assertCan(user, 'mensagem.enviar_manual')

  const parsed = entrada.safeParse(bruto)
  if (!parsed.success) return { erro: 'Não consegui ler o pedido de envio.' }

  const { leadIds, messageId, variaveis, loteId } = parsed.data

  try {
    const resultado = await withTenant(tenantOf(user), async (tx) => {
      const [mensagem] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.orgId, user.orgId)))
        .limit(1)

      if (!mensagem) throw new Error('mensagem_inexistente')

      /*
       * Os leads vêm por consulta, não da tela.
       *
       * O RLS recorta por consultor: quem não é administrador não encontra
       * lead alheio aqui, e um id colado à mão simplesmente não aparece. É a
       * mesma razão de não confiar no `contactId` vindo do navegador.
       */
      const alvos = await tx
        .select({ id: leads.id, contactId: leads.contactId })
        .from(leads)
        .where(and(eq(leads.orgId, user.orgId), inArray(leads.id, leadIds)))

      const parcial: ResultadoDisparo = { enfileirados: 0, pulados: {}, falhas: 0, barrados: [] }

      for (const alvo of alvos) {
        const canais = await enfileirarEnvio(tx, {
          orgId: user.orgId,
          contactId: alvo.contactId,
          messageId,
          dados: variaveis,
          /*
           * Um clique repetido, uma leva reenviada depois de a rede cair, ou
           * o mesmo contato em dois leads: nos três casos a chave é a mesma e
           * o segundo envio é recusado como duplicado.
           */
          dedupeKey: `lote:${loteId}:${alvo.contactId}`,
        })

        for (const canal of canais) {
          if (canal.situacao === 'enfileirado' || canal.situacao === 'reagendado') {
            parcial.enfileirados += 1
          } else if (canal.situacao === 'pulado') {
            parcial.pulados[canal.motivo] = (parcial.pulados[canal.motivo] ?? 0) + 1
          } else if (canal.situacao === 'barrado') {
            // Uma vez por canal, e não uma por contato: o motivo é o mesmo para
            // a lista inteira.
            if (!parcial.barrados.some((b) => b.canal === canal.canal)) {
              parcial.barrados.push({ canal: canal.canal, motivo: canal.motivo })
            }
          } else {
            parcial.falhas += 1
          }
        }
      }

      return parcial
    })

    log.info('leva disparada', {
      messageId,
      alvos: leadIds.length,
      enfileirados: resultado.enfileirados,
    })

    revalidatePath('/historico')
    return { resultado }
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : 'desconhecido'
    log.error('falha no disparo em lote', { motivo, alvos: leadIds.length })

    return {
      erro:
        motivo === 'mensagem_inexistente'
          ? 'Essa mensagem não existe mais. Recarregue a página.'
          : 'A leva não saiu. O que já tinha sido enfileirado antes dela continua valendo — pode tentar de novo, que ninguém recebe duas vezes.',
    }
  }
}
