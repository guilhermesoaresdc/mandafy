'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CHANNEL_COLOR_VAR,
  CHANNEL_SHORT,
  CHANNELS,
  NOTIFICATION_STATUS_LABELS,
  NOTIFICATION_STATUSES,
  type Channel,
  type NotificationStatus,
} from '@/db/schema/enums'
import { Dica } from '@/components/ui'
import { cn } from '@/lib/utils'
import { DetalheEnvio } from './detalhe'

/**
 * O log ao vivo (§10.1).
 *
 * Layout de terminal: denso, monoespaçado, rápido. Sem cards inflados — quem
 * olha esta tela está procurando uma linha específica entre milhares, e cada
 * pixel de respiro é uma linha a menos na tela.
 *
 * É um dos "use client" autorizados por §13.2 (filtros do histórico). O SSE
 * mantém a lista viva sem uma requisição por segundo.
 */

export type LinhaLog = {
  id: string
  createdAt: string
  channel: Channel
  status: NotificationStatus
  contactId: string | null
  contactName: string | null
  messageKey: string | null
  scheduledFor: string | null
  errorCode: string | null
  latenciaMs: number | null
}

/** Marcador de status: forma antes de cor, para não depender dela (§11.4). */
const MARCA: Record<NotificationStatus, string> = {
  queued: '⧗',
  scheduled: '⧗',
  sending: '◐',
  sent: '✓',
  delivered: '✓',
  read: '✓',
  failed: '✗',
  dead: '✗',
  cancelled: '⊘',
  skipped: '–',
}

const TOM: Record<NotificationStatus, string> = {
  queued: 'text-pending',
  scheduled: 'text-pending',
  sending: 'text-ink-2',
  sent: 'text-ok',
  delivered: 'text-ok',
  read: 'text-ok',
  failed: 'text-fail',
  dead: 'text-fail',
  cancelled: 'text-pending',
  skipped: 'text-pending',
}

/**
 * Fuso da operação, e não o do navegador.
 *
 * `toLocaleTimeString` sem `timeZone` usa o relógio de quem está olhando. Um
 * consultor viajando, ou um servidor em UTC, leria horários que não batem com
 * os que a banca combinou com o cliente — e "saiu 17:47" viraria "saiu 20:47"
 * sem nada explicando.
 */
const FUSO = 'America/Sao_Paulo'

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour12: false, timeZone: FUSO })
}

/**
 * `05/08 17:47:45` — a DATA junto com a hora.
 *
 * O histórico mostra três dias, e mostrava só a hora. Duas linhas às 17:47 de
 * dias diferentes ficavam idênticas na tela, e a lista, ordenada por data,
 * parecia fora de ordem: 16:17, 15:47, 15:46, 14:52, 12:16, 11:50, **18:20**,
 * 17:47 — o salto para trás é a virada do dia, invisível.
 *
 * O ano fica de fora de propósito: três dias nunca cruzam dois anos, e a coluna
 * já é a mais estreita da tabela.
 */
function dataEHora(iso: string): string {
  const d = new Date(iso)
  const dia = d.toLocaleDateString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' })
  return `${dia} ${hora(iso)}`
}

function latenciaTexto(linha: LinhaLog): string {
  if (linha.status === 'scheduled' || linha.status === 'queued') {
    return linha.scheduledFor ? hora(linha.scheduledFor).slice(0, 5) : ''
  }
  if (linha.errorCode) return linha.errorCode
  if (linha.latenciaMs === null) return ''
  return linha.latenciaMs < 1000
    ? `${linha.latenciaMs}ms`
    : `${(linha.latenciaMs / 1000).toFixed(1)}s`
}

/**
 * As colunas, com o que cada uma quer dizer.
 *
 * SEIS COLUNAS SEM CABEÇALHO ERAM SEIS ADIVINHAÇÕES
 *
 * A tabela nasceu com layout de terminal: densa, monoespaçada, sem cabeçalho —
 * e num terminal isso funciona porque quem lê já conhece o formato. Aqui não:
 * a segunda coluna é `zap`/`mail`, a quinta tem um símbolo e uma palavra, e a
 * última mostra `1.2s` numa linha e `sem_optin` na seguinte. Quem abria pela
 * primeira vez não tinha como saber o que era o quê, e a informação existia —
 * só não estava escrita em lugar nenhum.
 *
 * A largura da coluna não comporta a explicação, então ela vai na dica. O
 * cabeçalho fica FIXO no topo da área rolável (`sticky`): rolando mil linhas, a
 * referência tem de continuar visível — cabeçalho que sai da tela é cabeçalho
 * que só serve para a primeira tela.
 */
