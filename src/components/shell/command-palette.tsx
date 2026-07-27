'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { SearchIcon, SessionIcon } from './icons'
import type { SessionItem } from './nav-items'

/**
 * Paleta de comandos (§11.5, nível 3).
 *
 * Para o operador experiente isto substitui a navegação inteira. Na Fase 1
 * salta entre sessões; as ações ("desligar SMS em todas as mensagens",
 * "pausar fluxo de recuperação") entram nas fases seguintes.
 */
export function CommandPalette({ items }: { items: readonly SessionItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const results = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return items
    // Comparação sem acento: "historico" acha "Histórico".
    const normalize = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    return items.filter((item) => normalize(item.label).includes(normalize(term)))
  }, [items, query])

  useEffect(() => setHighlighted(0), [query])

  function choose(index: number) {
    const item = results[index]
    if (!item) return
    setOpen(false)
    setQuery('')
    router.push(item.href)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlighted((i) => (results.length === 0 ? 0 : (i + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlighted((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(highlighted)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className={cn(
          'flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5',
          'text-2xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink',
        )}
      >
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <span>Buscar</span>
        <kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-2xs">⌘K</kbd>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px]" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          className={cn(
            'fixed top-[18vh] left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line bg-surface shadow-2xl',
          )}
        >
          <VisuallyHidden>
            <Dialog.Title>Busca universal</Dialog.Title>
            <Dialog.Description>
              Pule para qualquer sessão. Use as setas para navegar e Enter para abrir.
            </Dialog.Description>
          </VisuallyHidden>

          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <SearchIcon className="size-4 text-pending" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Para onde você quer ir?"
              aria-label="Buscar sessão"
              aria-controls="paleta-resultados"
              className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-pending"
            />
          </div>

          <ul ref={listRef} id="paleta-resultados" role="listbox" className="max-h-72 overflow-y-auto p-1.5">
            {results.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-ink-2">
                Nada com esse nome. Tente “leads”, “fluxos” ou “histórico”.
              </li>
            ) : (
              results.map((item, index) => (
                <li key={item.href}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => choose(index)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs',
                      index === highlighted ? 'bg-live-soft text-live' : 'text-ink-2',
                    )}
                  >
                    <SessionIcon name={item.icon} className="size-4" aria-hidden="true" />
                    {item.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
