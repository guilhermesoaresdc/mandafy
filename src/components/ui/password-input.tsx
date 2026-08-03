'use client'

import { useId, useState, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { Input } from './input'

/**
 * Campo de senha com o olhinho para conferir o que foi digitado.
 *
 * Existe porque senha digitada às cegas é a maior fonte de "não consigo
 * entrar": num teclado de celular, com maiúsculas e símbolos, errar sem
 * perceber é o caso comum, não a exceção.
 *
 * Três decisões que não são óbvias:
 *
 * 1. Começa OCULTA. Mostrar por padrão exporia a senha a quem estiver por perto
 *    em quem só queria entrar depressa.
 * 2. O botão fica FORA da ordem de tabulação (`tabIndex={-1}`). Quem usa o
 *    teclado espera ir do campo direto para o botão de enviar; um passo
 *    intermediário atrapalha mais gente do que ajuda, e o mouse alcança o
 *    olhinho normalmente.
 * 3. O estado é anunciado por `aria-pressed` e o rótulo muda com ele, para que
 *    leitores de tela digam se a senha está visível — informação de segurança,
 *    não decoração.
 */
export function PasswordInput({
  className,
  forcaVisivel,
  ...props
}: ComponentProps<'input'> & {
  /** Controlado de fora, quando outro campo precisa acompanhar. */
  forcaVisivel?: boolean
}) {
  const [visivel, setVisivel] = useState(false)
  const mostrando = forcaVisivel ?? visivel
  const rotuloId = useId()

  return (
    <div className="relative">
      <Input
        {...props}
        type={mostrando ? 'text' : 'password'}
        // `pr-10` abre espaço para o botão não cobrir o texto digitado.
        className={cn('pr-10', className)}
      />

      <button
        type="button"
        onClick={() => setVisivel((v) => !v)}
        tabIndex={-1}
        aria-pressed={mostrando}
        aria-label={mostrando ? 'Ocultar senha' : 'Mostrar senha'}
        aria-describedby={rotuloId}
        title={mostrando ? 'Ocultar senha' : 'Mostrar senha'}
        className={cn(
          'absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center',
          'rounded-md text-pending transition-colors hover:text-ink',
          'focus-visible:ring-1 focus-visible:ring-live focus-visible:outline-none',
        )}
      >
        {mostrando ? <OlhoFechado /> : <Olho />}
      </button>

      <span id={rotuloId} className="sr-only">
        {mostrando ? 'A senha está visível na tela.' : 'A senha está oculta.'}
      </span>
    </div>
  )
}

function Olho() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function OlhoFechado() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M2.5 12S6 5.5 12 5.5c1.6 0 3 .45 4.2 1.1" />
      <path d="M20 8.4c1 1.2 1.5 2.1 1.5 2.1S18 18.5 12 18.5c-1.2 0-2.3-.26-3.3-.68" />
      <path d="M9.9 9.9a3 3 0 1 0 4.2 4.2" />
      <path d="M3.5 3.5l17 17" />
    </svg>
  )
}