const COLUNAS = [
  {
    chave: 'quando',
    rotulo: 'Quando',
    dica: 'Dia e hora em que a linha foi criada, no horário de Brasília. Para o que ainda não saiu, o envio está marcado para mais tarde — veja a coluna da direita.',
    classe: 'w-24 pl-3',
  },
  {
    chave: 'canal',
    rotulo: 'Canal',
    dica: 'Por onde a mensagem foi (ou iria): WhatsApp, e-mail, SMS ou Telegram.',
    classe: 'w-12',
  },
  {
    chave: 'contato',
    rotulo: 'Para quem',
    dica: 'O nome do contato como está no cadastro. O telefone e o e-mail ficam no detalhe, ao clicar.',
    classe: 'min-w-0',
  },
  {
    chave: 'mensagem',
    rotulo: 'Mensagem',
    dica: 'Qual mensagem do catálogo gerou esta linha. Clique para ver o texto exato que a pessoa recebeu.',
    classe: 'w-40',
  },
  {
    chave: 'status',
    rotulo: 'Situação',
    dica: 'Na fila, saiu, entregue, lida, falhou, cancelada ou pulada. "Pulada" é quando uma regra de proteção barrou o envio de propósito — o motivo aparece à direita.',
    classe: 'w-28',
  },
  {
    chave: 'tempo',
    rotulo: 'Tempo / motivo',
    dica: 'Quanto o provedor levou para aceitar a mensagem. Para o que está agendado, a hora marcada; para o que falhou ou foi pulado, o motivo.',
    classe: 'w-24 pr-3 text-right',
  },
] as const

