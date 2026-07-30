import { Queue } from 'bullmq'
import { getQueueConnection } from './redis'

/**
 * Filas separadas por canal (§7.1).
 *
 * Uma fila única seria um erro: cada canal tem risco e throughput
 * completamente diferentes. O WhatsApp não-oficial exige 1 mensagem a cada
 * 4 segundos POR INSTÂNCIA — por isso a fila do WhatsApp é por instância, não
 * por canal.
 */

export const QUEUE_NAMES = {
  /** Normaliza events_raw → events e dispara os fluxos (§4.3). */
  normalize: 'normalize',
  email: 'email',
  sms: 'sms',
  telegram: 'telegram',
  /** Partições, arquivamento e agregados (§10.2). */
  maintenance: 'maintenance',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/** Uma fila por instância de WhatsApp, para o rate limit valer por número. */
export function waQueueName(instanceId: string): string {
  return `wa:${instanceId}`
}

/**
 * A fila de um envio.
 *
 * O WhatsApp é o caso especial: a fila é POR INSTÂNCIA, porque o limite de
 * 1 msg/4s é do chip, não do canal. Sem instância não há fila — e devolver
 * `null` obriga quem chama a tratar isso, em vez de acabar com um
 * `getQueue(undefined)`.
 */
export function queueForChannel(
  channel: 'whatsapp' | 'email' | 'sms' | 'telegram',
  instanceId?: string | null,
): string | null {
  if (channel === 'whatsapp') return instanceId ? waQueueName(instanceId) : null
  return QUEUE_NAMES[channel]
}

export type QueueLimits = {
  /** Máximo de jobs por janela. */
  max: number
  /** Tamanho da janela, em milissegundos. */
  duration: number
  concurrency: number
  attempts: number
}

/** Os valores literais da tabela de §7.1. */
export const QUEUE_LIMITS: Record<string, QueueLimits> = {
  // 1 msg / 4s, concorrência 1, 3× backoff exponencial
  wa: { max: 1, duration: 4_000, concurrency: 1, attempts: 3 },
  email: { max: 100, duration: 60_000, concurrency: 10, attempts: 5 },
  // SMS custa dinheiro; não insista.
  sms: { max: 60, duration: 60_000, concurrency: 5, attempts: 2 },
  // Teto do Telegram é 30/s e estourar bloqueia o bot inteiro. 20/s dá margem.
  telegram: { max: 20, duration: 1_000, concurrency: 5, attempts: 3 },
  normalize: { max: 500, duration: 1_000, concurrency: 10, attempts: 3 },
  maintenance: { max: 10, duration: 60_000, concurrency: 1, attempts: 2 },
}

/** Limites da fila `name`, caindo para o perfil `wa` em filas `wa:<id>`. */
export function limitsFor(name: string): QueueLimits {
  if (name.startsWith('wa:')) return QUEUE_LIMITS.wa!
  return QUEUE_LIMITS[name] ?? QUEUE_LIMITS.maintenance!
}

const queues = new Map<string, Queue>()

export function getQueue(name: string): Queue {
  const existing = queues.get(name)
  if (existing) return existing

  const limits = limitsFor(name)
  const queue = new Queue(name, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: limits.attempts,
      backoff: { type: 'exponential', delay: 5_000 },
      // Mantém o histórico curto: o log de verdade está no Postgres.
      removeOnComplete: { count: 1_000, age: 24 * 3600 },
      removeOnFail: { count: 5_000, age: 7 * 24 * 3600 },
    },
  })

  queues.set(name, queue)
  return queue
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()))
  queues.clear()
}
