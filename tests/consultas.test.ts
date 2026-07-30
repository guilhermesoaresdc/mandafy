import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { listarPlataformas } from '@/db/queries/sources'

/**
 * Consultas das telas, EXECUTADAS contra um Postgres de verdade.
 *
 * Existe porque uma query pode passar no `tsc`, no lint e no `next build` e
 * ainda ser recusada pelo banco. Foi o que aconteceu com a contagem de eventos
 * da tela de plataformas: o Drizzle renderizava `sources.id` sem qualificar a
 * tabela dentro da projeção, o Postgres resolvia o `"id"` solto como
 * `events_raw.id`, e a tela quebrava em produção com uuid = bigint.
 *
 * Precisa dos mesmos endereços de tests/rls.test.ts:
 *   TEST_DATABASE_URL_ADMIN → dono das tabelas, monta o cenário
 *   TEST_DATABASE_URL       → papel mandafy_app, com RLS aplicado
 * Sem eles a suíte é pulada.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('c1')
const ADMIN = uid('c2')
const ORIGEM_A = uid('c3')
const ORIGEM_B = uid('c4')

describe.skipIf(!habilitado)('Consultas das telas contra o Postgres', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  /** Mesma mecânica de withTenant(), sem depender das variáveis de ambiente. */
  async function comoUsuario<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${ADMIN}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Consultas', 'consultas-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'consultas-admin@teste.local', 'x', 'admin')`

      // Duas plataformas: uma com eventos, outra sem — a contagem precisa
      // distinguir zero de "não apareceu no agrupamento".
      await tx`INSERT INTO sources (id, org_id, name, ingest_token) VALUES
        (${ORIGEM_A}, ${ORG}, 'Com eventos', 'consultas-token-a'),
        (${ORIGEM_B}, ${ORG}, 'Sem eventos', 'consultas-token-b')`

      await tx`INSERT INTO events_raw (source_id, payload) VALUES
        (${ORIGEM_A}, '{"a":1}'::jsonb),
        (${ORIGEM_A}, '{"a":2}'::jsonb),
        (${ORIGEM_A}, '{"a":3}'::jsonb)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM events_raw WHERE source_id IN (${ORIGEM_A}, ${ORIGEM_B})`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('lista as plataformas com o total de eventos recebidos', async () => {
    const lista = await comoUsuario(listarPlataformas)

    const porNome = new Map(lista.map((p) => [p.name, p]))
    expect(porNome.get('Com eventos')?.recebidos).toBe(3)
    expect(porNome.get('Sem eventos')?.recebidos).toBe(0)
  })

  it('não conta eventos de outra organização', async () => {
    const outraOrg = uid('d1')
    const outraOrigem = uid('d3')

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Org Vizinha', 'consultas-vizinha')`
      await tx`INSERT INTO sources (id, org_id, name, ingest_token) VALUES
        (${outraOrigem}, ${outraOrg}, 'Da vizinha', 'consultas-token-c')`
      await tx`INSERT INTO events_raw (source_id, payload) VALUES (${outraOrigem}, '{"x":1}'::jsonb)`
    })

    try {
      const lista = await comoUsuario(listarPlataformas)
      expect(lista.map((p) => p.name).sort()).toEqual(['Com eventos', 'Sem eventos'])
    } finally {
      await admin`DELETE FROM events_raw WHERE source_id = ${outraOrigem}`
      await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
    }
  })

  it('devolve lista vazia quando não há plataforma conectada', async () => {
    const vazia = uid('e1')
    const usuarioVazio = uid('e2')

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${vazia}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${vazia}, 'Org Vazia', 'consultas-vazia')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${usuarioVazio}, ${vazia}, 'Admin', 'consultas-vazio@teste.local', 'x', 'admin')`
    })

    try {
      const lista = await db.transaction(async (tx) => {
        await tx.execute(sql`
          select
            set_config('app.org_id',   ${vazia}, true),
            set_config('app.user_id',  ${usuarioVazio}, true),
            set_config('app.is_admin', 'true', true)
        `)
        return listarPlataformas(tx as Tx)
      })
      expect(lista).toEqual([])
    } finally {
      await admin`DELETE FROM organizations WHERE id = ${vazia}`
    }
  })
})
