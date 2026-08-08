'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input, fieldDescriptionId } from '@/components/ui'
import { MODELOS_CHAVE, montarChave, variaveisDaChave } from '@/lib/flows/cancel-key'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { salvarFluxoAction, type FluxoState } from '../actions'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { descreverEvento, ehEventoQueOMandafyNaoGera } from '@/lib/vocabulario'

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
  triggerEvent,
  cancelOn,
  cancelKeyTemplate,
  precisaDeChave,
  janelaLigada,
  maxPorDia,
}: {
  id: string
  nome: string
  /** O evento que dispara. Era escrito pelo seed e virava imutável. */
  triggerEvent: string
  /** Os eventos que param o fluxo — o "combinar com outro evento" (§5.1). */
  cancelOn: string[]
  cancelKeyTemplate: string | null
  precisaDeChave: boolean
  janelaLigada: boolean
  maxPorDia: number
}) {
  const [chave, setChave] = useState(cancelKeyTemplate ?? '')
  /*
   * `cancelam` mora no cliente porque a guarda depende dele: cancelar sem
   * chave é o pior estado possível — o fluxo agenda os envios e nada consegue
   * pará-los —, e a tela precisa exigir a chave no momento da marcação, não
   * depois do salvamento.
   */
  const [cancelam, setCancelam] = useState<string[]>(cancelOn)
  const [estado, salvar, salvando] = useActionState<FluxoState, FormData>(salvarFluxoAction, {})

  const nomeId = useId()
  const gatilhoId = useId()
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
          {/*
            AQUI HAVIA UM CAMPO ESCONDIDO `janelaLigada`, e ele era uma trava de
            sentido único.

            Ele era emitido sempre que a janela já estava ligada, ANTES do
            checkbox de mesmo nome lá embaixo. `formData.get()` devolve o
            PRIMEIRO valor: desmarcar a caixa e salvar mandava `"on"` do mesmo
            jeito, o servidor gravava "ligada" e a tela respondia "Salvo." em
            verde. Dava para ligar a janela de silêncio e nunca mais desligar.

            Checkbox desmarcado simplesmente não vai no FormData, e
            `formData.get('janelaLigada') === 'on'` já lê isso como `false` —
            que era o comportamento pretendido desde o começo.
          */}

          <Field label="Nome do fluxo" htmlFor={nomeId}>
            <Input id={nomeId} name="nome" defaultValue={nome} maxLength={80} required />
          </Field>

          {/*
            O GATILHO DEIXA DE SER IMUTÁVEL.

            `triggerEvent` não estava no schema da ação, então não havia como
            mudá-lo: o evento era escrito uma vez pelo seed e ficava assim para
            sempre. Sete dos quinze eventos canônicos não tinham fluxo e nunca
            teriam.
          */}
          <Field label="Quando isto acontecer" htmlFor={gatilhoId}>
            <select
              id={gatilhoId}
              name="triggerEvent"
              defaultValue={triggerEvent}
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-xs text-ink outline-none focus:border-live"
            >
              {CANONICAL_EVENTS.map((evento) => (
                <option key={evento} value={evento}>
                  {descreverEvento(evento).nome}
                  {ehEventoQueOMandafyNaoGera(evento) ? ' (o Mandafy ainda não gera)' : ''}
                </option>
              ))}
            </select>
          </Field>

          {/*
            "PARA SOZINHO EM" — o combinar com outro evento, pedido, e que cabe
            no motor de hoje: `run.ts` já lê `cancel_on` e cancela por chave.
          */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-2xs font-medium text-ink-2">
              Para sozinho quando acontecer
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {CANONICAL_EVENTS.filter((e) => e !== triggerEvent).map((evento) => (
                <label key={evento} className="flex items-center gap-1.5 text-2xs text-ink-2">
                  <input
                    type="checkbox"
                    name="cancelOn"
                    value={evento}
                    checked={cancelam.includes(evento)}
                    onChange={(e) =>
                      setCancelam((atual) =>
                        e.target.checked
                          ? [...atual, evento]
                          : atual.filter((c) => c !== evento),
                      )
                    }
                    className="size-3 accent-ink"
                  />
                  {descreverEvento(evento).nome}
                </label>
              ))}
            </div>
            {cancelam.length > 0 && chave.trim() === '' ? (
              <p className="text-2xs text-fail">
                Escolha a chave abaixo: sem ela o fluxo agenda os envios e nada consegue pará-los.
              </p>
            ) : null}
          </fieldset>

          {/*
            "CANCELAR QUANDO" NÃO ERA O QUE ESTE CAMPO FAZ.

            O rótulo dizia "quando", e o campo pede `order:{{external_id}}` —
            uma CHAVE, não um momento. Quem parou aqui procurando o "quando"
            encontrou uma expressão com chaves duplas e foi embora. O "quando"
            agora tem campo próprio, logo acima; este responde a outra
            pergunta: o que amarra os envios ao pedido.
          */}
          <Field
            label="O que amarra os envios ao pedido"
            htmlFor={chaveId}
            hint="Precisa dar o mesmo resultado no evento que dispara e no que cancela."
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
                title={`${modelo.dica} (${modelo.modelo})`}
                className="rounded border border-line px-2 py-2 text-2xs text-ink-2 hover:border-ink hover:text-ink md:py-0.5"
              >
                {/*
                  O RÓTULO, e não a expressão. "Por aposta · Por contato · Por
                  sorteio" está escrito em `cancel-key.ts` desde sempre e nunca
                  foi lido por tela nenhuma — os botões mostravam
                  `order:{{external_id}}`, que é o que o campo já vai receber
                  quando alguém clicar. Dizer duas vezes a mesma coisa técnica é
                  não dizer a única que ajuda a escolher.
                */}
                {modelo.rotulo}
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
