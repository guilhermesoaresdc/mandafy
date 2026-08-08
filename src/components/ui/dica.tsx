'use client'

import type { ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'

/**
 * A explicação que aparece ao passar o mouse.
 *
 * O CABEÇALHO DE UMA TABELA DENSA NÃO CABE A EXPLICAÇÃO
 *
 * "Latência", "Chave", "Status" são rótulos de uma palavra porque a coluna tem
 * a largura de uma palavra. Só que uma palavra não ensina: quem abre o
 * histórico pela primeira vez lê seis colunas e não sabe se "latência" é o
 * tempo até o envio ou até a entrega. A dica é onde essa frase cabe.
 *
 * `title` NO GATILHO, ALÉM DA DICA — e não é redundância. A dica do Radix não
 * abre no toque (não há "passar o mouse" num celular), e o `title` nativo é o
 * que sobra ali. Também é o que o leitor de tela lê quando o conteúdo do
 * `aria-describedby` não chega.
 */
export function Dica({
  texto,
  children,
  lado = 'bottom',
}: {
  texto: string
  children: ReactNode
  lado?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span title={texto} className="cursor-help">
            {children}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={lado}
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-64 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-2xs leading-relaxed text-ink-2 shadow-lg"
          >
            {texto}
            <Tooltip.Arrow className="fill-[var(--color-line)]" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
