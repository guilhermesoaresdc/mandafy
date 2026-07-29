import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { serverEnv } from '@/env'
import * as schema from './schema'

export * as schema from './schema'

/**
 * Cliente e instância do Drizzle compartilhados.
 *
 * A conexão usa DATABASE_URL, que aponta para o papel `mandafy_app` — o papel
 * com RLS SEMPRE aplicado (ver drizzle/0010_rls.sql). Migrations e seed usam
 * DATABASE_URL_ADMIN, um papel diferente, e não passam por aqui.
 *
 * O cache em globalThis evita esgotar o pool de conexões nos hot-reloads do
 * Next em desenvolvimento.
 */

type DrizzleDb = PostgresJsDatabase<typeof schema>

const globalForDb = globalThis as unknown as {
  __mandafyClient?: postgres.Sql
  __mandafyDb?: DrizzleDb
}

/**
 * A conexão é criada na PRIMEIRA USO, não na importação do módulo.
 *
 * Isso importa por dois motivos: `next build` percorre os módulos das rotas
 * para coletar configuração e não pode exigir segredos de produção; e um
 * processo que só renderiza HTML estático nunca abre conexão à toa.
 */
/**
 * Detecta um pooler de conexão em modo transação (Supabase Supavisor na porta
 * 6543, PgBouncer em `transaction`).
 *
 * Nesse modo cada query pode cair numa conexão diferente do servidor, então
 * prepared statements não sobrevivem entre chamadas e o driver quebra com
 * "prepared statement already exists". A correção é desligar o preparo.
 *
 * Detectamos em vez de exigir configuração manual porque o sintoma — login
 * falhando só em produção — é caro de diagnosticar. `DATABASE_PREPARE` força
 * o comportamento quando a heurística não serve.
 */
export function usesTransactionPooler(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.port === '6543') return true
    if (parsed.hostname.includes('pooler.supabase.com')) return true
    // PgBouncer costuma ser sinalizado por query string.
    const mode = parsed.searchParams.get('pgbouncer')
    return mode === 'true' || mode === '1'
  } catch {
    return false
  }
}

function realClient(): postgres.Sql {
  const cached = globalForDb.__mandafyClient
  if (cached) return cached

  const url = serverEnv().DATABASE_URL
  const forced = process.env.DATABASE_PREPARE
  const prepare = forced === undefined ? !usesTransactionPooler(url) : forced !== 'false'

  const created = postgres(url, {
    // Serverless abre muitos processos; um pool grande por processo esgota o
    // limite de conexões do Postgres. Com pooler, quem gerencia é ele.
    max: prepare ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare,
    // Nenhum dado pessoal em log de aplicação (§14.1): o postgres.js não
    // registra parâmetros por padrão, e não ligamos `debug`.
    onnotice: () => {},
  })

  globalForDb.__mandafyClient = created
  return created
}

function realDb(): DrizzleDb {
  const cached = globalForDb.__mandafyDb
  if (cached) return cached

  const created = drizzle(realClient(), { schema })
  globalForDb.__mandafyDb = created
  return created
}

/** Encaminha todo acesso para a instância real, criando-a na primeira vez. */
function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, property, receiver) {
      const instance = resolve()
      const value = Reflect.get(instance, property, receiver)
      return typeof value === 'function' ? value.bind(instance) : value
    },
    has: (_target, property) => property in resolve(),
    apply: (_target, thisArg, args) =>
      Reflect.apply(resolve() as unknown as (...a: unknown[]) => unknown, thisArg, args),
  })
}

export const client: postgres.Sql = lazy(realClient)
export const db: DrizzleDb = lazy(realDb)

export type TenantContext = {
  orgId: string
  userId: string
  isAdmin: boolean
}

/** O tipo da transação que o Drizzle entrega ao callback. */
export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0]

/**
 * Executa `fn` numa transação com o contexto de tenant definido — é o que faz
 * o RLS valer (§9.4). Toda leitura ou escrita de dado de tenant DEVE passar
 * por aqui; uma query fora daqui roda sem `app.org_id` e não enxerga nada.
 *
 * Usamos `set_config(..., true)` em vez de `SET LOCAL` porque só a forma de
 * função aceita parâmetros vinculados. `SET LOCAL` exigiria interpolar o valor
 * na string do comando, o que abriria injeção de SQL.
 */
export function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.org_id',   ${ctx.orgId}, true),
        set_config('app.user_id',  ${ctx.userId}, true),
        set_config('app.is_admin', ${ctx.isAdmin ? 'true' : 'false'}, true)
    `)
    return fn(tx)
  })
}

/** Encerra o pool. Usado no desligamento gracioso do worker. */
export async function closeDb(): Promise<void> {
  // Só encerra se alguma conexão chegou a ser aberta — tocar em `client` aqui
  // criaria uma conexão apenas para fechá-la.
  const existing = globalForDb.__mandafyClient
  if (!existing) return

  await existing.end({ timeout: 5 })
  globalForDb.__mandafyClient = undefined
  globalForDb.__mandafyDb = undefined
}
