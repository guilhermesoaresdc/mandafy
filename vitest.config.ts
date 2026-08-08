import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      /*
       * `server-only` lança na importação de propósito — é assim que ele
       * impede um módulo de servidor de acabar no bundle do navegador. Sob o
       * Vitest não há navegador, e essa exceção derrubava suítes inteiras
       * que só queriam testar a lógica por trás (o batimento de entrega
       * alcança `normalize.ts`, por exemplo). A regra continua valendo onde
       * importa: no `next build`.
       */
      'server-only': resolve(import.meta.dirname, './tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],

    /*
     * Ambiente mínimo antes de qualquer suíte: ver tests/ambiente.ts. Sem ele,
     * todo teste que alcance uma função que chame `serverEnv()` morre num erro
     * de configuração antes de exercitar o que veio testar.
     */
    setupFiles: ['tests/ambiente.ts'],
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
