'use client'

import { CHANNEL_LABELS, type Channel } from '@/db/schema/enums'
import { ChannelIcon } from '@/components/ui'
import { resumoContador } from '@/lib/messages/gsm'
import type { Compilacao } from '@/lib/messages/compile'
import { cn } from '@/lib/utils'

/**
 * Pré-visualização lado a lado (§6.6).
 *
 * Cada canal ganha a moldura em que a mensagem realmente aparece: bolha de
 * conversa no WhatsApp e no Telegram, caixa de entrada no e-mail, tela de
 * aparelho no SMS. A moldura não é enfeite — é o que deixa "esse parágrafo
 * ficou grande demais" evidente antes do envio, e não depois.
 */

function Moldura({
  canal,
  children,
  rodape,
}: {
  canal: Channel
  children: React.ReactNode
  rodape?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <ChannelIcon channel={canal} className="size-3.5" aria-hidden="true" />
        <span className="text-2xs font-medium text-ink-2">{CHANNEL_LABELS[canal]}</span>
      </div>

      <div className="min-h-32 flex-1 rounded-xl border border-line bg-surface-2 p-3">{children}</div>

      {rodape ? <div className="text-2xs text-pending">{rodape}</div> : null}
    </div>
  )
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

export function PreviaWhatsapp({ compilacao }: { compilacao: Compilacao }) {
  return (
    <Moldura canal="whatsapp">
      {compilacao.ok ? <Bolha texto={compilacao.corpo} canal="whatsapp" /> : <Falha compilacao={compilacao} />}
    </Moldura>
  )
}

export function PreviaTelegram({ compilacao }: { compilacao: Compilacao }) {
  /*
   * O Telegram recebe HTML e o renderiza. Aqui exibimos o texto COM as tags
   * visíveis de propósito: injetar o HTML gerado nesta página daria a um nome
   * de contato o poder de escrever marcação no painel. Ver o `<b>` também
   * ajuda a conferir o escape antes de mandar.
   */
  return (
    <Moldura canal="telegram" rodape="parse_mode: HTML · prévia do link desligada">
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
}: {
  compilacao: Compilacao
  assunto: string
  preheader: string
}) {
  return (
    <Moldura canal="email" rodape="Versão texto puro sai junto, no mesmo envio">
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

export function PreviaSms({ compilacao }: { compilacao: Compilacao }) {
  const contagem = compilacao.ok ? compilacao.sms : undefined
  const caro = (contagem?.segmentos ?? 0) > 1

  return (
    <Moldura
      canal="sms"
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
        <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-ink">
          {compilacao.corpo}
        </p>
      ) : (
        <Falha compilacao={compilacao} />
      )}
    </Moldura>
  )
}
