'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { detalharNotificacao, type DetalheNotificacao } from '@/db/queries/historico'
import { notifications } from '@/db/schema'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { getQueue, queueForChannel } from '@/lib/queue'

/** Detalhe e reenvio (§10.1). */

const log = createLogger('historico')

const chaveSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime() })

export type DetalheState = { erro?: string; detalhe?: DetalheNotificacao }

export async function carregarDetalhe(id: string, createdAt: string): Promise<DetalheState> {
  const user = await requireUser()

  const parsed = chaveSchema.safeParse({ id, createdAt })
  if (!parsed.success) return { erro: 'Referência inválida.' }

  const detalhe = await withTenant(tenantOf(user), (tx) =>
    detalharNotificacao(tx, parsed.data.id, new Date(parsed.data.createdAt)),
  )

  // O RLS já filtra por organização; sumir da consulta é o mesmo que não
  // existir. Dizer "sem permissão" confirmaria que existe.
  if (!detalhe) return { erro: 'Envio não encontrado.' }

  return { detalhe }
}

export type ReenvioState = { erro?: string; ok?: string }

/**
 * Reenviar uma falha (§10.1).
 *
 * Cria uma LINHA NOVA em vez de ressuscitar a antiga. O histórico é registro do
 * que aconteceu: reabrir uma notificação morta apagaria o fato de que ela
 * falhou, e a contagem de falhas do painel passaria a mentir.
 */
export async function reenviarAction(
  _prev: ReenvioState,
  formData: FormData,
): Promise<ReenvioState> {
  const user = await requireUser()
  assertCan(user, 'mensagem.enviar_manual')

  const parsed = chaveSchema.safeParse({
    id: formData.get('id'),
    createdAt: formData.get('createdAt'),
  })
  if (!parsed.success) return { erro: 'Referência inválida.' }

  try {
    const resultado = await withTenant(tenantOf(user), async (tx) => {
      const original = await detalharNotificacao(tx, parsed.data.id, new Date(parsed.data.createdAt))
      if (!original) return { erro: 'Envio não encontrado.' }

      if (!['failed', 'dead', 'skipped'].includes(original.status)) {
        return { erro: 'Só faz sentido reenviar o que falhou ou foi pulado.' }
      }

      if (!original.renderedBody) {
        return { erro: 'Este envio não chegou a ser compilado. Dispare pelo fluxo ou pelo teste.' }
      }

      const [nova] = await tx
        .insert(notifications)
        .values({
          orgId: user.orgId,
          contactId: original.contactId,
          messageId: original.messageId,
          channel: original.channel,
          status: 'queued',
          scheduledFor: new Date(),
          providerInstance: original.providerInstance,
          renderedSubject: original.renderedSubject,
          // O MESMO corpo do original: reenvio é reenvio, não recompilação. Os
          // dados do evento podem ter mudado, e mandar outro texto sob o rótulo
          // "reenviar" seria mentira.
          renderedBody: original.renderedBody,
          cancelKey: original.cancelKey,
        })
        .returning({ id: notifications.id, createdAt: notifications.createdAt })

      if (!nova) return { erro: 'Não foi possível criar o reenvio.' }

      const fila = queueForChannel(original.channel, original.providerInstance)
      if (!fila) return { erro: 'Nenhum número de WhatsApp disponível para reenviar.' }

      const job = await getQueue(fila).add(
        'enviar',
        { notificationId: nova.id, createdAt: nova.createdAt.toISOString(), orgId: user.orgId },
        { jobId: `n:${nova.id}` },
      )

      await tx
        .update(notifications)
        .set({ queueJobId: String(job.id) })
        .where(and(eq(notifications.id, nova.id), eq(notifications.createdAt, nova.createdAt)))

      return { ok: 'Reenviado. A linha nova aparece no topo do log.' }
    })

    revalidatePath('/historico')
    return resultado
  } catch (erro) {
    log.error('falha ao reenviar', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível reenviar. Tente de novo.' }
  }
}
