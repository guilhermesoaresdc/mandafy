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

    /*
     * Um arquivo por vez.
     *
     * As suítes de `tests/` compartilham UM banco: cada uma monta e derruba
     * organizações inteiras, e `DELETE FROM organizations` cascateia. Rodando
     * em paralelo, uma limpeza cai no meio do cenário da outra e o resultado é
     * falha intermitente — que é pior que falha constante, porque ensina a
     * ignorar o vermelho.
     *
     * O custo é pequeno: a suíte inteira leva poucos segundos. Determinismo
     * vale mais.
     */
    fileParallelism: false,
  },
})
