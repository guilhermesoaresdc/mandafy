import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { db } from '@/db'
import { organizations, sessions, users } from '@/db/schema'
import type { Session } from '@/db/schema'
import type { UserRole } from '@/db/schema/enums'

/**
 * Sessão em cookie, sem dependência externa.
 *
 * O token cru (32 bytes aleatórios) vive apenas no cookie do navegador. O
 * banco guarda o sha256 dele como chave primária. Consequência: quem obtiver
 * uma cópia do banco não consegue personificar ninguém, porque não é possível
 * inverter o hash para reconstruir o cookie.
 */

export const SESSION_COOKIE = 'mandafy_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dias

export type AuthUser = {
  id: string
  orgId: string
  name: string
  email: string
  role: UserRole
  isAdmin: boolean
  orgName: string
  orgSlug: string
  timezone: string
}

export type SessionValidation = { session: Session; user: AuthUser } | { session: null; user: null }

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** sha256 do token — é o `id` da linha em `sessions`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; session: Session }> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  const [session] = await db
    .insert(sessions)
    .values({
      id: hashSessionToken(token),
      userId,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })
    .returning()

  if (!session) throw new Error('Não foi possível criar a sessão.')
  return { token, session }
}

/**
 * Valida o token e devolve o usuário já com os dados da organização.
 *
 * Renova a expiração quando falta menos de metade do TTL — evita escrever no
 * banco a cada requisição, mas mantém a sessão viva para quem usa o sistema.
 */
export async function validateSessionToken(token: string): Promise<SessionValidation> {
  const id = hashSessionToken(token)

  const [row] = await db
    .select({
      session: sessions,
      userId: users.id,
      orgId: users.orgId,
      name: users.name,
      email: users.email,
      role: users.role,
      active: users.active,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      timezone: organizations.timezone,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(sessions.id, id))
    .limit(1)

  if (!row) return { session: null, user: null }

  // Sessão vencida é removida na hora em que é apresentada.
  if (row.session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return { session: null, user: null }
  }

  // Usuário desativado perde a sessão imediatamente, sem esperar expirar.
  if (!row.active) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return { session: null, user: null }
  }

  let session = row.session
  const remaining = row.session.expiresAt.getTime() - Date.now()
  if (remaining < SESSION_TTL_MS / 2) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    const [renewed] = await db
      .update(sessions)
      .set({ expiresAt })
      .where(eq(sessions.id, id))
      .returning()
    if (renewed) session = renewed
  }

  return {
    session,
    user: {
      id: row.userId,
      orgId: row.orgId,
      name: row.name,
      email: row.email,
      role: row.role,
      isAdmin: row.role === 'admin',
      orgName: row.orgName,
      orgSlug: row.orgSlug,
      timezone: row.timezone,
    },
  }
}

export async function invalidateSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)))
}

/** Usado ao trocar senha ou desativar usuário. */
export async function invalidateAllSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

/** Higiene: remove sessões vencidas. Chamado pela fila de manutenção. */
export async function purgeExpiredSessions(): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(and(lt(sessions.expiresAt, new Date())))
    .returning({ id: sessions.id })
  return removed.length
}
