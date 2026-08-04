'use client'

import { useActionState, useId, useState } from 'react'
import {
  Button,
  Card,
  CardBody,
  ChannelIcon,
  Field,
  Input,
  fieldDescriptionId,
} from '@/components/ui'
import {
  CHANNEL_COLOR_VAR,
  CHANNEL_LABELS,
  MESSAGE_CATEGORIES,
  MESSAGE_CATEGORY_LABELS,
  type MessageCategory,
} from '@/db/schema/enums'
import type { ResumoModelo } from '@/lib/messages/galeria'
import { criarMensagemAction, type MensagemState } from './actions'

/**
 * Criar mensagem, a partir de um modelo ou do zero.
 *
 * COMEÇAR DO ZERO ERA O ÚNICO CAMINHO
 *
 * A tela pedia nome e categoria e abria o editor vazio. Os treze modelos
 * prontos existiam — mas só para quem tinha rodado o seed, e mesmo aí ninguém
 * descobria que dava para partir deles: o cinza no editor é texto de exemplo,
 * que some ao digitar. "Comece pelo modelo de recuperação de PIX — leva 2
 * minutos" (§11.7) só é verdade se o modelo estiver à vista na hora de criar.
 *
 * Escolher um modelo preenche nome e categoria aqui, e o corpo, as variantes e
 * os canais no servidor — pela mesma função que o seed usa, então a mensagem
 * nasce idêntica à do catálogo.
 */

/** Categoria de quem começa em branco: a de menos consequência em §14.1. */
const CATEGORIA_PADRAO: MessageCategory = 'relacionamento'

