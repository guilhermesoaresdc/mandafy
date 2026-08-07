'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { detectarMapeamento } from '@/lib/ingest/detectar'
import { CAMPOS_CANONICOS, MAPEAMENTO_SUGERIDO } from '@/lib/ingest/mapping'
import { getByPath, listLeafPaths } from '@/lib/ingest/path'
import { salvarMapeamentoAction, type PlataformaState } from '../actions'

/**
 * Passo 3 de §4.2: combinar os campos.
 *
 * A pessoa escolhe, para cada campo canônico, qual caminho do payload real o
 * alimenta — e vê o valor que sairia dali. Nada de digitar JSONPath de cabeça.
 */

type Mapping = {
  event_path?: string
  event_map?: Record<string, string>
  contact?: Record<string, unknown>
  fields?: Record<string, unknown>
}

function caminhoDe(spec: unknown): string {
  if (typeof spec === 'string') return spec
  if (spec && typeof spec === 'object' && 'path' in spec) return String((spec as { path: string }).path)
  return ''
}

/**
 * O que foi salvo vence; o palpite preenche o resto.
 *
 * Nessa ordem porque a pessoa é a autoridade sobre o próprio mapeamento: um
 * palpite que sobrescreve escolha manual desfaz trabalho e destrói a confiança
 * na tela inteira.
 *
 * COM UMA EXCEÇÃO, E ELA É O CASO COMUM
 *
 * Caminho salvo que NÃO EXISTE no evento recebido não conta como escolha. Toda
 * plataforma nasce com o mapeamento sugerido já gravado, e ele descreve um
 * formato aninhado (`$.data.user.name`). Numa plataforma que manda tudo plano,
 * esses caminhos apontam para o nada: a tela já os recusava — mostrava
 * "— não usar —" com "— não encontrado" embaixo — e o palpite ficava bloqueado
 * por um valor que ninguém escolheu e que a própria tela não exibia.
 *
 * Era o bug que tornaria a detecção inútil justamente onde ela mais serve.
 */
function comPalpites(
  salvo: Record<string, unknown>,
  palpites: Record<string, { caminho: string }>,
  existe: (caminho: string) => boolean,
): Record<string, string> {
  const saida: Record<string, string> = {}

  for (const [chave, valor] of Object.entries(salvo)) {
    const caminho = caminhoDe(valor)
    if (caminho && existe(caminho)) saida[chave] = caminho
  }

  for (const [chave, palpite] of Object.entries(palpites)) {
    if (!saida[chave]) saida[chave] = palpite.caminho
  }

  return saida
}

function Salvar() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Salvando…' : 'Salvar combinação'}
    </Button>
  )
}

/** A tradução que o Mandafy traz de fábrica, por nome de plataforma. */
const DE_FABRICA: Record<string, string | undefined> = MAPEAMENTO_SUGERIDO.event_map ?? {}

