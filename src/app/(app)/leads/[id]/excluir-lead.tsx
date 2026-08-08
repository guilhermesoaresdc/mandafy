'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Modal } from '@/components/ui'
import { excluirLeadAction, type LeadState } from '../actions'

/**
 * Excluir o lead, com a confirmação proporcional ao estrago.
 *
 * Não é um `confirm()` do navegador: a janela precisa dizer O QUE some e o que
 * fica, porque a intuição erra aqui. Some o cartão e as anotações dele; ficam a
 * pessoa, os eventos da plataforma e o histórico de mensagens — que não são do
 * lead, são do contato, e que a lei manda guardar (§14.1).
 *
 * Depois de apagar, volta para a lista: ficar numa página cujo objeto não
 * existe mais renderiza um 404 no próximo carregamento e parece defeito.
 */
export function ExcluirLead({ leadId, titulo }: { leadId: string; titulo: string }) {
  const [aberto, setAberto] = useState(false)
  const [estado, excluir, excluindo] = useActionState<LeadState, FormData>(excluirLeadAction, {})
  const router = useRouter()

  useEffect(() => {
    if (estado.ok) router.push('/leads')
  }, [estado.ok, router])

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        Excluir
      </Button>

      <Modal
        aberto={aberto}
        aoFechar={() => setAberto(false)}
        titulo="Excluir este lead?"
        descricao={titulo}
        largura="sm"
        acoes={
          <form action={excluir} className="flex w-full items-center gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <Button type="submit" size="sm" variant="danger" disabled={excluindo}>
              {excluindo ? 'Excluindo…' : 'Excluir o lead'}
            </Button>
            <Button type="button" size="sm" variant="ghost" semEspera onClick={() => setAberto(false)}>
              Cancelar
            </Button>
            {estado.erro ? (
              <span role="alert" className="text-2xs text-fail">
                {estado.erro}
              </span>
            ) : null}
          </form>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-2xs text-ink-2">
            Some o cartão do funil e as anotações feitas nele. Não tem como desfazer.
          </p>
          <p className="text-2xs text-ink-2">
            <span className="text-ink">A pessoa continua na base</span> — com os eventos da
            plataforma e o histórico de mensagens que já saíram. Para apagar o cadastro inteiro, use
            o pedido de exclusão em Configurações → Privacidade, que é o caminho da LGPD.
          </p>
          <p className="text-2xs text-pending">
            Se o negócio simplesmente não vingou, o certo é marcar como perdido: isso conta no
            relatório, excluir não.
          </p>
        </div>
      </Modal>
    </>
  )
}
