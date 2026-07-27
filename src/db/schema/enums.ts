/**
 * Enumerações do domínio.
 *
 * Não usamos `pgEnum`: as colunas são `text` com `CHECK` no SQL (ver drizzle/).
 * Tipos nativos do Postgres são caros de alterar e a spec (§3) as define como
 * text com check. Aqui ficam os valores canônicos e os tipos derivados.
 */

// ── Canais (§3.4) ────────────────────────────────────────────────────────────

export const CHANNELS = ['whatsapp', 'email', 'sms', 'telegram'] as const
export type Channel = (typeof CHANNELS)[number]

export const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  sms: 'SMS',
  telegram: 'Telegram',
}

/** Sigla de 2–3 letras usada no log denso do histórico (§10.1). */
export const CHANNEL_SHORT: Record<Channel, string> = {
  whatsapp: 'WA',
  email: 'EM',
  sms: 'SMS',
  telegram: 'TG',
}

/** Variável CSS com a cor do canal (§11.2). A cor só aparece em elemento ativo. */
export const CHANNEL_COLOR_VAR: Record<Channel, string> = {
  whatsapp: '--color-ch-whatsapp',
  email: '--color-ch-email',
  sms: '--color-ch-sms',
  telegram: '--color-ch-telegram',
}

// ── Pessoas e acesso (§3.1, §9.4) ────────────────────────────────────────────

export const USER_ROLES = ['admin', 'consultor'] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  consultor: 'Consultor',
}

// ── Notificações (§8.1) ──────────────────────────────────────────────────────

export const NOTIFICATION_STATUSES = [
  'queued',
  'scheduled',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'dead',
  'cancelled',
  'skipped',
] as const
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number]

export const NOTIFICATION_STATUS_LABELS: Record<NotificationStatus, string> = {
  queued: 'na fila',
  scheduled: 'agendado',
  sending: 'enviando',
  sent: 'enviado',
  delivered: 'entregue',
  read: 'lido',
  failed: 'falhou',
  dead: 'desistiu',
  cancelled: 'cancelado',
  skipped: 'pulado',
}

/** Estados em que o envio ainda pode ser cancelado por chave (§5.1). */
export const CANCELLABLE_STATUSES = ['queued', 'scheduled'] as const

// ── Mensagens (§3.4, §14.1) ──────────────────────────────────────────────────

export const MESSAGE_CATEGORIES = ['transacional', 'recuperacao', 'relacionamento'] as const
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number]

export const MESSAGE_CATEGORY_LABELS: Record<MessageCategory, string> = {
  transacional: 'Transacional',
  recuperacao: 'Recuperação',
  relacionamento: 'Relacionamento',
}

/**
 * Base legal por categoria (§14.1). Promocional exige `optin_at` registrado;
 * transacional se apoia em execução de contrato.
 */
export const CATEGORY_REQUIRES_OPTIN: Record<MessageCategory, boolean> = {
  transacional: false,
  recuperacao: true,
  relacionamento: true,
}

// ── Ritmo de envio (§7.2) ────────────────────────────────────────────────────

export const JITTER_MODES = ['instantaneo', 'fixo', 'faixa', 'humano'] as const
export type JitterMode = (typeof JITTER_MODES)[number]

export const JITTER_MODE_LABELS: Record<JitterMode, string> = {
  instantaneo: 'Instantâneo',
  fixo: 'Fixo',
  faixa: 'Faixa',
  humano: 'Humano',
}

// ── CRM (§3.7) ───────────────────────────────────────────────────────────────

export const LEAD_STATUSES = ['aberto', 'ganho', 'perdido'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LEAD_ACTIVITY_TYPES = ['nota', 'ligacao', 'mudanca_etapa', 'mensagem'] as const
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number]

// ── Instâncias de WhatsApp (§3.8, §7.3) ──────────────────────────────────────

export const WA_STATUSES = ['conectando', 'conectado', 'desconectado', 'banido'] as const
export type WaStatus = (typeof WA_STATUSES)[number]

/**
 * Escada de aquecimento (§7.3). O índice do array é o `warmup_stage`.
 * A progressão é automática, mas só avança se a taxa de falha ficar < 3%.
 */
export const WARMUP_LADDER = [
  { stage: 0, label: 'Novo', dailyCap: 20, minIntervalSeconds: 60 },
  { stage: 1, label: 'Inicial', dailyCap: 50, minIntervalSeconds: 40 },
  { stage: 2, label: 'Crescendo', dailyCap: 120, minIntervalSeconds: 25 },
  { stage: 3, label: 'Estável', dailyCap: 300, minIntervalSeconds: 15 },
  { stage: 4, label: 'Maduro', dailyCap: 600, minIntervalSeconds: 8 },
  { stage: 5, label: 'Consolidado', dailyCap: 1000, minIntervalSeconds: 5 },
] as const

// ── Supressões (§3.3) ────────────────────────────────────────────────────────

export const SUPPRESSION_REASONS = ['hard_bounce', 'invalid', 'optout', 'complaint'] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

// ── Eventos canônicos (§4.1) ─────────────────────────────────────────────────

/** Vêm das plataformas de sorteio, traduzidos pelo mapeamento do conector. */
export const PLATFORM_EVENTS = [
  'user.created',
  'order.created',
  'order.paid',
  'order.expired',
  'order.cancelled',
  'ticket.awarded',
  'withdrawal.pending',
  'withdrawal.completed',
  'campaign.created',
  'campaign.ending_soon',
] as const

/** Gerados internamente pelo Mandafy, nunca pela plataforma. */
export const INTERNAL_EVENTS = [
  'contact.inactive_7d',
  'contact.inactive_30d',
  'contact.first_purchase',
  'contact.repeat_purchase',
  'campaign.ending_24h',
] as const

export const CANONICAL_EVENTS = [...PLATFORM_EVENTS, ...INTERNAL_EVENTS] as const
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number]

/**
 * Transacionais críticos ignoram a janela de silêncio por padrão (§7.4).
 * Configurável por mensagem depois.
 */
export const CRITICAL_TRANSACTIONAL_EVENTS = [
  'order.paid',
  'ticket.awarded',
  'withdrawal.completed',
] as const

// ── Plataformas de origem (§3.1) ─────────────────────────────────────────────

export const SOURCE_PLATFORMS = ['generico', 'rifei', 'custom'] as const
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number]
