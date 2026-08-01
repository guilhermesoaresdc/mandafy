import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { Channel } from '@/db/schema/enums'
import { abrirCredenciais } from '@/lib/delivery/config'

/**
 * Achar o canal a partir do token que veio na URL do webhook (drizzle/0019).
 *
 * O provedor chama de fora, sem sessão e sem contexto de tenant. Com a política
 * de RLS valendo, um SELECT direto por `webhook_token` compara `org_id` com
 * NULL e devolve zero linhas — o retorno seria descartado em silêncio. Por isso
 * a busca passa pela função SECURITY DEFINER, como já acontece na ingestão das
 * plataformas e no retorno da Evolution.
 */

export type CanalPorToken = {
  id: string
  orgId: string
  canal: Channel
  provider: string
  credenciais: Record<string, string>
  ativo: boolean
}

/** Segredo na URL do webhook de retorno. 24 bytes, como o da Evolution. */
export function gerarTokenRetorno(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Formato antes do banco: recusa varredura sem custo de query.
 *
 * Exportada porque as três rotas fazem a mesma checagem antes de tocar o
 * Postgres, e porque é o teste mais barato que existe contra quem chuta token.
 */
export function tokenPlausivel(token: string | undefined): boolean {
  if (!token) return false
  return token.length >= 16 && token.length <= 64 && /^[A-Za-z0-9_-]+$/.test(token)
}

export async function canalPorToken(token: string): Promise<CanalPorToken | null> {
  const linhas = await db.execute<{
    id: string
    org_id: string
    channel: string
    provider: string
    credentials_encrypted: Buffer | null
    active: boolean
  }>(sql`SELECT id, org_id, channel, provider, credentials_encrypted, active
         FROM mandafy_canal_por_token(${token})`)

  const linha = linhas[0]
  if (!linha) return null

  return {
    id: linha.id,
    orgId: linha.org_id,
    canal: linha.channel as Channel,
    provider: linha.provider,
    credenciais: abrirCredenciais(linha.credentials_encrypted ?? null),
    ativo: linha.active,
  }
}
