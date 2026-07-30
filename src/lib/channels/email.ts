import type { AdaptadorCanal, DestinoEnvio, ResultadoEnvio } from './types'
import { falhaDeRede, lerJson, postJson } from './types'

/**
 * E-mail (§8.3).
 *
 * Interface `EmailProvider` com adaptadores por provedor; trocar de provedor é
 * trocar `EMAIL_PROVIDER`. Resend é o padrão recomendado; SES entra quando o
 * volume passa de ~200 mil/mês.
 *
 * Dois itens são obrigatórios em TODO envio e não são opcionais de
 * configuração: versão texto puro (entregabilidade) e `List-Unsubscribe` +
 * `List-Unsubscribe-Post` — o descadastro em um clique que Gmail e Outlook
 * passaram a exigir. Sem eles a entrega degrada sozinha com o tempo.
 */

export type ConfigEmail = {
  provider: 'resend' | 'brevo'
  apiKey: string
  /** "Mandafy <envio@seudominio.com.br>" */
  remetente: string
}

type Falha = Extract<ResultadoEnvio, { ok: false }>

function semCredencial(provider: string): Falha {
  return {
    ok: false,
    provider,
    codigo: 'sem_credencial',
    mensagem: 'o canal de e-mail não está configurado',
    reenviavel: false,
  }
}

function classificar(provider: string, status: number, corpo: unknown): Falha {
  const mensagem = extrairMensagem(corpo) ?? `HTTP ${status}`

  if (status === 401 || status === 403) {
    return { ok: false, provider, codigo: 'credencial_recusada', mensagem, reenviavel: false }
  }
  if (status === 422 || status === 400) {
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

  for (const chave of ['message', 'error', 'name', '_texto']) {
    const valor = registro[chave]
    if (typeof valor === 'string' && valor.trim() !== '') return valor
  }
  return null
}

/**
 * Cabeçalhos obrigatórios de §8.3.
 *
 * `List-Unsubscribe-Post` é o que torna o descadastro um clique só, sem abrir
 * o navegador — é a forma que Gmail e Outlook exigem de quem manda volume.
 */
export function cabecalhosDescadastro(link: string | undefined): Record<string, string> {
  if (!link) return {}
  return {
    'List-Unsubscribe': `<${link}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

async function enviarResend(destino: DestinoEnvio, config: ConfigEmail): Promise<ResultadoEnvio> {
  const corpo = {
    from: config.remetente,
    to: [destino.para],
    subject: destino.assunto ?? '',
    html: destino.html ?? destino.corpo,
    // Multipart sempre: melhora entregabilidade e atende quem lê sem HTML.
    text: destino.textoPuro ?? destino.corpo,
    headers: cabecalhosDescadastro(destino.linkDescadastro),
  }

  try {
    const resposta = await postJson('https://api.resend.com/emails', corpo, {
      authorization: `Bearer ${config.apiKey}`,
    })
    const json = await lerJson(resposta)

    if (!resposta.ok) return classificar('resend', resposta.status, json)

    const id = (json as { id?: unknown } | null)?.id
    return { ok: true, provider: 'resend', providerMessageId: typeof id === 'string' ? id : null }
  } catch (erro) {
    return falhaDeRede('resend', erro)
  }
}

async function enviarBrevo(destino: DestinoEnvio, config: ConfigEmail): Promise<ResultadoEnvio> {
  const { nome, email } = separarRemetente(config.remetente)

  const corpo = {
    sender: { name: nome, email },
    to: [{ email: destino.para }],
    subject: destino.assunto ?? '',
    htmlContent: destino.html ?? destino.corpo,
    textContent: destino.textoPuro ?? destino.corpo,
    headers: cabecalhosDescadastro(destino.linkDescadastro),
  }

  try {
    const resposta = await postJson('https://api.brevo.com/v3/smtp/email', corpo, {
      'api-key': config.apiKey,
    })
    const json = await lerJson(resposta)

    if (!resposta.ok) return classificar('brevo', resposta.status, json)

    const id = (json as { messageId?: unknown } | null)?.messageId
    return { ok: true, provider: 'brevo', providerMessageId: typeof id === 'string' ? id : null }
  } catch (erro) {
    return falhaDeRede('brevo', erro)
  }
}

/** "Mandafy <envio@x.com.br>" → { nome, email }. Aceita o e-mail cru também. */
export function separarRemetente(remetente: string): { nome: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(remetente)
  if (match) return { nome: (match[1] ?? '').replace(/^"|"$/g, ''), email: match[2] ?? '' }
  return { nome: '', email: remetente.trim() }
}

export async function enviarEmail(
  destino: DestinoEnvio,
  config: ConfigEmail,
): Promise<ResultadoEnvio> {
  if (!config.apiKey || !config.remetente) return semCredencial(config.provider)

  return config.provider === 'brevo' ? enviarBrevo(destino, config) : enviarResend(destino, config)
}

export const adaptadorEmail: AdaptadorCanal<ConfigEmail> = {
  canal: 'email',
  provider: 'email',
  enviar: enviarEmail,
}
