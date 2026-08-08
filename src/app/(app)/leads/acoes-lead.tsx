'use client'

import { useActionState, useId } from 'react'
import { Button } from '@/components/ui'
import { anotarAction, moverLeadAction, type LeadState } from './actions'

/**
 * O que dá para FAZER com um lead, num bloco só.
 *
 * POR QUE ISTO EXISTE SEPARADO
 *
 * A ficha — a janela que abre ao tocar numa linha da lista — mostrava nome,
 * contato, valor, origem e último evento, e oferecia três botões: "Abrir
 * página completa", "Selecionar para envio", "Fechar". Ou seja: para mover de
 * etapa ou anotar uma conversa era preciso sair da lista, abrir uma página,
 * agir, e voltar — por lead. Quem trabalha uma fila de vinte leads fazia isso
 * vinte vezes.
 *
 * Os formulários já existiam na página completa e são client components com
 * props primitivas. Trazê-los para cá é remontagem, não reescrita — e o mesmo
 * bloco serve às duas telas, para que elas não passem a divergir sobre o que
 * se pode fazer com um lead.
 */
export function AcoesDoLead({
  leadId,
  stageId,
  etapas,
  aoEnviar,
}: {
  leadId: string
  stageId: string
  etapas: { id: string; name: string }[]
  /** Abre o disparo com este lead só. Ausente quando não há permissão. */
  aoEnviar?: () => void
}) {
  const [mover, moverAction, movendo] = useActionState<LeadState, FormData>(moverLeadAction, {})
  const [nota, notaAction, salvandoNota] = useActionState<LeadState, FormData>(anotarAction, {})

  const etapaId = useId()
  const notaId = useId()

  return (
    <div className="flex flex-col gap-3">
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

      <form action={notaAction} className="flex flex-col gap-2">
        <input type="hidden" name="leadId" value={leadId} />
        <label htmlFor={notaId} className="text-2xs font-medium text-ink-2">
          Anotar
        </label>
        <textarea
          id={notaId}
          name="nota"
          rows={2}
          maxLength={2000}
          placeholder="O que aconteceu na conversa?"
          className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="secondary" disabled={salvandoNota}>
            {salvandoNota ? 'Salvando…' : 'Salvar nota'}
          </Button>

          {/*
            "Enviar mensagem" para UM lead.
            O painel de disparo já recebe uma lista e não sabe se tem 1 ou 500 —
            o que faltava era um caminho até ele que não passasse por marcar
            caixinhas na lista.
          */}
          {aoEnviar ? (
            <Button type="button" size="sm" onClick={aoEnviar}>
              Enviar mensagem
            </Button>
          ) : null}

          {nota.ok ? <span className="text-2xs text-ok">{nota.ok}</span> : null}
          {nota.erro ? (
            <span role="alert" className="text-2xs text-fail">
              {nota.erro}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  )
}
