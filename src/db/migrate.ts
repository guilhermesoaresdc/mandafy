/**
 * Aplicador de migrations.
 *
 * As migrations são SQL escrito à mão em `drizzle/*.sql`, aplicadas em ordem
 * lexical. O drizzle-kit não é usado para gerar: partições, RLS, citext e
 * índices trigram não cabem no gerador.
 *
 * Conecta com DATABASE_URL_ADMIN (dono das tabelas, ignora RLS). Sem essa
 * variável cai para DATABASE_URL — aceitável em ambiente sem separação de
 * papéis, mas então o RLS não protege nada, porque a aplicação seria dona.
 *
 * Uso: npm run db:migrate
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { usesTransactionPooler } from './index'

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle')

function adminUrl(): string {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL_ADMIN (ou DATABASE_URL) não definida. Copie .env.example para .env.',
    )
  }
  return url
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function runMigrations(): Promise<void> {
  const url = adminUrl()
  const sql = postgres(url, {
    max: 1,
    // Mesmo motivo de src/db/index.ts: atrás de um pooler em modo transação,
    // prepared statements não sobrevivem entre queries.
    prepare: !usesTransactionPooler(url),
    onnotice: (n) => console.log(`  ↳ ${n.message}`),
  })

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `

    const applied = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM _migrations
    `
    const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]))

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, 'en'))

    if (files.length === 0) {
      console.log('Nenhuma migration encontrada em drizzle/.')
      return
    }

    let pending = 0

    for (const file of files) {
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      const hash = checksum(content)
      const previous = appliedByName.get(file)

      if (previous !== undefined) {
        if (previous !== hash) {
          throw new Error(
            `A migration ${file} já foi aplicada mas seu conteúdo mudou.\n` +
              'Migrations aplicadas são imutáveis: crie um novo arquivo com a correção.',
          )
        }
        continue
      }

      pending += 1
      process.stdout.write(`Aplicando ${file}… `)

      // Cada arquivo é atômico: ou aplica inteiro, ou nada.
      await sql.begin(async (tx) => {
        await tx.unsafe(content)
        await tx`INSERT INTO _migrations (name, checksum) VALUES (${file}, ${hash})`
      })

      console.log('ok')
    }

    console.log(
      pending === 0
        ? `Nada a fazer: ${files.length} migrations já aplicadas.`
        : `${pending} migration(s) aplicada(s).`,
    )
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// Executa apenas quando este arquivo é o ponto de entrada do processo.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations().catch((error: unknown) => {
    console.error('\nFalha ao migrar:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
