import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { getRedis } from '@/lib/redis'

/**
 * Healthcheck do container e do balanceador.
 *
 * Sem autenticação — é o Docker que consulta. Por isso não devolve string de
 * conexão, versão de serviço externo nem mensagem de erro do driver: apenas se
 * cada dependência respondeu.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const started = Date.now()

async function check(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe()
    return true
  } catch {
    return false
  }
}

export async function GET() {
  const [database, redis] = await Promise.all([
    check(() => db.execute(sql`SELECT 1`)),
    check(() => getRedis().ping()),
  ])

  const ok = database && redis

  return NextResponse.json(
    {
      ok,
      service: 'mandafy',
      checks: { database, redis },
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
    },
    { status: ok ? 200 : 503 },
  )
}
