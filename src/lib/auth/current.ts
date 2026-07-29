import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { TenantContext } from '@/db'
import { readSessionToken } from './cookies'

import { validateSessionToken, type AuthUser } from './session'

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

  const { user } = await validateSessionToken(token)
  return user
})

/**
 * Exige sessão válida. Redireciona para a tela de entrada se não houver.
 *
 * O marcador `?sessao=expirada` existe para quebrar um laço: o middleware só
 * enxerga a presença do cookie, então um cookie que existe mas não valida
 * mandaria /entrar de volta para /painel indefinidamente. Com o marcador, o
 * middleware apaga o cookie e deixa a página abrir.
 */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser()
  if (user) return user

  // Havia cookie e mesmo assim não validou: é sessão morta, não ausência dela.
  const tinhaCookie = (await readSessionToken()) !== null
  redirect(tinhaCookie ? '/entrar?sessao=expirada' : '/entrar')
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
