'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, Field, Input, fieldDescriptionId } from '@/components/ui'
import { MESSAGE_CATEGORIES, MESSAGE_CATEGORY_LABELS } from '@/db/schema/enums'
import { criarMensagemAction, type MensagemState } from './actions'

/**
 * Criar mensagem.
 *
 * Pede só o nome e a categoria. A chave (§3.4) é derivada do nome — quem está
 * criando a segunda mensagem da vida não deveria ter de inventar um
 * identificador antes de escrever a primeira frase (§11.7).
 */
export function NovaMensagem() {
  const [aberto, setAberto] = useState(false)
  const [estado, action, pendente] = useActionState<MensagemState, FormData>(
    criarMensagemAction,
    {},
  )
  const nomeId = useId()

  if (!aberto) {
    return (
      <Button onClick={() => setAberto(true)} size="sm">
        Nova mensagem
      </Button>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={action} className="flex flex-col gap-3">
          <Field
            label="Como você chama essa mensagem?"
            htmlFor={nomeId}
            hint="Ex.: Lembrete de PIX, Boas-vindas, Parabéns pelo bilhete"
            {...(estado.error ? { error: estado.error } : {})}
          >
            <Input
              id={nomeId}
              name="nome"
              autoFocus
              required
              maxLength={80}
              placeholder="Lembrete de PIX"
              aria-describedby={fieldDescriptionId(nomeId)}
            />
          </Field>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-2xs font-medium text-ink-2">
              Que tipo de mensagem é essa?
            </legend>
            <div className="flex flex-wrap gap-2">
              {MESSAGE_CATEGORIES.map((categoria, indice) => (
                <label
                  key={categoria}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink"
                >
                  <input
                    type="radio"
                    name="categoria"
                    value={categoria}
                    defaultChecked={indice === MESSAGE_CATEGORIES.length - 1}
                    className="size-3 accent-ink"
                  />
                  {MESSAGE_CATEGORY_LABELS[categoria]}
                </label>
              ))}
            </div>
            <p className="text-2xs text-pending">
              Transacional pode ser enviada a qualquer hora. Recuperação e relacionamento
              exigem que a pessoa tenha aceitado receber.
            </p>
          </fieldset>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pendente}>
              {pendente ? 'Criando…' : 'Criar e escrever'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
