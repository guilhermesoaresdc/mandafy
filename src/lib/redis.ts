import Redis from 'ioredis'
import { serverEnv } from '@/env'

/**
 * Conexões Redis compartilhadas.
 *
 * Duas conexões distintas de propósito: o BullMQ exige
 * `maxRetriesPerRequest: null` nas conexões que usa para bloquear em filas,
 * e essa configuração é ruim para o uso geral (cache, contadores), onde
 * queremos que uma operação falhe rápido em vez de pendurar a requisição.
 *
 * O cache em globalThis evita abrir uma conexão nova a cada hot-reload do Next.
 */

const globalForRedis = globalThis as unknown as {
  __mandafyRedis?: Redis
  __mandafyQueueRedis?: Redis
}

function connect(options: { forQueue: boolean }): Redis {
  const client = new Redis(serverEnv().REDIS_URL, {
    // BullMQ exige null; no uso geral, 2 tentativas e desiste.
    maxRetriesPerRequest: options.forQueue ? null : 2,
    enableReadyCheck: !options.forQueue,
    lazyConnect: false,
  })

  // Sem isto, um Redis fora do ar derruba o processo com unhandled error.
  client.on('error', (error: Error) => {
    console.error(
      JSON.stringify({ level: 'error', scope: 'redis', message: error.message }),
    )
  })

  return client
}

export function getRedis(): Redis {
  const existing = globalForRedis.__mandafyRedis
  if (existing) return existing

  const client = connect({ forQueue: false })
  if (process.env.NODE_ENV !== 'production') globalForRedis.__mandafyRedis = client
  return client
}

/** Conexão dedicada ao BullMQ. Nunca use para comandos avulsos. */
export function getQueueConnection(): Redis {
  const existing = globalForRedis.__mandafyQueueRedis
  if (existing) return existing

  const client = connect({ forQueue: true })
  if (process.env.NODE_ENV !== 'production') globalForRedis.__mandafyQueueRedis = client
  return client
}

export async function closeRedis(): Promise<void> {
  const clients = [globalForRedis.__mandafyRedis, globalForRedis.__mandafyQueueRedis]
  await Promise.allSettled(clients.map((c) => c?.quit()))
  globalForRedis.__mandafyRedis = undefined
  globalForRedis.__mandafyQueueRedis = undefined
}
