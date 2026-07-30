'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { formatarOffset, lerAtraso } from '@/lib/flows/schedule'
import { salvarPassoAction, type FluxoState } from '../actions'

/**
 * Ajusta o tempo de um passo.
 *
 * O campo aceita "5min", "2h", "3 dias" — a pessoa escreve como pensa, não em
 * segundos. O rótulo ao lado confirma o que foi entendido antes de salvar.
 *
 * Atenção: o valor é RELATIVO ao passo anterior, enquanto a lista mostra o
 * acumulado desde o gatilho. Os dois números são diferentes de propósito, e o
 * texto do campo diz qual é qual.
 */
export function EditarPasso({
  flowId,
  stepId,
  delaySeconds,
  position,
}: {
  flowId: string
  stepId: string
  delaySeconds: number
  position: number
}) {
  const [aberto, setAberto] = useState(false)
  const [texto, setTexto] = useState(() => (delaySeconds === 0 ? '0' : formatarOffset(delaySeconds).replace('+', '').replace(/\s/g, '')))
  const [estado, salvar, salvando] = useActionState<FluxoState, FormData>(salvarPassoAction, {})
  const campoId = useId()

  if (!aberto) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        Ajustar
      </Button>
    )
  }

  const lido = lerAtraso(texto)

  return (
    <form action={salvar} className="flex w-full flex-col gap-1.5">
      <input type="hidden" name="flowId" value={flowId} />
      <input type="hidden" name="stepId" value={stepId} />

      <label htmlFor={campoId} className="text-2xs text-ink-2">
        {position === 1 ? 'Depois do gatilho' : 'Depois do passo anterior'}
      </label>

      <div className="flex items-center gap-2">
        <Input
          id={campoId}
          name="atraso"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          maxLength={20}
          placeholder="5min"
          className="w-28 font-mono"
        />

        <span className="text-2xs text-pending">
          {lido === null ? 'não entendi' : lido === 0 ? 'imediato' : formatarOffset(lido)}
        </span>

        <Button type="submit" size="sm" variant="secondary" disabled={salvando || lido === null}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
          Cancelar
        </Button>
      </div>

      {estado.erro ? (
        <span role="alert" className="text-2xs text-fail">
          {estado.erro}
        </span>
      ) : null}
    </form>
  )
}
