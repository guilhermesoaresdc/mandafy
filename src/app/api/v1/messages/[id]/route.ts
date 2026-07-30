import { z } from 'zod'
import { comChave, erro, ok } from '@/lib/api/responder'
import { detalharNotificacao } from '@/db/queries/historico'

/**
 * GET /v1/messages/{id} (§12.2) — status de um envio.
 *
 * `created_at` entra por query string porque é a coluna de partição: a chave
 * primária de `notifications` é (id, created_at), e sem ela o Postgres varreria
 * todas as partições. Sem o parâmetro, procuramos nas últimas 72h.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  return comChave(request, 'messages:read', async (tx) => {
    if (!z.uuid().safeParse(id).success) return erro('nao_encontrado', 'Envio não encontrado.')

    const bruto = new URL(request.url).searchParams.get('created_at')

    // Com a data, uma partição; sem ela, tenta os 3 dias da camada quente.
    const candidatos = bruto
      ? [new Date(bruto)]
      : [0, 1, 2, 3].map((d) => new Date(Date.now() - d * 86400_000))

    for (const quando of candidatos) {
      if (Number.isNaN(quando.getTime())) continue

      const detalhe = bruto
        ? await detalharNotificacao(tx, id, quando)
        : await procurarNoDia(tx, id, quando)

      if (detalhe) {
        return ok({
          id: detalhe.id,
          channel: detalhe.channel,
          status: detalhe.status,
          created_at: detalhe.createdAt,
          scheduled_for: detalhe.scheduledFor,
          sent_at: detalhe.sentAt,
          delivered_at: detalhe.deliveredAt,
          read_at: detalhe.readAt,
          attempts: detalhe.attempts,
          provider: detalhe.provider,
          provider_message_id: detalhe.providerMessageId,
          error_code: detalhe.errorCode,
          error_message: detalhe.errorMessage,
          cancel_key: detalhe.cancelKey,
          rendered_body: detalhe.renderedBody,
        })
      }
    }

    return erro('nao_encontrado', 'Envio não encontrado nos últimos 3 dias.')
  })
}

/** Busca pelo id dentro de um dia — a partição inteira, não um instante. */
async function procurarNoDia(
  tx: Parameters<Parameters<typeof comChave>[2]>[0],
  id: string,
  dia: Date,
): ReturnType<typeof detalharNotificacao> {
  const { and, eq, gte, lt } = await import('drizzle-orm')
  const { notifications } = await import('@/db/schema')

  const inicio = new Date(dia)
  inicio.setUTCHours(0, 0, 0, 0)
  const fim = new Date(inicio.getTime() + 86400_000)

  const [linha] = await tx
    .select({ createdAt: notifications.createdAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, id),
        gte(notifications.createdAt, inicio),
        lt(notifications.createdAt, fim),
      ),
    )
    .limit(1)

  return linha ? detalharNotificacao(tx, id, linha.createdAt) : null
}
