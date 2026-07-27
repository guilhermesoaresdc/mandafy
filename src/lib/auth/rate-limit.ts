import 'server-only'
import { getRedis } from '@/lib/redis'

/**
 * Limite de tentativas de login, em Redis.
 *
 * Decisão deliberada: se o Redis estiver fora do ar, o login CONTINUA
 * funcionando. Um contador indisponível não pode virar uma negação de serviço
 * na própria operação — o risco de força bruta é menor que o de deixar o time
 * comercial trancado para fora do sistema.
 */

const MAX_ATTEMPTS = 10
const WINDOW_SECONDS = 15 * 60

export type RateLimitResult = { allowed: boolean; remaining: number }

function keyFor(scope: string, identifier: string): string {
  return `ratelimit:${scope}:${identifier}`
}

export async function consumeAttempt(scope: string, identifier: string): Promise<RateLimitResult> {
  try {
    const redis = getRedis()
    const key = keyFor(scope, identifier)

    const results = await redis.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').exec()
    const count = Number(results?.[0]?.[1] ?? 0)

    return { allowed: count <= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - count) }
  } catch {
    // Redis indisponível — ver comentário no topo.
    return { allowed: true, remaining: MAX_ATTEMPTS }
  }
}

/** Chamado após login bem-sucedido: zera o contador daquele identificador. */
export async function resetAttempts(scope: string, identifier: string): Promise<void> {
  try {
    await getRedis().del(keyFor(scope, identifier))
  } catch {
    // Sem consequência: a chave expira sozinha.
  }
}
