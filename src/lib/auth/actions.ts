'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, users } from '@/db/schema'
import { isConfigError } from '@/env'
import { classifyDbError } from '@/lib/db-errors'
import { createLogger } from '@/lib/logger'
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

const log = createLogger('auth')

/**
 * Erros explicam o que houve e o que fazer, sem pedir desculpa (§11.7).
 * Sem isto, ambiente mal configurado vira um 500 cru — ou, pior, uma mensagem
 * genérica que manda procurar em quatro lugares diferentes.
 */
function mensagemDeFalha(error: unknown): string {
  if (isConfigError(error)) {
    return `O sistema ainda não está configurado: falta ${error.missing.join(', ')}. Defina as variáveis de ambiente e faça um novo deploy.`
  }

  const { hint, detail } = classifyDbError(error)

  /*
   * O detalhe entra na mensagem porque ele nomeia o objeto: "permission denied
   * for table sessions" resolve em um segundo o que a dica genérica deixa em
   * aberto. As credenciais já foram removidas por classifyDbError, e este é um
   * painel de acesso restrito — não uma página de cliente final.
   */
  return detail ? `Não foi possível entrar. ${hint} (${detail})` : `Não foi possível entrar. ${hint}`
}

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

  try {
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
  } catch (error) {
    // Sem e-mail nem senha no log (§14.1) — só o motivo técnico.
    log.error('falha ao processar entrada', {
      kind: error instanceof Error ? error.name : 'desconhecido',
      reason: error instanceof Error ? error.message : String(error),
    })
    return { error: mensagemDeFalha(error) }
  }

  // Fora do try: `redirect()` sinaliza por exceção, e engoli-la aqui
  // transformaria um login bem-sucedido em mensagem de erro.
  redirect('/painel')
}

export async function sairAction(): Promise<void> {
  const token = await readSessionToken()
  if (token) await invalidateSession(token)
  await clearSessionCookie()
  redirect('/entrar')
}
