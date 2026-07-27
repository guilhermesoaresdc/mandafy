'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, fieldDescriptionId } from '@/components/ui'
import { entrarAction, type EntrarState } from '@/lib/auth/actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="mt-2 w-full">
      {pending ? 'Entrando…' : 'Entrar'}
    </Button>
  )
}

export function EntrarForm() {
  const [state, formAction] = useActionState<EntrarState, FormData>(entrarAction, {})

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="E-mail" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="voce@empresa.com.br"
          aria-invalid={state.error ? true : undefined}
        />
      </Field>

      <Field label="Senha" htmlFor="senha" error={state.error}>
        <Input
          id="senha"
          name="senha"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? fieldDescriptionId('senha') : undefined}
        />
      </Field>

      <Submit />
    </form>
  )
}
