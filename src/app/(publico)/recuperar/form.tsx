'use client'

import Link from 'next/link'
import { useActionState, useId } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/components/ui'
import { recuperarAction, type RecuperarState } from '@/lib/auth/senha-actions'

function Enviar() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="mt-1 w-full">
      {pending ? 'Enviando…' : 'Enviar link'}
    </Button>
  )
}

export function RecuperarForm() {
  const [estado, recuperar] = useActionState<RecuperarState, FormData>(recuperarAction, {})
  const emailId = useId()

  if (estado.enviado) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium text-ok">Pronto.</p>
        {/*
          A mensagem é deliberadamente ambígua: "se existir uma conta". Dizer
          "enviamos para você" confirmaria que o e-mail está cadastrado, e a
          lista de quem tem acesso ao painel é o primeiro passo de um ataque
          dirigido. O custo é quem digitou o e-mail errado demorar mais a
          perceber — bem menor que o outro.
        */}
        <p className="text-2xs text-ink-2">
          Se existir uma conta com esse e-mail, o link chegou na caixa de entrada. Ele vale por
          1 hora.
        </p>
        <p className="text-2xs text-pending">
          Não chegou? Confira o spam, ou fale com quem administra o painel.
        </p>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/entrar">Voltar para a entrada</Link>
        </Button>
      </div>
    )
  }

  return (
    <form action={recuperar} className="flex flex-col gap-4">
      <Field label="E-mail" htmlFor={emailId} {...(estado.erro ? { error: estado.erro } : {})}>
        <Input
          id={emailId}
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="voce@empresa.com.br"
          aria-invalid={estado.erro ? true : undefined}
        />
      </Field>

      <Enviar />

      <Link
        href="/entrar"
        className="text-center text-2xs text-ink-2 underline-offset-2 hover:underline"
      >
        Lembrei, voltar para a entrada
      </Link>
    </form>
  )
}
