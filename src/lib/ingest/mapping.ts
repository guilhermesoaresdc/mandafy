import { z } from 'zod'
import { CANONICAL_EVENTS, type CanonicalEvent } from '@/db/schema/enums'
import { toE164 } from '@/lib/phone'
import { getByPath } from './path'
import { applyTransform, isTransformName, type TransformName } from './transforms'

/**
 * Tradução declarativa de payload de plataforma → evento canônico (§4.2).
 *
 * É o que torna o sistema plugável em qualquer plataforma de sorteio sem
 * escrever código novo: o conector guarda um mapeamento, e este módulo o
 * executa. Nenhuma regra de plataforma específica mora aqui.
 */

const fieldSpec = z.union([
  z.string(),
  z.object({
    path: z.string(),
    transform: z.string().optional(),
    /** Usado quando o caminho não existe no payload. */
    default: z.unknown().optional(),
  }),
])

export const mappingSchema = z.object({
  /** Onde está o nome do evento no payload. */
  event_path: z.string().default('$.event'),
  /** Nome na plataforma → evento canônico. */
  event_map: z.record(z.string(), z.string()).default({}),
  /** Campos do contato. */
  contact: z
    .object({
      external_id: fieldSpec.optional(),
      name: fieldSpec.optional(),
      phone: fieldSpec.optional(),
      email: fieldSpec.optional(),
      cpf: fieldSpec.optional(),
      telegram_chat_id: fieldSpec.optional(),
    })
    .default({}),
  /** Campos livres que alimentam as variáveis das mensagens (§6.3). */
  fields: z.record(z.string(), fieldSpec).default({}),
})

export type SourceMappingInput = z.input<typeof mappingSchema>
export type SourceMapping = z.output<typeof mappingSchema>

export type NormalizedContact = {
  externalId?: string
  name?: string
  phoneE164?: string
  email?: string
  cpf?: string
  telegramChatId?: number
}

export type NormalizedEvent = {
  type: CanonicalEvent
  externalId?: string
  contact: NormalizedContact
  data: Record<string, unknown>
}

export type MappingFailure =
  | { reason: 'mapeamento_invalido'; detail: string }
  | { reason: 'evento_ausente'; detail: string }
  | { reason: 'evento_nao_mapeado'; detail: string }

export type MappingResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; failure: MappingFailure }

const CANONICAL = new Set<string>(CANONICAL_EVENTS)

/**
 * Onde a rota de entrada guarda o evento que veio na URL (`?evento=`).
 *
 * Chave reservada, com prefixo, porque ela convive dentro do payload da
 * plataforma: o nome precisa ser um que nenhum sistema de sorteio use por
 * acidente. O corpo original fica intacto ao lado — é ele que a tela de
 * mapeamento mostra e é ele que o replay reexecuta.
 */
export const CHAVE_EVENTO_NA_URL = '_mandafy_evento'

/**
 * O nome que a plataforma deu ao evento, sem depender do mapeamento.
 *
 * A tela de conexão precisa dizer O QUE chegou antes de a tradução existir —
 * é justamente para quem ainda não configurou que ela serve. Antes disto o
 * passo 2 mostrava só a hora: quem tinha acabado de criar uma conta de teste
 * não tinha como saber se o que chegou foi o cadastro ou outra coisa.
 *
 * A ordem segue a de `applyMapping`: primeiro os nomes usuais do corpo, depois
 * a chave da URL como reserva. Os apelidos vêm de plataformas reais — cada uma
 * chama esse campo de um jeito.
 */
export function nomeDoEvento(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const objeto = payload as Record<string, unknown>

  for (const chave of ['event', 'evento', 'type', 'tipo', 'event_type', 'eventType']) {
    const valor = objeto[chave]
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim()
  }

  const daUrl = objeto[CHAVE_EVENTO_NA_URL]
  return typeof daUrl === 'string' && daUrl.trim() !== '' ? daUrl.trim() : null
}

