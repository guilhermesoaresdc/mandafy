'use client'

import { useId, useState } from 'react'
import { Button, Field, Input, Modal } from '@/components/ui'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { descreverEvento, ehEventoQueOMandafyNaoGera } from '@/lib/vocabulario'
import { criarFluxoAction } from './actions'

/**
 * Criar um fluxo do zero.
 *
 * POR QUE NÃO EXISTIA
 *
 * O único caminho para ter fluxos era "Trazer os nove fluxos prontos", um
 * botão que vive DENTRO do estado vazio da lista. Depois do primeiro clique
 * ele some — e não havia como criar o décimo. Sete dos quinze eventos
 * canônicos não tinham fluxo e nunca teriam, porque `triggerEvent` era escrito
 * uma vez pelo seed e nada na interface o alcançava.
 *
 * DUAS PERGUNTAS, E SÓ DUAS
 *
 * Nome e quando dispara. O resto — mensagens, tempos, o que cancela — se
 * decide na tela do fluxo, com as coisas na frente. Pedir tudo aqui seria
 * transformar "criar um fluxo" numa configuração antes de existir alguma coisa
 * para configurar.
 */
export function NovoFluxo() {
  const [aberto, setAberto] = useState(false)
  const nomeId = useId()
  const eventoId = useId()

  return (
    <>
      <Button size="sm" onClick={() => setAberto(true)}>
        Novo fluxo
      </Button>

      <Modal
        aberto={aberto}
        aoFechar={() => setAberto(false)}
        titulo="Novo fluxo"
        descricao="Ele nasce pausado e vazio — as mensagens entram na tela seguinte."
      >
        <form action={criarFluxoAction} className="flex flex-col gap-3">
          <Field label="Nome" htmlFor={nomeId}>
            <Input
              id={nomeId}
              name="nome"
              maxLength={80}
              required
              autoFocus
              placeholder="Recuperação de PIX"
            />
          </Field>

          <Field
            label="Quando isto acontecer"
            htmlFor={eventoId}
            hint="O aviso que a sua plataforma manda e que faz este fluxo começar."
          >
            <select
              id={eventoId}
              name="triggerEvent"
              defaultValue="order.created"
              className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-xs text-ink outline-none focus:border-live"
            >
              {CANONICAL_EVENTS.map((evento) => (
                <option key={evento} value={evento}>
                  {descreverEvento(evento).nome}
                  {/*
                    Dito na hora de escolher, e não depois de ligar e esperar.
                    Cinco dos quinze eventos o Mandafy não produz sozinho, e
                    quem escolhesse um deles descobriria pelo painel dizendo "o
                    evento nunca chegou" — culpando a plataforma dele, que está
                    sã.
                  */}
                  {ehEventoQueOMandafyNaoGera(evento) ? ' (o Mandafy ainda não gera)' : ''}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm">
              Criar
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </Modal>
    </>
  )
}
