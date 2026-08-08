'use client'

import { useActionState, useEffect, useId, useState } from 'react'
import { Button, Input, Modal } from '@/components/ui'
import { formatarOffset, lerAtraso } from '@/lib/flows/schedule'
import { adicionarPassoAction, type FluxoState } from '../actions'

/**
 * Acrescenta um passo à cadência.
 *
 * Antes disto, o número de passos de um fluxo era o que o seed tivesse criado:
 * a tela deixava ajustar cada um e não deixava ter mais um. Quem quisesse um
 * quinto lembrete não tinha caminho nenhum pela interface.
 *
 * DUAS PORTAS, E A SEGUNDA É A QUE IMPORTA
 *
 * Escolher uma mensagem que já existe é o caso fácil. O que faltava mesmo era
 * "quero um passo novo com um texto novo" — e exigir que a pessoa fosse a
 * Mensagens criar antes, para depois voltar e escolher, é o vaivém que esta
 * tela existe para acabar. Sem escolher, o passo nasce com uma mensagem em
 * branco e o editor abre nela.
 */
export function AdicionarPasso({
  flowId,
  opcoes,
}: {
  flowId: string
  opcoes: { id: string; nome: string; chave: string }[]
}) {
  const [aberto, setAberto] = useState(false)
  const [atraso, setAtraso] = useState('1h')
  const [messageId, setMessageId] = useState('')
  const [estado, adicionar, adicionando] = useActionState<FluxoState, FormData>(
    adicionarPassoAction,
    {},
  )

  const atrasoId = useId()
  const msgId = useId()
  const formId = useId()

  const lido = lerAtraso(atraso)

  /*
   * Fecha sozinho quando deu certo: o passo novo já aparece na lista atrás da
   * janela, e manter a janela aberta faz parecer que não salvou — o próximo
   * clique acrescentaria um segundo passo igual.
   */
  useEffect(() => {
    if (estado.ok) setAberto(false)
  }, [estado.ok])

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setAberto(true)}>
        Acrescentar passo
      </Button>

      <Modal
        aberto={aberto}
        aoFechar={() => setAberto(false)}
        titulo="Acrescentar um passo"
        descricao="Ele entra no fim da cadência. O tempo é contado a partir do passo anterior."
        acoes={
          <>
            <Button type="submit" form={formId} size="sm" disabled={adicionando || lido === null}>
              {adicionando ? 'Acrescentando…' : 'Acrescentar'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            {estado.erro ? (
              <span role="alert" className="text-2xs text-fail">
                {estado.erro}
              </span>
            ) : null}
          </>
        }
      >
        <form id={formId} action={adicionar} className="flex flex-col gap-3">
          <input type="hidden" name="flowId" value={flowId} />

          <div className="flex flex-col gap-1.5">
            <label htmlFor={msgId} className="text-2xs text-ink-2">
              Qual mensagem sai
            </label>
            <select
              id={msgId}
              name="messageId"
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-xs text-ink"
            >
              <option value="">Criar uma mensagem em branco para este passo</option>
              {opcoes.map((opcao) => (
                <option key={opcao.id} value={opcao.id}>
                  {opcao.nome}
                </option>
              ))}
            </select>
            {messageId === '' ? (
              <p className="text-2xs text-pending">
                A mensagem nasce vazia. Escreva o texto em &ldquo;Ajustar&rdquo;, no passo, assim
                que ele aparecer.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={atrasoId} className="text-2xs text-ink-2">
              Depois do passo anterior
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={atrasoId}
                name="atraso"
                value={atraso}
                onChange={(e) => setAtraso(e.target.value)}
                maxLength={20}
                placeholder="2h"
                className="w-24 font-mono"
              />
              <span className="text-2xs text-pending">
                {lido === null ? 'não entendi' : lido === 0 ? 'imediato' : formatarOffset(lido)}
              </span>
            </div>
          </div>
        </form>
      </Modal>
    </>
  )
}
