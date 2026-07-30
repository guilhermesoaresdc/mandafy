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

  const bruto = comoTexto(getByPath(payload, mapping.event_path))
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
    quantidade: { path: '$.data.order.tickets', transform: 'inteiro' },
    campanha: '$.data.campaign.title',
    pix_copia_cola: '$.data.order.pix_code',
    link_pagamento: '$.data.order.checkout_url',
    premio: '$.data.campaign.prize',
  },
}

/** Campos canônicos oferecidos na tela de mapeamento, com rótulo em pt-BR. */
export const CAMPOS_CANONICOS = [
  { chave: 'external_id', rotulo: 'Número do pedido', dica: 'Amarra o cancelamento ao pagamento' },
  { chave: 'valor_cents', rotulo: 'Valor', dica: 'Usado em {{valor|moeda}}' },
  { chave: 'quantidade', rotulo: 'Quantidade de números' },
  { chave: 'campanha', rotulo: 'Nome da campanha' },
  { chave: 'pix_copia_cola', rotulo: 'PIX copia e cola' },
  { chave: 'link_pagamento', rotulo: 'Link de pagamento' },
  { chave: 'premio', rotulo: 'Prêmio' },
] as const
