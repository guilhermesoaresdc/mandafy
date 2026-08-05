'use client'

import { useOptimistic, useTransition } from 'react'
import { ChannelPad } from '@/components/ui'
import type { Channel } from '@/db/schema/enums'
import { alternarCanalAction } from '../actions'

/**
 * O pad que liga e desliga um canal da mensagem (§11.4).
 *
 * Antes, cada pad vinha embrulhado num `<form action={...}>` com um
 * `<button type="submit">` por fora e `onChange={() => {}}` por dentro. Duas
 * consequências:
 *
 *   1. o pad não acendia no clique. O envio do formulário disparava
 *      `revalidatePath` de DUAS rotas, e a luz só mudava quando a página
 *      inteira voltasse renderizada do servidor — segundos, com o banco longe.
 *      Como o pad é o controle mais importante da tela, o sistema inteiro
 *      passava a impressão de estar travado.
 *
 *   2. um `<button>` envolvia um elemento com `role="switch"`, que já é um
 *      controle. Controle dentro de controle: o leitor de tela anuncia dois, e
 *      a tecla Espaço fica ambígua entre eles.
 *
 * Agora o pad usa a própria API que ele sempre teve. `useOptimistic` acende na
 * hora e reconcilia com o servidor; se a gravação falhar, o React desfaz —
 * o estado otimista só vive durante a transição.
 */
export function PadCanalMensagem({
  messageId,
  canal,
  ligado,
  rotulo,
  className,
}: {
  messageId: string
  canal: Channel
  ligado: boolean
  /** `""` encolhe o pad ao ícone — é a forma usada na lista de mensagens. */
  rotulo?: string
  className?: string
}) {
  const [, iniciar] = useTransition()
  const [ligadoOtimista, definirOtimista] = useOptimistic(ligado)

  function alternar(proximo: boolean) {
    iniciar(async () => {
      definirOtimista(proximo)

      const dados = new FormData()
      dados.set('id', messageId)
      dados.set('canal', canal)
      dados.set('ligar', proximo ? '1' : '0')
      await alternarCanalAction(dados)
    })
  }

  return (
    <ChannelPad
      channel={canal}
      on={ligadoOtimista}
      onChange={alternar}
      {...(rotulo !== undefined ? { label: rotulo } : {})}
      {...(className ? { className } : {})}
    />
  )
}
