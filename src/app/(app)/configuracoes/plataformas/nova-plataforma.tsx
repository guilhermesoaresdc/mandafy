'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Card, CardBody, Field, Input } from '@/components/ui'
import { criarPlataformaAction, type PlataformaState } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Conectando…' : 'Conectar'}
    </Button>
  )
}

export function NovaPlataforma() {
  const [aberto, setAberto] = useState(false)
  const [state, formAction] = useActionState<PlataformaState, FormData>(criarPlataformaAction, {})

  if (!aberto) {
    return (
      <div>
        <Button onClick={() => setAberto(true)}>Conectar plataforma</Button>
      </div>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={formAction} className="flex flex-col gap-3">
          <Field
            label="Nome da plataforma"
            htmlFor="nome"
            hint="Como você a chama no dia a dia. Ex.: “Rifa do João”."
            error={state.error}
          >
            <Input id="nome" name="nome" autoFocus required maxLength={80} placeholder="Rifa do João" />
          </Field>

          <div className="flex items-center gap-2">
            <Submit />
            <Button variant="ghost" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
