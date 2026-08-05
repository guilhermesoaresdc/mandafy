'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { formatarOffset, lerAtraso, lerHorario } from '@/lib/flows/schedule'
import { salvarPassoAction, type FluxoState } from '../actions'

/**
 * Ajusta um passo: QUAL mensagem sai, QUANTO tempo depois e A QUE HORAS.
 *
 * As três coisas num formulário só porque são a mesma decisão. Enquanto só o
 * tempo era editável, trocar a mensagem de um passo não tinha caminho nenhum
 * pela tela — a única saída era editar o texto da mensagem em si, o que muda
 * ela em TODOS os fluxos que a usam. Quem quisesse só experimentar outro texto
 * neste passo não tinha como.
 *
 * Atenção ao que os dois números querem dizer: o campo de tempo é RELATIVO ao
 * passo anterior, e a lista mostra o acumulado desde o gatilho. São diferentes
 * de propósito, e o rótulo do campo diz qual é qual.
 */
export function EditarPasso({
  flowId,
  stepId,
  delaySeconds,
  sendAtLocal,
  messageId,
  position,
  opcoes,
}: {
  flowId: string
  stepId: string
  delaySeconds: number
  sendAtLocal: string | null
  messageId: string
  position: number
  opcoes: { id: string; nome: string; chave: string }[]
}) {
  const [aberto, setAberto] = useState(false)
  const [texto, setTexto] = useState(() => (delaySeconds === 0 ? '0' : formatarOffset(delaySeconds).replace('+', '').replace(/\s/g, '')))
  const [hora, setHora] = useState(sendAtLocal ?? '')
  const [estado, salvar, salvando] = useActionState<FluxoState, FormData>(salvarPassoAction, {})
  const campoId = useId()
  const horaId = useId()
  const msgId = useId()

  if (!aberto) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        Ajustar
      </Button>
    )
  }

  const lido = lerAtraso(texto)
  // Campo vazio é "sem hora marcada", que é válido — e diferente de hora que
  // não dá para entender, que precisa travar o salvar.
  const horaOk = hora.trim() === '' || lerHorario(hora) !== null

  return (
    <form action={salvar} className="flex w-full flex-col gap-3 border-t border-line pt-3">
      <input type="hidden" name="flowId" value={flowId} />
      <input type="hidden" name="stepId" value={stepId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor={msgId} className="text-2xs text-ink-2">
          Qual mensagem sai
        </label>
        <select
          id={msgId}
          name="messageId"
          defaultValue={messageId}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-xs text-ink"
        >
          {/*
            A mensagem atual entra na lista mesmo se estiver pausada: ela é a
            que está gravada, e sumir do seletor faria o `defaultValue` não
            casar com opção nenhuma — o navegador escolheria a primeira, e um
            "Salvar" pensando em mexer só na hora trocaria a mensagem do passo.
          */}
          {(opcoes.some((o) => o.id === messageId)
            ? opcoes
            : [{ id: messageId, nome: '(a mensagem atual, pausada)', chave: '' }, ...opcoes]
          ).map((opcao) => (
            <option key={opcao.id} value={opcao.id}>
              {opcao.nome}
              {opcao.chave ? ` · ${opcao.chave}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={campoId} className="text-2xs text-ink-2">
            {position === 1 ? 'Depois do gatilho' : 'Depois do passo anterior'}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={campoId}
              name="atraso"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              maxLength={20}
              placeholder="5min"
              className="w-24 font-mono"
            />
            <span className="text-2xs text-pending">
              {lido === null ? 'não entendi' : lido === 0 ? 'imediato' : formatarOffset(lido)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={horaId} className="text-2xs text-ink-2">
            Nesse dia, às
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={horaId}
              name="hora"
              value={hora}
              onChange={(e) => setHora(e.target.value)}
              maxLength={5}
              placeholder="10:00"
              className="w-20 font-mono"
            />
            <span className="text-2xs text-pending">
              {hora.trim() === ''
                ? 'na hora que cair'
                : horaOk
                  ? 'horário de Brasília'
                  : 'não entendi'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="secondary" disabled={salvando || lido === null || !horaOk}>
            {salvando ? 'Salvando…' : 'Salvar'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
            Cancelar
          </Button>
        </div>
      </div>

      {/*
        A explicação do campo de hora fica aqui e não em `title`: sem ela, "+2
        dias às 10:00" parece que pode adiantar o envio, e a regra é o contrário
        — o horário só empurra para a frente, nunca para trás.
      */}
      <p className="text-2xs text-pending">
        Sem horário, o passo sai no instante que a conta der. Com horário, ele espera até a próxima
        vez que der essa hora — nunca sai antes. Deixe em branco na recuperação de PIX: um lembrete
        de 5 minutos adiado para as 10h não é um lembrete.
      </p>

      {estado.erro ? (
        <span role="alert" className="text-2xs text-fail">
          {estado.erro}
        </span>
      ) : null}
    </form>
  )
}
