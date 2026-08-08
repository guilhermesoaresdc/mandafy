'use client'

import { useState } from 'react'
import { Badge, ChannelIcon, Modal } from '@/components/ui'
import { NOTIFICATION_STATUS_LABELS, type Channel, type NotificationStatus } from '@/db/schema/enums'
import { camposDoEvento, descreverEvento, resumoDoEvento } from '@/lib/vocabulario'
import { cn } from '@/lib/utils'
import { DetalheEnvio } from '../../historico/detalhe'

/**
 * A linha do tempo do lead (§9.1) — agora dizendo o que aconteceu.
 *
 * O QUE ELA MOSTRAVA
 *
 * `order.created`. Só isso, em fonte monoespaçada. Do lado de cá do banco havia
 * o valor da aposta, a modalidade, o palpite, o link de pagamento e o código do
 * pedido — tudo gravado em `events.data` desde a Fase 2, e nada disso aparecia
 * em tela nenhuma. Quem abria a ficha para ligar para o cliente via uma pilha
 * de identificadores em inglês e não sabia dizer quanto ele tinha apostado.
 *
 * O QUE ELA MOSTRA AGORA
 *
 * Cada linha tem nome em português ("Fez uma aposta", "Pagou a aposta") e um
 * resumo com os dois ou três campos que mais dizem — R$ 5,00 · Grupo ·
 * Elefante. Clicar abre TUDO o que veio naquele evento, com rótulo em cada
 * campo.
 *
 * Um envio abre o MESMO detalhe do histórico: o texto exato que a pessoa
 * recebeu, as tentativas, a resposta do provedor. É a informação que faz a
 * diferença numa ligação — "a senhora recebeu esta mensagem às 14h32" vale mais
 * que "mandamos alguma coisa".
 *
 * É um `"use client"` a mais que §13.2 não listava, e a razão é que abrir
 * detalhe sem recarregar a página é o ponto: a alternativa era navegar para
 * outra rota e perder o lugar na lista de vinte eventos.
 */

export type ItemLinha =
  | {
      tipo: 'atividade'
      quando: string
      texto: string
      quem: string | null
      especie: string
    }
  | {
      tipo: 'evento'
      quando: string
      evento: string
      /** O `data` do evento, como a plataforma mandou. */
      dados: unknown
      externalId: string | null
    }
  | {
      tipo: 'envio'
      quando: string
      canal: Channel
      status: NotificationStatus
      texto: string
      notificationId: string
      /** Chave de partição: o detalhe precisa dela junto com o id. */
      criadoEm: string
    }

const FUSO = 'America/Sao_Paulo'

function quandoCurto(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: FUSO,
  })
}

function quandoPorExtenso(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: FUSO, dateStyle: 'full', timeStyle: 'medium' })
}

const TOM_DO_EVENTO = {
  ok: 'text-ok',
  fail: 'text-fail',
  pending: 'text-warn',
  neutro: 'text-ink',
} as const

function tomDoStatus(status: NotificationStatus): 'ok' | 'fail' | 'pending' {
  if (['sent', 'delivered', 'read'].includes(status)) return 'ok'
  if (['failed', 'dead'].includes(status)) return 'fail'
  return 'pending'
}

export function LinhaDoTempo({
  itens,
  podeReenviar,
}: {
  itens: ItemLinha[]
  podeReenviar: boolean
}) {
  const [aberto, setAberto] = useState<ItemLinha | null>(null)

  if (itens.length === 0) {
    return <p className="text-2xs text-pending">Nada registrado ainda.</p>
  }

  return (
    <>
      <ol className="flex flex-col">
        {itens.map((item, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => setAberto(item)}
              className="flex w-full items-start gap-2 border-b border-line/40 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <span className="w-20 shrink-0 font-mono text-2xs text-pending tabular-nums">
                {quandoCurto(item.quando)}
              </span>

              <span className="min-w-0 flex-1">
                {item.tipo === 'envio' ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ChannelIcon channel={item.canal} className="size-3" aria-hidden="true" />
                    <span className="truncate text-2xs text-ink">{item.texto}</span>
                    <Badge tone={tomDoStatus(item.status)}>
                      {NOTIFICATION_STATUS_LABELS[item.status]}
                    </Badge>
                  </span>
                ) : item.tipo === 'evento' ? (
                  <span className="flex flex-col">
                    <span
                      className={cn('text-2xs', TOM_DO_EVENTO[descreverEvento(item.evento).tom])}
                    >
                      {descreverEvento(item.evento).nome}
                    </span>
                    {/*
                      O resumo é o que faz esta linha valer sozinha: sem ele, a
                      pessoa teria de abrir cada evento para saber se aquela
                      aposta foi de R$ 2 ou de R$ 200.
                    */}
                    {resumoDoEvento(item.dados) ? (
                      <span className="truncate text-2xs text-ink-2">
                        {resumoDoEvento(item.dados)}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-2xs text-ink">
                    {item.texto}
                    {item.quem ? <span className="text-pending"> — {item.quem}</span> : null}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/*
        O envio reaproveita o detalhe do histórico — mesma janela, mesmos dados,
        mesmo botão de reenviar. Uma segunda tela mostrando "quase isso" é como
        duas telas passam a discordar sobre o que foi enviado.
      */}
      {aberto?.tipo === 'envio' ? (
        <DetalheEnvio
          id={aberto.notificationId}
          createdAt={aberto.criadoEm}
          podeReenviar={podeReenviar}
          onFechar={() => setAberto(null)}
        />
      ) : null}

      {aberto && aberto.tipo !== 'envio' ? (
        <Modal
          aberto
          aoFechar={() => setAberto(null)}
          titulo={
            aberto.tipo === 'evento' ? descreverEvento(aberto.evento).nome : 'Anotação do lead'
          }
          descricao={quandoPorExtenso(aberto.quando)}
        >
          {aberto.tipo === 'evento' ? (
            <div className="flex flex-col gap-3">
              <p className="text-2xs text-ink-2">{descreverEvento(aberto.evento).ajuda}</p>

              {aberto.externalId ? (
                <p className="text-2xs text-pending">
                  Código na plataforma:{' '}
                  <span className="font-mono text-ink-2">{aberto.externalId}</span>
                </p>
              ) : null}

              {camposDoEvento(aberto.dados).length === 0 ? (
                <p className="text-2xs text-pending">
                  A plataforma não mandou nenhum detalhe junto deste evento — só o tipo. Se algo
                  deveria vir aqui, confira o mapeamento em Configurações → Plataformas.
                </p>
              ) : (
                <dl className="divide-y divide-line">
                  {camposDoEvento(aberto.dados).map((campo) => (
                    <div
                      key={campo.chave}
                      className="flex items-baseline justify-between gap-4 py-1.5"
                    >
                      <dt className="shrink-0 text-2xs text-pending" title={campo.chave}>
                        {campo.rotulo}
                      </dt>
                      <dd className="truncate text-2xs text-ink">{campo.valor}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <p className="font-mono text-2xs text-pending">{aberto.evento}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-xs whitespace-pre-wrap text-ink">{aberto.texto}</p>
              <p className="text-2xs text-pending">
                {aberto.quem ? `Por ${aberto.quem}` : 'Registrado pelo sistema'} · {aberto.especie}
              </p>
            </div>
          )}
        </Modal>
      ) : null}
    </>
  )
}
