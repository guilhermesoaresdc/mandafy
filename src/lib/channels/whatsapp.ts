import type { AdaptadorCanal, DestinoEnvio, ResultadoEnvio } from './types'
import { falhaDeRede, lerJson, postJson } from './types'

/**
 * WhatsApp via Evolution API (§8.2).
 *
 * ATENÇÃO DE VERSÃO — o ponto que a spec marca como crítico: o formato do
 * corpo mudou entre a v1 e a v2, e a mudança quebra a integração EM SILÊNCIO
 * (a API aceita e não entrega). Usamos o formato v2, plano:
 *
 *   v1: { number, textMessage: { text }, options: { delay, presence } }
 *   v2: { number, text, delay, linkPreview }   ← este
 *
 * Fixe a imagem em `evoapicloud/evolution-api:v2.x.x`; nunca `latest`.
 *
 * Este arquivo é o único lugar que conhece o contrato da Evolution. Se a v3
 * mudar de novo, o conserto é aqui e em nenhum outro lugar.
 */

export type ConfigWhatsapp = {
  /** Base da Evolution, ex. http://evolution:8080 */
  url: string
  /** Nome da instância na Evolution (o "chip"). */
  instancia: string
  apikey: string
}

const PROVIDER = 'evolution'

function limparNumero(e164: string): string {
  // A Evolution espera dígitos, sem o `+`.
  return e164.replace(/\D/g, '')
}

function baseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

type Falha = Extract<ResultadoEnvio, { ok: false }>

/** Traduz o status HTTP da Evolution para os códigos estáveis do log. */
function classificar(status: number, corpo: unknown): Falha {
  const mensagem = extrairMensagem(corpo) ?? `HTTP ${status}`

  if (status === 401 || status === 403) {
    return { ok: false, provider: PROVIDER, codigo: 'credencial_recusada', mensagem, reenviavel: false }
  }

  if (status === 404) {
    // A Evolution devolve 404 quando a instância não existe — o que na prática
    // significa chip removido ou nome errado na configuração.
    return {
      ok: false,
      provider: PROVIDER,
      codigo: 'instancia_desconectada',
      mensagem,
      reenviavel: false,
    }
  }

  if (status === 400) {
    const texto = mensagem.toLowerCase()
    if (texto.includes('exists') || texto.includes('not a valid') || texto.includes('number')) {
      return { ok: false, provider: PROVIDER, codigo: 'sem_whatsapp', mensagem, reenviavel: false }
    }
    return { ok: false, provider: PROVIDER, codigo: 'destino_invalido', mensagem, reenviavel: false }
  }

  if (status === 429) {
    return { ok: false, provider: PROVIDER, codigo: 'limite_provedor', mensagem, reenviavel: true }
  }

  if (status >= 500) {
    return {
      ok: false,
      provider: PROVIDER,
      codigo: 'provedor_indisponivel',
      mensagem,
      reenviavel: true,
    }
  }

  return { ok: false, provider: PROVIDER, codigo: 'resposta_inesperada', mensagem, reenviavel: true }
}

function extrairMensagem(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const registro = corpo as Record<string, unknown>

  for (const chave of ['message', 'error', 'response', '_texto']) {
    const valor = registro[chave]
    if (typeof valor === 'string' && valor.trim() !== '') return valor
    if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0]
    if (typeof valor === 'object' && valor !== null) {
      const aninhado = extrairMensagem(valor)
      if (aninhado) return aninhado
    }
  }
  return null
}

function extrairId(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const chave = (corpo as { key?: { id?: unknown } }).key
  return typeof chave?.id === 'string' ? chave.id : null
}

export async function enviarWhatsapp(
  destino: DestinoEnvio,
  config: ConfigWhatsapp,
): Promise<ResultadoEnvio> {
  if (!config.url || !config.instancia || !config.apikey) {
    return {
      ok: false,
      provider: PROVIDER,
      codigo: 'sem_credencial',
      mensagem: 'a instância de WhatsApp não está configurada',
      reenviavel: false,
    }
  }

  const url = `${baseUrl(config.url)}/message/sendText/${encodeURIComponent(config.instancia)}`

  /*
   * `delay` + presença de digitação (§6.4): a Evolution mostra "digitando…"
   * pelo tempo do delay antes de entregar. Faz o envio parecer conversa, que é
   * exatamente o ponto de §7.3.
   */
  const corpo = {
    number: limparNumero(destino.para),
    text: destino.corpo,
    delay: destino.delayMs ?? 1200,
    linkPreview: false,
  }

  try {
    const resposta = await postJson(url, corpo, { apikey: config.apikey })
    const json = await lerJson(resposta)

    if (!resposta.ok) return classificar(resposta.status, json)

    return { ok: true, provider: PROVIDER, providerMessageId: extrairId(json) }
  } catch (erro) {
    return falhaDeRede(PROVIDER, erro)
  }
}

/**
 * O número existe no WhatsApp? (§8.2)
 *
 * Chamada antes do primeiro envio a um contato novo. Mandar para número que
 * não tem WhatsApp queima reputação da instância — e reputação queimada é o
 * caminho para o banimento.
 */
export async function numeroTemWhatsapp(
  e164: string,
  config: ConfigWhatsapp,
): Promise<boolean | null> {
  if (!config.url || !config.instancia || !config.apikey) return null

  const url = `${baseUrl(config.url)}/chat/whatsappNumbers/${encodeURIComponent(config.instancia)}`

  try {
    const resposta = await postJson(url, { numbers: [limparNumero(e164)] }, { apikey: config.apikey })
    if (!resposta.ok) return null

    const json = await lerJson(resposta)
    if (!Array.isArray(json)) return null

    const primeiro = json[0] as { exists?: unknown } | undefined
    return typeof primeiro?.exists === 'boolean' ? primeiro.exists : null
  } catch {
    // Indisponibilidade da checagem não pode bloquear o envio; devolve
    // "não sei" e quem chama decide.
    return null
  }
}

/** Palavras que disparam opt-out imediato (§8.2, §14.1). */
export const PADRAO_OPTOUT = /^\s*(sair|parar|cancelar|descadastrar|stop|remover)\b/i

export function ehPedidoDeSaida(texto: string): boolean {
  return PADRAO_OPTOUT.test(texto)
}

export const adaptadorWhatsapp: AdaptadorCanal<ConfigWhatsapp> = {
  canal: 'whatsapp',
  provider: PROVIDER,
  enviar: enviarWhatsapp,
}
