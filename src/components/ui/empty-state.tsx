import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type EmptyStateProps = {
  title: string
  description: string
  action?: ReactNode
  icon?: ReactNode
  className?: string
}

/**
 * Vazio convida à ação (§11.7): "Nenhum fluxo ainda. Comece pelo modelo de
 * recuperação de PIX — leva 2 minutos." Nunca "Nenhum resultado encontrado".
 */
export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl',
        'border border-dashed border-line bg-surface/50 px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? <div className="text-pending">{icon}</div> : null}
      <div className="flex flex-col gap-1">
        <p className="font-display text-sm font-semibold text-ink">{title}</p>
        <p className="max-w-md text-xs text-ink-2">{description}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
