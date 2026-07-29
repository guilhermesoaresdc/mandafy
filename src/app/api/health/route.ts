import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { classifyDbError } from '@/lib/db-errors'
import { getRedis } from '@/lib/redis'

/**
 * Healthcheck do container, do balanceador — e do operador.
 *
 * Além de dizer se está de pé, classifica a falha em um código curto. Sem
 * isso, "não foi possível entrar" manda quem configurou procurar em quatro
 * lugares diferentes. Os códigos são genéricos de propósito: nada de string
 * de conexão, host, usuário ou versão de serviço externo na resposta.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const started = Date.now()

type Check = {
  ok: boolean
  /** Código estável, seguro de exibir. */
  reason?: string
  /** O que fazer a respeito. */
  hint?: string
}

function falha(error: unknown): Check {
  return { ok: false, ...classifyDbError(error) }
}

export async function GET() {
  let database: Check = { ok: false }
  let schema: Check = { ok: false, reason: 'nao_verificado' }

  try {
    await db.execute(sql`SELECT 1`)
    database = { ok: true }

    // Conectar não basta: sem as migrations aplicadas o login falha do mesmo
    // jeito, e é o erro mais comum em ambiente novo.
    const rows = await db.execute<{ existe: boolean }>(
      sql`SELECT to_regclass('public.users') IS NOT NULL AS existe`,
    )
    schema = rows[0]?.existe
      ? { ok: true }
      : {
          ok: false,
          reason: 'migrations_pendentes',
          hint: 'O banco respondeu mas está vazio. Rode: npm run db:migrate && npm run db:seed',
        }
  } catch (error) {
    database = falha(error)
    schema = { ok: false, reason: 'nao_verificado' }
  }

  let redis: Check = { ok: false }
  try {
    await getRedis().ping()
    redis = { ok: true }
  } catch (error) {
    redis = falha(error)
  }

  // Redis fora do ar não impede login (o limite de tentativas degrada
  // graciosamente), então ele não derruba o status geral.
  const ok = database.ok && schema.ok

  return NextResponse.json(
    {
      ok,
      service: 'mandafy',
      checks: { database, schema, redis },
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
    },
    { status: ok ? 200 : 503 },
  )
}
