import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { TenantContext } from '@/db'
import { createLogger } from '@/lib/logger'
import { readSessionToken } from './cookies'

import { validateSessionToken, type AuthUser } from './session'

const log = createLogger('auth')

/**
 * Usuário da requisição atual.
 *
 * `cache` do React memoiza por requisição: o layout, a página e cada Server
 * Component podem chamar `getCurrentUser()` à vontade que a validação da
 * sessão bate no banco uma única vez.
 */
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const token = await readSessionToken()
  if (!token) return null

  try {
    const { user } = await validateSessionToken(token)
    return user
  } catch (error) {
    /*
     * Banco fora do ar ou ambiente incompleto significa "não autenticado",
     * nunca uma página de erro.
     *
     * Isto importa porque a tela de entrada também chama esta função: se ela
     * propagasse a exceção, um banco indisponível derrubaria justamente a
     * página onde o problema deveria ser explicado ao operador.
     */
    log.warn('não foi possível validar a sessão', {
      reason: error instanceof Error ? error.name : 'desconhecido',
    })
    return null
  }
})

/** Exige sessão válida. Redireciona para a tela de entrada se não houver. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/entrar')
  return user
}

/**
 * Exige perfil de administrador (§9.4). Consultor que tentar acessar uma
 * sessão restrita pela URL vai parar no painel — a restrição não depende do
 * menu estar escondido.
 */
export async function requireAdmin(): Promise<AuthUser> {
  const user = await requireUser()
  if (!user.isAdmin) redirect('/painel')
  return user
}

/** Contexto para `withTenant()`, que ativa o RLS na transação. */
export function tenantOf(user: AuthUser): TenantContext {
  return { orgId: user.orgId, userId: user.id, isAdmin: user.isAdmin }
}

export type { AuthUser }
