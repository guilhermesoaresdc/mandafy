/**
 * `npm run db:migrate` — o mesmo aplicador, pela linha de comando.
 *
 * Separado de `migrate.ts` porque aquele módulo é importado pela subida do app
 * (src/instrumentation.ts), e o empacotador do Next percorre tudo que ele
 * importa. Um `node:url` aqui dentro derruba o build inteiro com
 * "Reading from node:url is not handled by plugins" — já derrubou.
 *
 * Regra que vale para todo o `src/db/`: módulo que o app importa não tem ponto
 * de entrada de processo.
 */
import { runMigrations } from './migrate'

runMigrations((nome) => process.stdout.write(`Aplicando ${nome}…\n`))
  .then((r) => {
    console.log(
      r.aplicadas.length === 0
        ? `Nada a fazer: ${r.jaAplicadas} migrations já aplicadas.`
        : `${r.aplicadas.length} migration(s) aplicada(s).`,
    )
  })
  .catch((error: unknown) => {
    console.error('\nFalha ao migrar:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
