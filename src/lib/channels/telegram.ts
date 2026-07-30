import type { AdaptadorCanal, DestinoEnvio, ResultadoEnvio } from './types'
import { falhaDeRede, lerJson, postJson } from './types'

/**
 * Telegram (§8.5).
 *
 * O mais simples dos quatro, e o único sem risco de banimento. O cuidado que
 * importa está no 429: estourar o limite bloqueia o BOT INTEIRO — não só aquele
 * envio — pelo tempo que vem em `retry_after`. Por isso o campo sobe até a fila
 * em `esperarSegundos`, e a fila roda a 20/s contra um teto de 30 (§7.1).
 *
 * `parse_mode: HTML` e não MarkdownV2: o MarkdownV2 exige escapar
 * `_ * [ ] ( ) ~ > # + - = | { } . !`, e qualquer um desses num texto em
 * português derruba o envio com 400.
 */

export type ConfigTelegram = {
  botToken: string
}

type Falha = Extract<ResultadoEnvio, { ok: false }>

type RespostaTelegram = {
  ok?: boolean
  result?: { message_id?: unknown }
  description?: unknown
  error_code?: unknown
  parameters?: { retry_after?: unknown }
}

function classificar(status: number, json: RespostaTelegram | null): Falha {
  const mensagem =
    typeof json?.description === 'string' ? json.description : `HTTP ${status}`

  if (status === 429) {
    // Respeitar `retry_after` é obrigatório: ignorar estende o bloqueio.
    const espera = json?.parameters?.retry_after
    return {
      ok: false,
      provider: 'telegram',
      codigo: 'limite_provedor',
      mensagem,
      reenviavel: true,
      ...(typeof espera === 'number' ? { esperarSegundos: espera } : {}),
    }
  }

  if (status === 401) {
    return {
      ok: false,
      provider: 'telegram',
      codigo: 'credencial_recusada',
      mensagem: 'token do bot recusado',
      reenviavel: false,
    }
  }

  if (status === 403) {
    /*
     * 403 aqui quase sempre é "bot was blocked by the user". Não é falha de
     * infraestrutura: reenviar não resolve, e quem chama deve criar supressão.
     */
    return {
      ok: false,
      provider: 'telegram',
      codigo: 'bloqueado_pelo_destino',
      mensagem,
      reenviavel: false,
    }
  }

  if (status === 400) {
    return { ok: false, provider: 'telegram', codigo: 'destino_invalido', mensagem, reenviavel: false }
  }

  if (status >= 500) {
    return {
      ok: false,
      provider: 'telegram',
      codigo: 'provedor_indisponivel',
      mensagem,
      reenviavel: true,
    }
  }

  return { ok: false, provider: 'telegram', codigo: 'resposta_inesperada', mensagem, reenviavel: true }
}

export async function enviarTelegram(
  destino: DestinoEnvio,
  config: ConfigTelegram,
): Promise<ResultadoEnvio> {
  if (!config.botToken) {
    return {
      ok: false,
      provider: 'telegram',
      codigo: 'sem_credencial',
      mensagem: 'o bot do Telegram não está configurado',
      reenviavel: false,
    }
  }

  const corpo = {
    chat_id: destino.para,
    text: destino.corpo,
    parse_mode: 'HTML',
    // Sem prévia de link por padrão: ela polui a conversa (§6.4).
    link_preview_options: { is_disabled: true },
    ...(destino.botoes && destino.botoes.length > 0
      ? { reply_markup: { inline_keyboard: [destino.botoes] } }
      : {}),
  }

  try {
    const resposta = await postJson(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      corpo,
      {},
    )
    const json = (await lerJson(resposta)) as RespostaTelegram | null

    if (!resposta.ok || json?.ok === false) return classificar(resposta.status, json)

    const id = json?.result?.message_id
    return {
      ok: true,
      provider: 'telegram',
      providerMessageId: id === undefined || id === null ? null : String(id),
    }
  } catch (erro) {
    return falhaDeRede('telegram', erro)
  }
}

/**
 * Link de captura com payload (§8.5).
 *
 * O `chat_id` só existe depois que a pessoa fala com o bot, e este link resolve
 * o problema: o `/start` já chega vinculado ao contato. Vale colocar na página
 * de obrigado da plataforma e na primeira mensagem de WhatsApp.
 */
export function linkDeCaptura(bot: string, contatoExternalId: string): string {
  const usuario = bot.replace(/^@/, '')
  // O payload do /start aceita só [A-Za-z0-9_-], até 64 caracteres.
  const payload = contatoExternalId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return `https://t.me/${usuario}?start=${payload}`
}

/** `/parar` é o opt-out do Telegram (§14.1). */
export const PADRAO_OPTOUT_TELEGRAM = /^\s*\/?(parar|stop|sair|cancelar)\b/i

export const adaptadorTelegram: AdaptadorCanal<ConfigTelegram> = {
  canal: 'telegram',
  provider: 'telegram',
  enviar: enviarTelegram,
}
