import 'server-only'
import { cookies } from 'next/headers'
import { SESSION_COOKIE } from './session'

/**
 * Leitura e escrita do cookie de sessão.
 * No Next 15 `cookies()` é assíncrono — daí o await em tudo aqui.
 */

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    // Inacessível ao JavaScript da página: XSS não rouba a sessão.
    httpOnly: true,
    // 'lax' deixa o cookie viajar na navegação normal mas não em POST de outro
    // site — é a proteção base contra CSRF.
    sameSite: 'lax',
    // Em produção o Caddy termina TLS; sem isto o cookie viajaria em claro.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies()
  return store.get(SESSION_COOKIE)?.value ?? null
}
