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
import { normalizeRawEvent, reprocessPending, type NormalizeOutcome } from '@/lib/ingest/normalize'

const log = createLogger('worker')

const MAINTENANCE_JOB = 'maintain'
/** Minuto 17 para não competir com todo cron do mundo, que roda no minuto 0. */
const MAINTENANCE_CRON = '17 * * * *'

async function runMaintenance(job: Job): Promise<{ partitions: string; sessions: number; retomados: number }> {
  log.info('manutenção iniciada', { jobId: job.id })

  const [row] = await db.execute<{ result: string }>(
    sql`SELECT mandafy_maintain_partitions() AS result`,
  )
  const partitions = row?.result ?? 'sem retorno'

  const sessions = await purgeExpiredSessions()

  /*
   * Retoma eventos gravados que não chegaram à fila — o endpoint de ingestão
   * grava e enfileira em passos separados de propósito, para que um Redis fora
   * do ar não derrube o ACK. Sem esta varredura, esses eventos ficariam
   * parados para sempre.
   */
  const retomados = await reprocessPending(200)

  log.info('manutenção concluída', { partitions, expiredSessions: sessions, retomados })
  return { partitions, sessions, retomados }
}

/**
 * Normaliza um evento cru (§4.3). O trabalho pesado — upsert de contato,
 * escrita nas tabelas particionadas — mora aqui justamente para que o ACK do
 * webhook fique abaixo de 50 ms.
 */
async function runNormalize(job: Job<{ rawId: number }>): Promise<NormalizeOutcome> {
  const resultado = await normalizeRawEvent(job.data.rawId)

  // Erro de infraestrutura merece nova tentativa; evento que o mapa não
  // reconhece, não — reprocessá-lo daria no mesmo, e a fila encheria de lixo.
  if (resultado.status === 'erro') {
    throw new Error(resultado.motivo)
  }

  return resultado
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

  const normalizeLimits = limitsFor(QUEUE_NAMES.normalize)
  const normalizeWorker = new Worker(QUEUE_NAMES.normalize, runNormalize, {
    connection: getQueueConnection(),
    concurrency: normalizeLimits.concurrency,
    limiter: { max: normalizeLimits.max, duration: normalizeLimits.duration },
  })

  for (const [nome, worker] of [
    [QUEUE_NAMES.maintenance, maintenanceWorker],
    [QUEUE_NAMES.normalize, normalizeWorker],
  ] as const) {
    worker.on('failed', (job, error) => {
      log.error('job falhou', { queue: nome, jobId: job?.id, error: error.message })
    })
  }

  // Agenda a repetição e roda uma vez agora, para que um banco recém-criado já
  // ganhe suas partições sem esperar a próxima hora cheia.
  const maintenanceQueue = getQueue(QUEUE_NAMES.maintenance)
  await maintenanceQueue.add(
    MAINTENANCE_JOB,
    {},
    { repeat: { pattern: MAINTENANCE_CRON }, jobId: 'maintenance-recorrente' },
  )
  await maintenanceQueue.add(MAINTENANCE_JOB, {}, { jobId: `maintenance-boot-${Date.now()}` })

  log.info('worker no ar', {
    queues: [QUEUE_NAMES.maintenance, QUEUE_NAMES.normalize],
    cron: MAINTENANCE_CRON,
  })

  // TODO Fase 4: workers de canal — wa:{instance}, email, sms, telegram —
  // com os rate limits de §7.1 e circuit breaker por provedor (§13.2).

  const workers = [maintenanceWorker, normalizeWorker]
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
