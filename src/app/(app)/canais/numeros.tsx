import { Button } from '@/components/ui'
import type { SaudeInstancia } from '@/db/queries/channels'
import { cn } from '@/lib/utils'
import { alternarNumeroAction, desconectarNumeroAction, removerNumeroAction } from './actions'
import { AcoesNumero } from './acoes-numero'
import { ConectarNumero } from './conectar-numero'

/**
 * Os números de WhatsApp, DENTRO do cartão do WhatsApp (§7.3).
 *
 * Ficavam numa seção solta no fim da página, separados do canal a que
 * pertencem por um divisor e por três outros cartões. Quem abria a tela via o
 * WhatsApp "sem configuração" em cima e uma lista de números embaixo, sem nada
 * dizendo que uma coisa é a outra.
 *
 * O rodízio é a razão de a lista existir: com mais de um número, o envio
 * alterna entre eles, e cada um tem seu próprio teto e ritmo. Um número
 * pausado sai do rodízio sem sair da lista — é o controle que se usa quando um
 * chip começa a falhar e ainda não se quer removê-lo.
 */

const CORES_SEMAFORO = {
  verde: 'bg-ok',
  ambar: 'bg-pending',
  vermelho: 'bg-fail',
} as const

export function NumerosDeWhatsapp({
  instancias,
  servidorPronto,
}: {
  instancias: SaudeInstancia[]
  servidorPronto: boolean
}) {
  const ativos = instancias.filter((i) => i.ativa && i.status === 'conectado').length

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-2xs font-medium text-ink">
            Números {instancias.length > 0 ? `(${ativos} no rodízio)` : ''}
          </p>
          <p className="text-2xs text-ink-2">
            {instancias.length === 0
              ? 'Nenhum conectado. Sem número o WhatsApp não envia; os outros canais seguem normais.'
              : 'O envio alterna entre os ativos. Pausar tira do rodízio sem desconectar.'}
          </p>
        </div>
        <ConectarNumero servidorPronto={servidorPronto} />
      </div>

      {/*
        Um número só é o estado mais arriscado da operação: se ele cai ou é
        banido, o canal para inteiro. O aviso aparece exatamente aí, e não como
        regra geral que se lê e esquece.
      */}
      {instancias.length === 1 ? (
        <p className="text-2xs text-pending">
          Com um número só, um bloqueio para o canal inteiro. Conecte um segundo.
        </p>
      ) : null}

      {instancias.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {instancias.map((instancia) => (
            <li
              key={instancia.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line px-3 py-2"
            >
              <span
                aria-label={instancia.semaforo.texto}
                title={instancia.semaforo.texto}
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  CORES_SEMAFORO[instancia.semaforo.cor],
                  // Pausado é um estado escolhido, não uma falha. O anel o
                  // distingue de um número que caiu sozinho.
                  instancia.ativa ? '' : 'opacity-40 ring-1 ring-line',
                )}
              />

              <div className="min-w-32 flex-1">
                <p className="truncate text-2xs font-medium text-ink">
                  {instancia.name}
                  {instancia.ativa ? null : (
                    <span className="ml-1.5 text-pending">· pausado</span>
                  )}
                </p>
                <p className="truncate font-mono text-2xs text-pending">
                  {instancia.telefone ?? instancia.instanceName}
                </p>
              </div>

              <Medida rotulo="estágio" valor={instancia.estagioLabel} />
              <Medida
                rotulo="hoje"
                valor={`${instancia.enviadasHoje}/${instancia.tetoDiario}`}
                mono
              />
              <Medida rotulo="intervalo" valor={`${instancia.intervaloMinimo}s`} mono />
              <Medida
                rotulo="falha 24h"
                valor={`${(instancia.falha24h * 100).toFixed(1)}%`}
                mono
              />

              <form action={alternarNumeroAction}>
                <input type="hidden" name="id" value={instancia.id} />
                <input type="hidden" name="ativar" value={instancia.ativa ? '0' : '1'} />
                <Button type="submit" variant="ghost" size="sm">
                  {instancia.ativa ? 'Pausar' : 'Retomar'}
                </Button>
              </form>

              {instancia.status === 'conectado' ? (
                <form action={desconectarNumeroAction}>
                  <input type="hidden" name="id" value={instancia.id} />
                  <Button type="submit" variant="ghost" size="sm">
                    Desconectar
                  </Button>
                </form>
              ) : null}

              <AcoesNumero
                id={instancia.id}
                nome={instancia.name}
                gerenciada={instancia.gerenciada}
                conectado={instancia.status === 'conectado'}
                onRemover={removerNumeroAction}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Medida({ rotulo, valor, mono }: { rotulo: string; valor: string; mono?: boolean }) {
  return (
    <div className="text-2xs text-ink-2">
      <span className="text-pending">{rotulo} </span>
      <span className={mono ? 'font-mono' : undefined}>{valor}</span>
    </div>
  )
}
