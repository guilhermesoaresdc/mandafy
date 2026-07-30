'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { atenderPedidoAction, buscarTitularAction, type TitularState } from './actions'

/**
 * Busca e atendimento do pedido do titular (§14.1).
 *
 * A anonimização pede confirmação explícita, digitando. Não é fricção
 * decorativa: é irreversível, e um clique errado numa lista apagaria o nome de
 * quem não pediu nada.
 */
export function BuscarTitular() {
  const [busca, buscar, buscando] = useActionState<TitularState, FormData>(buscarTitularAction, {})
  const [acao, atender, atendendo] = useActionState<TitularState, FormData>(atenderPedidoAction, {})
  const [confirmando, setConfirmando] = useState<string | null>(null)
  const [confirmacao, setConfirmacao] = useState('')
  const campoId = useId()

  return (
    <div className="flex flex-col gap-3">
      <form action={buscar} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={campoId} className="sr-only">
            Telefone, e-mail ou nome
          </label>
          <Input
            id={campoId}
            name="termo"
            placeholder="Telefone, e-mail ou nome"
            minLength={3}
            required
          />
        </div>
        <Button type="submit" size="sm" variant="secondary" disabled={buscando}>
          {buscando ? 'Buscando…' : 'Buscar'}
        </Button>
      </form>

      {busca.erro ? (
        <p role="alert" className="text-2xs text-fail">
          {busca.erro}
        </p>
      ) : null}
      {acao.ok ? <p className="text-2xs text-ok">{acao.ok}</p> : null}
      {acao.erro ? (
        <p role="alert" className="text-2xs text-fail">
          {acao.erro}
        </p>
      ) : null}

      {busca.achados?.map((titular) => (
        <div key={titular.id} className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-ink">{titular.nome ?? 'sem nome'}</span>
            {titular.telefone ? (
              <span className="font-mono text-2xs text-ink-2">{titular.telefone}</span>
            ) : null}
            {titular.email ? (
              <span className="font-mono text-2xs text-ink-2">{titular.email}</span>
            ) : null}
            {titular.saiu ? <span className="text-2xs text-pending">já descadastrado</span> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/lgpd/exportar/${titular.id}`}
              className="rounded-lg border border-line px-2.5 py-1 text-2xs text-ink-2 hover:text-ink"
            >
              Exportar tudo (JSON)
            </a>

            {titular.saiu ? null : (
              <form action={atender}>
                <input type="hidden" name="contactId" value={titular.id} />
                <input type="hidden" name="acao" value="descadastrar" />
                <Button type="submit" variant="ghost" size="sm" disabled={atendendo}>
                  Descadastrar
                </Button>
              </form>
            )}

            {confirmando === titular.id ? (
              <form action={atender} className="flex items-center gap-2">
                <input type="hidden" name="contactId" value={titular.id} />
                <input type="hidden" name="acao" value="anonimizar" />
                <Input
                  value={confirmacao}
                  onChange={(e) => setConfirmacao(e.target.value)}
                  placeholder="digite ANONIMIZAR"
                  aria-label="Confirmação"
                  className="w-40"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={atendendo || confirmacao !== 'ANONIMIZAR'}
                >
                  Confirmar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setConfirmando(null)
                    setConfirmacao('')
                  }}
                >
                  Cancelar
                </Button>
              </form>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmando(titular.id)
                  setConfirmacao('')
                }}
              >
                Anonimizar
              </Button>
            )}
          </div>

          {confirmando === titular.id ? (
            <p className="text-2xs text-fail">
              Não dá para desfazer. Nome, telefone, e-mail e CPF somem, e o texto das mensagens
              enviadas é apagado.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