/** Extrai um campo, aplicando transformação e padrão. */
function extract(payload: unknown, spec: z.output<typeof fieldSpec>): unknown {
  if (typeof spec === 'string') return getByPath(payload, spec)

  const bruto = getByPath(payload, spec.path)
  if (bruto === undefined || bruto === null) return spec.default

  if (spec.transform) {
    if (!isTransformName(spec.transform)) return undefined
    const convertido = applyTransform(bruto, spec.transform as TransformName)
    return convertido === undefined ? spec.default : convertido
  }

  return bruto
}

function comoTexto(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object') return undefined
  const texto = String(value).trim()
  return texto === '' ? undefined : texto
}

/**
 * Aplica o mapeamento a um payload cru.
 *
 * Nunca lança: o payload vem de webhook externo e pode ser qualquer coisa.
 * Toda falha volta como `{ ok: false }` com o motivo, que é gravado em
 * `events_raw.error` para o operador ver na tela de conexão.
 */
export function applyMapping(payload: unknown, rawMapping: unknown): MappingResult {
  const parsed = mappingSchema.safeParse(rawMapping ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      failure: { reason: 'mapeamento_invalido', detail: parsed.error.issues[0]?.message ?? 'inválido' },
    }
  }
  const mapping = parsed.data

  /*
   * O corpo primeiro, a URL como reserva.
   *
   * Nessa ordem porque acrescentar `?evento=` a uma integração que já funciona
   * não pode mudar o que ela faz. A URL só responde quando o corpo cala — que é
   * o caso das plataformas que cadastram uma URL por tipo de evento, onde o
   * endereço É a declaração do que aconteceu.
   */
  const bruto =
    comoTexto(getByPath(payload, mapping.event_path)) ??
    comoTexto(getByPath(payload, `$.${CHAVE_EVENTO_NA_URL}`))

  if (!bruto) {
    return {
      ok: false,
      failure: {
        reason: 'evento_ausente',
        detail: `nenhum valor em ${mapping.event_path}`,
      },
    }
  }

  // O nome do evento na plataforma pode vir com caixa e espaços variados.
  const chave = bruto.trim()
  const alvo =
    mapping.event_map[chave] ??
    mapping.event_map[chave.toLowerCase()] ??
    // Se a plataforma já manda o nome canônico, aceita direto.
    (CANONICAL.has(chave) ? chave : undefined)

  if (!alvo || !CANONICAL.has(alvo)) {
    return {
      ok: false,
      failure: {
        reason: 'evento_nao_mapeado',
        detail: `"${chave}" não está no mapa de eventos`,
      },
    }
  }

  const contact: NormalizedContact = {}
  const c = mapping.contact

  if (c.external_id) contact.externalId = comoTexto(extract(payload, c.external_id))
  if (c.name) contact.name = comoTexto(extract(payload, c.name))
  if (c.email) contact.email = comoTexto(extract(payload, c.email))?.toLowerCase()
  if (c.cpf) contact.cpf = comoTexto(extract(payload, c.cpf))?.replace(/\D/g, '')

  if (c.phone) {
    // Telefone é normalizado para E.164 aqui, e não no banco: é o que garante
    // que a mesma pessoa não vire três contatos (§3.3).
    const e164 = toE164(comoTexto(extract(payload, c.phone)))
    if (e164) contact.phoneE164 = e164
  }

  if (c.telegram_chat_id) {
    const n = Number(comoTexto(extract(payload, c.telegram_chat_id)))
    if (Number.isSafeInteger(n) && n !== 0) contact.telegramChatId = n
  }

  const data: Record<string, unknown> = {}
  for (const [nome, spec] of Object.entries(mapping.fields)) {
    const valor = extract(payload, spec)
    if (valor !== undefined) data[nome] = valor
  }

  return {
    ok: true,
    event: {
      type: alvo as CanonicalEvent,
      externalId: comoTexto(data.external_id),
      contact,
      data,
    },
  }
}

