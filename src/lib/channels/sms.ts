import type { AdaptadorCanal, DestinoEnvio, ResultadoEnvio } from './types'
import { falhaDeRede, lerJson, postJson } from './types'

/**
 * SMS (§8.4).
 *
 * Provedores nacionais que cobram em real e sem mensalidade — SMSDev e Comtele.
 * Twilio fica de fora de propósito: cobrança em dólar traz IOF e variação
 * cambial numa operação 100% Brasil.
 *
 * Duas decisões da spec estão codificadas aqui e no `queue.ts`:
 *  - retry 2×, não 5. SMS custa dinheiro; insistir multiplica a fatura.
 *  - o canal vem desligado por padrão fora de recuperação de venda.
 */

export type ConfigSms = {
  provider: 'smsdev' | 'comtele'
  apiKey: string
  /** Remetente/short code, quando o provedor exige. */
  remetente?: string
}

type Falha = Extract<ResultadoEnvio, { ok: false }>

/** SMS nacional vai sem o `+` e com o DDI. */
function numeroNacional(e164: string): string {
  return e164.replace(/\D/g, '')
}

function classificar(provider: string, status: number, corpo: unknown): Falha {
  const mensagem = extrairMensagem(corpo) ?? `HTTP ${status}`

  if (status === 401 || status === 403) {
    return { ok: false, provider, codigo: 'credencial_recusada', mensagem, reenviavel: false }
  }
  if (status === 400 || status === 422) {
    return { ok: false, provider, codigo: 'destino_invalido', mensagem, reenviavel: false }
  }
  if (status === 429) {
    return { ok: false, provider, codigo: 'limite_provedor', mensagem, reenviavel: true }
  }
  if (status >= 500) {
    return { ok: false, provider, codigo: 'provedor_indisponivel', mensagem, reenviavel: true }
  }
  return { ok: false, provider, codigo: 'resposta_inesperada', mensagem, reenviavel: true }
}

function extrairMensagem(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const registro = corpo as Record<string, unknown>

  for (const chave of ['descricao', 'message', 'Message', 'error', '_texto']) {
    const valor = registro[chave]
    if (typeof valor === 'string' && valor.trim() !== '') return valor
  }
  return null
}

async function enviarSmsDev(destino: DestinoEnvio, config: ConfigSms): Promise<ResultadoEnvio> {
  const corpo = {
    key: config.apiKey,
    type: 9,
    number: numeroNacional(destino.para),
    msg: destino.corpo,
  }

  try {
    const resposta = await postJson('https://api.smsdev.com.br/v1/send', corpo, {})
    const json = await lerJson(resposta)

    if (!resposta.ok) return classificar('smsdev', resposta.status, json)

    /*
     * O SMSDev responde 200 mesmo em erro de negócio, sinalizando por
     * `situacao: "ERRO"`. Tratar só o status HTTP daria "enviado" para
     * mensagem que nunca saiu — e o log ficaria mentindo.
     */
    const registro = json as { situacao?: unknown; id?: unknown; descricao?: unknown } | null
    if (typeof registro?.situacao === 'string' && registro.situacao.toUpperCase() !== 'OK') {
      return {
        ok: false,
        provider: 'smsdev',
        codigo: 'resposta_inesperada',
        mensagem: typeof registro.descricao === 'string' ? registro.descricao : 'envio recusado',
        reenviavel: false,
      }
    }

    const id = registro?.id
    return {
      ok: true,
      provider: 'smsdev',
      providerMessageId: id === undefined || id === null ? null : String(id),
    }
  } catch (erro) {
    return falhaDeRede('smsdev', erro)
  }
}

async function enviarComtele(destino: DestinoEnvio, config: ConfigSms): Promise<ResultadoEnvio> {
  const corpo = {
    Receivers: numeroNacional(destino.para),
    Content: destino.corpo,
    ...(config.remetente ? { Sender: config.remetente } : {}),
  }

  try {
    const resposta = await postJson('https://sms.comtele.com.br/api/v2/send', corpo, {
      'auth-key': config.apiKey,
    })
    const json = await lerJson(resposta)

    if (!resposta.ok) return classificar('comtele', resposta.status, json)

    const registro = json as { Success?: unknown; Object?: unknown; Message?: unknown } | null
    if (registro?.Success === false) {
      return {
        ok: false,
        provider: 'comtele',
        codigo: 'resposta_inesperada',
        mensagem: typeof registro.Message === 'string' ? registro.Message : 'envio recusado',
        reenviavel: false,
      }
    }

    const id = registro?.Object
    return {
      ok: true,
      provider: 'comtele',
      providerMessageId: id === undefined || id === null ? null : String(id),
    }
  } catch (erro) {
    return falhaDeRede('comtele', erro)
  }
}

export async function enviarSms(destino: DestinoEnvio, config: ConfigSms): Promise<ResultadoEnvio> {
  if (!config.apiKey) {
    return {
      ok: false,
      provider: config.provider,
      codigo: 'sem_credencial',
      mensagem: 'o canal de SMS não está configurado',
      reenviavel: false,
    }
  }

  return config.provider === 'comtele' ? enviarComtele(destino, config) : enviarSmsDev(destino, config)
}

export const adaptadorSms: AdaptadorCanal<ConfigSms> = {
  canal: 'sms',
  provider: 'sms',
  enviar: enviarSms,
}
