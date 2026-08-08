'use client'

import { useActionState, useId, useRef, useState } from 'react'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { SeletorDeVariaveis, inserirNoCursor } from '@/components/mensagens/variaveis'
import { variaveisDoCorpo } from '@/lib/messages/compile'
import { formatarOffset, lerAtraso, lerHorario } from '@/lib/flows/schedule'
import {
  removerPassoAction,
  salvarPassoAction,
  salvarTextoDoPassoAction,
  type FluxoState,
} from '../actions'

/**
 * O passo inteiro numa janela só: quando sai, qual mensagem, o que ela diz.
 *
 * O QUE ERA PRECISO FAZER ANTES PARA MUDAR UMA PALAVRA
 *
 * Abrir o fluxo, ler o passo, clicar em "Ajustar", ver que ali só dava para
 * mexer no tempo, sair para Mensagens, achar a mensagem certa pelo nome, editar,
 * salvar, voltar para o fluxo e conferir. Por passo. Montar uma cadência de
 * quatro mensagens era esse vaivém quatro vezes — e no meio dele a pessoa perde
 * de vista justamente o que estava montando: como os quatro textos conversam
 * entre si.
 *
 * Agora tudo abre aqui: tempo, hora, qual mensagem, o TEXTO dela, e o botão de
 * tirar o passo da cadência.
 *
 * O TEXTO É O DA MENSAGEM, NÃO UMA CÓPIA DO PASSO
 *
 * Não existe "texto deste passo" no banco — um passo aponta para uma mensagem
 * (§5.2). Editar aqui é editar a mensagem, e portanto aparece em Mensagens e em
 * todo fluxo que a use. Esconder isso seria a pior escolha possível: a pessoa
 * ajustaria o lembrete de PIX de um fluxo e mudaria o de outro sem saber. Por
 * isso a janela DIZ quando a mensagem é usada em mais lugares, antes de salvar.
 *
 * Dois formulários, e não um: o texto é salvo por uma ação e o agendamento por
 * outra. São escritas em tabelas diferentes (`messages` e `flow_steps`) e com
 * permissões diferentes — quem pode montar cadência não necessariamente pode
 * reescrever o texto que sai para o cliente.
 */
export function EditarPasso({
  flowId,
  stepId,
  delaySeconds,
  sendAtLocal,
  messageId,
  messageName,
  messageBody,
  usadaEmOutrosPassos,
  position,
  opcoes,
}: {
  flowId: string
  stepId: string
  delaySeconds: number
  sendAtLocal: string | null
  messageId: string
  messageName: string
  messageBody: string
  usadaEmOutrosPassos: number
  position: number
  opcoes: { id: string; nome: string; chave: string }[]
}) {
  const [aberto, setAberto] = useState(false)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        Ajustar
      </Button>

      {/*
        O conteúdo só é montado com a janela aberta, e isso importa: uma cadência
        de seis passos manteria seis editores de texto e seis seletores de
        variável vivos na página, todos com estado próprio, para nada.
      */}
      {aberto ? (
        <CorpoDaJanela
          flowId={flowId}
          stepId={stepId}
          delaySeconds={delaySeconds}
          sendAtLocal={sendAtLocal}
          messageId={messageId}
          messageName={messageName}
          messageBody={messageBody}
          usadaEmOutrosPassos={usadaEmOutrosPassos}
          position={position}
          opcoes={opcoes}
          aoFechar={() => setAberto(false)}
        />
      ) : null}
    </>
  )
}

