'use client'

import dynamic from 'next/dynamic'
import type { SessionItem } from './nav-items'
import type { UserRole } from '@/db/schema/enums'

/**
 * As duas ilhas Radix da casca do app são carregadas sob demanda.
 *
 * Motivo: o orçamento de §13.1 é 120 KB de JS na rota inicial, e o Dialog da
 * paleta ⌘K mais o DropdownMenu do menu do usuário custam dezenas de KB que
 * ninguém precisa para ver o painel. Nenhum dos dois participa da primeira
 * pintura — só existem depois de um clique ou de um atalho de teclado.
 *
 * `ssr: false` porque ambos são puramente interativos: renderizá-los no
 * servidor não adianta nada e ainda os traria de volta para o bundle inicial.
 */

const CommandPaletteLazy = dynamic(
  () => import('./command-palette').then((m) => m.CommandPalette),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="h-[30px] w-[104px] rounded-lg border border-line bg-surface"
      />
    ),
  },
)

const UserMenuLazy = dynamic(() => import('./user-menu').then((m) => m.UserMenu), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="h-[43px] w-full rounded-lg bg-surface-2/60" />,
})

export function CommandPaletteIsland({ items }: { items: readonly SessionItem[] }) {
  return <CommandPaletteLazy items={items} />
}

export function UserMenuIsland(props: {
  name: string
  email: string
  role: UserRole
  orgName: string
}) {
  return <UserMenuLazy {...props} />
}
