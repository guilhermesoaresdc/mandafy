/**
 * Embute as migrations SQL num módulo TypeScript.
 *
 * POR QUE ISTO EXISTE
 *
 * `src/db/migrate.ts` lia `drizzle/*.sql` do disco com `readdir`/`readFile`.
 * Funciona no terminal e no Docker, e falha na Vercel: o empacotador só leva
 * para a função serverless os arquivos que alguém IMPORTA, e ninguém importa
 * um `.sql`. O resultado seria ENOENT em produção — no exato momento em que a
 * migration mais precisa rodar.
 *
 * Dava para remendar com `outputFileTracingIncludes` no next.config, mas isso
 * depende de o `process.cwd()` da função apontar para a raiz do projeto, o que
 * varia por plataforma. Embutir não depende de nada: o SQL vira string dentro
 * do bundle e roda igual na Vercel, no Docker e no Vitest.
 *
 * A fonte da verdade continua sendo `drizzle/*.sql`. Este script só copia. O
 * teste em `src/db/migrations.test.ts` recusa qualquer diferença entre os dois,
 * então um arquivo novo sem regerar quebra o `npm test` — e não a produção.
 *
 * Uso: npm run db:embutir  (roda sozinho antes de build, dev e test)
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const origem = join(raiz, 'drizzle')
const destino = join(raiz, 'src', 'db', 'migrations.generated.ts')

/** Lê `drizzle/*.sql` em ordem lexical — a mesma ordem em que são aplicadas. */
export async function lerMigrations() {
  const arquivos = (await readdir(origem))
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'))

  return Promise.all(
    arquivos.map(async (nome) => {
      const sql = await readFile(join(origem, nome), 'utf8')
      return { nome, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    }),
  )
}

export function renderizar(migrations) {
  const corpo = migrations
    .map(
      (m) =>
        `  {\n    nome: ${JSON.stringify(m.nome)},\n` +
        `    checksum: ${JSON.stringify(m.checksum)},\n` +
        // JSON.stringify em vez de template literal: o SQL tem crases e cifrões
        // nos comentários, e um deles quebraria o arquivo gerado em silêncio.
        `    sql: ${JSON.stringify(m.sql)},\n  },`,
    )
    .join('\n')

  return `/*
 * GERADO AUTOMATICAMENTE — não edite à mão.
 *
 * Fonte: drizzle/*.sql · Gerador: scripts/embutir-migrations.mjs
 * Regere com: npm run db:embutir
 *
 * Existe para que as migrations viajem DENTRO do bundle: na Vercel, arquivo
 * que ninguém importa não chega na função serverless.
 */

export type MigrationEmbutida = {
  nome: string
  /** sha256 do conteúdo. Migration aplicada é imutável — ver src/db/migrate.ts. */
  checksum: string
  sql: string
}

export const MIGRATIONS: readonly MigrationEmbutida[] = [
${corpo}
]
`
}

const migrations = await lerMigrations()
const conteudo = renderizar(migrations)

// Só escreve se mudou: evita recompilação à toa do Next em modo dev.
let atual = ''
try {
  atual = await readFile(destino, 'utf8')
} catch {}

if (atual !== conteudo) {
  await writeFile(destino, conteudo, 'utf8')
  console.log(`Migrations embutidas: ${migrations.length} arquivo(s) → src/db/migrations.generated.ts`)
} else {
  console.log(`Migrations embutidas já estavam em dia (${migrations.length} arquivo(s)).`)
}
