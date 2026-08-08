import { cn } from '@/lib/utils'

/**
 * Os gráficos do painel — SVG puro, renderizado no servidor.
 *
 * POR QUE ESCRITOS À MÃO
 *
 * A pilha é fixa (§0) e nenhuma biblioteca de gráfico faz parte dela. Trazer
 * uma custaria de 40 a 100 kB de JavaScript no cliente e transformaria o painel
 * — hoje um Server Component — num componente de cliente, o que §13.2 não
 * autoriza. Rosca, área e funil são três caminhos de SVG; a biblioteca
 * resolveria o que aqui são vinte linhas, e cobraria o orçamento de performance
 * inteiro por isso.
 *
 * Nenhum destes componentes leva `"use client"`: são funções que devolvem SVG a
 * partir dos números, sem estado nem evento. O que se ganha em interatividade
 * fica no `<title>` de cada fatia, que o navegador mostra ao passar o mouse.
 *
 * REGRA DE HONESTIDADE (§10.3): sem dado, o gráfico DIZ que não há dado. Uma
 * rosca vazia desenhada como um anel cinza é indistinguível de "tudo em uma
 * categoria só", e é assim que um painel passa a mentir sem ninguém notar.
 */

export type Fatia = { rotulo: string; valor: number; cor: string }

/** Vazio é uma frase, nunca um desenho de zero. */
function SemDado({ texto }: { texto: string }) {
  return <p className="py-6 text-center text-2xs text-pending">{texto}</p>
}

// ── Rosca ────────────────────────────────────────────────────────────────────

/**
 * A divisão de um total entre poucas categorias.
 *
 * Rosca e não pizza: o furo do meio é onde cabe o total, e é ele que dá a
 * escala. "60% WhatsApp" sobre 5 envios e sobre 5 mil são a mesma pizza e
 * decisões diferentes.
 */
