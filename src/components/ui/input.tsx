import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-line bg-surface px-3 text-xs text-ink',
        'placeholder:text-pending',
        'transition-colors focus:border-live',
        'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-2',
        // O estado inválido também muda a borda, não só a mensagem: quem não
        // distingue a cor ainda enxerga a mensagem de erro do Field.
        'aria-[invalid=true]:border-fail',
        className,
      )}
      {...props}
    />
  )
}
