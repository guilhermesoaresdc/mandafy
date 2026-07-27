import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations } from './organizations'
import { contacts } from './contacts'
import { users } from './users'
import { LEAD_ACTIVITY_TYPES, LEAD_STATUSES } from './enums'

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pipelines_one_default_uq').on(t.orgId).where(sql`${t.isDefault}`)],
)

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    color: text('color'),
    probability: integer('probability'),
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pipeline_stages_position_uq').on(t.pipelineId, t.position)],
)

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    /** Consultor responsável — é a base do RBAC e da política RLS (§9.4). */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    valueCents: bigint('value_cents', { mode: 'number' }).notNull().default(0),
    /** 'evento:order.created' | 'manual' | 'api' */
    source: text('source').notNull().default('manual'),
    status: text('status', { enum: LEAD_STATUSES }).notNull().default('aberto'),
    lostReason: text('lost_reason'),
    nextActionAt: timestamp('next_action_at', { withTimezone: true }),
    stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_org_owner_stage_idx').on(t.orgId, t.ownerId, t.stageId),
    index('leads_next_action_idx')
      .on(t.orgId, t.nextActionAt)
      .where(sql`${t.status} = 'aberto'`),
    index('leads_contact_idx').on(t.contactId),
    index('leads_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
)

export const leadActivities = pgTable(
  'lead_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    type: text('type', { enum: LEAD_ACTIVITY_TYPES }).notNull(),
    content: text('content'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lead_activities_lead_idx').on(t.leadId, t.createdAt.desc())],
)

export type Pipeline = typeof pipelines.$inferSelect
export type NewPipeline = typeof pipelines.$inferInsert
export type PipelineStage = typeof pipelineStages.$inferSelect
export type NewPipelineStage = typeof pipelineStages.$inferInsert
export type Lead = typeof leads.$inferSelect
export type NewLead = typeof leads.$inferInsert
export type LeadActivity = typeof leadActivities.$inferSelect
export type NewLeadActivity = typeof leadActivities.$inferInsert
