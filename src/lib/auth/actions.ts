'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, users } from '@/db/schema'
import { verifyPassword } from './password'
import { clearSessionCookie, readSessionToken, setSessionCookie } from './cookies'
import { consumeAttempt, resetAttempts } from './rate-limit'
import { createSession, invalidateSession } from './session'

export type EntrarState = { error?: string }

const entrarSchema = z.object({
  email: z.email({ message: 'Informe um e-mail válido.' }),
  senha: z.string().min(1, { message: 'Informe a senha.' }),
})

/**
 * Mesma mensagem para e-mail inexistente, senha errada e usuário desativado.
 * Revelar qual dos três aconteceu entrega ao atacante a lista de e-mails
 * cadastrados.
 */
const CREDENCIAIS_INVALIDAS = 'E-mail ou senha incorretos.'

/** Primeiro IP da cadeia do proxy. O Caddy preenche X-Forwarded-For. */
async function clientIp(): Promise<string | null> {
  const store = await headers()
  const forwarded = store.get('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  return first && first.length > 0 ? first : null
}

export async function entrarAction(
  _prev: EntrarState,
  formData: FormData,
): Promise<EntrarState> {
  const parsed = entrarSchema.safeParse({
    email: formData.get('email'),
    senha: formData.get('senha'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? CREDENCIAIS_INVALIDAS }
  }

  const email = parsed.data.email.trim().toLowerCase()
  const ip = await clientIp()

  const limit = await consumeAttempt('login', `${ip ?? 'sem-ip'}:${email}`)
  if (!limit.allowed) {
    return { error: 'Muitas tentativas. Tente de novo em alguns minutos.' }
  }

  const [user] = await db
    .select({
      id: users.id,
      orgId: users.orgId,
      passwordHash: users.passwordHash,
      active: users.active,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  // Verificamos a senha mesmo sem usuário, contra um hash descartável, para
  // que o tempo de resposta não denuncie se o e-mail existe.
  const hash = user?.passwordHash ?? '$scrypt$0$0$0$x$x'
  const senhaOk = await verifyPassword(parsed.data.senha, hash)

  if (!user || !senhaOk || !user.active) {
    return { error: CREDENCIAIS_INVALIDAS }
  }

  const userAgent = (await headers()).get('user-agent')
  const { token, session } = await createSession(user.id, { ip, userAgent })

  await setSessionCookie(token, session.expiresAt)
  await resetAttempts('login', `${ip ?? 'sem-ip'}:${email}`)

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))

  // Sem dado pessoal no registro: só o id do usuário (§14.1).
  await db.insert(auditLog).values({
    orgId: user.orgId,
    userId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    ip,
    userAgent: userAgent?.slice(0, 500) ?? null,
  })

  redirect('/painel')
}

export async function sairAction(): Promise<void> {
  const token = await readSessionToken()
  if (token) await invalidateSession(token)
  await clearSessionCookie()
  redirect('/entrar')
}
