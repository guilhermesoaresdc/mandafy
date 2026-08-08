'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { SessionNav } from './session-nav'
import type { SessionItem } from './nav-items'

/**
 * O menu no celular — a gaveta que a casca não tinha (§11.5).
 *
 * O QUE ACONTECIA NUM TELEFONE
 *
 * A barra lateral era `w-[200px] shrink-0`, sem `hidden`, sem `md:`, sem
 * alternativa. Num aparelho de 390px ela comia 200, o `px-6` do quadro comia
 * mais 48, e sobravam 142 pixels para a tabela de leads e para o histórico de
 * seis colunas. O `overflow-hidden` da raiz impedia até rolar de lado para
 * escapar. As telas por dentro tinham `md:` e `sm:` por toda parte — só a
 * moldura que as continha não tinha nenhum.
 *
 * POR QUE UMA GAVETA, E NÃO UMA BARRA INFERIOR
 *
 * A barra inferior de ícones é o padrão de aplicativo com quatro seções. Aqui
 * são sete, com rótulos que importam ("Fluxos" e "Histórico" não têm ícone
 * óbvio), e a lista cresce. A gaveta guarda os rótulos e não disputa espaço com
 * o conteúdo — que é o recurso escasso na tela pequena.
 *
 * FECHA AO NAVEGAR, e isso não é detalhe: sem isso, tocar em "Leads" abriria a
 * tela nova atrás de uma gaveta que continua cobrindo tudo, e o gesto seguinte
 * de quem está em pé no balcão é tocar de novo.
 */
export function MenuMobile({
  items,
  children,
}: {
  items: readonly SessionItem[]
  /** O bloco do usuário, que no desktop mora no pé da barra lateral. */
  children?: ReactNode
}) {
  const [aberto, setAberto] = useState(false)
  const pathname = usePathname()

  // A navegação é do `SessionNav`, que não sabe da gaveta. Quem sabe que a rota
  // mudou é o `pathname` — fechar aqui vale para clique, ⌘K e botão de voltar.
  useEffect(() => {
    setAberto(false)
  }, [pathname])

  return (
    <Dialog.Root open={aberto} onOpenChange={setAberto}>
      <Dialog.Trigger
        aria-label="Abrir menu"
        className="-ml-1 rounded-lg p-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink md:hidden"
      >
        {/* Três traços: o único ícone que dispensa rótulo em qualquer idioma. */}
        <svg viewBox="0 0 16 16" className="size-5" fill="none" aria-hidden="true">
          <path
            d="M2 4h12M2 8h12M2 12h12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 md:hidden" />
        <Dialog.Content
          className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-line bg-surface md:hidden"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-2 px-4 py-4">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-sm font-bold tracking-tight text-ink">
                Mandafy
              </Dialog.Title>
              <p className="text-2xs text-pending">Cada mensagem no tempo certo</p>
            </div>

            <Dialog.Close
              aria-label="Fechar menu"
              className="-mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              ✕
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
            <SessionNav items={items} />
          </div>

          {children ? <div className="border-t border-line p-2">{children}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
