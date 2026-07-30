'use client'

import { useActionState, useId } from 'react'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { anotarAction, moverLeadAction, mudarStatusAction, type LeadState } from '../actions'

/**
 * Painel lateral do lead (§9.1): mudar etapa, marcar ganho ou perdido, anotar.
 *
 * Três formulários separados, não um só. Salvar uma nota não deveria arrastar
 * junto uma mudança de etapa que a pessoa ainda estava pensando.
 */
export function PainelLead({
  leadId,
  stageId,
  status,
  etapas,
}: {
  leadId: string
  stageId: string
  status: string
  etapas: { id: string; name: string }[]
}) {
  const [mover, moverAction, movendo] = useActionState<LeadState, FormData>(moverLeadAction, {})
  const [nota, notaAction, salvandoNota] = useActionState<LeadState, FormData>(anotarAction, {})
  const [statusState, statusAction, mudandoStatus] = useActionState<LeadState, FormData>(
    mudarStatusAction,
    {},
  )

  const notaId = useId()
  const etapaId = useId()

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Situação</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <form action={moverAction} className="flex flex-col gap-1.5">
            <input type="hidden" name="leadId" value={leadId} />
            <label htmlFor={etapaId} className="text-2xs font-medium text-ink-2">
              Etapa
            </label>
            <div className="flex gap-2">
              <select
                id={etapaId}
                name="stageId"
                defaultValue={stageId}
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none focus-visible:border-ink"
              >
                {etapas.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="secondary" disabled={movendo}>
                {movendo ? '…' : 'Mover'}
              </Button>
            </div>
            {mover.erro ? (
              <span role="alert" className="text-2xs text-fail">
                {mover.erro}
              </span>
            ) : null}
            {mover.ok ? <span className="text-2xs text-ok">{mover.ok}</span> : null}
          </form>

          {status === 'aberto' ? (
            <div className="flex gap-2">
              <form action={statusAction}>
                <input type="hidden" name="leadId" value={leadId} />
                <input type="hidden" name="status" value="ganho" />
                <Button type="submit" size="sm" disabled={mudandoStatus}>
                  Ganhou
                </Button>
              </form>
              <form action={statusAction} className="flex items-center gap-2">
                <input type="hidden" name="leadId" value={leadId} />
                <input type="hidden" name="status" value="perdido" />
                <input
                  name="motivo"
                  placeholder="por quê?"
                  maxLength={200}
                  aria-label="Motivo da perda"
                  className="w-28 rounded-lg border border-line bg-surface-2 px-2 py-1 text-2xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
                />
                <Button type="submit" variant="ghost" size="sm" disabled={mudandoStatus}>
                  Perdeu
                </Button>
              </form>
            </div>
          ) : (
            <form action={statusAction}>
              <input type="hidden" name="leadId" value={leadId} />
              <input type="hidden" name="status" value="aberto" />
              <Button type="submit" variant="ghost" size="sm" disabled={mudandoStatus}>
                Reabrir
              </Button>
            </form>
          )}

          {statusState.erro ? (
            <span role="alert" className="text-2xs text-fail">
              {statusState.erro}
            </span>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Anotar</CardTitle>
        </CardHeader>
        <CardBody>
          <form action={notaAction} className="flex flex-col gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <label htmlFor={notaId} className="sr-only">
              Nota
            </label>
            <textarea
              id={notaId}
              name="nota"
              rows={3}
              maxLength={2000}
              placeholder="O que aconteceu na conversa?"
              className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant="secondary" disabled={salvandoNota}>
                {salvandoNota ? 'Salvando…' : 'Salvar nota'}
              </Button>
              {nota.ok ? <span className="text-2xs text-ok">{nota.ok}</span> : null}
              {nota.erro ? (
                <span role="alert" className="text-2xs text-fail">
                  {nota.erro}
                </span>
              ) : null}
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  )
}
