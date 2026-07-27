import {
  bigint,
  date,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { CHANNELS, NOTIFICATION_STATUSES } from './enums'

/**
 * Fila e log de notificações (§3.6). PARTICIONADA POR DIA no SQL, retenção de
 * 3 dias quentes. Sem FK para contacts/messages/flows de propósito: é a tabela
 * de maior volume de escrita e cada FK custa uma verificação por linha. O
 * vínculo é lógico; o que importa (o tenant) tem FK e RLS.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').notNull().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    contactId: uuid('contact_id'),
    messageId: uuid('message_id'),
    variantId: uuid('variant_id'),
    flowId: uuid('flow_id'),
    stepId: uuid('step_id'),
    eventId: bigint('event_id', { mode: 'number' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),

    /** Máquina de estados de §8.1. */
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('queued'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),

    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    /** Qual número/instância enviou (§7.3). */
    providerInstance: text('provider_instance'),

    /** Exatamente o que foi enviado, para auditoria (§6.5). */
    renderedSubject: text('rendered_subject'),
    renderedBody: text('rendered_body'),

    attempts: smallint('attempts').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    /** 'order:12345' — permite cancelar em lote quando o pagamento chega (§5.1). */
    cancelKey: text('cancel_key'),
    dedupeKey: text('dedupe_key'),
    queueJobId: text('queue_job_id'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('notifications_org_created_idx').on(t.orgId, t.createdAt.desc()),
    // O índice do cancelamento por chave: só interessa o que ainda não saiu.
    index('notifications_cancel_key_idx')
      .on(t.cancelKey)
      .where(sql`${t.status} IN ('queued', 'scheduled')`),
    index('notifications_channel_status_idx').on(t.channel, t.status, t.createdAt.desc()),
    // Alimenta a barra de pulso (§11.6) e a lista de próximos envios.
    index('notifications_scheduled_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} IN ('queued', 'scheduled')`),
    index('notifications_contact_idx').on(t.contactId, t.createdAt.desc()),
    // Unicidade por dia: numa tabela particionada o índice único precisa
    // conter a coluna de partição. Suficiente na prática — o dedupe protege
    // contra reenfileiramento do mesmo passo, que ocorre em minutos.
    uniqueIndex('notifications_dedupe_uq')
      .on(t.dedupeKey, t.createdAt)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
  ],
)

/** Camada morna: 30 dias, sem partição (§10.2). Mesmo formato da quente. */
export const notificationsArchive = pgTable(
  'notifications_archive',
  {
    id: uuid('id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    contactId: uuid('contact_id'),
    messageId: uuid('message_id'),
    variantId: uuid('variant_id'),
    flowId: uuid('flow_id'),
    stepId: uuid('step_id'),
    eventId: bigint('event_id', { mode: 'number' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    providerInstance: text('provider_instance'),
    renderedSubject: text('rendered_subject'),
    renderedBody: text('rendered_body'),
    attempts: smallint('attempts').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    cancelKey: text('cancel_key'),
    dedupeKey: text('dedupe_key'),
    queueJobId: text('queue_job_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index('notifications_archive_org_created_idx').on(t.orgId, t.createdAt.desc()),
  ],
)

/**
 * Camada fria: 12 meses de agregados (§10.2). Também é a fonte dos contadores
 * do painel — nunca COUNT(*) em tabela grande (§13.2).
 *
 * `flowId` não pode ser nulo por compor a chave primária; o UUID zerado
 * representa "envio sem fluxo" (disparo manual ou via API).
 */
export const notificationDailyStats = pgTable(
  'notification_daily_stats',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    flowId: uuid('flow_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    total: bigint('total', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day, t.channel, t.status, t.flowId] })],
)

export type Notification = typeof notifications.$inferSelect
export type NewNotification = typeof notifications.$inferInsert
export type NotificationArchive = typeof notificationsArchive.$inferSelect
export type NotificationDailyStat = typeof notificationDailyStats.$inferSelect
