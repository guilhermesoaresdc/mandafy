import { desc, eq, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { authTokens, users } from '@/db/schema'
import type { UserRole } from '@/db/schema/enums'

/**
 * Quem tem acesso ao painel (§9.4).
 *
 * O hash da senha NUNCA sai daqui — nem para a tela do administrador. O que a
 * tela precisa saber é se a pessoa já definiu senha, e isso é um booleano.
 */

export type MembroEquipe = {
  id: string
  nome: string
  email: string
  papel: UserRole
  ativo: boolean
  ultimoAcesso: Date | null
  criadoEm: Date
  /** Já definiu senha, ou o convite continua pendente? */
  aceitou: boolean
  /** Há um convite válido em aberto? */
  conviteAberto: boolean
}

export async function listarEquipe(tx: Tx): Promise<MembroEquipe[]> {
  const linhas = await tx
    .select({
      id: users.id,
      nome: users.name,
      email: users.email,
      papel: users.role,
      ativo: users.active,
      ultimoAcesso: users.lastLoginAt,
      criadoEm: users.createdAt,
      /*
       * `password_hash = ''` é a marca de convite não aceito. Guardar um hash
       * vazio em vez de permitir NULL mantém a coluna obrigatória — e um NULL
       * ali seria um convite para alguém esquecer de verificá-lo antes de
       * comparar senha.
       */
      aceitou: sql<boolean>`${users.passwordHash} <> ''`,
      conviteAberto: sql<boolean>`EXISTS (
        SELECT 1 FROM ${authTokens} t
        WHERE t.user_id = ${users.id}
          AND t.used_at IS NULL
          AND t.expires_at > now()
      )`,
    })
    .from(users)
    .orderBy(desc(users.createdAt))

  return linhas.map((l) => ({ ...l, email: String(l.email) }))
}

/** Um membro específico da organização em contexto. */
export async function membroDaOrg(tx: Tx, id: string) {
  const [linha] = await tx
    .select({
      id: users.id,
      orgId: users.orgId,
      nome: users.name,
      email: users.email,
      papel: users.role,
      ativo: users.active,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)

  return linha ? { ...linha, email: String(linha.email) } : null
}

/** Quantos administradores ATIVOS existem. Ver `equipe/actions.ts`. */
export async function contarAdminsAtivos(tx: Tx): Promise<number> {
  const [linha] = await tx.execute<{ total: number }>(sql`
    SELECT count(*)::int AS total FROM users WHERE role = 'admin' AND active
  `)

  return linha?.total ?? 0
}
