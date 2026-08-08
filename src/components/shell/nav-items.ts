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
  /*
    "Pipeline" saiu daqui: virou a vista de funil de Leads (`?vista=funil`).
    Eram duas entradas de menu para a mesma lista de pessoas, e alternar entre
    elas era a única forma de usar o que cada uma tinha de exclusivo.
  */
  { href: '/leads', label: 'Leads', icon: 'leads' },
  { href: '/canais', label: 'Canais', icon: 'canais', permission: 'canais.gerenciar' },
  {
    href: '/configuracoes',
    label: 'Configurações',
    icon: 'configuracoes',
    permission: 'integracoes.gerenciar',
  },
]
