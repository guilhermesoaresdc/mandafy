import { cn } from '@/lib/utils'

type StatProps = {
  label: string
  value: string
  hint?: string
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
export function Stat({ label, value, hint, tone = 'neutral', className }: StatProps) {
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
      {hint ? <span className="text-2xs text-pending">{hint}</span> : null}
    </div>
  )
}
