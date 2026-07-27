'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { startTransition } from 'react'
import { cn } from '@/lib/utils'
import { SessionIcon } from './icons'
import type { SessionItem } from './nav-items'

/**
 * Navegação entre sessões (§11.5, nível 1).
 *
 * Trocar de sessão faz uma transição horizontal com a View Transitions API.
 * Onde a API não existe (Firefox, Safari antigo) a navegação acontece
 * normalmente, sem animação — nada quebra.
 *
 * Recebe a lista JÁ filtrada por permissão: o cliente nunca decide o que pode
 * ver (§9.4).
 */
export function SessionNav({ items }: { items: readonly SessionItem[] }) {
  const pathname = usePathname()
  const router = useRouter()

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (href === pathname) return
    // Deixa o navegador cuidar de ctrl+clique, clique do meio etc.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => unknown
    }
    if (typeof doc.startViewTransition !== 'function') return

    event.preventDefault()
    doc.startViewTransition(() => {
      startTransition(() => router.push(href))
    })
  }

  return (
    <nav aria-label="Sessões" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`)

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => navigate(event, item.href)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors',
              active
                ? 'bg-live-soft font-medium text-live'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <SessionIcon name={item.icon} className="size-4 shrink-0" aria-hidden="true" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
