'use client'

import { useOptimistic, useState, useTransition } from 'react'
import Link from 'next/link'
import { moverLeadAction } from '../leads/actions'
import { cn, formatBRL } from '@/lib/utils'

/**
 * O kanban (§9.2).
 *
 * Arrastar e soltar com atualização OTIMISTA: a interface move o cartão na
 * hora e o servidor confirma depois (§13.2). Se falhar, o cartão volta com uma
 * explicação — esperar a ida e volta antes de mover faria o funil parecer
 * travado a cada arrasto.
 *
 * HTML5 drag-and-drop nativo, sem biblioteca: são três handlers, e a stack é
 * fixa (§2 do CLAUDE.md). Quem usa teclado tem o seletor de etapa no cartão —
 * arrastar nunca é o único caminho.
 */

export type Cartao = {
  id: string
  title: string
  valueCents: number
  ownerName: string | null
  contactName: string | null
  diasNaEtapa: number
}

export type Coluna = {
  stageId: string
  name: string
  color: string | null
  isWon: boolean
  isLost: boolean
  total: number
  somaCents: number
  cartoes: Cartao[]
}

type Movimento = { leadId: string; paraStageId: string }

export function Kanban({ colunas }: { colunas: Coluna[] }) {
  const [erro, setErro] = useState<string | null>(null)
  const [, iniciar] = useTransition()
  const [arrastando, setArrastando] = useState<string | null>(null)
  const [sobre, setSobre] = useState<string | null>(null)

  /*
   * O estado otimista recebe o movimento e recalcula as colunas. Guardar as
   * colunas inteiras faria uma revalidação do servidor apagar o movimento em
   * curso; guardar só o movimento deixa o servidor ser a verdade.
   */
  const [visiveis, aplicar] = useOptimistic(colunas, (atual, movimento: Movimento) => {
    const cartao = atual.flatMap((c) => c.cartoes).find((c) => c.id === movimento.leadId)
    if (!cartao) return atual

    return atual.map((coluna) => {
      if (coluna.stageId === movimento.paraStageId) {
        if (coluna.cartoes.some((c) => c.id === cartao.id)) return coluna
        return {
          ...coluna,
          total: coluna.total + 1,
          somaCents: coluna.somaCents + cartao.valueCents,
          cartoes: [{ ...cartao, diasNaEtapa: 0 }, ...coluna.cartoes],
        }
      }

      if (!coluna.cartoes.some((c) => c.id === cartao.id)) return coluna
      return {
        ...coluna,
        total: Math.max(0, coluna.total - 1),
        somaCents: Math.max(0, coluna.somaCents - cartao.valueCents),
        cartoes: coluna.cartoes.filter((c) => c.id !== cartao.id),
      }
    })
  })

  function mover(leadId: string, paraStageId: string): void {
    setErro(null)

    iniciar(async () => {
      // O otimista precisa acontecer DENTRO da transição, senão o React
      // descarta o estado assim que ela termina.
      aplicar({ leadId, paraStageId })

      const dados = new FormData()
      dados.set('leadId', leadId)
      dados.set('stageId', paraStageId)

      const resultado = await moverLeadAction({}, dados)
      if (resultado.erro) setErro(resultado.erro)
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {erro ? (
        <p role="alert" className="text-2xs text-fail">
          {erro}
        </p>
      ) : null}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {visiveis.map((coluna) => (
          <section
            key={coluna.stageId}
            onDragOver={(e) => {
              e.preventDefault()
              setSobre(coluna.stageId)
            }}
            onDragLeave={() => setSobre((s) => (s === coluna.stageId ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              setSobre(null)
              const leadId = e.dataTransfer.getData('text/plain')
              if (leadId) mover(leadId, coluna.stageId)
            }}
            className={cn(
              'flex w-64 shrink-0 flex-col gap-2 rounded-xl border bg-surface-2 p-2 transition-colors',
              sobre === coluna.stageId ? 'border-ink' : 'border-line',
            )}
          >
            <header className="flex items-baseline justify-between gap-2 px-1">
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full"
                  style={{ background: coluna.color ?? 'var(--color-ink-2)' }}
                />
                <h2 className="text-xs font-medium text-ink">{coluna.name}</h2>
                <span className="font-mono text-2xs text-pending">{coluna.total}</span>
              </div>
              <span className="font-mono text-2xs text-pending tabular-nums">
                {coluna.somaCents > 0 ? formatBRL(coluna.somaCents) : ''}
              </span>
            </header>

            <div className="flex min-h-16 flex-col gap-1.5">
              {coluna.cartoes.length === 0 ? (
                <p className="px-1 py-3 text-2xs text-pending">Vazio.</p>
              ) : (
                coluna.cartoes.map((cartao) => (
                  <article
                    key={cartao.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', cartao.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setArrastando(cartao.id)
                    }}
                    onDragEnd={() => setArrastando(null)}
                    className={cn(
                      'cursor-grab rounded-lg border border-line bg-surface p-2 active:cursor-grabbing',
                      arrastando === cartao.id && 'opacity-40',
                    )}
                  >
                    <Link
                      href={`/leads/${cartao.id}`}
                      className="block truncate text-xs text-ink underline-offset-2 hover:underline"
                    >
                      {cartao.title}
                    </Link>

                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate text-2xs text-pending">
                        {cartao.ownerName ?? 'sem dono'}
                      </span>
                      {cartao.valueCents > 0 ? (
                        <span className="font-mono text-2xs text-ink-2 tabular-nums">
                          {formatBRL(cartao.valueCents)}
                        </span>
                      ) : null}
                    </div>

                    {/* Dias parado: o número que denuncia lead esquecido. */}
                    {cartao.diasNaEtapa > 0 ? (
                      <p
                        className={cn(
                          'mt-0.5 text-2xs',
                          cartao.diasNaEtapa >= 7 ? 'text-fail' : 'text-pending',
                        )}
                      >
                        {cartao.diasNaEtapa}d nesta etapa
                      </p>
                    ) : null}

                    {/* Caminho de teclado: arrastar nunca é o único jeito. */}
                    <label className="mt-1.5 block">
                      <span className="sr-only">Mover {cartao.title} para</span>
                      <select
                        value={coluna.stageId}
                        onChange={(e) => mover(cartao.id, e.target.value)}
                        /*
                          `py-1.5` no telefone: este seletor É o jeito de mover
                          um lead no celular — arrastar não funciona por toque —
                          e apontar alguém para um alvo de 29px de altura é
                          apontar para o alvo errado.
                        */
                        className="w-full rounded border border-line bg-surface-2 px-1 py-1.5 text-2xs text-ink-2 outline-none focus-visible:border-ink md:py-0.5"
                      >
                        {visiveis.map((c) => (
                          <option key={c.stageId} value={c.stageId}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
