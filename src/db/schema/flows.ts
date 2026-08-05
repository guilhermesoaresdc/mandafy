import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { messages } from './messages'
import { JITTER_MODES } from './enums'

/**
 * Perfil de randomização, o "ritmo de envio" da interface (§7.2, §11.7).
 * Aplicável em três níveis: global → fluxo → passo. O mais específico vence.
 */
export const jitterProfiles = pgTable(
  'jitter_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: text('mode', { enum: JITTER_MODES }).notNull(),
    minSeconds: integer('min_seconds').notNull().default(0),
    maxSeconds: integer('max_seconds').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jitter_profiles_org_name_uq').on(t.orgId, t.name),
    uniqueIndex('jitter_profiles_one_default_uq').on(t.orgId).where(sql`${t.isDefault}`),
  ],
)

export const flows = pgTable(
  'flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    triggerEvent: text('trigger_event').notNull(),
    entryConditions: jsonb('entry_conditions').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * Cancelamento por chave — a lógica mais crítica do sistema (§5.1).
     * `cancelOn` lista os eventos que cancelam; `cancelKeyTemplate` gera a
     * chave que amarra os envios agendados ao pedido: 'order:{{external_id}}'.
     */
    cancelOn: text('cancel_on').array().notNull().default(sql`'{}'`),
    cancelKeyTemplate: text('cancel_key_template'),

    quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(true),
    quietStart: time('quiet_start').notNull().default('21:00'),
    quietEnd: time('quiet_end').notNull().default('08:00'),
    maxPerContactPerDay: integer('max_per_contact_per_day').notNull().default(4),

    jitterProfileId: uuid('jitter_profile_id').references(() => jitterProfiles.id, {
      onDelete: 'set null',
    }),
    active: boolean('active').notNull().default(true),
    priority: integer('priority').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flows_org_trigger_idx').on(t.orgId, t.triggerEvent).where(sql`${t.active}`),
    index('flows_cancel_on_idx').using('gin', t.cancelOn),
  ],
)

export const flowSteps = pgTable(
  'flow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** Relativo ao passo anterior, não ao início do fluxo (§3.5). */
    delaySeconds: integer('delay_seconds').notNull().default(0),
    /**
     * Hora do relógio em que o passo sai, no fuso da organização. `'10:00'`.
     *
     * Nulo — o padrão — mantém o instante que a cascata calculou, que é o certo
     * para recuperação: um lembrete de +5 min adiado para as 10h não é um
     * lembrete. Preenchido, o instante é EMPURRADO PARA A FRENTE até a próxima
     * ocorrência daquela hora; nunca para trás, senão um passo poderia sair
     * antes do anterior.
     */
    sendAtLocal: text('send_at_local'),
    jitterProfileId: uuid('jitter_profile_id').references(() => jitterProfiles.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
    /** null = usa o `enabled` de cada variante do template */
    channelsOverride: text('channels_override').array(),
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
    stopIf: jsonb('stop_if').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('flow_steps_flow_position_uq').on(t.flowId, t.position)],
)

export type JitterProfile = typeof jitterProfiles.$inferSelect
export type NewJitterProfile = typeof jitterProfiles.$inferInsert
export type Flow = typeof flows.$inferSelect
export type NewFlow = typeof flows.$inferInsert
export type FlowStep = typeof flowSteps.$inferSelect
export type NewFlowStep = typeof flowSteps.$inferInsert
