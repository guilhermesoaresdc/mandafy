'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input, fieldDescriptionId } from '@/components/ui'
import { MODELOS_CHAVE, montarChave, variaveisDaChave } from '@/lib/flows/cancel-key'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { salvarFluxoAction, type FluxoState } from '../actions'

/**
 * Configuração do fluxo, com a chave de cancelamento em destaque.
 *
 * A chave ganha prévia ao vivo de propósito: ela é a única configuração do
 * sistema em que um erro de digitação não dá erro nenhum — o fluxo funciona,
 * agenda tudo, e simplesmente não cancela. A pessoa descobre pelo cliente que
 * já pagou e recebeu "finalize seu pagamento".
 */
export function ConfigFluxo({
  id,
  nome,
  cancelKeyTemplate,
  precisaDeChave,
  janelaLigada,
  maxPorDia,
}: {
  id: string
  nome: string
  cancelKeyTemplate: string | null
  precisaDeChave: boolean
  janelaLigada: boolean
  maxPorDia: number
}) {
  const [chave, setChave] = useState(cancelKeyTemplate ?? '')
  const [estado, salvar, salvando] = useActionState<FluxoState, FormData>(salvarFluxoAction, {})

  const nomeId = useId()
  const chaveId = useId()
  const maxId = useId()

  const previa = chave.trim() === '' ? null : montarChave(chave, CONTATO_EXEMPLO)
  const semVariavel = chave.trim() !== '' && variaveisDaChave(chave).length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ajustes</CardTitle>
      </CardHeader>
      <CardBody>
        <form action={salvar} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={id} />
          {janelaLigada ? <input type="hidden" name="janelaLigada" value="on" /> : null}

          <Field label="Nome do fluxo" htmlFor={nomeId}>
            <Input id={nomeId} name="nome" defaultValue={nome} maxLength={80} required />
          </Field>

          <Field
            label="Cancelar quando"
            htmlFor={chaveId}
            hint="A chave que amarra os envios ao pedido. Precisa dar o mesmo resultado no evento que dispara e no que cancela."
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={chaveId}
              name="cancelKeyTemplate"
              value={chave}
              onChange={(e) => setChave(e.target.value)}
              maxLength={200}
              placeholder="order:{{external_id}}"
              className="font-mono"
              aria-describedby={fieldDescriptionId(chaveId)}
            />
          </Field>

          {/* Prévia ao vivo: é o que transforma um erro invisível em visível. */}
          {previa ? (
            previa.ok ? (
              <p className="text-2xs text-ink-2">
                Com o contato de exemplo, a chave fica{' '}
                <code className="font-mono text-ink">{previa.chave}</code>.
              </p>
            ) : (
              <p className="text-2xs text-fail">
                Não dá para montar a chave: falta {previa.faltando.join(', ')} no exemplo. Confira
                se a plataforma manda esse campo.
              </p>
            )
          ) : null}

          {semVariavel ? (
            <p className="text-2xs text-fail">
              Uma chave sem variável é igual para todo mundo — cancelaria os envios de toda a base
              de uma vez.
            </p>
          ) : null}

          {chave.trim() === '' && precisaDeChave ? (
            <p className="text-2xs text-fail">
              Este fluxo declara eventos de cancelamento, então precisa de uma chave. Sem ela, os
              envios agendados saem mesmo depois do pagamento.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-1">
            {MODELOS_CHAVE.map((modelo) => (
              <button
                key={modelo.modelo}
                type="button"
                onClick={() => setChave(modelo.modelo)}
                title={modelo.dica}
                className="rounded border border-line px-1.5 py-0.5 font-mono text-2xs text-ink-2 hover:border-ink hover:text-ink"
              >
                {modelo.modelo}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Máximo por pessoa, por dia"
              htmlFor={maxId}
              hint="Somando todos os canais."
            >
              <Input
                id={maxId}
                name="maxPorDia"
                type="number"
                min={1}
                max={50}
                defaultValue={maxPorDia}
                aria-describedby={fieldDescriptionId(maxId)}
              />
            </Field>

            <label className="flex cursor-pointer items-start gap-2 self-end pb-6">
              <input
                type="checkbox"
                name="janelaLigada"
                defaultChecked={janelaLigada}
                className="mt-0.5 size-3 accent-ink"
              />
              <span className="text-2xs text-ink-2">
                Respeitar a madrugada
                <span className="block text-pending">
                  O que cairia entre 21h e 8h é reagendado para a manhã, não descartado.
                </span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </Button>
            {estado.ok ? <span className="text-2xs text-ok">Salvo.</span> : null}
            {estado.aviso ? <span className="text-2xs text-pending">{estado.aviso}</span> : null}
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
