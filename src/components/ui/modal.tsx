'use client'

import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'

/**
 * A janela que abre por cima — a primeira parada antes da página inteira.
 *
 * POR QUE UMA PRIMITIVA, E NÃO MAIS UM `<div className="fixed inset-0">`
 *
 * Já havia duas janelas assim escritas à mão (o detalhe do envio e o painel de
 * disparo), e as duas repetiam o mesmo trabalho por conta própria: fechar no
 * Esc, fechar no clique de fora, parar a propagação do clique de dentro. O que
 * NENHUMA das duas fazia era prender o foco: com a janela aberta, o Tab
 * continuava passeando pela página atrás dela, e quem navega por teclado ficava
 * digitando num formulário invisível. Uma terceira cópia acertaria por acaso.
 *
 * O Radix resolve isso — foco preso, `aria-modal`, retorno do foco ao elemento
 * que abriu, rolagem do fundo travada — e é dependência do projeto desde §13.2.
 *
 * `titulo` é obrigatório porque o leitor de tela anuncia a janela por ele.
 * Quando o desenho não pede um título visível, passe `tituloOculto`.
 */
export function Modal({
  aberto,
  aoFechar,
  titulo,
  tituloOculto = false,
  descricao,
  acoes,
  largura = 'md',
  children,
}: {
  aberto: boolean
  aoFechar: () => void
  titulo: string
  tituloOculto?: boolean
  /** Linha de apoio abaixo do título. */
  descricao?: ReactNode
  /** Rodapé fixo: os botões da janela. */
  acoes?: ReactNode
  largura?: 'sm' | 'md' | 'lg'
  children: ReactNode
}) {
  const LARGURAS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const

  return (
    <Dialog.Root open={aberto} onOpenChange={(v) => (v ? undefined : aoFechar())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className={cn(
            /*
             * Sobe do rodapé no celular e centraliza no desktop: é a mesma
             * decisão do detalhe do envio, que nasceu assim porque o histórico
             * é consultado no telefone, em pé, ao lado de quem pergunta.
             */
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[90vh] flex-col rounded-t-xl border border-line bg-surface',
            'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[calc(100%-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl',
            LARGURAS[largura],
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              {tituloOculto ? (
                <Dialog.Title className="sr-only">{titulo}</Dialog.Title>
              ) : (
                <Dialog.Title className="truncate text-xs font-medium text-ink">
                  {titulo}
                </Dialog.Title>
              )}
              {descricao ? (
                <Dialog.Description asChild>
                  <div className="mt-0.5 text-2xs text-ink-2">{descricao}</div>
                </Dialog.Description>
              ) : null}
            </div>

            <Dialog.Close
              aria-label="Fechar"
              className="-mr-1 shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-ink-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              ✕
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

          {acoes ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
              {acoes}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
