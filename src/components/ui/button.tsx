'use client'

import type { ComponentProps } from 'react'
import { useFormStatus } from 'react-dom'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '@/lib/utils'
import { Spinner } from './spinner'

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  asChild?: boolean
  /**
   * Desliga o giro automático deste botão.
   *
   * Um formulário com dois submits — "Salvar" e "Descartar" — acenderia os
   * dois, porque `useFormStatus` é do FORMULÁRIO, não do botão que foi clicado.
   * Nesses casos o secundário passa `semEspera`.
   */
  semEspera?: boolean
}

const VARIANTS = {
  primary: 'bg-live text-white hover:bg-live/90 disabled:bg-pending',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-fail text-white hover:bg-fail/90',
} as const

const SIZES = {
  sm: 'h-8 px-3 text-2xs',
  md: 'h-10 px-4 text-xs',
} as const

/**
 * O botão do sistema — e o lugar onde a espera vira visível (§13).
 *
 * O QUE ESTAVA ERRADO
 *
 * "Clico e demora, e não mostra que está carregando." Trinta e poucos
 * formulários espalhados pelo sistema eram `<form action={acao}>` com um
 * `<Button type="submit">` dentro, e nenhum deles dizia nada entre o clique e a
 * resposta. Com o banco em São Paulo e a função na Vercel, isso é um a três
 * segundos de tela parada — tempo suficiente para a pessoa concluir que o
 * clique não pegou e clicar de novo.
 *
 * A correção poderia ter sido `useActionState` em cada tela, e seria trinta
 * edições que a trigésima primeira esqueceria. `useFormStatus` lê o estado do
 * formulário ANCESTRAL, então o botão descobre sozinho que está esperando —
 * sem que nenhuma tela precise saber disso.
 *
 * Fora de um formulário o hook devolve `pending: false`, então botão de
 * navegação e botão com `onClick` continuam idênticos ao que eram.
 *
 * `disabled` enquanto espera não é enfeite: é o que impede o clique duplo por
 * impaciência de virar duas linhas no banco.
 */
function BotaoInterno({
  className,
  variant = 'primary',
  size = 'md',
  asChild = false,
  semEspera = false,
  type,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const { pending } = useFormStatus()
  const Comp = asChild ? Slot : 'button'

  /*
   * Só submits acendem. Um `type="button"` dentro do mesmo formulário —
   * "Cancelar", que só fecha o painel — não está esperando por nada, e girar
   * nele diria que está.
   */
  const ehSubmit = !asChild && (type ?? 'button') === 'submit'
  const esperando = ehSubmit && !semEspera && pending

  return (
    <Comp
      // Um <button> dentro de <form> submete por padrão; ser explícito evita
      // envios acidentais em botões de ação secundária.
      type={asChild ? undefined : (type ?? 'button')}
      disabled={disabled || esperando || undefined}
      aria-busy={esperando || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {/*
        Com `asChild` os filhos passam INTACTOS.
        O `Slot` do Radix exige um único elemento filho — acrescentar o giro ao
        lado do rótulo lhe entregaria dois, e o build inteiro quebra com
        "Slot failed to slot onto its children". De todo modo `asChild` é usado
        para envolver `<Link>`, que navega e não submete: não há o que esperar.

        E o rótulo NUNCA é trocado por "Salvando…". Trocar o texto muda a
        largura do botão no instante do clique, e a linha inteira dá um salto —
        o que se lê como defeito, não como progresso. O giro entra ao lado e o
        texto fica onde estava.
      */}
      {asChild ? (
        children
      ) : (
        <>
          {esperando ? <Spinner className="size-3.5" /> : null}
          {children}
        </>
      )}
    </Comp>
  )
}

export function Button(props: ButtonProps) {
  return <BotaoInterno {...props} />
}
