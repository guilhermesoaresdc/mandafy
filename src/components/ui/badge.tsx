import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

type BadgeProps = ComponentProps<'span'> & {
  tone?: 'neutral' | 'ok' | 'warn' | 'fail' | 'pending' | 'live'
}

const TONES = {
  neutral: 'bg-surface-2 text-ink-2',
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  fail: 'bg-fail/10 text-fail',
  pending: 'bg-pending/10 text-pending',
  live: 'bg-live-soft text-live',
} as const

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-2xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  )
}
