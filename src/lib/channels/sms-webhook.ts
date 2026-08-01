/**
 * Leitura da DLR — o aviso de entrega do SMS (§8.1, §8.4).
 *
 * Arquivo PURO, como os outros retornos.
 *
 * A DLR é o retorno mais bagunçado dos quatro canais, e por um motivo: ela
 * atravessa a operadora antes de chegar ao provedor. O SMSDev entrega por GET
 * com os campos na query string; a Comtele manda POST com JSON em PascalCase.
 * As duas formas caem no mesmo tipo aqui.
 *
 * O que a DLR NÃO faz é confirmar leitura — isso não existe em SMS. O melhor
 * que se sabe é que o aparelho recebeu.
 */

export type RetornoSms =
  | { tipo: 'status'; providerMessageId: string; estado: 'delivered' | 'failed'; detalhe: string }
  /** Resposta do destinatário. É por onde chega o "SAIR" (§14.1). */
  | { tipo: 'recebida'; telefone: string; texto: string }
  | { tipo: 'ignorado'; motivo: string }

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : null
}

/** Aceita número, porque a query string entrega tudo como texto e o JSON não. */
function comoTexto(valor: unknown): string | null {
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor)
  return texto(valor)
}

/**
 * Situações que os dois provedores usam, normalizadas.
 *
 * Só há dois destinos possíveis: entregue ou falhou. Estados intermediários
 * ("enviado à operadora", "aguardando") são ignorados de propósito — a
 * notificação já está em `sent`, e reescrever para o mesmo valor a cada passo
 * intermediário seria escrita à toa na tabela de maior volume do sistema.
 */
export function traduzirSituacao(bruto: string): 'delivered' | 'failed' | null {
  const s = bruto.trim().toUpperCase()

  if (['DELIVERED', 'ENTREGUE', 'DELIVRD', 'SUCCESS', 'OK', '1'].includes(s)) return 'delivered'
  if (
    ['UNDELIV', 'UNDELIVERED', 'NAO_ENTREGUE', 'NÃO ENTREGUE', 'FAILED', 'ERRO', 'ERROR', 'EXPIRED', 'REJECTD', 'REJECTED', '2'].includes(s)
  ) {
    return 'failed'
  }
  return null
}

/**
 * A DLR do SMSDev, que chega por GET.
 *
 * Campos conferidos contra o painel deles: `id` da mensagem e `situacao` com o
 * estado. Alguns planos mandam `status` em vez de `situacao`.
 */
export function lerDlrSmsDev(params: URLSearchParams): RetornoSms {
  const id = params.get('id') ?? params.get('ID')
  if (!id) return { tipo: 'ignorado', motivo: 'sem id da mensagem' }

  const bruto = params.get('situacao') ?? params.get('status') ?? ''
  const estado = traduzirSituacao(bruto)
  if (!estado) return { tipo: 'ignorado', motivo: `situação intermediária: ${bruto || 'vazia'}` }

  return {
    tipo: 'status',
    providerMessageId: id,
    estado,
    detalhe: bruto || estado,
  }
}

/** A DLR da Comtele, que chega por POST com JSON em PascalCase. */
export function lerDlrComtele(corpo: unknown): RetornoSms {
  if (typeof corpo !== 'object' || corpo === null) return { tipo: 'ignorado', motivo: 'corpo vazio' }
  const c = corpo as Record<string, unknown>

  /*
   * A Comtele usa o MESMO endereço para DLR e para resposta do destinatário,
   * distinguindo pela presença de `Message`/`Content`. Tratar tudo como DLR
   * faria um "SAIR" virar um status desconhecido e ser descartado.
   */
  const resposta = texto(c.Message) ?? texto(c.Content) ?? texto(c.message)
  const remetente = comoTexto(c.Sender) ?? comoTexto(c.PhoneNumber) ?? comoTexto(c.sender)

  if (resposta && remetente) {
    return { tipo: 'recebida', telefone: remetente, texto: resposta }
  }

  const id = comoTexto(c.MessageId) ?? comoTexto(c.Id) ?? comoTexto(c.id)
  if (!id) return { tipo: 'ignorado', motivo: 'sem id da mensagem' }

  const bruto = texto(c.Status) ?? texto(c.Situation) ?? comoTexto(c.StatusCode) ?? ''
  const estado = traduzirSituacao(bruto)
  if (!estado) return { tipo: 'ignorado', motivo: `situação intermediária: ${bruto || 'vazia'}` }

  return { tipo: 'status', providerMessageId: id, estado, detalhe: bruto }
}

/**
 * A resposta do destinatário no SMSDev, que também chega por GET.
 *
 * Só existe para quem contrata número de duas vias. Sem isso, o "SAIR" por SMS
 * não tem como chegar — e é por isso que a mensagem de SMS precisa mandar a
 * pessoa responder no WhatsApp ou clicar no link de descadastro.
 */
export function lerRespostaSmsDev(params: URLSearchParams): RetornoSms {
  const telefone = params.get('telefone') ?? params.get('number') ?? params.get('from')
  const conteudo = params.get('mensagem') ?? params.get('msg') ?? params.get('text')

  if (!telefone || !conteudo) return { tipo: 'ignorado', motivo: 'não é resposta' }
  return { tipo: 'recebida', telefone, texto: conteudo }
}