export function LogAoVivo({
  inicial,
  podeReenviar,
}: {
  inicial: LinhaLog[]
  podeReenviar: boolean
}) {
  const [linhas, setLinhas] = useState<LinhaLog[]>(inicial)
  const [canais, setCanais] = useState<Set<Channel>>(new Set(CHANNELS))
  const [status, setStatus] = useState<Set<NotificationStatus>>(new Set())
  const [busca, setBusca] = useState('')
  const [aoVivo, setAoVivo] = useState(true)
  const [conectado, setConectado] = useState(false)
  const [aberta, setAberta] = useState<LinhaLog | null>(null)

  const fonteRef = useRef<EventSource | null>(null)

  /** Mescla por id: uma linha que mudou de status substitui a antiga. */
  const mesclar = useCallback((novas: LinhaLog[]) => {
    setLinhas((atuais) => {
      const porId = new Map(atuais.map((l) => [l.id, l]))
      for (const nova of novas) porId.set(nova.id, nova)

      return [...porId.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        // Teto na memória do navegador: quem precisa de mais que isto usa o
        // filtro ou a exportação.
        .slice(0, 500)
    })
  }, [])

  useEffect(() => {
    if (!aoVivo) {
      fonteRef.current?.close()
      fonteRef.current = null
      setConectado(false)
      return
    }

    const params = new URLSearchParams()
    if (canais.size > 0 && canais.size < CHANNELS.length) {
      params.set('canais', [...canais].join(','))
    }
    if (status.size > 0) params.set('status', [...status].join(','))
    if (busca.trim() !== '') params.set('busca', busca.trim())

    const fonte = new EventSource(`/api/historico/stream?${params}`)
    fonteRef.current = fonte

    fonte.addEventListener('pronto', () => setConectado(true))
    fonte.addEventListener('linhas', (evento) => {
      try {
        mesclar(JSON.parse((evento as MessageEvent<string>).data) as LinhaLog[])
      } catch {
        // Payload truncado por reconexão: o próximo tique traz de novo.
      }
    })
    // O EventSource reconecta sozinho; só refletimos o estado na interface.
    fonte.onerror = () => setConectado(false)

    return () => {
      fonte.close()
      fonteRef.current = null
    }
    // `busca` fora das dependências de propósito: reabrir a conexão a cada
    // tecla digitada criaria e derrubaria uma conexão por caractere. O filtro
    // de texto é aplicado no cliente, sobre o que já está na tela.
  }, [aoVivo, canais, status, mesclar, busca])

  const visiveis = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return linhas.filter((linha) => {
      if (canais.size > 0 && !canais.has(linha.channel)) return false
      if (status.size > 0 && !status.has(linha.status)) return false
      if (termo === '') return true
      return (
        (linha.contactName ?? '').toLowerCase().includes(termo) ||
        (linha.messageKey ?? '').toLowerCase().includes(termo)
      )
    })
  }, [linhas, canais, status, busca])

  const alternarCanal = (canal: Channel): void => {
    setCanais((atual) => {
      const proximo = new Set(atual)
      if (proximo.has(canal)) proximo.delete(canal)
      else proximo.add(canal)
      // Nenhum canal selecionado esconderia tudo; equivale a "todos".
      return proximo.size === 0 ? new Set(CHANNELS) : proximo
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {/* ── Barra de filtros ── */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
          <div className="flex items-center gap-1">
            {CHANNELS.map((canal) => (
              <button
                key={canal}
                type="button"
                onClick={() => alternarCanal(canal)}
                aria-pressed={canais.has(canal)}
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-2xs transition-opacity',
                  canais.has(canal) ? 'border-line text-ink' : 'border-transparent text-pending opacity-40',
                )}
                style={
                  canais.has(canal)
                    ? { color: `var(${CHANNEL_COLOR_VAR[canal]})` }
                    : undefined
                }
              >
                {CHANNEL_SHORT[canal]}
              </button>
            ))}
          </div>

          <select
            value={[...status][0] ?? ''}
            onChange={(e) =>
              setStatus(e.target.value === '' ? new Set() : new Set([e.target.value as NotificationStatus]))
            }
            aria-label="Filtrar por status"
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-2xs text-ink-2 outline-none focus-visible:border-ink"
          >
            <option value="">Todos os status</option>
            {NOTIFICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {NOTIFICATION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>

          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar contato ou mensagem…"
            aria-label="Buscar"
            className="min-w-32 flex-1 rounded border border-line bg-surface px-2 py-0.5 text-2xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
          />

          <a
            href={`/api/historico/csv?${new URLSearchParams({
              ...(canais.size < CHANNELS.length ? { canais: [...canais].join(',') } : {}),
              ...(status.size > 0 ? { status: [...status].join(',') } : {}),
              ...(busca.trim() !== '' ? { busca: busca.trim() } : {}),
            })}`}
            className="rounded border border-line px-1.5 py-0.5 text-2xs text-ink-2 hover:text-ink"
          >
            CSV
          </a>

          <button
            type="button"
            onClick={() => setAoVivo((v) => !v)}
            aria-pressed={aoVivo}
            className="flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-2xs text-ink-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full',
                aoVivo && conectado ? 'bg-ok' : aoVivo ? 'bg-pending' : 'bg-line',
              )}
            />
            {aoVivo ? 'ao vivo' : 'pausado'}
          </button>
        </div>

        {/* ── As linhas ── */}
        {visiveis.length === 0 ? (
          <p className="px-3 py-6 text-center text-2xs text-pending">
            {linhas.length === 0
              ? 'Nada saiu ainda. Quando sair, aparece aqui na hora.'
              : 'Nenhuma linha com esses filtros.'}
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full border-collapse font-mono text-2xs">
              <caption className="sr-only">Envios dos últimos 3 dias</caption>
              <thead className="sticky top-0 z-10">
                <tr className="bg-surface-2 text-left">
                  {COLUNAS.map((coluna) => (
                    <th
                      key={coluna.chave}
                      scope="col"
                      className={cn(
                        'border-b border-line py-1.5 pr-2 font-sans text-2xs font-medium whitespace-nowrap text-ink-2',
                        coluna.classe,
                      )}
                    >
                      <Dica texto={coluna.dica}>
                        <span className="border-b border-dotted border-ink-2/50">
                          {coluna.rotulo}
                        </span>
                      </Dica>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visiveis.map((linha) => (
                  <tr
                    key={linha.id}
                    onClick={() => setAberta(linha)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setAberta(linha)
                      }
                    }}
                    className="cursor-pointer border-b border-line/50 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                  >
                    <td className="w-24 py-1 pr-2 pl-3 whitespace-nowrap text-pending tabular-nums">
                      {dataEHora(linha.createdAt)}
                    </td>
                    <td className="py-1 pr-2">
                      <span style={{ color: `var(${CHANNEL_COLOR_VAR[linha.channel]})` }}>
                        {CHANNEL_SHORT[linha.channel]}
                      </span>
                    </td>
                    <td className="max-w-40 truncate py-1 pr-2 text-ink">
                      {linha.contactName ?? '—'}
                    </td>
                    <td className="max-w-44 truncate py-1 pr-2 text-ink-2">
                      {linha.messageKey ?? '—'}
                    </td>
                    <td className={cn('py-1 pr-2 whitespace-nowrap', TOM[linha.status])}>
                      {MARCA[linha.status]} {NOTIFICATION_STATUS_LABELS[linha.status]}
                    </td>
                    <td className="py-1 pr-3 text-right text-pending tabular-nums">
                      {latenciaTexto(linha)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-2xs text-pending">
        {visiveis.length} de {linhas.length} linha(s) · 3 dias na camada quente
      </p>

      {aberta ? (
        <DetalheEnvio
          id={aberta.id}
          createdAt={aberta.createdAt}
          podeReenviar={podeReenviar}
          onFechar={() => setAberta(null)}
        />
      ) : null}
    </div>
  )
}
