import { Badge } from '@/components/ui'
import type { EventoRecebido } from '../actions'

/**
 * O histórico do que chegou por este webhook.
 *
 * POR QUE UM SÓ NÃO BASTAVA
 *
 * A tela mostrava o último evento, e isso responde ao passo 2 — "chegou alguma
 * coisa?". Não responde ao que vem depois. Quem liga a plataforma dispara
 * vários eventos seguidos para conferir, e cada novo apagava o anterior da
 * vista: se o cadastro funcionou e o pagamento não, a tela mostrava só o
 * pagamento, e a conclusão era "nada funciona".
 *
 * Aqui a lista vira trabalho: quais nomes a plataforma manda, quais o mapa já
 * traduz, e quais estão passando batido. É a diferença entre um susto e uma
 * lista do que falta ajustar no passo 3.
 *
 * Server Component: nada aqui reage a clique.
 */

/** Os nomes que caíram fora do mapa, com quantas vezes cada um chegou. */
function naoTraduzidos(eventos: EventoRecebido[]): Map<string, number> {
  const contagem = new Map<string, number>()

  for (const evento of eventos) {
    // Só `evento_nao_mapeado`: um erro de outro tipo — payload torto, campo
    // ausente — se conserta noutro lugar, e misturá-los daria uma lista em que
    // nenhum item tem a mesma correção.
    if (!evento.erro?.includes('evento_nao_mapeado') || !evento.nome) continue
    contagem.set(evento.nome, (contagem.get(evento.nome) ?? 0) + 1)
  }

  return contagem
}

export function EventosRecebidos({
  eventos,
  fuso,
}: {
  eventos: EventoRecebido[]
  fuso: string
}) {
  if (eventos.length === 0) return null

  const faltando = naoTraduzidos(eventos)

  return (
    <div className="flex flex-col gap-3">
      {/*
        A lista do que falta traduzir vem ANTES da lista de eventos, e não
        depois: ela é a conclusão, e quem chega aqui está procurando o que
        fazer, não o que aconteceu.
      */}
      {faltando.size > 0 ? (
        <div className="rounded-lg border border-warn/40 px-3 py-2">
          <p className="text-2xs text-warn">
            {faltando.size === 1
              ? 'Um nome de evento está chegando e não é traduzido:'
              : `${faltando.size} nomes de evento estão chegando e não são traduzidos:`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {[...faltando.entries()].map(([nome, vezes]) => (
              <li key={nome} className="text-2xs text-ink-2">
                <code className="font-mono text-ink">{nome}</code>
                {vezes > 1 ? ` · ${vezes} vezes` : null}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-2xs text-ink-2">
            Acrescente cada um no passo 3, em &ldquo;Quando chegar&rdquo;. Enquanto não estiverem
            lá, esses eventos chegam e não disparam fluxo nenhum.
          </p>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-line">
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-3 py-1.5">
          <span className="text-2xs text-ink-2">O que já chegou aqui</span>
          <span className="font-mono text-2xs text-pending">
            {eventos.length === 1 ? '1 evento' : `${eventos.length} eventos`}
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto">
          {eventos.map((evento) => (
            <div
              key={evento.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/50 px-3 py-1.5 last:border-b-0"
            >
              <span className="w-32 shrink-0 font-mono text-2xs whitespace-nowrap text-pending tabular-nums">
                {evento.recebidoEm.toLocaleString('pt-BR', {
                  timeZone: fuso,
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>

              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink">
                {evento.nome ?? 'sem nome'}
              </code>

              {evento.erro ? (
                <Badge tone="fail">não aproveitado</Badge>
              ) : evento.processadoEm ? (
                <Badge tone="ok">aproveitado</Badge>
              ) : (
                <Badge tone="pending">na fila</Badge>
              )}

              {/*
                O motivo na própria linha, truncado. Sem ele a lista diria só
                "não aproveitado" e a pessoa teria de abrir cada um para
                descobrir que são todos o mesmo problema.
              */}
              {evento.erro ? (
                <span className="w-full truncate text-2xs text-warn" title={evento.erro}>
                  {evento.erro}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
