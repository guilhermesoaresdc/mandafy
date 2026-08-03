'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, PasswordInput, fieldDescriptionId } from '@/components/ui'
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
        <PasswordInput
          id="senha"
          name="senha"
          autoComplete="current-password"
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? fieldDescriptionId('senha') : undefined}
        />
      </Field>

      <Submit />

      {/*
        Depois do botão, não antes: quem chega à tela quer entrar. O link de
        recuperação acima do envio disputa atenção com a ação principal e é
        clicado por engano.
      */}
      <Link
        href="/recuperar"
        className="text-center text-2xs text-ink-2 underline-offset-2 hover:underline"
      >
        Esqueci minha senha
      </Link>
    </form>
  )
}
