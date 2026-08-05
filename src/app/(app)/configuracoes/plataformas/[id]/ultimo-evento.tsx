import { Badge } from '@/components/ui'
import type { UltimoEvento } from '../actions'

/**
 * O passo 2 mostrando O QUE chegou, e não só quando.
 *
 * A tela dizia "Último evento em 05/08/2026, 13:53:08" e parava aí. Quem
 * acabou de criar uma conta de teste na plataforma não tinha como saber se o
 * que chegou foi o cadastro, o pagamento ou outra coisa — nem se aquilo chegou
 * a virar disparo. Hora sem nome não confirma nada, e o passo 2 existe
 * justamente para confirmar.
 *
 * Três informações, nesta ordem, porque é a ordem em que a dúvida aparece:
 *
 *   1. QUAL evento chegou, com o nome que a plataforma usa.
 *   2. Se ele já foi aproveitado, ainda está na fila, ou foi recusado e por quê.
 *   3. O que veio dentro — que é o material do passo 3.
 *
 * Server Component: nada aqui reage a clique. O `<details>` é do navegador.
 */

/** Achata o payload em pares "caminho → valor" legíveis. */
function achatar(valor: unknown, prefixo = '$'): [string, string][] {
  if (valor === null || valor === undefined) return [[prefixo, '—']]

  if (Array.isArray(valor)) {
    // Só o primeiro item: listas longas viram parede de texto, e o que
    // interessa aqui é o FORMATO, não o conteúdo inteiro.
    return valor.length === 0
      ? [[prefixo, '(lista vazia)']]
      : achatar(valor[0], `${prefixo}[0]`)
  }

  if (typeof valor === 'object') {
    return Object.entries(valor as Record<string, unknown>).flatMap(([chave, dentro]) =>
      achatar(dentro, `${prefixo}.${chave}`),
    )
  }

  return [[prefixo, String(valor)]]
}

export function UltimoEventoRecebido({
  evento,
  fuso,
  sugerido,
}: {
  evento: UltimoEvento
  fuso: string
  /** O evento canônico que o Mandafy já sabe traduzir a partir deste nome. */
  sugerido: string | null
}) {
  const campos = achatar(evento.payload).filter(([caminho]) => !caminho.includes('_mandafy_'))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {evento.nome ? (
          <>
            <span className="text-xs text-ink-2">Chegou</span>
            <code className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-2xs text-ink">
              {evento.nome}
            </code>
          </>
        ) : (
          <span className="text-xs text-ink-2">Chegou um evento sem nome identificável</span>
        )}

        <span className="font-mono text-2xs text-pending">
          {evento.recebidoEm.toLocaleString('pt-BR', { timeZone: fuso })}
        </span>

        {/*
          O estado do processamento, que é o que separa "chegou" de "funcionou".
          Um evento recebido e nunca aproveitado é indistinguível de um evento
          que disparou o fluxo inteiro — a não ser que a tela diga.
        */}
        {evento.erro ? (
          <Badge tone="fail">não aproveitado</Badge>
        ) : evento.processadoEm ? (
          <Badge tone="ok">aproveitado</Badge>
        ) : (
          <Badge tone="pending">na fila</Badge>
        )}
      </div>

      {evento.erro ? (
        <p className="text-2xs text-warn">
          Chegou, mas não foi aproveitado: {evento.erro}. Ajuste a tradução no passo 3.
        </p>
      ) : null}

      {!evento.erro && !evento.processadoEm ? (
        <p className="text-2xs text-pending">
          Ainda não processado — isso leva alguns instantes. Recarregue a página.
        </p>
      ) : null}

      {/*
        A tradução, quando já existe. Sem isto a pessoa lê `novo_usuario` e não
        tem como saber que o Mandafy já entende esse nome — e vai procurar no
        passo 3 uma configuração que já está feita.
      */}
      {evento.nome ? (
        <p className="text-2xs text-ink-2">
          {sugerido ? (
            <>
              O Mandafy entende <code className="font-mono">{evento.nome}</code> como{' '}
              <code className="font-mono text-ink">{sugerido}</code> — é esse o evento que os
              fluxos escutam.
            </>
          ) : (
            <>
              O Mandafy ainda não sabe traduzir <code className="font-mono">{evento.nome}</code>.
              Diga a ele no passo 3.
            </>
          )}
        </p>
      ) : null}

      {/*
        O conteúdo fechado por padrão: ele é longo, e a pergunta que traz a
        pessoa até aqui é "chegou o quê?", não "me mostre 40 campos". Quem
        precisa combinar os campos abre.
      */}
      {campos.length > 0 ? (
        <details className="rounded-lg border border-line">
          <summary className="cursor-pointer px-3 py-2 text-2xs text-ink-2">
            Ver o que veio dentro ({campos.length} campo{campos.length === 1 ? '' : 's'})
          </summary>
          <div className="flex flex-col gap-0.5 border-t border-line px-3 py-2">
            {campos.slice(0, 60).map(([caminho, valor]) => (
              <div key={caminho} className="flex flex-wrap gap-x-2 text-2xs">
                <code className="font-mono text-pending">{caminho}</code>
                {/*
                  O valor é truncado: um PIX copia-e-cola tem centenas de
                  caracteres e empurraria o resto para fora da tela.
                */}
                <span className="min-w-0 break-all text-ink">{valor.slice(0, 120)}</span>
              </div>
            ))}
            {campos.length > 60 ? (
              <p className="mt-1 text-2xs text-pending">e mais {campos.length - 60}…</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}
