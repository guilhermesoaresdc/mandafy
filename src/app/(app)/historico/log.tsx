'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { explicarMotivo } from '@/lib/vocabulario'
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
  messageName: string | null
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
  // O motivo em português, não o código do banco. A coluna se chama
  // "Tempo / motivo" e imprimia `sem_optin` para quem opera a banca.
  if (linha.errorCode) return explicarMotivo(linha.errorCode)
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

/** A query da busca, preservando o que já está na URL não seria útil aqui: uma
 * pesquisa nova é uma pergunta nova, e carregar o filtro anterior faria a tela
 * responder "não achei" por causa de um recorte que a pessoa esqueceu que pôs. */
function paraQuery(busca: string): string {
  return new URLSearchParams({ busca: busca.trim() }).toString()
}

/**
 * As duas perguntas que se faz a esta tela.
 *
 * `dead` é "falhou e ninguém vai tentar de novo" e `failed` é "falhou e ainda
 * tem chance": a distinção importa para o motor e não para quem procura o que
 * não chegou. `skipped` entra junto porque, para quem pergunta, uma mensagem
 * barrada por regra também não chegou — muda o motivo, não o fato.
 */
const ATALHOS_DE_STATUS = [
  { rotulo: 'Deu errado', status: ['failed', 'dead', 'skipped'] as NotificationStatus[] },
  { rotulo: 'Ainda não saiu', status: ['queued', 'scheduled'] as NotificationStatus[] },
] as const

