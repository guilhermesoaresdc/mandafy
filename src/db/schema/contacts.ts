import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { CHANNELS, SUPPRESSION_REASONS } from './enums'
import { citext } from './types'

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    name: text('name'),
    /** Sempre normalizado para E.164: +5588999999999 */
    phoneE164: text('phone_e164'),
    email: citext('email'),
    telegramChatId: bigint('telegram_chat_id', { mode: 'number' }),
    cpf: text('cpf'),
    tags: text('tags').array().notNull().default(sql`'{}'`),

    // Consentimento por canal (§14.1)
    optinWhatsapp: boolean('optin_whatsapp').notNull().default(true),
    optinEmail: boolean('optin_email').notNull().default(true),
    optinSms: boolean('optin_sms').notNull().default(true),
    optinTelegram: boolean('optin_telegram').notNull().default(true),
    optinSource: text('optin_source', { enum: ['checkout', 'import', 'api'] }),
    optinAt: timestamp('optin_at', { withTimezone: true }),
    optinIp: inet('optin_ip'),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    optoutReason: text('optout_reason'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    totalOrders: integer('total_orders').notNull().default(0),
    totalPaidCents: bigint('total_paid_cents', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contacts_org_phone_uq')
      .on(t.orgId, t.phoneE164)
      .where(sql`${t.phoneE164} IS NOT NULL`),
    uniqueIndex('contacts_org_email_uq')
      .on(t.orgId, t.email)
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex('contacts_org_external_uq')
      .on(t.orgId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    // Busca instantânea em 50 mil leads, alvo <100ms (§9.1, §13.2)
    index('contacts_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('contacts_org_last_event_idx').on(t.orgId, t.lastEventAt.desc()),
    index('contacts_tags_idx').using('gin', t.tags),
  ],
)

/** Bloqueio granular por canal (§3.3) — consultado na regra de guarda 2 (§5.3). */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    reason: text('reason', { enum: SUPPRESSION_REASONS }).notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suppressions_contact_channel_uq').on(t.contactId, t.channel),
    index('suppressions_org_idx').on(t.orgId),
  ],
)

export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Suppression = typeof suppressions.$inferSelect
export type NewSuppression = typeof suppressions.$inferInsert
