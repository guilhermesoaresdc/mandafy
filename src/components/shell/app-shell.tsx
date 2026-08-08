import type { ReactNode } from 'react'
import type { AuthUser } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { SESSIONS } from './nav-items'
import { MenuMobile } from './menu-mobile'
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

  const menuDoUsuario = (
    <UserMenuIsland name={user.name} email={user.email} role={user.role} orgName={user.orgName} />
  )

  return (
    <div className="flex h-dvh overflow-hidden">
      {/*
        A barra lateral SOME no celular.
        Ela era `w-[200px] shrink-0` sem nenhum breakpoint: num aparelho de
        390px comia 200, o quadro comia mais 48 de respiro, e sobravam 142
        pixels para a tabela de leads. Abaixo de `md` ela vira a gaveta do
        cabeçalho — os mesmos itens, sem disputar espaço com o conteúdo.
      */}
      <aside className="hidden w-[200px] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="px-4 py-4">
          <p className="font-display text-sm font-bold tracking-tight text-ink">Mandafy</p>
          <p className="text-2xs text-pending">Cada mensagem no tempo certo</p>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5">
          <SessionNav items={items} />
        </div>

        <div className="border-t border-line p-2">{menuDoUsuario}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2.5 md:px-6">
          <MenuMobile items={items}>{menuDoUsuario}</MenuMobile>

          {/*
            O nome do produto só no celular: no desktop ele já está no alto da
            barra lateral, e repeti-lo tiraria espaço de quem tem pouco.
          */}
          <span className="font-display text-sm font-bold tracking-tight text-ink md:hidden">
            Mandafy
          </span>

          <div className="ml-auto">
            <CommandPaletteIsland items={items} />
          </div>
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
      {/*
        `flex-wrap` e não `justify-between` fixo: num telefone, título e ações
        na mesma linha espremem os dois — "Recuperação de PIX" trunca em três
        letras para caber ao lado de "Pausar" e "Voltar". Quebrando, o título
        fica inteiro e os botões descem para a linha de baixo.

        E o respiro cai de 24 para 16 pixels de cada lado: são 16 pixels de
        conteúdo ganhos numa tela onde 390 é tudo que existe.
      */}
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3 md:px-6 md:pt-5 md:pb-4">
        <div className="min-w-0">
          <h1 className="font-display text-base font-bold tracking-tight text-ink md:text-lg">
            {title}
          </h1>
          {description ? <p className="mt-0.5 text-xs text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">{children}</div>
    </main>
  )
}
