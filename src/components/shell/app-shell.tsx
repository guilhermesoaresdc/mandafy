import type { ReactNode } from 'react'
import type { AuthUser } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { SESSIONS } from './nav-items'
import { SessionNav } from './session-nav'
import { CommandPaletteIsland, UserMenuIsland } from './lazy-islands'

/**
 * Casca do app (§11.5).
 *
 * Server Component: a barra lateral inteira é HTML. Só três ilhas são
 * interativas — a navegação (estado ativo + transição), a paleta ⌘K e o menu
 * do usuário. Isso mantém o JS da rota inicial dentro do orçamento de §13.1.
 *
 * A filtragem por permissão acontece AQUI, no servidor: o cliente recebe
 * apenas os itens que pode ver.
 */
export function AppShell({ user, children }: { user: AuthUser; children: ReactNode }) {
  const items = SESSIONS.filter((item) => !item.permission || can(user, item.permission))

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-line bg-surface">
        <div className="px-4 py-4">
          <p className="font-display text-sm font-bold tracking-tight text-ink">Mandafy</p>
          <p className="text-2xs text-pending">Cada mensagem no tempo certo</p>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5">
          <SessionNav items={items} />
        </div>

        <div className="border-t border-line p-2">
          <UserMenuIsland
            name={user.name}
            email={user.email}
            role={user.role}
            orgName={user.orgName}
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end border-b border-line bg-surface px-6 py-2.5">
          <CommandPaletteIsland items={items} />
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Cabeçalho de uma sessão. Título em --font-display, ações à direita.
 * A sessão é uma tela cheia: quem rola é a lista interna, não a moldura.
 */
export function SessionFrame({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div>
          <h1 className="font-display text-lg font-bold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-0.5 text-xs text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
    </main>
  )
}
