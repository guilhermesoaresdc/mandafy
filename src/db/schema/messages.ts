import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { CHANNELS, MESSAGE_CATEGORIES } from './enums'

/** Botão inline do Telegram (§6.4). */
export type TelegramButton = { text: string; url?: string; callback_data?: string }

/** A mensagem lógica. Uma por situação (§3.4). */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Identificador estável usado pela API pública: 'pix_lembrete_1' */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Define a base legal do envio (§14.1): promocional exige opt-in. */
    category: text('category', { enum: MESSAGE_CATEGORIES }).notNull().default('relacionamento'),
    description: text('description'),
    /** Corpo canônico em Markdown reduzido (§6.2). Dele nascem as variantes. */
    body: text('body').notNull().default(''),
    /** Transacional crítico pode furar a janela de silêncio (§7.4). */
    ignoreQuietHours: boolean('ignore_quiet_hours').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('messages_org_key_uq').on(t.orgId, t.key), index('messages_org_idx').on(t.orgId)],
)

/** Uma variante por canal. Padrão: todas habilitadas (§3.4, §6.1). */
export const messageVariants = pgTable(
  'message_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    /** É o pad que liga/desliga na interface (§11.4). */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * O selo `sincronizado` / `customizado` (§6.1). Enquanto true, editar o
     * corpo principal propaga para cá; ao editar a variante vira false.
     */
    synced: boolean('synced').notNull().default(true),

    subject: text('subject'),
    preheader: text('preheader'),
    body: text('body'),
    html: text('html'),
    /** Versão texto puro, exigida para entregabilidade de e-mail (§8.3). */
    textBody: text('text_body'),
    parseMode: text('parse_mode', { enum: ['HTML', 'MarkdownV2'] }),
    buttons: jsonb('buttons').$type<TelegramButton[]>(),
    mediaUrl: text('media_url'),
    /** SMS: encurtar links para economizar segmento (§6.4). */
    linkShorten: boolean('link_shorten').notNull().default(true),
    /** SMS: remover acentuação, opcional (§6.4). */
    stripAccents: boolean('strip_accents').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('message_variants_message_channel_uq').on(t.messageId, t.channel)],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type MessageVariant = typeof messageVariants.$inferSelect
export type NewMessageVariant = typeof messageVariants.$inferInsert
