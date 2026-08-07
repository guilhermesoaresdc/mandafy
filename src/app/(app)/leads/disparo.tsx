'use client'

import { useMemo, useState } from 'react'
import { Button, ChannelIcon } from '@/components/ui'
import type { MensagemParaDisparo } from '@/db/queries/messages'
import { compilar, variaveisObrigatorias } from '@/lib/messages/compile'
import { MOTIVO_LABELS, type MotivoSkip } from '@/lib/delivery/guards'
import { TAMANHO_DA_LEVA } from '@/lib/delivery/lote'
import { formatNumber } from '@/lib/utils'
import { dispararLoteAction, type ResultadoDisparo } from './disparo-actions'

/**
 * Enviar uma mensagem para os leads selecionados (§5, §9.1).
 *
 * O QUE ESTA TELA PRECISA IMPEDIR
 *
 * Mandar a coisa errada para mil pessoas de uma vez. Não dá para desfazer: o
 * que saiu, saiu. Por isso a ordem é escolher → preencher → VER O TEXTO FINAL →
 * enviar, e o botão diz o número de pessoas, não "confirmar".
 *
 * A prévia é compilada aqui, no navegador, com os valores já preenchidos —
 * mesma razão do importador. Quem vai disparar precisa ler o que vai sair
 * antes de disparar, e não depois, no histórico.
 *
 * EM LEVAS, COM PROGRESSO
 *
 * A lista vai em fatias de {@link TAMANHO_DA_LEVA}. Não é capricho: uma
 * chamada só, com o banco longe, morre no meio e deixa metade enviada sem
 * dizer qual metade. Em levas, o que já saiu está contado na tela, e repetir é
 * seguro — o mesmo `loteId` faz a guarda de duplicado recusar quem já recebeu.
 */

/** Variáveis que o sistema preenche do cadastro; pedi-las seria redundante. */
const VEM_DO_CONTATO = new Set(['nome', 'telefone', 'email'])

type Alvo = { id: string; nome: string }

