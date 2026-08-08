'use client'

import { useActionState, useState } from 'react'
import { Badge, Button } from '@/components/ui'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { descreverEvento } from '@/lib/vocabulario'
import { traduzirEventosAction, type PlataformaState } from '../actions'

/**
 * "O que é `payment-by-game`?" — respondido na própria tela, com um clique para
 * resolver.
 *
 * O QUE O AVISO FAZIA ANTES
 *
 * Listava os nomes crus — `qrcode-created · 8 vezes` — e mandava: "acrescente
 * cada um no passo 3". Duas coisas erradas de uma vez. Primeiro, quem opera a
 * banca não sabe o que esses nomes querem dizer; pedir para mapear um nome que
 * não se entende é pedir para adivinhar. Segundo, mandava rolar até outra
 * seção, achar o botão, clicar e lembrar de salvar — quatro passos para dizer
 * "sim" a uma tradução que o sistema já sabia fazer.
 *
 * O QUE ELE FAZ AGORA
 *
 * Diz o que cada evento É, em português, e traduz tudo num clique. Quando a
 * leitura for palpite — nome desconhecido, deduzido por palavra-chave —, ele
 * avisa e deixa trocar antes de gravar. Palpite confirmado é decisão de gente;
 * palpite aplicado sozinho é mensagem errada no telefone do cliente.
 */

export type EventoParaTraduzir = {
  nome: string
  vezes: number
  /** O que o Mandafy leu — `null` quando não deu para deduzir. */
  canonico: string | null
  /** `dicionario` é tradução conhecida; `palpite` precisa de conferência. */
  origem: 'canonico' | 'dicionario' | 'palpite' | 'nenhuma'
}

export function TraduzirEventos({
  sourceId,
  eventos,
}: {
  sourceId: string
  eventos: EventoParaTraduzir[]
}) {
  const [escolhas, setEscolhas] = useState<Record<string, string>>(() =>
    Object.fromEntries(eventos.map((e) => [e.nome, e.canonico ?? ''])),
  )
  const [estado, traduzir, traduzindo] = useActionState<PlataformaState, FormData>(
    traduzirEventosAction,
    {},
  )

  if (eventos.length === 0) return null

  const pares = Object.entries(escolhas)
    .filter(([, canonico]) => canonico !== '')
    .map(([nome, canonico]) => `${nome}=${canonico}`)
    .join('\n')

  const quantos = pares === '' ? 0 : pares.split('\n').length
  const temPalpite = eventos.some((e) => e.origem === 'palpite' && escolhas[e.nome])

  return (
    <form action={traduzir} className="rounded-lg border border-warn/40 px-3 py-2">
      <input type="hidden" name="sourceId" value={sourceId} />
      <input type="hidden" name="pares" value={pares} />

      <p className="text-2xs text-warn">
        {eventos.length === 1
          ? 'Um evento está chegando e ainda não dispara fluxo nenhum:'
          : `${eventos.length} eventos estão chegando e ainda não disparam fluxo nenhum:`}
      </p>

      <ul className="mt-2 flex flex-col gap-1.5">
        {eventos.map((evento) => {
          const escolhido = escolhas[evento.nome] ?? ''

          return (
            <li key={evento.nome} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code className="font-mono text-2xs text-ink">{evento.nome}</code>
              {evento.vezes > 1 ? (
                <span className="text-2xs text-pending">{evento.vezes}×</span>
              ) : null}

              <span aria-hidden="true" className="text-2xs text-pending">
                →
              </span>

              {/*
                O NOME EM PORTUGUÊS DENTRO DO SELETOR.

                A lista de destinos era de códigos canônicos, e trocar um código
                que não se entende por outro código que não se entende não é
                escolher — é chutar. Aqui cada opção diz o que significa, e o
                código fica ao lado, para quem for conferir com a documentação
                da plataforma.
              */}
              <select
                value={escolhido}
                onChange={(e) =>
                  setEscolhas((atual) => ({ ...atual, [evento.nome]: e.target.value }))
                }
                aria-label={`O que ${evento.nome} significa`}
                className="h-7 rounded border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus-visible:border-ink"
              >
                <option value="">— ignorar este evento —</option>
                {CANONICAL_EVENTS.map((canonico) => (
                  <option key={canonico} value={canonico}>
                    {descreverEvento(canonico).nome}
                  </option>
                ))}
              </select>

              {evento.origem === 'palpite' ? (
                <Badge tone="warn">palpite — confira</Badge>
              ) : evento.origem === 'nenhuma' ? (
                <Badge tone="fail">não reconheci</Badge>
              ) : null}

              {escolhido ? (
                <span className="w-full text-2xs text-pending">
                  {descreverEvento(escolhido).ajuda}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={traduzindo || quantos === 0}>
          {traduzindo
            ? 'Traduzindo…'
            : quantos === 1
              ? 'Traduzir este evento'
              : `Traduzir estes ${quantos} eventos`}
        </Button>

        {estado.error ? (
          <span role="alert" className="text-2xs text-fail">
            {estado.error}
          </span>
        ) : null}
        {estado.ok ? (
          <span className="text-2xs text-ok">
            Pronto. Os próximos eventos com esses nomes já disparam os fluxos.
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-2xs text-ink-2">
        {temPalpite
          ? 'Confira os marcados como palpite antes de gravar: o nome não está no catálogo e a leitura foi por semelhança.'
          : 'Enquanto não forem traduzidos, esses eventos chegam, ficam registrados e não acionam nenhuma mensagem.'}
      </p>
    </form>
  )
}