export function CombinarCampos({
  sourceId,
  mapping,
  payload,
  nomesRecebidos = [],
}: {
  sourceId: string
  mapping: unknown
  payload: unknown
  /**
   * Todos os nomes de evento que já chegaram por este webhook.
   *
   * O botão de adicionar só enxergava o evento do ÚLTIMO payload, então quem
   * recebeu cadastro, PIX gerado e PIX pago tinha de disparar cada um de novo
   * na plataforma para poder acrescentá-lo — uma volta ao painel da banca por
   * evento. Com a lista inteira, os que faltam entram de uma vez.
   */
  nomesRecebidos?: string[]
}) {
  const inicial = (mapping ?? {}) as Mapping
  const [state, formAction] = useActionState<PlataformaState, FormData>(salvarMapeamentoAction, {})

  /*
   * O QUE A TELA CONSEGUE ADIVINHAR, ELA JÁ VEM PREENCHIDO.
   *
   * Ela mostrava "10 campos detectados" no cabeçalho e, logo abaixo, dezoito
   * seletores em "— não usar —" com "— não encontrado" embaixo de cada um.
   * Detectar e não usar o que detectou é a pior combinação possível: parece que
   * o sistema entendeu, e obriga a pessoa a refazer o trabalho à mão.
   *
   * O palpite NUNCA sobrescreve o que já foi salvo — ele preenche buraco. Quem
   * ajustou um campo à mão e voltou à tela encontra o ajuste dele, não o
   * chute do sistema.
   */
  const detectado = useMemo(() => detectarMapeamento(payload), [payload])

  const [eventPath, setEventPath] = useState(
    inicial.event_path ?? detectado.eventPath ?? '$.event',
  )

  const [eventMap, setEventMap] = useState<Record<string, string>>(() => {
    const salvo = inicial.event_map ?? {}
    const nome = payload ? String(getByPath(payload, inicial.event_path ?? detectado.eventPath ?? '$.event') ?? '') : ''

    // O evento que acabou de chegar entra traduzido, quando dá para reconhecê-lo.
    return nome && !(nome in salvo) && detectado.eventoCanonico
      ? { ...salvo, [nome]: detectado.eventoCanonico }
      : salvo
  })

  /*
   * Sem evento recebido não há como saber se um caminho existe — e aí o salvo
   * vale integralmente, que é o certo: quem preencheu à mão antes do primeiro
   * evento não pode perder o trabalho por falta de prova.
   */
  const existe = (caminho: string) =>
    !payload || getByPath(payload, caminho) !== undefined

  /**
   * Os nomes que já chegaram, ainda não estão no mapa, e o Mandafy sabe
   * traduzir — com a tradução junto.
   *
   * Os três filtros importam. Sem "já chegaram", a lista traria nomes de
   * plataformas que esta banca não usa. Sem "não estão no mapa", ofereceria
   * refazer o que já está feito. E sem "sabe traduzir", pediria para adivinhar
   * o destino de um nome desconhecido — que é justamente o trabalho que o
   * seletor manual ao lado existe para fazer com calma.
   */
  const faltantes = useMemo(
    () =>
      [...new Set(nomesRecebidos)]
        .filter((nome) => nome && !(nome in eventMap))
        .map((nome) => [nome, DE_FABRICA[nome]] as const)
        .filter((par): par is readonly [string, string] => Boolean(par[1])),
    [nomesRecebidos, eventMap],
  )

  const [contato, setContato] = useState<Record<string, string>>(() =>
    comPalpites(inicial.contact ?? {}, detectado.contato, existe),
  )
  const [campos, setCampos] = useState<Record<string, string>>(() =>
    comPalpites(inicial.fields ?? {}, detectado.campos, existe),
  )

  /** Quantos campos a tela preencheu sozinha, para poder dizer isso em voz alta. */
  const quantosPalpites = useMemo(() => {
    const util = (registro: Record<string, unknown>) =>
      Object.entries(registro)
        .filter(([, v]) => {
          const caminho = caminhoDe(v)
          return caminho && (!payload || getByPath(payload, caminho) !== undefined)
        })
        .map(([k]) => k)

    const salvos = new Set([...util(inicial.contact ?? {}), ...util(inicial.fields ?? {})])
    return [...Object.keys(detectado.contato), ...Object.keys(detectado.campos)].filter(
      (chave) => !salvos.has(chave),
    ).length
    // Calculado do que foi DETECTADO contra o que estava SALVO, e não do estado
    // atual: depois do primeiro ajuste manual o número pararia de fazer sentido.
  }, [detectado, inicial.contact, inicial.fields, payload])

  // Caminhos detectados no payload que a plataforma realmente enviou.
  const caminhos = useMemo(() => (payload ? listLeafPaths(payload) : []), [payload])

  /** Valor que sairia deste caminho, para conferência imediata. */
  function amostra(caminho: string): string {
    if (!payload || !caminho) return ''
    const valor = getByPath(payload, caminho)
    if (valor === undefined) return '— não encontrado'
    if (valor === null) return 'nulo'
    if (typeof valor === 'object') return JSON.stringify(valor).slice(0, 40)
    return String(valor).slice(0, 40)
  }

  const nomeDoEventoNoPayload = payload ? String(getByPath(payload, eventPath) ?? '') : ''

  const mappingFinal = useMemo(() => {
    const limpar = (obj: Record<string, string>) =>
      Object.fromEntries(Object.entries(obj).filter(([, v]) => v.trim() !== ''))

    return JSON.stringify({
      event_path: eventPath,
      event_map: eventMap,
      contact: limpar(contato),
      // `valor_cents` precisa da conversão de reais; os demais vão crus.
      fields: Object.fromEntries(
        Object.entries(limpar(campos)).map(([chave, caminho]) =>
          chave === 'valor_cents'
            ? [chave, { path: caminho, transform: 'reais_para_centavos' }]
            : [chave, caminho],
        ),
      ),
    })
  }, [eventPath, eventMap, contato, campos])

  function Seletor({
    valor,
    onChange,
    id,
  }: {
    valor: string
    onChange: (v: string) => void
    id: string
  }) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {caminhos.length > 0 ? (
          <select
            id={id}
            value={caminhos.includes(valor) ? valor : ''}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-2xs text-ink"
          >
            <option value="">— não usar —</option>
            {!caminhos.includes(valor) && valor ? (
              <option value={valor}>{valor} (não está no último evento)</option>
            ) : null}
            {caminhos.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            value={valor}
            onChange={(e) => onChange(e.target.value)}
            placeholder="$.data.campo"
            className="h-8 w-full rounded-lg border border-line bg-surface px-2 font-mono text-2xs text-ink"
          />
        )}
        {valor ? <span className="truncate text-2xs text-pending">{amostra(valor)}</span> : null}
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="mr-2 font-mono text-2xs text-pending">3</span>
          Combinar os campos
        </CardTitle>
        {payload ? (
          <Badge tone="live">{caminhos.length} campos detectados</Badge>
        ) : (
          <Badge tone="pending">sem evento ainda</Badge>
        )}
      </CardHeader>

      <CardBody className="flex flex-col gap-5">
        {!payload ? (
          <p className="text-xs text-ink-2">
            Assim que o primeiro evento chegar, os campos dele aparecem aqui em listas — você
            escolhe qual alimenta o quê, sem digitar caminho à mão. Enquanto isso, dá para preencher
            manualmente.
          </p>
        ) : quantosPalpites > 0 ? (
          /*
            Dizer que foi a tela quem preencheu, e quantos.

            Campo que aparece preenchido sem explicação é campo que ninguém
            confere — e um palpite errado passa direto para a produção. A frase
            transforma "está pronto" em "está pronto, confira".
          */
          <p className="rounded-lg border border-ok/40 px-3 py-2 text-2xs text-ok">
            {quantosPalpites} campo{quantosPalpites === 1 ? '' : 's'} preenchido
            {quantosPalpites === 1 ? '' : 's'} a partir do último evento recebido. Confira o valor
            de exemplo embaixo de cada um e ajuste o que não bater.
          </p>
        ) : null}

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="sourceId" value={sourceId} />
          <input type="hidden" name="mapping" value={mappingFinal} />

          {/* ── Qual campo diz o tipo do evento ─────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-ink-2 uppercase">
              Onde está o tipo do evento
            </h3>
            <div className="flex items-start gap-2">
              <Seletor valor={eventPath} onChange={setEventPath} id="event-path" />
            </div>
            {nomeDoEventoNoPayload ? (
              <p className="text-2xs text-ink-2">
                No último evento recebido, esse campo vale{' '}
                <code className="font-mono text-ink">{nomeDoEventoNoPayload}</code>. Diga abaixo o
                que ele significa.
              </p>
            ) : null}
          </section>

          {/* ── Tradução dos nomes de evento ────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-ink-2 uppercase">
              O que cada evento significa
            </h3>

            <div className="flex flex-col gap-1.5">
              {Object.entries(eventMap).map(([origem, destino]) => (
                <div key={origem} className="flex items-center gap-2">
                  <code className="w-44 shrink-0 truncate font-mono text-2xs text-ink">{origem}</code>
                  <span className="text-pending">→</span>
                  <select
                    value={destino}
                    onChange={(e) =>
                      setEventMap((m) => ({ ...m, [origem]: e.target.value }))
                    }
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 font-mono text-2xs text-ink"
                  >
                    {CANONICAL_EVENTS.map((ev) => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEventMap((m) => {
                        const copia = { ...m }
                        delete copia[origem]
                        return copia
                      })
                    }
                  >
                    remover
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {nomeDoEventoNoPayload && !(nomeDoEventoNoPayload in eventMap) ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setEventMap((m) => ({
                      ...m,
                      // O reconhecido, e não um chute fixo: `order.created` para um
                      // evento de cadastro seria erro pré-selecionado.
                      [nomeDoEventoNoPayload]: detectado.eventoCanonico ?? 'order.created',
                    }))
                  }
                >
                  Adicionar “{nomeDoEventoNoPayload}”
                </Button>
              ) : null}

              {/*
                TODOS os que já chegaram e ainda não estão no mapa.

                Sem isto, acrescentar o segundo evento exigia voltar ao painel da
                plataforma e dispará-lo de novo, só para que ele virasse "o
                último payload" e o botão acima aparecesse. Uma volta por evento,
                por um clique que o sistema já tinha como oferecer — ele conhece
                os nomes que chegaram e conhece a tradução de fábrica de cada um.
              */}
              {faltantes.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setEventMap((m) => ({
                      ...m,
                      ...Object.fromEntries(faltantes.map(([nome, canonico]) => [nome, canonico])),
                    }))
                  }
                >
                  Adicionar os {faltantes.length} que já chegaram
                </Button>
              ) : null}
            </div>

            {faltantes.length > 0 ? (
              <p className="text-2xs text-pending">
                {faltantes.map(([nome, canonico], i) => (
                  <span key={nome}>
                    {i > 0 ? ' · ' : ''}
                    <code className="font-mono">{nome}</code> → {canonico}
                  </span>
                ))}
              </p>
            ) : null}
          </section>

          {/* ── Quem é a pessoa ─────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-ink-2 uppercase">
              Quem é a pessoa
            </h3>
            {[
              ['external_id', 'Identificador na plataforma'],
              ['name', 'Nome'],
              ['phone', 'Telefone'],
              ['email', 'E-mail'],
              ['cpf', 'CPF'],
            ].map(([chave, rotulo]) => (
              <div key={chave} className="flex items-start gap-2">
                <label
                  htmlFor={`contato-${chave}`}
                  className="w-44 shrink-0 pt-1.5 text-2xs text-ink-2"
                >
                  {rotulo}
                </label>
                <Seletor
                  id={`contato-${chave}`}
                  valor={contato[chave!] ?? ''}
                  onChange={(v) => setContato((c) => ({ ...c, [chave!]: v }))}
                />
              </div>
            ))}
          </section>

          {/* ── Dados do pedido ─────────────────────────────────────────── */}
          <section className="flex flex-col gap-2">
            <h3 className="text-2xs font-medium tracking-wide text-ink-2 uppercase">
              Dados que aparecem nas mensagens
            </h3>
            {CAMPOS_CANONICOS.map((campo) => (
              <div key={campo.chave} className="flex items-start gap-2">
                <label
                  htmlFor={`campo-${campo.chave}`}
                  className="w-44 shrink-0 pt-1.5 text-2xs text-ink-2"
                >
                  {campo.rotulo}
                  {'dica' in campo && campo.dica ? (
                    <span className="block text-2xs text-pending">{campo.dica}</span>
                  ) : null}
                </label>
                <Seletor
                  id={`campo-${campo.chave}`}
                  valor={campos[campo.chave] ?? ''}
                  onChange={(v) => setCampos((c) => ({ ...c, [campo.chave]: v }))}
                />
              </div>
            ))}
          </section>

          {state.error ? (
            <p role="alert" className="text-2xs text-fail">
              {state.error}
            </p>
          ) : null}
          {state.ok ? <p className="text-2xs text-ok">Combinação salva.</p> : null}

          <div>
            <Salvar />
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
