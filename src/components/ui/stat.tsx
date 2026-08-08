import Link from 'next/link'
import { cn } from '@/lib/utils'

type StatProps = {
  label: string
  value: string
  hint?: string
  /** Para onde a dica leva. Sem isto o número levanta a pergunta e não responde. */
  href?: string
  tone?: 'neutral' | 'ok' | 'warn' | 'fail'
  className?: string
}

const TONES = {
  neutral: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  fail: 'text-fail',
} as const

/**
 * Um dos cinco números do topo do painel (§10.3).
 * Número grande em --font-display, que tem largura variável e é o que dá
 * personalidade à tipografia (§11.3).
 */
export function Stat({ label, value, hint, href, tone = 'neutral', className }: StatProps) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-2xs font-medium tracking-wide text-ink-2 uppercase">{label}</span>
      <span
        className={cn(
          'font-display text-xl leading-none font-semibold tabular-nums',
          TONES[tone],
        )}
      >
        {value}
      </span>
      {/*
        A dica vira LINK quando há para onde ir.

        "34 falha(s) em 24h" era um número morto: a pessoa lia, e para ver
        QUAIS falhas tinha de abrir o histórico e remontar o filtro à mão. O
        número já sabe exatamente o recorte que responde a pergunta que ele
        levanta — falta só levar.
      */}
      {hint ? (
        href ? (
          <Link
            href={href}
            className="text-2xs text-pending underline-offset-2 hover:text-ink-2 hover:underline"
          >
            {hint}
          </Link>
        ) : (
          <span className="text-2xs text-pending">{hint}</span>
        )
      ) : null}
    </div>
  )
}