/**
 * Mapeamento inicial sugerido, com os nomes de evento do print que a spec
 * menciona em §4.2. Serve de ponto de partida na tela de conexão — a pessoa
 * ajusta arrastando, não digitando JSON.
 */
export const MAPEAMENTO_SUGERIDO: SourceMappingInput = {
  event_path: '$.event',
  event_map: {
    novo_usuario: 'user.created',
    qrcode_criado: 'order.created',
    qrcode_pago: 'order.paid',
    pedido_cancelado: 'order.cancelled',
    bilhete_premiado: 'ticket.awarded',
    saque_pendente: 'withdrawal.pending',
    saque_finalizado: 'withdrawal.completed',
    nova_campanha: 'campaign.created',
  },
  contact: {
    external_id: '$.data.user.id',
    name: '$.data.user.name',
    phone: '$.data.user.phone',
    email: '$.data.user.email',
  },
  fields: {
    external_id: '$.data.order.id',
    valor_cents: { path: '$.data.order.amount', transform: 'reais_para_centavos' },
    retorno_cents: { path: '$.data.order.payout', transform: 'reais_para_centavos' },
    sorteio: '$.data.draw.name',
    fecha_em: '$.data.draw.closes_at',
    modalidade: '$.data.bet.type',
    palpite: '$.data.bet.pick',
    pix_copia_cola: '$.data.order.pix_code',
    link_pagamento: '$.data.order.checkout_url',
  },
}

/**
 * Campos canônicos oferecidos na tela de mapeamento, com rótulo em pt-BR.
 *
 * ESTA LISTA E O CATÁLOGO DE MENSAGENS ANDAM JUNTOS.
 *
 * Cada `{{variavel}}` que uma mensagem escreve precisa ter de onde vir, e é
 * daqui que ela vem. Enquanto a lista falava de rifa — "quantidade de números",
 * "campanha", "prêmio" — e as mensagens já falavam de banca, conectar a
 * plataforma produzia mensagens sem `{{sorteio}}`, sem `{{palpite}}` e sem
 * `{{fecha_em}}`: nada quebrava na tela, e os envios morriam com
 * `variavel_ausente` depois. `tests/mapeamento.test.ts` prende as duas pontas.
 *
 * `nome`, `telefone` e `email` NÃO entram aqui: eles vêm da identidade do
 * contato, mapeada no bloco `contact`, e o enfileiramento os injeta nas
 * variáveis a cada envio.
 */
export const CAMPOS_CANONICOS = [
  { chave: 'external_id', rotulo: 'Número da aposta', dica: 'Amarra o cancelamento ao pagamento' },
  { chave: 'valor_cents', rotulo: 'Valor apostado', dica: 'Usado em {{valor_cents|moeda}}' },
  { chave: 'retorno_cents', rotulo: 'Quanto paga se ganhar' },
  { chave: 'sorteio', rotulo: 'Sorteio', dica: 'PTV 18h, Federal, Corujinha…' },
  { chave: 'fecha_em', rotulo: 'Hora que fecha', dica: 'A urgência real: depois disso não entra' },
  { chave: 'modalidade', rotulo: 'Modalidade', dica: 'Grupo, dezena, centena, milhar' },
  { chave: 'palpite', rotulo: 'Palpite' },
  { chave: 'saldo_cents', rotulo: 'Saldo na conta' },
  { chave: 'milhar', rotulo: 'Milhar sorteada', dica: 'Texto, para não perder o zero à esquerda' },
  { chave: 'grupo', rotulo: 'Grupo' },
  { chave: 'bicho', rotulo: 'Bicho' },
  { chave: 'pix_copia_cola', rotulo: 'PIX copia e cola' },
  { chave: 'link_pagamento', rotulo: 'Link de pagamento' },
  { chave: 'link_resultado', rotulo: 'Link do resultado' },
] as const
