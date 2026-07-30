import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { SOURCE_PLATFORMS } from './enums'
import type { SourceMapping as MappingType } from '@/lib/ingest/mapping'

/**
 * Mapeamento declarativo de payload → evento canônico (§4.2).
 *
 * O tipo vem do schema Zod que valida e executa o mapeamento, para que exista
 * uma definição só: duas declarações do mesmo formato divergem no primeiro
 * campo novo, e a divergência só aparece em produção.
 *
 * Import de tipo — apagado na compilação, então o schema não carrega o motor
 * de ingestão para dentro de si.
 */
export type { SourceMapping } from '@/lib/ingest/mapping'

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
    mapping: jsonb('mapping').$type<MappingType>().notNull().default({} as MappingType),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sources_org_idx').on(t.orgId)],
)

export type Source = typeof sources.$inferSelect
export type NewSource = typeof sources.$inferInsert
