import type { Permission } from '@/lib/rbac'

/**
 * As oito sessões do sistema (§11.5, nível 1). Fonte única da navegação:
 * a barra lateral, a paleta ⌘K e o guard de rota leem daqui.
 *
 * `permission` ausente = todo mundo vê. Onde há permissão, o item some do menu
 * E a página redireciona — esconder no menu nunca é a proteção (§9.4).
 */
export type SessionItem = {
  href: string
  label: string
  icon: SessionIconName
  permission?: Permission
}

export type SessionIconName =
  | 'painel'
  | 'mensagens'
  | 'fluxos'
  | 'historico'
  | 'leads'
  | 'pipeline'
  | 'canais'
  | 'configuracoes'

export const SESSIONS: readonly SessionItem[] = [
  { href: '/painel', label: 'Painel', icon: 'painel' },
  { href: '/mensagens', label: 'Mensagens', icon: 'mensagens', permission: 'mensagens.gerenciar' },
  { href: '/fluxos', label: 'Fluxos', icon: 'fluxos', permission: 'fluxos.gerenciar' },
  { href: '/historico', label: 'Histórico', icon: 'historico' },
  { href: '/leads', label: 'Leads', icon: 'leads' },
  { href: '/pipeline', label: 'Pipeline', icon: 'pipeline' },
  { href: '/canais', label: 'Canais', icon: 'canais', permission: 'canais.gerenciar' },
  {
    href: '/configuracoes',
    label: 'Configurações',
    icon: 'configuracoes',
    permission: 'integracoes.gerenciar',
  },
]
