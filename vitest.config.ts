import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Testes que tocam Postgres/Redis são marcados com `describe.skipIf(!process.env.TEST_DATABASE_URL)`
    globals: false,
  },
})
