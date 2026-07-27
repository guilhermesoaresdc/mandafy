import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://mandafy:mandafy@localhost:5432/mandafy',
  },
  // O log de notificações, events e events_raw são particionados por dia via SQL
  // manual (drizzle-kit não modela partições). Ver drizzle/ *_partitions.sql.
  verbose: true,
  strict: true,
} satisfies Config
