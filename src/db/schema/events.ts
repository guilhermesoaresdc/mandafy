import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { sources } from './sources'
import { contacts } from './contacts'

/**
 * Ambas as tabelas deste arquivo são PARTICIONADAS POR DIA no SQL
 * (drizzle/0005_events.sql). O drizzle-kit não modela partições — por isso as
 * migrations são escritas à mão e este arquivo existe apenas para tipar as
 * queries. A chave primária é composta porque o Postgres exige que a coluna de
 * partição participe de toda chave única.
 */

/** Cru: tudo que chega, sem processar. Auditoria + replay. Retenção 7 dias. */
export const eventsRaw = pgTable(
  'events_raw',
  {
    id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity(),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    headers: jsonb('headers').$type<Record<string, string>>(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    /** sha256(source_id + corpo). Plataformas fazem retry com frequência (§4.3). */
    dedupeHash: text('dedupe_hash'),
    signatureOk: boolean('signature_ok'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.receivedAt] }),
    index('events_raw_dedupe_idx')
      .on(t.dedupeHash, t.receivedAt.desc())
      .where(sql`${t.dedupeHash} IS NOT NULL`),
    index('events_raw_pending_idx').on(t.receivedAt).where(sql`${t.processedAt} IS NULL`),
    index('events_raw_source_idx').on(t.sourceId, t.receivedAt.desc()),
  ],
)

/** Normalizado: é sobre isto que os fluxos disparam. Retenção 30 dias. */
export const events = pgTable(
  'events',
  {
    id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    /** Evento canônico (§4.1). */
    type: text('type').notNull(),
    /** id do pedido/usuário na origem */
    externalId: text('external_id'),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Valores normalizados que alimentam as variáveis das mensagens (§6.3). */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    rawId: bigint('raw_id', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.occurredAt] }),
    index('events_org_type_idx').on(t.orgId, t.type, t.occurredAt.desc()),
    index('events_contact_idx').on(t.contactId, t.occurredAt.desc()),
    uniqueIndex('events_source_type_external_uq').on(t.sourceId, t.type, t.externalId, t.occurredAt),
    index('events_org_external_idx')
      .on(t.orgId, t.externalId, t.occurredAt.desc())
      .where(sql`${t.externalId} IS NOT NULL`),
  ],
)

export type EventRaw = typeof eventsRaw.$inferSelect
export type NewEventRaw = typeof eventsRaw.$inferInsert
export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
