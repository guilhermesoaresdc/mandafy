/**
 * Aplicador de migrations.
 *
 * As migrations são SQL escrito à mão em `drizzle/*.sql`, aplicadas em ordem
 * lexical. O drizzle-kit não é usado para gerar: partições, RLS, citext e
 * índices trigram não cabem no gerador.
 *
 * O conteúdo NÃO é lido do disco: vem de `migrations.generated.ts`, embutido no
 * bundle por `scripts/embutir-migrations.mjs`. Ler do disco funcionava no
 * terminal e no Docker e falharia na Vercel, onde arquivo que ninguém importa
 * não chega na função serverless — justamente onde não há terminal para
 * consertar depois.
 *
 * Conecta com DATABASE_URL_ADMIN (dono das tabelas, ignora RLS). Sem essa
 * variável cai para DATABASE_URL — aceitável em ambiente sem separação de
 * papéis, mas então o RLS não protege nada, porque a aplicação seria dona.
 *
 * Uso: npm run db:migrate — ou sozinho, na subida do app (ver instrumentation).
 */

import postgres from 'postgres'
import { usesTransactionPooler } from './index'
import { MIGRATIONS } from './migrations.generated'

/**
 * Trava de aplicação para serializar quem migra.
 *
 * Na Vercel várias instâncias sobem ao mesmo tempo depois de um deploy, e todas
 * chamariam isto. Sem trava, duas aplicariam o mesmo arquivo em paralelo: a
 * segunda quebra no meio (índice já existe, coluna já existe) e deixa
 * `_migrations` sem o registro — o pior dos mundos, porque a próxima tentativa
 * encontra o banco meio migrado e o arquivo marcado como pendente.
 *
 * O número é arbitrário e só precisa ser estável entre processos.
 */
const TRAVA = 8_270_119

export type ResultadoMigracao = {
  aplicadas: string[]
  jaAplicadas: number
  /** Falhou? A mensagem é do Postgres, sem credencial. */
  erro?: string
}

function adminUrl(): string {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL_ADMIN (ou DATABASE_URL) não definida. Copie .env.example para .env.',
    )
  }
  return url
}

export async function runMigrations(
  aoAplicar: (nome: string) => void = () => {},
): Promise<ResultadoMigracao> {
  const url = adminUrl()
  const sql = postgres(url, {
    max: 1,
    // Mesmo motivo de src/db/index.ts: atrás de um pooler em modo transação,
    // prepared statements não sobrevivem entre queries.
    prepare: !usesTransactionPooler(url),
    onnotice: () => {},
  })

  const aplicadas: string[] = []

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `

    /*
     * A trava é pega FORA da transação de cada arquivo e solta no fim: ela
     * precisa cobrir a leitura de `_migrations` até a última escrita, senão
     * dois processos leem "pendente" ao mesmo tempo antes de qualquer um
     * gravar.
     */
    await sql`SELECT pg_advisory_lock(${TRAVA})`

    try {
      const jaAplicadas = await sql<{ name: string; checksum: string }[]>`
        SELECT name, checksum FROM _migrations
      `
      const porNome = new Map(jaAplicadas.map((r) => [r.name, r.checksum]))

      for (const migration of MIGRATIONS) {
        const anterior = porNome.get(migration.nome)

        if (anterior !== undefined) {
          if (anterior !== migration.checksum) {
            throw new Error(
              `A migration ${migration.nome} já foi aplicada mas seu conteúdo mudou.\n` +
                'Migrations aplicadas são imutáveis: crie um novo arquivo com a correção.',
            )
          }
          continue
        }

        aoAplicar(migration.nome)

        // Cada arquivo é atômico: ou aplica inteiro, ou nada.
        await sql.begin(async (tx) => {
          await tx.unsafe(migration.sql)
          await tx`
            INSERT INTO _migrations (name, checksum)
            VALUES (${migration.nome}, ${migration.checksum})
          `
        })

        aplicadas.push(migration.nome)
      }

      return { aplicadas, jaAplicadas: porNome.size }
    } finally {
      await sql`SELECT pg_advisory_unlock(${TRAVA})`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** As migrations que ainda não rodaram, sem aplicar nada. Para o painel. */
export async function migrationsPendentes(): Promise<{
  pendentes: string[]
  aplicadas: number
  total: number
}> {
  const url = adminUrl()
  const sql = postgres(url, { max: 1, prepare: !usesTransactionPooler(url), onnotice: () => {} })

  try {
    const existe = await sql<{ ok: boolean }[]>`
      SELECT to_regclass('public._migrations') IS NOT NULL AS ok
    `

    if (!existe[0]?.ok) {
      return { pendentes: MIGRATIONS.map((m) => m.nome), aplicadas: 0, total: MIGRATIONS.length }
    }

    const linhas = await sql<{ name: string }[]>`SELECT name FROM _migrations`
    const nomes = new Set(linhas.map((l) => l.name))

    return {
      pendentes: MIGRATIONS.filter((m) => !nomes.has(m.nome)).map((m) => m.nome),
      aplicadas: nomes.size,
      total: MIGRATIONS.length,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
