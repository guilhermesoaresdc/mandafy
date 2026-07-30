'use client'

import { useActionState, useEffect, useState } from 'react'
import { Badge, Button, Separator } from '@/components/ui'
import { CHANNEL_LABELS, NOTIFICATION_STATUS_LABELS } from '@/db/schema/enums'
import type { DetalheNotificacao } from '@/db/queries/historico'
import { carregarDetalhe, reenviarAction, type ReenvioState } from './actions'

/**
 * Detalhe de um envio (§10.1).
 *
 * "Corpo exato enviado, tentativas, resposta crua do provedor, latência, qual
 * instância enviou". É a tela que responde "o que exatamente essa pessoa
 * recebeu?" — e por isso mostra `rendered_body` cru, sem reprocessar nada.
 */

function Linha({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="shrink-0 text-2xs text-pending">{rotulo}</span>
      <span className="truncate font-mono text-2xs text-ink-2">{valor}</span>
    </div>
  )
}

function instante(valor: Date | string | null): string | null {
  if (!valor) return null
  return new Date(valor).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

export function DetalheEnvio({
  id,
  createdAt,
  podeReenviar,
  onFechar,
}: {
  id: string
  createdAt: string
  podeReenviar: boolean
  onFechar: () => void
}) {
  const [detalhe, setDetalhe] = useState<DetalheNotificacao | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [reenvio, reenviar, reenviando] = useActionState<ReenvioState, FormData>(
    reenviarAction,
    {},
  )

  useEffect(() => {
    let ativo = true
    void carregarDetalhe(id, createdAt).then((r) => {
      if (!ativo) return
      if (r.erro) setErro(r.erro)
      else setDetalhe(r.detalhe ?? null)
    })
    return () => {
      ativo = false
    }
  }, [id, createdAt])

  // Esc fecha: quem está caçando uma linha no log abre e fecha dezenas.
  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      if (e.key === 'Escape') onFechar()
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [onFechar])

  const falhou = detalhe && ['failed', 'dead', 'skipped'].includes(detalhe.status)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Detalhe do envio"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
      onClick={onFechar}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-line bg-surface p-4 sm:rounded-xl"
      >
        {erro ? (
          <p className="text-2xs text-fail">{erro}</p>
        ) : !detalhe ? (
          <p className="text-2xs text-pending">Carregando…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-ink">
                  {detalhe.contactName ?? 'Contato removido'}
                </p>
                <p className="font-mono text-2xs text-pending">
                  {CHANNEL_LABELS[detalhe.channel]} · {detalhe.messageKey ?? 'sem mensagem'}
                </p>
              </div>
              <Badge
                tone={
                  ['sent', 'delivered', 'read'].includes(detalhe.status)
                    ? 'ok'
                    : ['failed', 'dead'].includes(detalhe.status)
                      ? 'fail'
                      : 'pending'
                }
              >
                {NOTIFICATION_STATUS_LABELS[detalhe.status]}
              </Badge>
            </div>

            {/* O que a pessoa recebeu, exatamente (§6.5). */}
            {detalhe.renderedSubject ? (
              <p className="text-2xs text-ink-2">
                <span className="text-pending">Assunto: </span>
                {detalhe.renderedSubject}
              </p>
            ) : null}

            {detalhe.renderedBody ? (
              <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-2xs whitespace-pre-wrap text-ink">
                {detalhe.renderedBody}
              </pre>
            ) : (
              <p className="text-2xs text-pending">Não chegou a ser compilado.</p>
            )}

            {detalhe.errorMessage || detalhe.errorCode ? (
              <div className="rounded-lg border border-fail/40 p-2">
                <p className="text-2xs text-fail">
                  {detalhe.errorCode}
                  {detalhe.errorMessage ? `: ${detalhe.errorMessage}` : ''}
                </p>
              </div>
            ) : null}

            <Separator />

            <div className="divide-y divide-line">
              <Linha rotulo="Criado" valor={instante(detalhe.createdAt)} />
              <Linha rotulo="Agendado para" valor={instante(detalhe.scheduledFor)} />
              <Linha rotulo="Tentado" valor={instante(detalhe.attemptedAt)} />
              <Linha rotulo="Enviado" valor={instante(detalhe.sentAt)} />
              <Linha rotulo="Entregue" valor={instante(detalhe.deliveredAt)} />
              <Linha rotulo="Lido" valor={instante(detalhe.readAt)} />
              <Linha
                rotulo="Latência"
                valor={
                  detalhe.latenciaMs === null ? null : `${(detalhe.latenciaMs / 1000).toFixed(2)}s`
                }
              />
              <Linha rotulo="Tentativas" valor={String(detalhe.attempts)} />
              <Linha rotulo="Provedor" valor={detalhe.provider} />
              <Linha rotulo="Id no provedor" valor={detalhe.providerMessageId} />
              <Linha rotulo="Enviado pelo número" valor={detalhe.providerInstance} />
              <Linha rotulo="Chave de cancelamento" valor={detalhe.cancelKey} />
            </div>

            <div className="flex items-center gap-2">
              {falhou && podeReenviar ? (
                <form action={reenviar}>
                  <input type="hidden" name="id" value={detalhe.id} />
                  <input
                    type="hidden"
                    name="createdAt"
                    value={new Date(detalhe.createdAt).toISOString()}
                  />
                  <Button type="submit" size="sm" variant="secondary" disabled={reenviando}>
                    {reenviando ? 'Reenviando…' : 'Reenviar'}
                  </Button>
                </form>
              ) : null}

              <Button variant="ghost" size="sm" onClick={onFechar}>
                Fechar
              </Button>

              {reenvio.ok ? <span className="text-2xs text-ok">{reenvio.ok}</span> : null}
              {reenvio.erro ? <span className="text-2xs text-fail">{reenvio.erro}</span> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
