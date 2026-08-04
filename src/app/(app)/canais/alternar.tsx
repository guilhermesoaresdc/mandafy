'use client'

import { useOptimistic, useTransition } from 'react'
import { Button } from '@/components/ui'
import type { Channel } from '@/db/schema/enums'
import { alternarCanalConfigAction } from './actions'

/**
 * Ligar e desligar um canal (§11.4, §13).
 *
 * Cliente por necessidade, não por comodidade. Como `<form action={...}>` puro,
 * cada clique era: requisição, validação de sessão, transação, e então
 * `revalidatePath('/canais')` — que refaz a página INTEIRA no servidor, com o
 * estado dos quatro canais e a saúde de cada número. Nada disso aparece na
 * tela enquanto acontece, então o botão fica parado e parece que não pegou.
 *
 * Com o banco longe da aplicação, isso são segundos por clique num controle
 * que só inverte um booleano.
 *
 * `useOptimistic` inverte o rótulo na hora e reconcilia quando a resposta
 * chega. Se o servidor recusar, o React desfaz sozinho — o estado otimista
 * dura só o tempo da transição, e o valor que volta é o do servidor. Não há
 * como a tela ficar mentindo que o canal está ligado.
 */
export function AlternarCanal({ canal, ativo }: { canal: Channel; ativo: boolean }) {
  const [pendente, iniciar] = useTransition()
  const [ativoOtimista, definirOtimista] = useOptimistic(ativo)

  function alternar() {
    const proximo = !ativoOtimista

    iniciar(async () => {
      definirOtimista(proximo)

      const dados = new FormData()
      dados.set('canal', canal)
      dados.set('ativar', proximo ? '1' : '0')
      await alternarCanalConfigAction(dados)
    })
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={alternar}
      /*
       * Não desabilita durante a transição: um botão que some do alcance do
       * teclado no meio do clique é pior que um clique repetido, e o servidor
       * é idempotente — mandar "ligar" duas vezes grava o mesmo valor.
       */
      aria-busy={pendente}
      aria-pressed={ativoOtimista}
    >
      {ativoOtimista ? 'Desligar' : 'Ligar'}
    </Button>
  )
}
