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

/**
 * Traduz a recusa do Postgres em instrução.
 *
 * `permission denied for schema public` é uma frase exata e correta que não diz
 * NADA a quem opera pelo navegador. A causa é sempre a mesma: `DATABASE_URL_ADMIN`
 * não está definida, `adminUrl()` cai para `DATABASE_URL` — o papel da aplicação,
 * que por projeto não pode criar tabela — e o botão recusa.
 *
 * O detalhe que fecha o raciocínio, e que a mensagem crua esconde: ler
 * `_migrations` esse papel CONSEGUE. Por isso a tela mostra "11 de 25 aplicadas"
 * com toda a confiança e só quebra no clique — o diagnóstico parece do botão
 * quando é da conexão.
 */
export function explicarFalha(erro: unknown): string {
  const bruto = erro instanceof Error ? erro.message : String(erro)
  const codigo = (erro as { code?: string } | null)?.code

  // 42501 = insufficient_privilege. A frase varia com a versão e com o idioma
  // do servidor; o código, não.
  if (codigo === '42501' || /permission denied|permissão negada/i.test(bruto)) {
    return (
      `${bruto}\n\n` +
      'O banco recusou por falta de permissão, e não por erro no SQL. A conexão ' +
      'usada aqui é a do papel da aplicação, que por projeto não pode criar nem ' +
      'alterar tabela — é isso que faz o isolamento entre organizações valer.\n\n' +
      'Defina DATABASE_URL_ADMIN nas variáveis do projeto, com o usuário dono do ' +
      'banco (no Supabase é o "postgres"), e publique de novo. Depois disso este ' +
      'botão funciona e as migrations também passam a ser aplicadas sozinhas a ' +
      'cada deploy. Ver docs/supabase.md.'
    )
  }

  return bruto
}

/** As migrations que ainda não rodaram, sem aplicar nada. Para o painel. */
export async function migrationsPendentes(): Promise<{
  pendentes: string[]
  aplicadas: number
  total: number
  /**
   * O papel com que as migrations seriam aplicadas, e se ele PODE aplicá-las.
   *
   * Sem isto a tela listava catorze pendentes, oferecia o botão e só no clique
   * revelava que a conexão não tem permissão. A pergunta "então pra que serve
   * este botão?" é a resposta certa a uma tela que esconde isso até o último
   * momento.
   */
  papel: string
  podeAplicar: boolean
}> {
  const url = adminUrl()
  const sql = postgres(url, { max: 1, prepare: !usesTransactionPooler(url), onnotice: () => {} })

  try {
    const [quem] = await sql<{ papel: string; pode: boolean }[]>`
      SELECT current_user AS papel,
             -- CREATE no schema public é exatamente o que toda migration precisa
             -- e o que o papel da aplicação não tem. Perguntar ao Postgres em vez
             -- de comparar nomes: o papel pode se chamar qualquer coisa.
             has_schema_privilege(current_user, 'public', 'CREATE') AS pode
    `

    const existe = await sql<{ ok: boolean }[]>`
      SELECT to_regclass('public._migrations') IS NOT NULL AS ok
    `

    const papel = quem?.papel ?? '?'
    const podeAplicar = quem?.pode ?? false

    if (!existe[0]?.ok) {
      return {
        pendentes: MIGRATIONS.map((m) => m.nome),
        aplicadas: 0,
        total: MIGRATIONS.length,
        papel,
        podeAplicar,
      }
    }

    const linhas = await sql<{ name: string }[]>`SELECT name FROM _migrations`
    const nomes = new Set(linhas.map((l) => l.name))

    return {
      pendentes: MIGRATIONS.filter((m) => !nomes.has(m.nome)).map((m) => m.nome),
      aplicadas: nomes.size,
      total: MIGRATIONS.length,
      papel,
      podeAplicar,
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
