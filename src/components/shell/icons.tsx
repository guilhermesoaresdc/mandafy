import type { SVGProps } from 'react'
import type { SessionIconName } from './nav-items'

/**
 * Ícones da navegação como componentes SVG inline.
 * Sem biblioteca de ícones — importar uma inteira estoura o orçamento de
 * 120 KB de JS da rota inicial (§13.2).
 */

type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ICONS: Record<SessionIconName, (p: IconProps) => React.JSX.Element> = {
  // Barra de pulso: a assinatura visual do produto (§11.6)
  painel: (p) => (
    <svg {...base} {...p}>
      <path d="M2.5 12h3l2-6 4 13 3-9 2 2h5" />
    </svg>
  ),
  mensagens: (p) => (
    <svg {...base} {...p}>
      <rect x="2.5" y="4.5" width="19" height="13" rx="2.5" />
      <path d="m3.5 6.5 7.4 5.3c.7.5 1.5.5 2.2 0l7.4-5.3M8 21h8" />
    </svg>
  ),
  fluxos: (p) => (
    <svg {...base} {...p}>
      <circle cx="6" cy="5.5" r="2.5" />
      <circle cx="6" cy="18.5" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 8v8M8.5 6.5c4 0 5.5 2.5 7 4.4M8.5 17.5c4 0 5.5-2.5 7-4.4" />
    </svg>
  ),
  historico: (p) => (
    <svg {...base} {...p}>
      <path d="M3.5 5.5h17M3.5 12h17M3.5 18.5h11" />
    </svg>
  ),
  leads: (p) => (
    <svg {...base} {...p}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 11.5a3 3 0 1 0 0-6M18 20a5.5 5.5 0 0 0-2-4.3" />
    </svg>
  ),
  pipeline: (p) => (
    <svg {...base} {...p}>
      <rect x="2.5" y="4.5" width="5" height="15" rx="1.5" />
      <rect x="9.5" y="4.5" width="5" height="10" rx="1.5" />
      <rect x="16.5" y="4.5" width="5" height="6.5" rx="1.5" />
    </svg>
  ),
  canais: (p) => (
    <svg {...base} {...p}>
      <path d="M6 3.5v17M12 3.5v17M18 3.5v17" />
      <circle cx="6" cy="8" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="14" r="2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="10" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
  configuracoes: (p) => (
    <svg {...base} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </svg>
  ),
}

export function SessionIcon({ name, ...props }: IconProps & { name: SessionIconName }) {
  const Icon = ICONS[name]
  return <Icon {...props} />
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M14.5 3.5h3a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H3.5" />
    </svg>
  )
}
