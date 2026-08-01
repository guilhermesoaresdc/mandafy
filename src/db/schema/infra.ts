import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { users } from './users'
import { CHANNELS, WA_STATUSES } from './enums'
import { bytea } from './types'

/** Credenciais de provedor cifradas em repouso — AES-256-GCM (§14.1). */
export const channelConfigs = pgTable(
  'channel_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    provider: text('provider').notNull(),
    credentialsEncrypted: bytea('credentials_encrypted'),
    rateLimitPerMinute: integer('rate_limit_per_minute'),
    dailyCap: integer('daily_cap'),
    active: boolean('active').notNull().default(true),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_configs_default_uq').on(t.orgId, t.channel).where(sql`${t.isDefault}`),
    index('channel_configs_org_idx').on(t.orgId),
  ],
)

/** Instâncias de WhatsApp na Evolution API, com aquecimento e rodízio (§7.3). */
export const waInstances = pgTable(
  'wa_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    evolutionUrl: text('evolution_url').notNull(),
    instanceName: text('instance_name').notNull(),
    apikeyEncrypted: bytea('apikey_encrypted'),
    phoneE164: text('phone_e164'),
    status: text('status', { enum: WA_STATUSES }).notNull().default('desconectado'),
    /** 0 = novo … 5 = consolidado. Define dailyCap e minIntervalSeconds (§7.3). */
    warmupStage: smallint('warmup_stage').notNull().default(0),
    warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
    dailyCap: integer('daily_cap').notNull().default(20),
    minIntervalSeconds: integer('min_interval_seconds').notNull().default(60),
    sentToday: integer('sent_today').notNull().default(0),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /** A progressão do aquecimento só avança com falha abaixo de 3% (§7.3). */
    failureRate24h: numeric('failure_rate_24h', { precision: 5, scale: 4 }).notNull().default('0'),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    proxyUrl: text('proxy_url'),
    /**
     * `true` = o Mandafy criou esta instância na Evolution. Só essas podem ser
     * APAGADAS do servidor — o resto foi colado de fora, e mexer derrubaria o
     * WhatsApp de outro sistema que compartilha a mesma Evolution.
     */
    managed: boolean('managed').notNull().default(false),
    /** Segredo na URL do webhook de retorno: a Evolution não assina o que envia. */
    webhookToken: text('webhook_token'),
    /** Peso para o rodízio entre números. */
    weight: integer('weight').notNull().default(1),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('wa_instances_org_name_uq').on(t.orgId, t.instanceName),
    index('wa_instances_org_active_idx').on(t.orgId).where(sql`${t.active}`),
  ],
)

/**
 * Chaves da API pública (§12.1). Guardamos só o sha256; `keyPrefix`
 * (mandafy_live_a1b2…) serve para o usuário reconhecer a chave na lista.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_org_idx').on(t.orgId)],
)

/** Webhooks de saída (§12.3). Assinatura HMAC-SHA256 em X-Mandafy-Signature. */
export const outboundWebhooks = pgTable(
  'outbound_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: text('events').array().notNull().default(sql`'{}'`),
    secret: text('secret').notNull(),
    active: boolean('active').notNull().default(true),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /** Após 5 falhas seguidas o webhook é desativado e o admin é alertado. */
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbound_webhooks_org_idx').on(t.orgId)],
)

/** Auditoria de todo acesso e alteração de dado pessoal (§14.1). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_created_idx').on(t.orgId, t.createdAt.desc()),
    index('audit_log_entity_idx').on(t.entity, t.entityId, t.createdAt.desc()),
  ],
)

/**
 * Quando cada tarefa periódica rodou pela última vez (§7.1).
 *
 * O worker guardava isso na própria fila do BullMQ, que é um processo de pé. Um
 * tick disparado por HTTP nasce sem memória: precisa perguntar ao banco se a
 * manutenção desta hora já aconteceu. Sem org_id — são tarefas do sistema.
 */
export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
})

export type ChannelConfig = typeof channelConfigs.$inferSelect
export type NewChannelConfig = typeof channelConfigs.$inferInsert
export type WaInstance = typeof waInstances.$inferSelect
export type NewWaInstance = typeof waInstances.$inferInsert
export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert
export type OutboundWebhook = typeof outboundWebhooks.$inferSelect
export type NewOutboundWebhook = typeof outboundWebhooks.$inferInsert
export type AuditLogEntry = typeof auditLog.$inferSelect
export type NewAuditLogEntry = typeof auditLog.$inferInsert