function CorpoDaJanela({
  flowId,
  stepId,
  delaySeconds,
  sendAtLocal,
  messageId,
  messageName,
  messageBody,
  usadaEmOutrosPassos,
  position,
  opcoes,
  aoFechar,
}: {
  flowId: string
  stepId: string
  delaySeconds: number
  sendAtLocal: string | null
  messageId: string
  messageName: string
  messageBody: string
  usadaEmOutrosPassos: number
  position: number
  opcoes: { id: string; nome: string; chave: string }[]
  aoFechar: () => void
}) {
  /*
   * O texto do campo é uma APROXIMAÇÃO do número gravado, e por isso ele não
   * pode ser a fonte do que se salva.
   *
   * `formatarOffset(5700)` devolve "1.6 h", e `lerAtraso("1.6h")` devolve 5760.
   * Abrir um passo de 1h35 e salvar sem tocar em nada o transformava em 1h36 —
   * e de novo no próximo salvamento. A cadência derivava sozinha, um minuto por
   * visita, sem ninguém ter editado nada.
   *
   * `mexeuNoTempo` separa "o campo tem um texto" de "a pessoa mudou o tempo".
   * Enquanto ela não mudar, vale o número exato que está no banco.
   */
  const [texto, setTexto] = useState(() =>
    delaySeconds === 0 ? '0' : formatarOffset(delaySeconds).replace('+', '').replace(/\s/g, ''),
  )
  const [mexeuNoTempo, setMexeuNoTempo] = useState(false)
  const [hora, setHora] = useState(sendAtLocal ?? '')
  const [corpo, setCorpo] = useState(messageBody)
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false)

  const [estado, salvar, salvando] = useActionState<FluxoState, FormData>(salvarPassoAction, {})
  const [estadoTexto, salvarTexto, salvandoTexto] = useActionState<FluxoState, FormData>(
    salvarTextoDoPassoAction,
    {},
  )
  const [estadoRemocao, remover, removendo] = useActionState<FluxoState, FormData>(
    removerPassoAction,
    {},
  )

  const campoRef = useRef<HTMLTextAreaElement | null>(null)
  const campoId = useId()
  const horaId = useId()
  const msgId = useId()
  const corpoId = useId()

  const lido = lerAtraso(texto)
  // Campo vazio é "sem hora marcada", que é válido — e diferente de hora que
  // não dá para entender, que precisa travar o salvar.
  const horaOk = hora.trim() === '' || lerHorario(hora) !== null
  const textoAlterado = corpo !== messageBody

  /** Insere a variável onde o cursor parou e devolve o foco ao texto. */
  function inserir(trecho: string): void {
    const { proximo, cursor } = inserirNoCursor(campoRef.current, trecho, corpo)
    setCorpo(proximo)

    requestAnimationFrame(() => {
      const campo = campoRef.current
      if (!campo) return
      campo.focus()
      campo.setSelectionRange(cursor, cursor)
    })
  }

  return (
    <Modal
      aberto
      aoFechar={aoFechar}
      titulo={`Passo ${position} — ${messageName}`}
      descricao="O tempo é contado a partir do passo anterior; o texto é o da mensagem."
      largura="lg"
      acoes={
        <>
          <Button
            type="submit"
            form={`${corpoId}-agenda`}
            size="sm"
            disabled={salvando || lido === null || !horaOk}
          >
            {salvando ? 'Salvando…' : 'Salvar quando sai'}
          </Button>

          <Button
            type="submit"
            form={`${corpoId}-texto`}
            size="sm"
            variant="secondary"
            disabled={salvandoTexto || !textoAlterado}
          >
            {salvandoTexto ? 'Salvando…' : 'Salvar o texto'}
          </Button>

          <div className="ml-auto flex items-center gap-2">
            {estado.erro || estadoTexto.erro || estadoRemocao.erro ? (
              <span role="alert" className="text-2xs text-fail">
                {estado.erro ?? estadoTexto.erro ?? estadoRemocao.erro}
              </span>
            ) : null}
            {estado.ok || estadoTexto.ok ? <span className="text-2xs text-ok">Salvo.</span> : null}

            {confirmandoRemocao ? (
              <form action={remover} className="flex items-center gap-2">
                <input type="hidden" name="flowId" value={flowId} />
                <input type="hidden" name="stepId" value={stepId} />
                <span className="text-2xs text-ink-2">Tirar da cadência?</span>
                <Button type="submit" size="sm" variant="danger" disabled={removendo}>
                  {removendo ? 'Tirando…' : 'Tirar'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  semEspera
                  onClick={() => setConfirmandoRemocao(false)}
                >
                  Não
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmandoRemocao(true)}
              >
                Remover passo
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ── Quando sai ── */}
        <form id={`${corpoId}-agenda`} action={salvar} className="flex flex-col gap-3">
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
                : [{ id: messageId, nome: `${messageName} (pausada)`, chave: '' }, ...opcoes]
              ).map((opcao) => (
                <option key={opcao.id} value={opcao.id}>
                  {opcao.nome}
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
                {/*
                  O número exato vai escondido enquanto ninguém editar o campo;
                  a partir da primeira tecla, quem manda é o texto.
                */}
                {mexeuNoTempo ? null : (
                  <input type="hidden" name="atrasoSegundos" value={delaySeconds} />
                )}
                <Input
                  id={campoId}
                  name="atraso"
                  value={texto}
                  onChange={(e) => {
                    setMexeuNoTempo(true)
                    setTexto(e.target.value)
                  }}
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
          </div>

          {/*
            A explicação do campo de hora fica aqui e não em `title`: sem ela, "+2
            dias às 10:00" parece que pode adiantar o envio, e a regra é o contrário
            — o horário só empurra para a frente, nunca para trás.
          */}
          <p className="text-2xs text-pending">
            Sem horário, o passo sai no instante que a conta der. Com horário, ele espera até a
            próxima vez que der essa hora — nunca sai antes. Deixe em branco na recuperação de PIX:
            um lembrete de 5 minutos adiado para as 10h não é um lembrete.
          </p>
        </form>

        {/* ── O que ela diz ── */}
        <form
          id={`${corpoId}-texto`}
          action={salvarTexto}
          className="flex flex-col gap-2 border-t border-line pt-4"
        >
          <input type="hidden" name="flowId" value={flowId} />
          <input type="hidden" name="messageId" value={messageId} />
          <input type="hidden" name="corpo" value={corpo} />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={`${corpoId}-campo`} className="text-2xs text-ink-2">
              O texto que sai
            </label>
            {usadaEmOutrosPassos > 0 ? (
              <Badge tone="warn">
                usada em mais {usadaEmOutrosPassos}{' '}
                {usadaEmOutrosPassos === 1 ? 'passo' : 'passos'}
              </Badge>
            ) : null}
          </div>

          {usadaEmOutrosPassos > 0 ? (
            <p className="text-2xs text-pending">
              Editar aqui muda a mensagem para todos eles — é a mesma mensagem, não uma cópia. Para
              um texto só deste passo, escolha outra mensagem no seletor acima.
            </p>
          ) : null}

          <textarea
            id={`${corpoId}-campo`}
            ref={campoRef}
            value={corpo}
            onChange={(e) => setCorpo(e.target.value)}
            rows={7}
            spellCheck
            placeholder="Oi {{nome}}! …"
            className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none placeholder:text-pending focus-visible:border-ink"
          />

          {corpo.trim() === '' ? (
            <p className="text-2xs text-warn">
              Em branco, este passo não envia nada — ele entra na fila e falha na hora de compilar.
            </p>
          ) : null}
        </form>

        {/* ── Os campos que dá para usar ── */}
        <div className="border-t border-line pt-4">
          <p className="mb-2 text-2xs font-medium text-ink-2">Campos disponíveis</p>
          <SeletorDeVariaveis aoInserir={inserir} usadas={variaveisDoCorpo(corpo)} />
        </div>
      </div>
    </Modal>
  )
}
