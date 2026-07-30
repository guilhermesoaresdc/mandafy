import { count, eq, inArray } from 'drizzle-orm'
import { notifications, waInstances } from '@/db/schema'
import { saudeDosCanais } from '@/db/queries/painel'
import { comChave, ok } from '@/lib/api/responder'
import { semaforo } from '@/lib/delivery/warmup'

/**
 * GET /v1/health (§12.2) — status de instâncias, filas e canais.
 *
 * Diferente de `/api/health`, que é o healthcheck do container: este responde à
 * chave da API e conta sobre a OPERAÇÃO, não sobre o processo.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  return comChave(request, 'messages:read', async (tx) => {
    const [fila] = await tx
      .select({ total: count() })
      .from(notifications)
      .where(inArray(notifications.status, ['queued', 'scheduled']))

    const [falhas] = await tx
      .select({ total: count() })
      .from(notifications)
      .where(
        inArray(notifications.status, ['failed', 'dead']),
      )

    const instancias = await tx.select().from(waInstances).where(eq(waInstances.active, true))
    const canais = await saudeDosCanais(tx)

    return ok({
      queue: { pending: fila?.total ?? 0, failed: falhas?.total ?? 0 },
      channels: canais.map((c) => ({
        channel: c.canal,
        sent_24h: c.enviadas24h,
        failed_24h: c.falhas24h,
        failure_rate: c.taxaFalha,
      })),
      whatsapp_instances: instancias.map((i) => {
        const estado = semaforo({
          id: i.id,
          name: i.name,
          status: i.status,
          warmupStage: i.warmupStage,
          warmupStartedAt: i.warmupStartedAt,
          dailyCap: i.dailyCap,
          minIntervalSeconds: i.minIntervalSeconds,
          sentToday: i.sentToday,
          lastSentAt: i.lastSentAt,
          failureRate24h: Number(i.failureRate24h),
          weight: i.weight,
          active: i.active,
        })

        return {
          name: i.name,
          status: i.status,
          health: estado.cor,
          detail: estado.texto,
          sent_today: i.sentToday,
          daily_cap: i.dailyCap,
          warmup_stage: i.warmupStage,
        }
      }),
    })
  })
}
