import type { Channel } from '@/db/schema/enums'

/**
 * A interface comum dos quatro canais (§8, regra 3 do CLAUDE.md).
 *
 * Trocar de provedor tem de ser trocar uma variável de ambiente. Por isso o
 * adaptador não conhece banco, fila nem organização: recebe um destino, um
 * texto e credenciais, e devolve um resultado. Tudo que é decisão — jitter,
 * janela de silêncio, rodízio de número — acontece antes, em `lib/delivery`.
 */

export type DestinoEnvio = {
  /** E.164 para WhatsApp/SMS, e-mail para e-mail, chat_id para Telegram. */
  para: string
  corpo: string
  assunto?: string
  html?: string
  textoPuro?: string
  /** Botões inline do Telegram (§6.4). */
  botoes?: { text: string; url?: string; callback_data?: string }[]
  /** Simula digitação no WhatsApp: delay + presence (§6.4). */
  delayMs?: number
  mediaUrl?: string
  /** One-click unsubscribe, exigido por Gmail e Outlook (§8.3). */
  linkDescadastro?: string
}

export type ResultadoEnvio =
  | { ok: true; providerMessageId: string | null; provider: string }
  | {
      ok: false
      provider: string
      /** Código curto e estável — é o que vai para `error_code` no log. */
      codigo: CodigoErroEnvio
      mensagem: string
      /** Erro passageiro merece nova tentativa; permanente, não. */
      reenviavel: boolean
      /** 429 do Telegram traz `retry_after`; respeitar é obrigatório (§7.1). */
      esperarSegundos?: number
    }

export const CODIGOS_ERRO_ENVIO = [
  'sem_credencial',
  'credencial_recusada',
  'destino_invalido',
  'sem_whatsapp',
  'limite_provedor',
  'instancia_desconectada',
  'bloqueado_pelo_destino',
  'provedor_indisponivel',
  'rede',
  'resposta_inesperada',
] as const

export type CodigoErroEnvio = (typeof CODIGOS_ERRO_ENVIO)[number]

export const CODIGO_ERRO_LABELS: Record<CodigoErroEnvio, string> = {
  sem_credencial: 'canal sem configuração',
  credencial_recusada: 'credencial recusada pelo provedor',
  destino_invalido: 'endereço inválido',
  sem_whatsapp: 'o número não tem WhatsApp',
  limite_provedor: 'limite do provedor atingido',
  instancia_desconectada: 'o número não está conectado',
  bloqueado_pelo_destino: 'o destinatário bloqueou o envio',
  provedor_indisponivel: 'o provedor não respondeu',
  rede: 'falha de rede',
  resposta_inesperada: 'resposta que não soubemos ler',
}

/** Um adaptador de canal. Um arquivo por canal, nada além disto exposto. */
export type AdaptadorCanal<Config = unknown> = {
  canal: Channel
  provider: string
  enviar: (destino: DestinoEnvio, config: Config) => Promise<ResultadoEnvio>
}

/** Erro de rede vira resultado, não exceção: quem chama trata um tipo só. */
export function falhaDeRede(provider: string, erro: unknown): ResultadoEnvio {
  const mensagem = erro instanceof Error ? erro.message : String(erro)
  const abortado = erro instanceof Error && erro.name === 'AbortError'

  return {
    ok: false,
    provider,
    codigo: abortado ? 'provedor_indisponivel' : 'rede',
    mensagem: abortado ? 'o provedor não respondeu a tempo' : mensagem,
    reenviavel: true,
  }
}

/** Tempo máximo de espera por provedor. Sem isso, um job trava a fila. */
export const TIMEOUT_PADRAO_MS = 15_000

export async function postJson(
  url: string,
  corpo: unknown,
  cabecalhos: Record<string, string>,
  timeoutMs = TIMEOUT_PADRAO_MS,
): Promise<Response> {
  const abortar = AbortSignal.timeout(timeoutMs)
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
    signal: abortar,
  })
}

/**
 * Lê o corpo da resposta sem estourar em resposta que não é JSON.
 *
 * Provedor fora do ar costuma devolver HTML de erro do balanceador, e um
 * `JSON.parse` cru transformaria "provedor caiu" numa exceção com mensagem
 * inútil.
 */
export async function lerJson(resposta: Response): Promise<unknown> {
  const texto = await resposta.text()
  if (texto.trim() === '') return null
  try {
    return JSON.parse(texto)
  } catch {
    return { _texto: texto.slice(0, 500) }
  }
}
