import type { UserRole } from '@/db/schema/enums'

/**
 * Controle de acesso (§9.4).
 *
 * Esta é a ÚNICA fonte de verdade das permissões. A interface esconde itens
 * consultando `can()`, e toda Server Action chama `assertCan()` no início —
 * jamais se confia apenas na UI. O banco reforça o mesmo com RLS.
 */

export const PERMISSIONS = [
  'leads.ver_todos',
  'leads.editar_proprio',
  'leads.reatribuir',
  'pipeline.ver_completo',
  'mensagens.gerenciar',
  'fluxos.gerenciar',
  'canais.gerenciar',
  'notificacoes.ver_todas',
  'mensagem.enviar_manual',
  'integracoes.gerenciar',
  'usuarios.gerenciar',
  'faturamento.ver',
  /* Direitos do titular (§14.1): exportar e anonimizar dado pessoal. */
  'contatos.exportar',
  'contatos.anonimizar',
] as const

export type Permission = (typeof PERMISSIONS)[number]

/**
 * A matriz de §9.4, literal. Admin tem tudo; consultor tem o subconjunto que
 * a tabela marca com ✓.
 */
const MATRIX: Record<UserRole, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  consultor: new Set<Permission>([
    // "Editar lead próprio ✓" e "Enviar mensagem manual ✓ (só para leads próprios)"
    'leads.editar_proprio',
    'mensagem.enviar_manual',
  ]),
}

export function can(user: { role: UserRole }, permission: Permission): boolean {
  return MATRIX[user.role].has(permission)
}

export class ForbiddenError extends Error {
  readonly permission: Permission

  constructor(permission: Permission) {
    super('Você não tem permissão para esta ação.')
    this.name = 'ForbiddenError'
    this.permission = permission
  }
}

/** Use no início de toda Server Action que altere dados. */
export function assertCan(user: { role: UserRole }, permission: Permission): void {
  if (!can(user, permission)) {
    throw new ForbiddenError(permission)
  }
}

/**
 * Consultor enxerga apenas os próprios leads (§9.4). Retorna o id do dono a
 * filtrar, ou `null` quando o usuário pode ver todos.
 */
export function leadOwnerFilter(user: { id: string; role: UserRole }): string | null {
  return can(user, 'leads.ver_todos') ? null : user.id
}