export function Rosca({
  fatias,
  total,
  rotuloTotal,
  vazio = 'Nada ainda.',
  tamanho = 132,
}: {
  fatias: Fatia[]
  /** O número do meio. Por padrão, a soma das fatias. */
  total?: number
  rotuloTotal?: string
  vazio?: string
  tamanho?: number
}) {
  const comValor = fatias.filter((f) => f.valor > 0)
  const soma = comValor.reduce((s, f) => s + f.valor, 0)

  if (soma === 0) return <SemDado texto={vazio} />

  const raio = tamanho / 2 - 10
  const circunferencia = 2 * Math.PI * raio
  let percorrido = 0

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative shrink-0" style={{ width: tamanho, height: tamanho }}>
        <svg
          width={tamanho}
          height={tamanho}
          viewBox={`0 0 ${tamanho} ${tamanho}`}
          role="img"
          aria-label={comValor.map((f) => `${f.rotulo}: ${f.valor}`).join(', ')}
        >
          {/* -90° para a primeira fatia começar no topo, como todo mundo espera. */}
          <g transform={`rotate(-90 ${tamanho / 2} ${tamanho / 2})`}>
            {comValor.map((fatia) => {
              const fracao = fatia.valor / soma
              const traco = fracao * circunferencia
              const deslocamento = -percorrido * circunferencia
              percorrido += fracao

              return (
                <circle
                  key={fatia.rotulo}
                  cx={tamanho / 2}
                  cy={tamanho / 2}
                  r={raio}
                  fill="none"
                  stroke={fatia.cor}
                  strokeWidth={14}
                  // Um traço do tamanho da fatia e um vão do tamanho do resto:
                  // é o jeito de fatiar um círculo sem calcular arco à mão.
                  strokeDasharray={`${traco} ${circunferencia - traco}`}
                  strokeDashoffset={deslocamento}
                >
                  <title>{`${fatia.rotulo}: ${fatia.valor} (${Math.round(fracao * 100)}%)`}</title>
                </circle>
              )
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-sm text-ink tabular-nums">
            {(total ?? soma).toLocaleString('pt-BR')}
          </span>
          {rotuloTotal ? <span className="text-2xs text-pending">{rotuloTotal}</span> : null}
        </div>
      </div>

      <ul className="flex min-w-28 flex-1 flex-col gap-1">
        {comValor.map((fatia) => (
          <li key={fatia.rotulo} className="flex items-center gap-2 text-2xs">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: fatia.cor }}
            />
            <span className="min-w-0 flex-1 truncate text-ink-2">{fatia.rotulo}</span>
            <span className="font-mono text-pending tabular-nums">
              {Math.round((fatia.valor / soma) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Evolução ─────────────────────────────────────────────────────────────────

export type PontoSerie = { rotulo: string; valor: number }

/**
 * A subida (ou a queda) ao longo dos dias.
 *
 * Área e não barras: o que se lê aqui é tendência, não comparação de um dia
 * com outro. O último ponto ganha um círculo porque "onde estamos hoje" é a
 * única leitura pontual que interessa numa curva de tendência.
 */
export function Evolucao({
  serie,
  cor = 'var(--color-live)',
  formatar = (v: number) => v.toLocaleString('pt-BR'),
  altura = 96,
  vazio = 'Sem histórico ainda.',
}: {
  serie: PontoSerie[]
  cor?: string
  formatar?: (valor: number) => string
  altura?: number
  vazio?: string
}) {
  if (serie.length < 2 || serie.every((p) => p.valor === 0)) return <SemDado texto={vazio} />

  const largura = 320
  const teto = Math.max(...serie.map((p) => p.valor))
  const passo = largura / (serie.length - 1)

  // Teto + 15% de folga: uma curva encostada na borda de cima parece cortada, e
  // o pico do período é justamente o que se quer enxergar inteiro.
  const escala = (valor: number) => altura - (valor / (teto * 1.15 || 1)) * altura

  const pontos = serie.map((p, i) => [i * passo, escala(p.valor)] as const)
  const linha = pontos.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${linha} L${largura},${altura} L0,${altura} Z`
  const ultimo = pontos[pontos.length - 1]!
  const idGradiente = `grad-${cor.replace(/[^a-z]/gi, '')}`

  return (
    <div className="flex flex-col gap-1">
      <svg
        viewBox={`0 0 ${largura} ${altura}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={serie.map((p) => `${p.rotulo}: ${formatar(p.valor)}`).join(', ')}
      >
        <defs>
          <linearGradient id={idGradiente} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={cor} stopOpacity="0.25" />
            <stop offset="100%" stopColor={cor} stopOpacity="0" />
          </linearGradient>
        </defs>

        <path d={area} fill={`url(#${idGradiente})`} />
        <path
          d={linha}
          fill="none"
          stroke={cor}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {/*
          As áreas de toque ficam por cima da curva inteira, uma por ponto: sem
          elas o `<title>` só apareceria em cima da linha de 2px.
        */}
        {serie.map((ponto, i) => (
          <rect
            key={ponto.rotulo}
            x={i * passo - passo / 2}
            y={0}
            width={passo}
            height={altura}
            fill="transparent"
          >
            <title>{`${ponto.rotulo}: ${formatar(ponto.valor)}`}</title>
          </rect>
        ))}

        <circle cx={ultimo[0]} cy={ultimo[1]} r="3" fill={cor} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="flex justify-between text-2xs text-pending">
        <span>{serie[0]?.rotulo}</span>
        <span className="font-mono text-ink-2">{formatar(serie[serie.length - 1]?.valor ?? 0)}</span>
        <span>{serie[serie.length - 1]?.rotulo}</span>
      </div>
    </div>
  )
}

// ── Funil ────────────────────────────────────────────────────────────────────

export type EtapaFunil = { rotulo: string; valor: number; ajuda?: string }

/**
 * Quantos sobram a cada passo.
 *
 * A barra é proporcional ao PRIMEIRO degrau, não ao maior — é o que faz a queda
 * ser visível. E a porcentagem mostrada é a do degrau ANTERIOR, porque a
 * pergunta operacional é "onde estou perdendo", e não "quanto sobrou do topo".
 */
export function Funil({
  etapas,
  formatar = (v: number) => v.toLocaleString('pt-BR'),
  vazio = 'Sem movimento no período.',
}: {
  etapas: EtapaFunil[]
  formatar?: (valor: number) => string
  vazio?: string
}) {
  const topo = etapas[0]?.valor ?? 0
  if (etapas.length === 0 || topo === 0) return <SemDado texto={vazio} />

  return (
    <ol className="flex flex-col gap-2">
      {etapas.map((etapa, i) => {
        const anterior = etapas[i - 1]?.valor
        const proporcao = Math.max(etapa.valor / topo, 0.02)
        const conversao =
          anterior === undefined || anterior === 0 ? null : etapa.valor / anterior

        return (
          <li key={etapa.rotulo} className="flex flex-col gap-1" title={etapa.ajuda}>
            <div className="flex items-baseline justify-between gap-2 text-2xs">
              <span className="min-w-0 truncate text-ink-2">{etapa.rotulo}</span>
              <span className="shrink-0 font-mono text-ink tabular-nums">
                {formatar(etapa.valor)}
                {conversao === null ? null : (
                  <span
                    className={cn(
                      'ml-1.5',
                      conversao >= 0.5 ? 'text-ok' : conversao >= 0.2 ? 'text-warn' : 'text-fail',
                    )}
                  >
                    {Math.round(conversao * 100)}%
                  </span>
                )}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-live"
                style={{ width: `${(proporcao * 100).toFixed(1)}%`, opacity: 1 - i * 0.13 }}
              />
            </div>
          </li>
        )
      })}
    </ol>
  )
}
