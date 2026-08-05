'use client'

import { CHANNEL_LABELS, type Channel } from '@/db/schema/enums'
import { ChannelIcon } from '@/components/ui'
import { cortarParaSegmentos, resumoContador, SEGMENTOS_MAX } from '@/lib/messages/gsm'
import type { Compilacao } from '@/lib/messages/compile'
import { cn } from '@/lib/utils'

/**
 * Pré-visualização lado a lado (§6.6).
 *
 * Cada canal ganha a moldura em que a mensagem realmente aparece: bolha de
 * conversa no WhatsApp e no Telegram, caixa de entrada no e-mail, tela de
 * aparelho no SMS. A moldura não é enfeite — é o que deixa "esse parágrafo
 * ficou grande demais" evidente antes do envio, e não depois.
 *
 * A MOLDURA É TAMBÉM ONDE SE EDITA
 *
 * Ajustar só o e-mail sempre foi possível (§6.1), mas o controle morava num
 * cartão no fim da página, depois do botão de teste — longe da prévia que
 * mostra o problema. Quem via o assunto errado no e-mail não tinha como
 * suspeitar de que a correção estava três blocos abaixo, e concluía que a
 * única saída era mudar o texto comum, que serve aos quatro.
 *
 * Por isso `acoes` e `abaixo`: o botão de editar fica no cabeçalho da moldura
 * e o formulário abre dentro dela. Onde se vê o defeito é onde se corrige.
 */

function Moldura({
  canal,
  children,
  rodape,
  /** Selo de estado e o botão de editar, no cabeçalho. */
  acoes,
  /** O formulário de ajuste, quando aberto. */
  abaixo,
}: {
  canal: Channel
  children: React.ReactNode
  rodape?: React.ReactNode
  acoes?: React.ReactNode
  abaixo?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-6 items-center gap-1.5">
        <ChannelIcon channel={canal} className="size-3.5" aria-hidden="true" />
        <span className="text-2xs font-medium text-ink-2">{CHANNEL_LABELS[canal]}</span>
        {acoes ? <div className="ml-auto flex items-center gap-1.5">{acoes}</div> : null}
      </div>

      <div className="min-h-32 flex-1 rounded-xl border border-line bg-surface-2 p-3">{children}</div>

      {rodape ? <div className="text-2xs text-pending">{rodape}</div> : null}

      {abaixo}
    </div>
  )
}

/** As duas fatias que toda prévia aceita para virar também editor. */
export type SlotsPrevia = {
  acoes?: React.ReactNode
  abaixo?: React.ReactNode
}

/**
 * O que a moldura mostra quando a compilação não deu certo.
 *
 * CORPO VAZIO NÃO É ERRO
 *
 * Mensagem recém-criada em branco tem corpo vazio, e a compilação falha nos
 * quatro canais. Pintar isso de vermelho quatro vezes é dizer "você errou" a
 * quem ainda não fez nada — a primeira coisa que a pessoa vê ao criar a
 * primeira mensagem da vida. Aqui vira convite, na cor de texto secundário
 * (§11.7): nomeie pelo que a pessoa controla, e não pelo que o compilador
 * encontrou.
 *
 * Variável sem valor e erro de sintaxe continuam vermelhos — nesses dois a
 * pessoa escreveu algo que não vai sair, e precisa saber agora.
 */
function Falha({ compilacao }: { compilacao: Extract<Compilacao, { ok: false }> }) {
  if (compilacao.motivo === 'corpo_vazio') {
    return <p className="text-2xs text-pending">Escreva ao lado e a prévia aparece aqui.</p>
  }

  return (
    <p className="text-2xs text-fail">
      {compilacao.motivo === 'variavel_ausente'
        ? `Não sai assim: ${compilacao.detalhe} Dê um valor padrão com {{nome|"amigo"}} ou confira o nome da variável.`
        : compilacao.detalhe}
    </p>
  )
}

/** Bolha de conversa. Serve para WhatsApp e Telegram; muda só a cor. */
function Bolha({ texto, canal }: { texto: string; canal: 'whatsapp' | 'telegram' }) {
  return (
    <div
      className={cn(
        'max-w-[85%] rounded-xl rounded-tl-sm px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink',
        canal === 'whatsapp' ? 'bg-[color-mix(in_oklab,var(--color-ch-whatsapp)_14%,transparent)]' : 'bg-[color-mix(in_oklab,var(--color-ch-telegram)_14%,transparent)]',
      )}
    >
      {texto}
    </div>
  )
}

