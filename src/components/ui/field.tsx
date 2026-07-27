import type { ReactNode } from 'react'
import * as Label from '@radix-ui/react-label'
import { cn } from '@/lib/utils'

type FieldProps = {
  label: string
  htmlFor: string
  hint?: string
  error?: string
  className?: string
  children: ReactNode
}

/** Id do parágrafo de erro/dica. O campo deve apontar `aria-describedby` para cá. */
export function fieldDescriptionId(htmlFor: string): string {
  return `${htmlFor}-descricao`
}

/**
 * Rótulo + campo + dica ou erro.
 *
 * O erro é anunciado por leitor de tela (`role="alert"`). Quem usa o
 * componente deve ligar o campo à descrição com
 * `aria-describedby={fieldDescriptionId(id)}` — assim a mensagem é lida junto
 * com o nome do campo, em vez de ficar órfã na tela.
 */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  const message = error ?? hint

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label.Root htmlFor={htmlFor} className="text-2xs font-medium text-ink-2">
        {label}
      </Label.Root>

      {children}

      {message ? (
        <p
          id={fieldDescriptionId(htmlFor)}
          role={error ? 'alert' : undefined}
          className={cn('text-2xs', error ? 'text-fail' : 'text-ink-2')}
        >
          {message}
        </p>
      ) : null}
    </div>
  )
}
