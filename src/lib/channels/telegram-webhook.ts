/**
 * Leitura do que o bot do Telegram recebe (§8.5, §14.1).
 *
 * Arquivo PURO, como os outros retornos.
 *
 * O Telegram não reporta entrega nem leitura para bots — o `sendMessage` já
 * devolve tudo que se vai saber. Então este retorno existe por dois motivos
 * diferentes dos outros canais:
 *
 *   1. CAPTURA. O `chat_id` só passa a existir quando a pessoa fala com o bot.
 *      É aqui que o `/start <payload>` chega, e é a única forma de descobrir o
 *      chat de alguém. Sem esta rota, o canal mais barato dos quatro fica
 *      permanentemente vazio.
 *   2. `/parar`. O opt-out do canal (§14.1).
 *
 * O terceiro caso — a pessoa bloquear o bot — não chega aqui: aparece como 403
 * na hora do envio, e o adaptador já classifica como `bloqueado_pelo_destino`.
 */

/** `/parar` é o opt-out do Telegram (§14.1). Reexportado do adaptador. */
export { PADRAO_OPTOUT_TELEGRAM } from './telegram'
import { PADRAO_OPTOUT_TELEGRAM } from './telegram'

export type RetornoTelegram =
  /**
   * A pessoa iniciou a conversa. `payload` é o `contact_external_id` que veio
   * no link de captura — pode ser nulo se ela achou o bot pela busca.
   */
  | { tipo: 'inicio'; chatId: number; payload: string | null; nome: string | null }
  /** Pediu para sair. */
  | { tipo: 'saida'; chatId: number }
  /** Qualquer outra mensagem. Alimenta o CRM, não muda consentimento. */
  | { tipo: 'mensagem'; chatId: number; texto: string; nome: string | null }
  | { tipo: 'ignorado'; motivo: string }

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null
}

/** O nome de quem escreveu, para preencher contato novo criado pelo /start. */
function nomeDe(from: Record<string, unknown> | null): string | null {
  if (!from) return null
  const primeiro = texto(from.first_name)
  const ultimo = texto(from.last_name)
  const junto = [primeiro, ultimo].filter(Boolean).join(' ')
  return junto !== '' ? junto : texto(from.username)
}

export function lerRetornoTelegram(corpo: unknown): RetornoTelegram {
  if (typeof corpo !== 'object' || corpo === null) return { tipo: 'ignorado', motivo: 'corpo vazio' }
  const update = corpo as Record<string, unknown>

  /*
   * `message` é a mensagem nova; `edited_message` é uma editada. Ler as duas
   * porque editar "oi" para "parar" é um pedido de descadastro igual ao
   * original, e ignorá-lo seria continuar enviando para quem pediu para sair.
   */
  const bruta = update.message ?? update.edited_message
  if (typeof bruta !== 'object' || bruta === null) {
    return { tipo: 'ignorado', motivo: 'update sem mensagem' }
  }

  const mensagem = bruta as Record<string, unknown>
  const chat = mensagem.chat
  const chatId =
    typeof chat === 'object' && chat !== null
      ? (chat as Record<string, unknown>).id
      : undefined

  if (typeof chatId !== 'number' || !Number.isFinite(chatId)) {
    return { tipo: 'ignorado', motivo: 'sem chat_id' }
  }

  const conteudo = texto(mensagem.text) ?? texto(mensagem.caption)
  if (!conteudo) return { tipo: 'ignorado', motivo: 'mensagem sem texto' }

  const from =
    typeof mensagem.from === 'object' && mensagem.from !== null
      ? (mensagem.from as Record<string, unknown>)
      : null
  const nome = nomeDe(from)

  const inicio = /^\/start(?:@\w+)?(?:\s+(\S+))?/i.exec(conteudo)
  if (inicio) {
    return { tipo: 'inicio', chatId, payload: inicio[1] ?? null, nome }
  }

  // `/parar`, e também "sair"/"stop" digitados sem barra.
  if (PADRAO_OPTOUT_TELEGRAM.test(conteudo)) return { tipo: 'saida', chatId }

  return { tipo: 'mensagem', chatId, texto: conteudo, nome }
}

/**
 * O payload do `/start`, saneado.
 *
 * O Telegram só aceita `[A-Za-z0-9_-]` até 64 caracteres, e `linkDeCaptura` já
 * gera assim — mas o que chega no webhook é o que a pessoa digitou, e digitar
 * `/start qualquer-coisa` à mão é livre. Sanear de novo na leitura impede que
 * um payload inventado vire busca por `external_id` com caractere de controle.
 */
export function payloadValido(payload: string | null): string | null {
  if (!payload) return null
  const limpo = payload.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return limpo !== '' ? limpo : null
}