export function PreviaWhatsapp({ compilacao, ...slots }: { compilacao: Compilacao } & SlotsPrevia) {
  return (
    <Moldura canal="whatsapp" {...slots}>
      {compilacao.ok ? <Bolha texto={compilacao.corpo} canal="whatsapp" /> : <Falha compilacao={compilacao} />}
    </Moldura>
  )
}

export function PreviaTelegram({ compilacao, ...slots }: { compilacao: Compilacao } & SlotsPrevia) {
  /*
   * O Telegram recebe HTML e o renderiza. Aqui exibimos o texto COM as tags
   * visíveis de propósito: injetar o HTML gerado nesta página daria a um nome
   * de contato o poder de escrever marcação no painel. Ver o `<b>` também
   * ajuda a conferir o escape antes de mandar.
   */
  return (
    <Moldura canal="telegram" rodape="parse_mode: HTML · prévia do link desligada" {...slots}>
      {compilacao.ok ? (
        <Bolha texto={compilacao.corpo} canal="telegram" />
      ) : (
        <Falha compilacao={compilacao} />
      )}
    </Moldura>
  )
}

export function PreviaEmail({
  compilacao,
  assunto,
  preheader,
  ...slots
}: {
  compilacao: Compilacao
  assunto: string
  preheader: string
} & SlotsPrevia) {
  return (
    <Moldura canal="email" rodape="Versão texto puro sai junto, no mesmo envio" {...slots}>
      {compilacao.ok ? (
        <div className="flex flex-col gap-2">
          <div className="border-b border-line pb-2">
            <p className="truncate text-xs font-medium text-ink">
              {assunto.trim() === '' ? 'Sem assunto' : assunto}
            </p>
            <p className="truncate text-2xs text-pending">
              {preheader.trim() === '' ? 'Sem pré-cabeçalho' : preheader}
            </p>
          </div>
          <div className="text-xs leading-relaxed break-words whitespace-pre-wrap text-ink">
            {compilacao.texto ?? compilacao.corpo}
          </div>
        </div>
      ) : (
        <Falha compilacao={compilacao} />
      )}
    </Moldura>
  )
}

export function PreviaSms({ compilacao, ...slots }: { compilacao: Compilacao } & SlotsPrevia) {
  const contagem = compilacao.ok ? compilacao.sms : undefined
  const caro = (contagem?.segmentos ?? 0) > SEGMENTOS_MAX

  /*
   * O que o cliente REALMENTE receberia, com o teto de custo aplicado.
   *
   * A prévia mostra o texto inteiro de propósito — é assim que quem escreve vê
   * que passou. Mas mostrar só isso mentiria na outra ponta: no envio, o que
   * excede é cortado. Sem esta linha, alguém escreveria 300 caracteres, veria
   * os 300 na tela, e descobriria o corte pelo cliente reclamando.
   */
  const cortado =
    compilacao.ok && caro ? cortarParaSegmentos(compilacao.corpo).texto : null

  return (
    <Moldura
      canal="sms"
      {...slots}
      rodape={
        contagem ? (
          <span className={cn('font-mono', caro && 'font-medium text-fail')}>
            {resumoContador(contagem)}
            {contagem.codificacao === 'UCS-2' ? ' · UCS-2' : ''}
          </span>
        ) : null
      }
    >
      {compilacao.ok ? (
        <>
          <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-ink">
            {compilacao.corpo}
          </p>

          {cortado ? (
            <div className="mt-3 rounded-lg border border-fail/40 px-2.5 py-2">
              <p className="text-2xs text-fail">
                Passou de {SEGMENTOS_MAX === 1 ? 'um segmento' : `${SEGMENTOS_MAX} segmentos`} — o
                SMS se cobra por pedaço, e o que sobra {contagem ? `custaria ${contagem.segmentos}×` : 'dobra a conta'}.
              </p>
              <p className="mt-1.5 text-2xs text-ink-2">
                Para não cobrar a mais, o envio corta aqui:
              </p>
              <p className="mt-1 text-2xs leading-relaxed break-words whitespace-pre-wrap text-ink-2">
                {cortado}
              </p>
              <p className="mt-1.5 text-2xs text-pending">
                Encurte o texto para escolher você mesmo o que fica.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <Falha compilacao={compilacao} />
      )}
    </Moldura>
  )
}