export function LogAoVivo({
  inicial,
  total,
  podeReenviar,
  canaisIniciais,
  statusIniciais,
  buscaInicial,
}: {
  inicial: LinhaLog[]
  /** Quantas linhas o filtro tem no BANCO — não quantas couberam na tela. */
  total: number
  podeReenviar: boolean
  /** O filtro veio na URL: é assim que um alerta do painel aponta para cá. */
  canaisIniciais: Channel[] | null
  statusIniciais: NotificationStatus[] | null
  buscaInicial: string
}) {
  const router = useRouter()
  const [linhas, setLinhas] = useState<LinhaLog[]>(inicial)
  const [canais, setCanais] = useState<Set<Channel>>(new Set(canaisIniciais ?? CHANNELS))
  const [status, setStatus] = useState<Set<NotificationStatus>>(new Set(statusIniciais ?? []))
  /*
   * `busca` é o que está sendo DIGITADO; `buscaInicial` é o que já foi
   * perguntado ao banco. São coisas diferentes e a distinção conserta dois
   * defeitos de uma vez: a conexão ao vivo passa a depender da busca enviada
   * (e não reabre a cada tecla) e a caixa continua refinando na hora o que já
   * está na tela, sem esperar ida e volta.
   */
  const [busca, setBusca] = useState(buscaInicial)
  const [aoVivo, setAoVivo] = useState(true)
  const [conectado, setConectado] = useState(false)
  const [aberta, setAberta] = useState<LinhaLog | null>(null)

  const fonteRef = useRef<EventSource | null>(null)

  /*
   * Navegação para o mesmo caminho com outra query traz linhas novas por props,
   * e o React mantém o estado do componente. Sem isto, filtrar pela URL não
   * mudaria nada na tela — que é o defeito exato que estamos consertando.
   */
  useEffect(() => {
    setLinhas(inicial)
    setBusca(buscaInicial)
    setCanais(new Set(canaisIniciais ?? CHANNELS))
    setStatus(new Set(statusIniciais ?? []))
  }, [inicial, buscaInicial, canaisIniciais, statusIniciais])

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
    if (buscaInicial.trim() !== '') params.set('busca', buscaInicial.trim())

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
    /*
     * `buscaInicial` e não `busca`: o comentário antigo jurava que a busca
     * estava fora das dependências para não derrubar a conexão a cada tecla —
     * e ela estava DENTRO, então o navegador abria e fechava uma conexão por
     * caractere digitado. Agora depende do que foi enviado, que muda uma vez
     * por pesquisa, e a promessa do comentário passa a ser verdade.
     */
  }, [aoVivo, canais, status, mesclar, buscaInicial])

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
                  // py-2 no telefone: ligar e desligar canal é o filtro mais
                  // usado desta tela, e 23px de altura é menos que um polegar.
                  'rounded border px-2 py-2 font-mono text-2xs transition-opacity md:px-1.5 md:py-0.5',
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

          {/*
            DOIS CHIPS NO LUGAR DE DEZ OPÇÕES.

            O select listava os dez status do banco — "na fila", "agendada",
            "enviando", "enviada", "entregue", "lida", "falhou", "morta",
            "cancelada", "pulada" — e pedia que a pessoa soubesse a diferença
            entre "falhou" e "morta", entre "cancelada" e "pulada", para achar
            o que procura. São duas perguntas de verdade, e cada uma junta
            vários status: o que deu errado, e o que ainda não saiu.

            O select continua embaixo para quem quiser um status específico —
            o atalho não tira o caminho, adianta os dois casos comuns.
          */}
          <div className="flex items-center gap-1">
            {ATALHOS_DE_STATUS.map((atalho) => {
              const ligado =
                status.size === atalho.status.length &&
                atalho.status.every((s) => status.has(s))
              return (
                <button
                  key={atalho.rotulo}
                  type="button"
                  onClick={() => setStatus(ligado ? new Set() : new Set(atalho.status))}
                  aria-pressed={ligado}
                  className={cn(
                    'rounded border px-2 py-2 text-2xs transition-colors md:py-0.5',
                    ligado
                      ? 'border-ink bg-surface text-ink'
                      : 'border-line text-ink-2 hover:text-ink',
                  )}
                >
                  {atalho.rotulo}
                </button>
              )
            })}
          </div>

          <select
            value={status.size === 1 ? ([...status][0] ?? '') : ''}
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

          {/*
            A BUSCA VAI AO BANCO, e não só ao que está na tela.

            A mesma caixa procurava na base inteira quando alguém baixava a
            planilha — o link do CSV manda `busca` ao servidor, que faz ILIKE em
            nome, telefone e e-mail — e em 200 linhas quando olhava a tela.
            Duas respostas para a mesma pergunta, e a da tela era a errada:
            "não achei" queria dizer "não estava nas 200 primeiras".

            Enter envia; enquanto digita, refina o que já está carregado. Os
            dois comportamentos convivem porque servem a momentos diferentes —
            um é procurar, o outro é olhar melhor.
          */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              router.push(busca.trim() ? `/historico?${paraQuery(busca)}` : '/historico')
            }}
            className="flex min-w-32 flex-1 items-center gap-1"
          >
            <input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar e apertar Enter…"
              aria-label="Buscar contato ou mensagem"
              className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-0.5 text-2xs text-ink outline-none placeholder:text-pending focus-visible:border-ink"
            />
          </form>

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
            {/*
              ── No celular a tabela vira lista ──

              As seis colunas somam 512px de largura fixa. Num aparelho de 375px
              apareciam as três primeiras — "Quando", "Canal" e metade de "Para
              quem". SITUAÇÃO E MOTIVO, as duas que respondem a pergunta que traz
              alguém a esta tela, ficavam além da borda direita.

              Alcançáveis, para ser exato: `overflow-y-auto` faz o `overflow-x`
              computar como `auto`, então dava para arrastar de lado dentro da
              lista. Só que nada na tela dizia isso. Uma rolagem horizontal
              escondida dentro de uma lista que rola na vertical, sem barra à
              vista no toque, é um recurso que existe para quem já sabe que ele
              está lá — e quem já sabe não precisava dele.

              Cada linha vira um bloco de três andares, na ordem em que a
              pergunta é feita: o que aconteceu, com quem, e por quê.
            */}
            <ul className="divide-y divide-line/50 md:hidden">
              {visiveis.map((linha) => {
                const detalhe = latenciaTexto(linha)
                return (
                  <li key={linha.id}>
                    <button
                      type="button"
                      onClick={() => setAberta(linha)}
                      className="w-full px-3 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className={cn('text-xs font-medium', TOM[linha.status])}>
                          {MARCA[linha.status]} {NOTIFICATION_STATUS_LABELS[linha.status]}
                        </span>
                        <span
                          className="ml-auto shrink-0 font-mono text-2xs"
                          style={{ color: `var(${CHANNEL_COLOR_VAR[linha.channel]})` }}
                        >
                          {CHANNEL_SHORT[linha.channel]}
                        </span>
                        <span className="shrink-0 font-mono text-2xs text-pending tabular-nums">
                          {dataEHora(linha.createdAt)}
                        </span>
                      </div>

                      <p className="truncate text-xs text-ink">{linha.contactName ?? '—'}</p>

                      {/*
                        O motivo NÃO trunca: "número não tem WhatsApp" cortado em
                        "número não tem…" devolve a pessoa ao lugar de onde ela
                        veio. O nome da mensagem, sim — ele é referência, não
                        resposta.
                      */}
                      <p className="text-2xs text-pending">
                        <span>{linha.messageName ?? linha.messageKey ?? '—'}</span>
                        {detalhe ? <span className="text-ink-2"> · {detalhe}</span> : null}
                      </p>
                    </button>
                  </li>
                )
              })}
            </ul>

            <table className="hidden w-full border-collapse font-mono text-2xs md:table">
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
                    {/*
                      O NOME, e a chave na dica. Procurar "Lembrete de PIX" no
                      histórico não achava nada: a linha se chamava
                      `pix_lembrete_1`. A chave continua no CSV e na API, que
                      são contrato com quem integra.
                    */}
                    <td
                      className="max-w-44 truncate py-1 pr-2 font-sans text-ink-2"
                      title={linha.messageKey ?? undefined}
                    >
                      {linha.messageName ?? linha.messageKey ?? '—'}
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

      {/*
        O RODAPÉ DIZ O QUE ESTÁ ACONTECENDO.

        Ele imprimia "200 de 200" — o mesmo número dos dois lados, sempre,
        porque media o array carregado contra ele mesmo. Numa base de cinco mil,
        a tela afirmava estar mostrando tudo enquanto mostrava 4%. É a diferença
        entre "não existe" e "não estava nas primeiras 200", e quem lê o rodapé
        está justamente tentando decidir qual das duas é.
      */}
      <p className="text-2xs text-pending">
        {visiveis.length} de {linhas.length} carregada(s)
        {total > linhas.length ? (
          <>
            {' '}
            · <span className="text-ink-2">{total} no filtro</span> — a busca procura em todas
          </>
        ) : null}{' '}
        · 3 dias na camada quente
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
