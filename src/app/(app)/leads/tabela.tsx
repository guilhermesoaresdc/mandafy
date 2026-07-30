'use client'

import { useActionState, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Badge, Button } from '@/components/ui'
import { cn, formatBRL } from '@/lib/utils'
import { atribuirAction, type LeadState } from './actions'

/**
 * A tabela de leads (§9.1).
 *
 * Virtualizada: renderiza só as linhas visíveis, para 50 mil leads não
 * travarem o navegador (§13.2). É um dos "use client" autorizados.
 *
 * A busca é local, sobre o que já veio. O servidor manda um recorte grande e
 * filtrado; refazer a consulta a cada tecla trocaria uma busca instantânea por
 * uma ida e volta de rede — e §9.1 pede abaixo de 100ms.
 */

export type LinhaLead = {
  id: string
  title: string
  valueCents: number
  status: string
  stageName: string
  stageColor: string | null
  ownerId: string | null
  ownerName: string | null
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  source: string
  nextActionAt: string | null
  lastEventAt: string | null
}

const ALTURA_LINHA = 34

function quando(iso: string | null): string {
  if (!iso) return '—'
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000)
  if (dias === 0) return 'hoje'
  if (dias === 1) return 'ontem'
  if (dias < 30) return `${dias}d`
  return `${Math.floor(dias / 30)}m`
}

export function TabelaLeads({
  linhas,
  consultores,
  podeReatribuir,
}: {
  linhas: LinhaLead[]
  consultores: { id: string; name: string }[]
  podeReatribuir: boolean
}) {
  const [busca, setBusca] = useState('')
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set())
  const [estado, atribuir, atribuindo] = useActionState<LeadState, FormData>(atribuirAction, {})

  const containerRef = useRef<HTMLDivElement | null>(null)

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    if (termo === '') return linhas

    return linhas.filter(
      (l) =>
        l.title.toLowerCase().includes(termo) ||
        (l.contactName ?? '').toLowerCase().includes(termo) ||
        (l.contactPhone ?? '').includes(termo) ||
        (l.contactEmail ?? '').toLowerCase().includes(termo),
    )
  }, [linhas, busca])

  const virtual = useVirtualizer({
    count: visiveis.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ALTURA_LINHA,
    overscan: 12,
  })

  const alternar = (id: string): void => {
    setSelecionados((atual) => {
      const proximo = new Set(atual)
      if (proximo.has(id)) proximo.delete(id)
      else proximo.add(id)
      return proximo
    })
  }

  const todosVisiveisSelecionados =
    visiveis.length > 0 && visiveis.every((l) => selecionados.has(l.id))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar por nome, telefone ou e-mail…"
          aria-label="Buscar leads"
          className="min-w-48 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
        />

        {/* Seleção múltipla → ações em lote (§9.1) */}
        {selecionados.size > 0 && podeReatribuir ? (
          <form action={atribuir} className="flex items-center gap-2">
            <input type="hidden" name="leadIds" value={[...selecionados].join(',')} />
            <select
              name="ownerId"
              aria-label="Atribuir a"
              defaultValue="auto"
              className="rounded-lg border border-line bg-surface px-2 py-1.5 text-2xs text-ink outline-none focus-visible:border-ink"
            >
              <option value="auto">Distribuir no rodízio</option>
              <option value="">Sem responsável</option>
              {consultores.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" disabled={atribuindo}>
              {atribuindo ? 'Atribuindo…' : `Atribuir ${selecionados.size}`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelecionados(new Set())}
            >
              Limpar
            </Button>
          </form>
        ) : null}

        <a
          href="/api/leads/csv"
          className="rounded-lg border border-line px-2 py-1.5 text-2xs text-ink-2 hover:text-ink"
        >
          CSV
        </a>
      </div>

      {estado.erro ? (
        <p role="alert" className="text-2xs text-fail">
          {estado.erro}
        </p>
      ) : null}
      {estado.ok ? <p className="text-2xs text-ok">{estado.ok}</p> : null}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {/* Cabeçalho fora da área rolável, para não rolar junto. */}
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-2xs text-pending">
          {podeReatribuir ? (
            <input
              type="checkbox"
              checked={todosVisiveisSelecionados}
              onChange={(e) =>
                setSelecionados(e.target.checked ? new Set(visiveis.map((l) => l.id)) : new Set())
              }
              aria-label="Selecionar todos"
              className="size-3 accent-ink"
            />
          ) : null}
          <span className="min-w-0 flex-1">Lead</span>
          <span className="hidden w-28 sm:block">Etapa</span>
          <span className="hidden w-24 md:block">Responsável</span>
          <span className="w-20 text-right">Valor</span>
          <span className="w-12 text-right">Visto</span>
        </div>

        {visiveis.length === 0 ? (
          <p className="px-3 py-6 text-center text-2xs text-pending">
            {linhas.length === 0
              ? 'Nenhum lead ainda. Eles aparecem sozinhos conforme os eventos chegam.'
              : 'Nenhum lead com essa busca.'}
          </p>
        ) : (
          <div ref={containerRef} className="max-h-[60vh] overflow-y-auto">
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((item) => {
                const lead = visiveis[item.index]
                if (!lead) return null

                return (
                  <div
                    key={lead.id}
                    className="absolute top-0 left-0 flex w-full items-center gap-2 border-b border-line/50 px-3 text-2xs hover:bg-surface-2"
                    style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                  >
                    {podeReatribuir ? (
                      <input
                        type="checkbox"
                        checked={selecionados.has(lead.id)}
                        onChange={() => alternar(lead.id)}
                        aria-label={`Selecionar ${lead.title}`}
                        className="size-3 accent-ink"
                      />
                    ) : null}

                    <Link
                      href={`/leads/${lead.id}`}
                      className="min-w-0 flex-1 truncate text-ink underline-offset-2 hover:underline"
                    >
                      {lead.title}
                      {lead.contactPhone ? (
                        <span className="ml-2 font-mono text-pending">{lead.contactPhone}</span>
                      ) : null}
                    </Link>

                    <span className="hidden w-28 truncate sm:block">
                      <Badge tone={lead.status === 'ganho' ? 'ok' : lead.status === 'perdido' ? 'fail' : 'pending'}>
                        {lead.stageName}
                      </Badge>
                    </span>

                    <span
                      className={cn(
                        'hidden w-24 truncate md:block',
                        lead.ownerName ? 'text-ink-2' : 'text-fail',
                      )}
                    >
                      {lead.ownerName ?? 'sem dono'}
                    </span>

                    <span className="w-20 text-right font-mono text-ink-2 tabular-nums">
                      {lead.valueCents > 0 ? formatBRL(lead.valueCents) : '—'}
                    </span>

                    <span className="w-12 text-right text-pending tabular-nums">
                      {quando(lead.lastEventAt)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <p className="text-2xs text-pending">
        {visiveis.length} de {linhas.length} lead(s)
        {selecionados.size > 0 ? ` · ${selecionados.size} selecionado(s)` : ''}
      </p>
    </div>
  )
}
