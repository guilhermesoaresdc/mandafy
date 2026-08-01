/**
 * Worker: processo long-running que consome as filas BullMQ.
 *
 * Consome as filas de §7.1 — uma por canal, e uma POR INSTÂNCIA no WhatsApp,
 * porque o limite de 1 msg/4s pertence ao chip e não ao canal. Também cuida da
 * manutenção das partições, do avanço da escada de aquecimento (§7.3) e das
 * varreduras que retomam trabalho que não chegou à fila.
 *
 * Log sem nenhum dado pessoal (§14.1): id de notificação e de instância, nunca
 * telefone, e-mail ou nome.
 *
 * Uso: npm run worker  |  npm run worker:dev
 */

import { Worker, UnrecoverableError, type Job } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import { closeDb, db, withTenant } from '@/db'
import { waInstances } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import { closeQueues, getQueue, limitsFor, QUEUE_NAMES, waQueueName } from '@/lib/queue'
import { closeRedis, getQueueConnection } from '@/lib/redis'
import { normalizeRawEvent, type NormalizeOutcome } from '@/lib/ingest/normalize'
import { marcarEsgotado, processarEnvio, type DadosJobEnvio } from '@/lib/delivery/send'
import { reagendarEnvio } from '@/lib/delivery/enqueue'
import {
  manutencaoHoraria,
  zerarContadoresDiarios,
  type ResultadoHorario,
} from '@/lib/manutencao'

const log = createLogger('worker')

const MAINTENANCE_JOB = 'maintain'
/** Minuto 17 para não competir com todo cron do mundo, que roda no minuto 0. */
const MAINTENANCE_CRON = '17 * * * *'

const ZERAR_JOB = 'zerar-contadores'
/** 00:05 do fuso de operação — depois da virada, não em cima dela. */
const ZERAR_CRON = '5 0 * * *'
const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo'

type ResultadoManutencao = ResultadoHorario | { zerados: number }

/**
 * Manutenção periódica.
 *
 * O corpo mora em `src/lib/manutencao.ts` e não aqui: a mesma rotina precisa
 * rodar pelo tick por HTTP, para quem publica sem um processo de pé. Duas
 * cópias divergiriam — e a que roda menos seria a que ninguém testa.
 */
async function runMaintenance(job: Job): Promise<ResultadoManutencao> {
  if (job.name === ZERAR_JOB) {
    const zerados = await zerarContadoresDiarios()
    log.info('contadores diários zerados', { instancias: zerados })
    return { zerados }
  }

  log.info('manutenção iniciada', { jobId: job.id })
  const resultado = await manutencaoHoraria()
  log.info('manutenção concluída', resultado)
  return resultado
}

/**
 * Um envio (§8.1).
 *
 * O adaptador do canal já devolve `reenviavel`; aqui esse sinal vira decisão de
 * fila. `UnrecoverableError` faz o BullMQ desistir na hora — é o que impede a
 * fila de insistir num número sem WhatsApp ou num e-mail inválido, que só
 * queima reputação e, no SMS, dinheiro.
 */
async function runEnvio(job: Job<DadosJobEnvio>): Promise<string> {
  const resultado = await processarEnvio(job.data)

  switch (resultado.desfecho) {
    case 'enviado':
    case 'cancelado':
    case 'ja_processado':
      return resultado.desfecho

    /*
     * A fila entregou antes da hora. `moveToDelayed` seria mais direto, mas
     * ele exige o token do job — e o token some quando o job volta de um
     * `stalled`. Reagendar pelo banco funciona nos dois casos e deixa
     * `queueJobId` apontando para o job novo, que é o que a varredura de
     * pendentes usa para saber que este envio ainda tem dono.
     */
    case 'cedo_demais': {
      await withTenant(
        { orgId: job.data.orgId, userId: job.data.orgId, isAdmin: true },
        (tx) =>
          reagendarEnvio(
            tx,
            {
              notificationId: job.data.notificationId,
              createdAt: new Date(job.data.createdAt),
              orgId: job.data.orgId,
            },
            resultado.quando,
          ),
      )

      log.warn('envio chegou adiantado e foi reagendado', {
        notificationId: job.data.notificationId,
        emSegundos: Math.round((resultado.quando.getTime() - Date.now()) / 1000),
      })
      return 'reagendado'
    }

    case 'falhou': {
      if (!resultado.reenviavel) {
        throw new UnrecoverableError(resultado.codigo)
      }

      // 429 do Telegram traz `retry_after`; respeitar é obrigatório, porque
      // ignorar estende o bloqueio do bot inteiro (§7.1).
      if (resultado.esperarSegundos !== undefined) {
        await job.moveToDelayed(Date.now() + resultado.esperarSegundos * 1000, job.token)
        return 'adiado'
      }

      throw new Error(resultado.codigo)
    }
  }
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

  /*
   * Uma fila por canal (§7.1), com os limites literais da tabela da spec. O
   * WhatsApp é a exceção: a fila é POR INSTÂNCIA, porque o limite de 1 msg/4s
   * pertence ao chip. Uma fila só de "whatsapp" faria dois números somarem o
   * dobro do ritmo seguro no mesmo aparelho.
   */
  const canaisSimples = [QUEUE_NAMES.email, QUEUE_NAMES.sms, QUEUE_NAMES.telegram] as const
  const canalWorkers = canaisSimples.map((nome) => {
    const l = limitsFor(nome)
    return new Worker<DadosJobEnvio>(nome, runEnvio, {
      connection: getQueueConnection(),
      concurrency: l.concurrency,
      limiter: { max: l.max, duration: l.duration },
    })
  })

  // Uma fila por chip conectado. Instância nova exige reiniciar o worker — é
  // aceitável nesta fase e está anotado como dívida na tela de canais.
  const instancias = await db
    .select({ id: waInstances.id })
    .from(waInstances)
    .where(eq(waInstances.active, true))

  const waWorkers = instancias.map((instancia) => {
    const nome = waQueueName(instancia.id)
    const l = limitsFor(nome)
    return new Worker<DadosJobEnvio>(nome, runEnvio, {
      connection: getQueueConnection(),
      concurrency: l.concurrency,
      limiter: { max: l.max, duration: l.duration },
    })
  })

  const deEnvio = [...canalWorkers, ...waWorkers]

  for (const worker of deEnvio) {
    worker.on('failed', (job, error) => {
      if (!job) return
      log.error('envio falhou', {
        queue: worker.name,
        jobId: job.id,
        tentativa: job.attemptsMade,
        error: error.message,
      })

      // Esgotou as tentativas: fecha o estado em `dead`, senão a notificação
      // ficaria para sempre em `failed` e o painel mostraria "vai tentar de
      // novo" para algo que ninguém mais vai tentar (§8.1).
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void marcarEsgotado(job.data, error.message)
      }
    })
  }

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

  /*
   * Virada do dia no fuso de operação: zera `sent_today` de cada instância.
   * Sem isto o contador cresceria para sempre, toda instância bateria o teto no
   * segundo dia, e a operação pararia sem erro nenhum aparecer.
   */
  await maintenanceQueue.add(
    ZERAR_JOB,
    {},
    { repeat: { pattern: ZERAR_CRON, tz: DEFAULT_TZ }, jobId: 'zerar-contadores' },
  )

  log.info('worker no ar', {
    queues: [
      QUEUE_NAMES.maintenance,
      QUEUE_NAMES.normalize,
      ...canaisSimples,
      ...waWorkers.map((w) => w.name),
    ],
    cron: MAINTENANCE_CRON,
  })

  const workers = [maintenanceWorker, normalizeWorker, ...deEnvio]
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
