/**
 * Worker: processo long-running que consome as filas BullMQ.
 *
 * Na Fase 1 ele só faz a manutenção das partições — mas já sobe com a
 * estrutura de filas de §7.1 no lugar, com desligamento gracioso e log sem
 * dado pessoal.
 *
 * Uso: npm run worker  |  npm run worker:dev
 */

import { Worker, type Job } from 'bullmq'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '@/db'
import { createLogger } from '@/lib/logger'
import { closeQueues, getQueue, limitsFor, QUEUE_NAMES } from '@/lib/queue'
import { closeRedis, getQueueConnection } from '@/lib/redis'
import { purgeExpiredSessions } from '@/lib/auth/session'

const log = createLogger('worker')

const MAINTENANCE_JOB = 'maintain'
/** Minuto 17 para não competir com todo cron do mundo, que roda no minuto 0. */
const MAINTENANCE_CRON = '17 * * * *'

async function runMaintenance(job: Job): Promise<{ partitions: string; sessions: number }> {
  log.info('manutenção iniciada', { jobId: job.id })

  const [row] = await db.execute<{ result: string }>(
    sql`SELECT mandafy_maintain_partitions() AS result`,
  )
  const partitions = row?.result ?? 'sem retorno'

  const sessions = await purgeExpiredSessions()

  log.info('manutenção concluída', { partitions, expiredSessions: sessions })
  return { partitions, sessions }
}

async function main(): Promise<void> {
  // Falhar ruidosamente na subida é melhor que aceitar jobs e perdê-los.
  await db.execute(sql`SELECT 1`)
  await getQueueConnection().ping()
  log.info('conectado ao Postgres e ao Redis')

  const limits = limitsFor(QUEUE_NAMES.maintenance)

  const maintenanceWorker = new Worker(QUEUE_NAMES.maintenance, runMaintenance, {
    connection: getQueueConnection(),
    concurrency: limits.concurrency,
  })

  maintenanceWorker.on('failed', (job, error) => {
    log.error('job falhou', { queue: QUEUE_NAMES.maintenance, jobId: job?.id, error: error.message })
  })

  // Agenda a repetição e roda uma vez agora, para que um banco recém-criado já
  // ganhe suas partições sem esperar a próxima hora cheia.
  const maintenanceQueue = getQueue(QUEUE_NAMES.maintenance)
  await maintenanceQueue.add(
    MAINTENANCE_JOB,
    {},
    { repeat: { pattern: MAINTENANCE_CRON }, jobId: 'maintenance-recorrente' },
  )
  await maintenanceQueue.add(MAINTENANCE_JOB, {}, { jobId: `maintenance-boot-${Date.now()}` })

  log.info('worker no ar', { queues: [QUEUE_NAMES.maintenance], cron: MAINTENANCE_CRON })

  // TODO Fase 4: workers de canal — wa:{instance}, email, sms, telegram —
  // com os rate limits de §7.1 e circuit breaker por provedor (§13.2).
  // TODO Fase 2: worker da fila `normalize`, que transforma events_raw em
  // eventos canônicos e dispara os fluxos.

  const workers = [maintenanceWorker]
  let encerrando = false

  async function shutdown(signal: string): Promise<void> {
    if (encerrando) return
    encerrando = true
    log.info('encerrando', { signal })

    try {
      // Fecha os workers primeiro: eles terminam o job em andamento antes de
      // soltar a conexão. Depois filas, Redis e Postgres.
      await Promise.allSettled(workers.map((w) => w.close()))
      await closeQueues()
      await closeRedis()
      await closeDb()
      log.info('encerrado')
      process.exit(0)
    } catch (error) {
      log.error('falha ao encerrar', {
        error: error instanceof Error ? error.message : String(error),
      })
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  log.error('worker não subiu', {
    error: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
