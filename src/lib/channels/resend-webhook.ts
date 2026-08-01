import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Leitura do retorno da Resend (§8.3, §14.1).
 *
 * Este arquivo é PURO: recebe corpo e cabeçalhos, devolve um retorno já
 * classificado. Nada de banco, nada de rede — é o que permite ter teste do
 * formato sem depender do provedor.
 *
 * O que está em jogo aqui não é o relatório de entrega: é a reputação do
 * domínio. Endereço que dá hard bounce e continua na fila queima o IP de envio
 * sozinho, e quem marca como spam e continua recebendo derruba junto todo o
 * resto. Por isso `bounced` e `complained` viram supressão IMEDIATA, e não uma
 * contagem que alguém revisa depois.
 *
 * Envelope da Resend:
 *   { type: "email.delivered", created_at: "...", data: { email_id, to: [...] } }
 */

export type RetornoEmail =
  /** Confirmação de entrega na caixa do destinatário. */
  | { tipo: 'entregue'; providerMessageId: string; email: string | null }
  /** Abertura ou clique. Não muda status, mas alimenta o histórico. */
  | { tipo: 'engajou'; providerMessageId: string; email: string | null; acao: 'aberto' | 'clicado' }
  /**
   * Falha permanente ou reclamação: bloqueia o endereço.
   * `razao` é o motivo que vai para `suppressions.reason`.
   */
  | {
      tipo: 'bloquear'
      providerMessageId: string | null
      email: string | null
      razao: 'hard_bounce' | 'complaint' | 'invalid'
      detalhe: string
    }
  /** Evento que não nos interessa. Responder 200 e seguir. */
  | { tipo: 'ignorado'; evento: string }

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null
}

/**
 * O destinatário, que a Resend manda como lista.
 *
 * Só o primeiro interessa: o Mandafy sempre envia para um endereço por
 * mensagem (ver `enviarResend`), então uma lista com dois itens seria uma
 * mensagem que não saiu daqui.
 */
export function destinatario(data: Record<string, unknown>): string | null {
  const para = data.to
  if (Array.isArray(para)) return texto(para[0])
  return texto(para)
}

/**
 * Distingue rejeição definitiva de temporária.
 *
 * A diferença é cara nos dois sentidos: tratar soft como hard descarta cliente
 * bom por uma caixa cheia que esvazia amanhã; tratar hard como soft mantém na
 * lista um endereço que não existe, que é o que queima a reputação. Quando a
 * Resend não diz qual é, o padrão é NÃO bloquear — errar para o lado de manter
 * o contato é recuperável, o contrário não é.
 */
export function ehBounceDefinitivo(data: Record<string, unknown>): boolean {
  const bounce = data.bounce
  const sub =
    typeof bounce === 'object' && bounce !== null
      ? texto((bounce as Record<string, unknown>).type) ??
        texto((bounce as Record<string, unknown>).subType)
      : null

  const tipo = (sub ?? texto(data.bounce_type) ?? '').toLowerCase()
  if (tipo === '') return false
  if (tipo.includes('transient') || tipo.includes('soft')) return false
  return tipo.includes('permanent') || tipo.includes('hard') || tipo.includes('undetermined')
}

export function lerRetornoEmail(corpo: unknown): RetornoEmail | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const envelope = corpo as Record<string, unknown>

  const evento = texto(envelope.type)
  if (!evento) return null

  const data =
    typeof envelope.data === 'object' && envelope.data !== null
      ? (envelope.data as Record<string, unknown>)
      : {}

  const id = texto(data.email_id) ?? texto(data.id)
  const email = destinatario(data)

  switch (evento) {
    case 'email.delivered':
      return id ? { tipo: 'entregue', providerMessageId: id, email } : { tipo: 'ignorado', evento }

    case 'email.opened':
      return id
        ? { tipo: 'engajou', providerMessageId: id, email, acao: 'aberto' }
        : { tipo: 'ignorado', evento }

    case 'email.clicked':
      return id
        ? { tipo: 'engajou', providerMessageId: id, email, acao: 'clicado' }
        : { tipo: 'ignorado', evento }

    case 'email.bounced': {
      // Soft bounce não bloqueia: a fila já tem retry para isso.
      if (!ehBounceDefinitivo(data)) return { tipo: 'ignorado', evento: `${evento}.soft` }
      return {
        tipo: 'bloquear',
        providerMessageId: id,
        email,
        razao: 'hard_bounce',
        detalhe: 'o endereço devolveu recusa definitiva',
      }
    }

    case 'email.complained':
      return {
        tipo: 'bloquear',
        providerMessageId: id,
        email,
        razao: 'complaint',
        detalhe: 'marcou o e-mail como spam',
      }

    /*
     * `failed` é a Resend dizendo que nem tentou entregar — endereço malformado
     * na maioria dos casos. Bloqueia como inválido, que é diferente de bounce:
     * na tela de privacidade os dois aparecem com motivos distintos.
     */
    case 'email.failed':
      return {
        tipo: 'bloquear',
        providerMessageId: id,
        email,
        razao: 'invalid',
        detalhe: texto(data.reason) ?? 'o provedor recusou o endereço',
      }

    default:
      return { tipo: 'ignorado', evento }
  }
}

/**
 * Assinatura Svix, que é o que a Resend usa (§12.3 vale para os nossos webhooks
 * de saída; este é o de entrada, e segue o formato do provedor).
 *
 * Conferida POR CIMA do token da URL, nunca no lugar dele: se o segredo não
 * estiver configurado o token ainda protege, mas com ele configurado nem um
 * token vazado basta para forjar um bounce — e um bounce forjado é um cliente
 * bloqueado sem motivo.
 *
 * O segredo vem como `whsec_<base64>`; o que assina é o base64 decodificado.
 */
export function assinaturaValida(
  segredo: string,
  cabecalhos: { id: string | null; timestamp: string | null; signature: string | null },
  corpoBruto: string,
  agora = new Date(),
): boolean {
  const { id, timestamp, signature } = cabecalhos
  if (!id || !timestamp || !signature) return false

  // Tolerância de 5 minutos contra replay, a mesma dos webhooks de saída.
  const quando = Number(timestamp)
  if (!Number.isFinite(quando)) return false
  if (Math.abs(agora.getTime() / 1000 - quando) > 300) return false

  const chave = Buffer.from(segredo.replace(/^whsec_/, ''), 'base64')
  const esperada = createHmac('sha256', chave)
    .update(`${id}.${timestamp}.${corpoBruto}`)
    .digest('base64')

  /*
   * O header carrega uma LISTA — `v1,<assinatura> v1,<outra>` — porque durante
   * uma rotação de segredo os dois valores viajam juntos. Conferir só o
   * primeiro derrubaria todo webhook durante a rotação.
   */
  return signature
    .split(' ')
    .filter((parte) => parte.startsWith('v1,'))
    .some((parte) => comparaSegura(parte.slice(3), esperada))
}

/** Comparação de tempo constante; comprimentos diferentes já saem falso. */
function comparaSegura(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