export function PainelDisparo({
  alvos,
  mensagens,
  aoFechar,
}: {
  alvos: Alvo[]
  mensagens: MensagemParaDisparo[]
  aoFechar: () => void
}) {
  const [messageId, setMessageId] = useState('')
  const [valores, setValores] = useState<Record<string, string>>({})
  const [enviando, setEnviando] = useState(false)
  const [feitos, setFeitos] = useState(0)
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<ResultadoDisparo | null>(null)

  const escolhida = mensagens.find((m) => m.id === messageId)

  const pendentes = useMemo(() => {
    if (!escolhida) return []
    return variaveisObrigatorias(escolhida.body).filter((v) => !VEM_DO_CONTATO.has(v))
  }, [escolhida])

  const faltando = pendentes.filter((v) => (valores[v] ?? '').trim() === '')

  /*
   * A prévia usa o primeiro selecionado como exemplo. Um nome de verdade na
   * tela é o que faz alguém notar "isso vai sair errado" — `{{nome}}` cru não
   * faz ninguém notar nada.
   */
  const previa = useMemo(() => {
    if (!escolhida) return null
    const exemplo = alvos[0]
    return compilar(escolhida.body, {
      canal: 'whatsapp',
      dados: { ...(exemplo ? { nome: exemplo.nome } : {}), ...valores },
    })
  }, [escolhida, valores, alvos])

  async function enviar() {
    if (!escolhida || faltando.length > 0) return

    setEnviando(true)
    setErro(null)

    // Um id por disparo, o mesmo em todas as levas: é a chave que impede a
    // mesma pessoa de receber duas vezes se algo for repetido.
    const loteId = crypto.randomUUID()
    const total: ResultadoDisparo = { enfileirados: 0, pulados: {}, falhas: 0 }

    for (let i = 0; i < alvos.length; i += TAMANHO_DA_LEVA) {
      const leva = alvos.slice(i, i + TAMANHO_DA_LEVA)

      let estado
      try {
        estado = await dispararLoteAction({
          leadIds: leva.map((a) => a.id),
          messageId,
          variaveis: valores,
          loteId,
        })
      } catch {
        estado = { erro: 'A conexão caiu no meio do envio.' }
      }

      if (estado.erro || !estado.resultado) {
        /*
         * Para na primeira leva que falhar, em vez de insistir. Se a causa for
         * o banco ou a rede, seguir adiante só multiplica o erro — e o que já
         * saiu continua contado abaixo, que é a informação que importa agora.
         */
        setErro(
          `${estado.erro ?? 'Falha no envio.'} ${formatNumber(total.enfileirados)} já foram enfileirados; o resto não. Pode tentar de novo — quem já recebeu não recebe de novo.`,
        )
        break
      }

      total.enfileirados += estado.resultado.enfileirados
      total.falhas += estado.resultado.falhas
      for (const [motivo, n] of Object.entries(estado.resultado.pulados)) {
        const m = motivo as MotivoSkip
        total.pulados[m] = (total.pulados[m] ?? 0) + (n ?? 0)
      }

      setFeitos(Math.min(i + TAMANHO_DA_LEVA, alvos.length))
    }

    setResultado(total)
    setEnviando(false)
  }

  // ── Depois de enviar ──────────────────────────────────────────────────────
  if (resultado) {
    const pulados = Object.entries(resultado.pulados) as [MotivoSkip, number][]

    return (
      <Moldura titulo="Disparo registrado" aoFechar={aoFechar}>
        <p className="text-xs text-ink">
          <span className="font-medium text-ok">
            {formatNumber(resultado.enfileirados)} envio(s) na fila.
          </span>{' '}
          Eles saem no ritmo do batimento, com o intervalo entre mensagens e a janela de silêncio
          de sempre — acompanhe em Histórico.
        </p>

        {pulados.length > 0 ? (
          <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
            <p className="text-2xs font-medium text-ink">Quem não recebeu, e por quê</p>
            {pulados.map(([motivo, n]) => (
              <p key={motivo} className="text-2xs text-ink-2">
                <span className="font-mono text-ink">{formatNumber(n)}</span> — {MOTIVO_LABELS[motivo]}
              </p>
            ))}
          </div>
        ) : null}

        {resultado.falhas > 0 ? (
          <p className="text-2xs text-fail">
            {formatNumber(resultado.falhas)} não puderam ser enfileirados. Veja o Histórico para o
            motivo de cada um.
          </p>
        ) : null}

        {erro ? <p className="text-2xs text-fail">{erro}</p> : null}

        <Button size="sm" onClick={aoFechar}>
          Fechar
        </Button>
      </Moldura>
    )
  }

  return (
    <Moldura titulo={`Enviar para ${formatNumber(alvos.length)} pessoa(s)`} aoFechar={aoFechar}>
      <label className="flex flex-col gap-1.5">
        <span className="text-2xs font-medium text-ink-2">Mensagem</span>
        <select
          value={messageId}
          onChange={(e) => {
            setMessageId(e.target.value)
            setValores({})
          }}
          className="h-9 rounded-lg border border-line bg-surface px-2 text-xs text-ink"
        >
          <option value="">Escolha a mensagem…</option>
          {mensagens.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      {escolhida ? (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-ink-2">Sai por</span>
            {escolhida.canaisAtivos.map((c) => (
              <ChannelIcon key={c} channel={c} className="size-3.5" />
            ))}
            {escolhida.canaisAtivos.length === 0 ? (
              <span className="text-2xs text-fail">nenhum canal ligado nesta mensagem</span>
            ) : null}
          </div>

          {pendentes.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-2xs text-ink-2">
                Esta mensagem pede valores que não estão no cadastro. O que você escrever aqui vale
                para as {formatNumber(alvos.length)} pessoas.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {pendentes.map((v) => (
                  <label key={v} className="flex flex-col gap-1">
                    <span className="font-mono text-2xs text-ink-2">{v}</span>
                    <input
                      value={valores[v] ?? ''}
                      onChange={(e) => setValores((a) => ({ ...a, [v]: e.target.value }))}
                      className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-ink outline-none focus-visible:border-ink"
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {/* O texto final, com o primeiro selecionado como exemplo. */}
          <div className="flex flex-col gap-1">
            <p className="text-2xs text-ink-2">
              Como chega{alvos[0] ? ` para ${alvos[0].nome}` : ''}
            </p>
            <div className="rounded-xl border border-line bg-surface-2 p-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink">
              {previa?.ok ? (
                previa.corpo
              ) : (
                <span className="text-fail">
                  {faltando.length > 0
                    ? `Preencha ${faltando.join(', ')} para ver como fica.`
                    : (previa?.detalhe ?? 'Não consegui montar a prévia.')}
                </span>
              )}
            </div>
          </div>
        </>
      ) : null}

      {erro ? <p className="text-2xs text-fail">{erro}</p> : null}

      <div className="flex items-center gap-3">
        <Button onClick={enviar} disabled={!escolhida || faltando.length > 0 || enviando}>
          {enviando
            ? `Enfileirando ${formatNumber(feitos)}/${formatNumber(alvos.length)}…`
            : `Enviar para ${formatNumber(alvos.length)}`}
        </Button>
        <Button variant="ghost" size="sm" onClick={aoFechar} disabled={enviando}>
          Cancelar
        </Button>
      </div>

      <p className="text-2xs text-pending">
        Quem pediu para sair, quem já bateu o limite do dia e quem não tem endereço no canal ficam
        de fora automaticamente — o relatório diz quantos e por quê.
      </p>
    </Moldura>
  )
}

function Moldura({
  titulo,
  aoFechar,
  children,
}: {
  titulo: string
  aoFechar: () => void
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-ink">{titulo}</h2>
        <button
          type="button"
          onClick={aoFechar}
          aria-label="Fechar"
          className="text-2xs text-ink-2 hover:text-ink"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  )
}