export function NovaMensagem({ modelos }: { modelos: ResumoModelo[] }) {
  const [aberto, setAberto] = useState(false)
  const [estado, action, pendente] = useActionState<MensagemState, FormData>(
    criarMensagemAction,
    {},
  )

  const [modelo, setModelo] = useState('')
  const [nome, setNome] = useState('')
  const [categoria, setCategoria] = useState<MessageCategory>(CATEGORIA_PADRAO)

  /*
   * Um nome digitado à mão não é sobrescrito ao escolher um modelo.
   *
   * Sem isto, quem já sabe como vai chamar a mensagem digita, olha a galeria,
   * clica — e perde o que escreveu. O caminho comum (escolher primeiro) segue
   * preenchendo o campo sozinho, que é o que faz a galeria valer a pena.
   */
  const [nomeTocado, setNomeTocado] = useState(false)

  const nomeId = useId()

  function escolher(escolhido: ResumoModelo | null) {
    setModelo(escolhido?.key ?? '')
    if (!nomeTocado) setNome(escolhido?.name ?? '')
    if (escolhido) setCategoria(escolhido.category)
  }

  if (!aberto) {
    return (
      <Button onClick={() => setAberto(true)} size="sm">
        Nova mensagem
      </Button>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={action} className="flex flex-col gap-4">
          {/*
            O que vai para o servidor é a chave do modelo, e não o índice do
            cartão: a galeria pode ganhar modelo novo ou mudar de ordem sem que
            uma criação em andamento passe a apontar para outra mensagem.
          */}
          <input type="hidden" name="modelo" value={modelo} />

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-2xs font-medium text-ink-2">
              Quer começar de um modelo pronto?
            </legend>

            {/* Rolagem própria: catorze opções não podem empurrar o botão de
                criar para fora da tela num telefone. */}
            <div className="grid max-h-72 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
              <OpcaoModelo
                nome="Em branco"
                amostra="Você escreve do zero. WhatsApp, e-mail e Telegram já ligados."
                escolhido={modelo === ''}
                onEscolher={() => escolher(null)}
              />

              {modelos.map((m) => (
                <OpcaoModelo
                  key={m.key}
                  nome={m.name}
                  amostra={m.amostra}
                  etiqueta={MESSAGE_CATEGORY_LABELS[m.category]}
                  canais={m.canais}
                  escolhido={modelo === m.key}
                  onEscolher={() => escolher(m)}
                />
              ))}
            </div>

            <p className="text-2xs text-pending">
              O texto aparece com um contato de exemplo. Tudo continua editável depois — o
              modelo é ponto de partida, não regra.
            </p>
          </fieldset>

          <Field
            label="Como você chama essa mensagem?"
            htmlFor={nomeId}
            hint="Ex.: Lembrete de PIX, Boas-vindas, Parabéns pelo bilhete"
            {...(estado.error ? { error: estado.error } : {})}
          >
            <Input
              id={nomeId}
              name="nome"
              autoFocus
              required
              maxLength={80}
              placeholder="Lembrete de PIX"
              value={nome}
              onChange={(evento) => {
                setNome(evento.target.value)
                setNomeTocado(true)
              }}
              aria-describedby={fieldDescriptionId(nomeId)}
            />
          </Field>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-2xs font-medium text-ink-2">
              Que tipo de mensagem é essa?
            </legend>
            <div className="flex flex-wrap gap-2">
              {MESSAGE_CATEGORIES.map((opcao) => (
                <label
                  key={opcao}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink"
                >
                  <input
                    type="radio"
                    name="categoria"
                    value={opcao}
                    checked={categoria === opcao}
                    onChange={() => setCategoria(opcao)}
                    className="size-3 accent-ink"
                  />
                  {MESSAGE_CATEGORY_LABELS[opcao]}
                </label>
              ))}
            </div>
            <p className="text-2xs text-pending">
              Transacional pode ser enviada a qualquer hora. Recuperação e relacionamento
              exigem que a pessoa tenha aceitado receber.
            </p>
          </fieldset>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pendente}>
              {pendente ? 'Criando…' : 'Criar e escrever'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

type OpcaoModeloProps = {
  nome: string
  amostra: string
  etiqueta?: string
  canais?: ResumoModelo['canais']
  escolhido: boolean
  onEscolher: () => void
}

/**
 * Um cartão da galeria.
 *
 * `radio` de verdade, e visível: a borda mais escura sozinha não diz qual está
 * escolhido para quem não distingue a diferença de contraste, e um cartão
 * "clicável" sem input perde teclado e leitor de tela. As setas navegam entre
 * as opções porque o grupo compartilha o `name` — comportamento nativo.
 */
function OpcaoModelo({ nome, amostra, etiqueta, canais, escolhido, onEscolher }: OpcaoModeloProps) {
  return (
    <label className="flex cursor-pointer gap-2 rounded-lg border border-line p-2.5 has-[:checked]:border-ink has-[:checked]:bg-surface-2">
      <input
        type="radio"
        name="galeria"
        checked={escolhido}
        onChange={onEscolher}
        className="mt-0.5 size-3 shrink-0 accent-ink"
      />

      <span className="min-w-0 flex-1">
        {/* O nome QUEBRA em vez de cortar: "Lembrete de PIX — 5 minutos" e
            "— 25 minutos" só se distinguem no fim, e cortadas viram a mesma
            coisa na tela. A etiqueta é que cede espaço. */}
        <span className="flex items-baseline justify-between gap-1.5">
          <span className="text-2xs font-medium text-ink">{nome}</span>
          {etiqueta ? <span className="shrink-0 text-2xs text-pending">{etiqueta}</span> : null}
        </span>

        {/* Duas linhas e corta: o cartão é vitrine, o editor é onde se lê. */}
        <span className="mt-0.5 line-clamp-2 text-2xs leading-snug text-ink-2">{amostra}</span>

        {canais ? (
          <span
            className="mt-1 flex items-center gap-1"
            aria-label={`Canais: ${canais.map((c) => CHANNEL_LABELS[c]).join(', ')}`}
          >
            {canais.map((canal) => (
              <ChannelIcon
                key={canal}
                channel={canal}
                aria-hidden="true"
                className="size-3"
                style={{ color: `var(${CHANNEL_COLOR_VAR[canal]})` }}
              />
            ))}
          </span>
        ) : null}
      </span>
    </label>
  )
}
