import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { SOURCE_PLATFORMS } from './enums'

/** Mapeamento declarativo de payload → evento canônico (§4.2). */
export type SourceMapping = {
  event_path?: string
  event_map?: Record<string, string>
  contact?: Record<string, string>
  fields?: Record<string, string | { path: string; transform?: string }>
}

/** Cada plataforma de sorteio plugada (§3.1). */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform', { enum: SOURCE_PLATFORMS }).notNull().default('generico'),
    /** Vai na URL do webhook: POST /in/{ingest_token} */
    ingestToken: text('ingest_token').notNull().unique(),
    /** Opcional: se a plataforma assinar o corpo, validamos HMAC (§4.3). */
    hmacSecret: text('hmac_secret'),
    mapping: jsonb('mapping').$type<SourceMapping>().notNull().default({}),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sources_org_idx').on(t.orgId)],
)

export type Source = typeof sources.$inferSelect
export type NewSource = typeof sources.$inferInsert
