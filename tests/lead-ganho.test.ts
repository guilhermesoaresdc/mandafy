import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { montarPipeline } from '@/db/queries/leads'

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

/**
 * Os controles que diziam "Salvo." e não mudavam nada (§9.2).
 *
 * O QUE ESTE BLOCO EXISTE PARA IMPEDIR
 *
 * Uma auditoria das telas encontrou quatro controles que respondiam em verde e
 * não faziam o que prometiam. Nenhum deles quebra o `tsc`, o lint ou o build:
 * são valores certos em colunas certas, ou uma coluna que ninguém escreve.
 *
 * O mais caro era este: "Ganhou" gravava `status = 'ganho'` e deixava o lead na
 * etapa em que estava. Como o funil listava só quem está `aberto`, o lead sumia
 * da tela inteira — a coluna "Ganho" ficava vazia para sempre, e o número que o
 * dono abre o funil para ver não existia em lugar nenhum.
 */
describe.skipIf(!habilitado)('§9.2 — marcar ganho move o lead para a coluna de ganho', () => {
  let admin: postgres.Sql
  let app: postgres.Sql

  const ORG2 = uid('d01')
  const ADMIN2 = uid('d02')
  const PIPE2 = uid('d03')
  const NOVO2 = uid('d04')
  const GANHO2 = uid('d05')
  const PERDIDO2 = uid('d06')
  const CONTATO2 = uid('d07')
  const LEAD2 = uid('d08')

  const USUARIO = {
    id: ADMIN2,
    orgId: ORG2,
    name: 'Admin',
    email: 'ganho-admin@teste.local',
    role: 'admin' as const,
    isAdmin: true,
    orgName: 'Ganho',
    orgSlug: 'ganho-org',
    timezone: 'America/Sao_Paulo',
  }

  async function comoAdmin2<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return drizzle(app, { schema }).transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG2}, true),
          set_config('app.user_id',  ${ADMIN2}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })

    await admin`DELETE FROM organizations WHERE id = ${ORG2}`
    await admin.begin(async (tx) => {
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG2}, 'Ganho', 'ganho-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN2}, ${ORG2}, 'Admin', 'ganho-admin@teste.local', 'x', 'admin')`
      await tx`INSERT INTO pipelines (id, org_id, name, is_default) VALUES
        (${PIPE2}, ${ORG2}, 'Padrão', true)`
      await tx`INSERT INTO pipeline_stages (id, pipeline_id, name, position, is_won, is_lost) VALUES
        (${NOVO2},    ${PIPE2}, 'Novo',    0, false, false),
        (${GANHO2},   ${PIPE2}, 'Ganho',   1, true,  false),
        (${PERDIDO2}, ${PIPE2}, 'Perdido', 2, false, true)`
      await tx`INSERT INTO contacts (id, org_id, name, phone_e164) VALUES
        (${CONTATO2}, ${ORG2}, 'Cliente', '+5511933333333')`
    })

    /*
     * A action é do Next: ela lê o cookie da sessão e abre o `withTenant`. Fora
     * de uma requisição nenhum dos dois existe, e é por isso que este arquivo é
     * separado de `crm.test.ts` — lá os mocks contaminariam os imports estáticos
     * das consultas.
     */
    vi.doMock('@/db', async () => {
      const real = await vi.importActual<typeof import('@/db')>('@/db')
      return {
        ...real,
        withTenant: <T,>(_ctx: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> =>
          drizzle(app, { schema }).transaction(async (tx) => {
            await tx.execute(sql`
              select
                set_config('app.org_id',   ${ORG2}, true),
                set_config('app.user_id',  ${ADMIN2}, true),
                set_config('app.is_admin', 'true', true)
            `)
            return fn(tx as Tx)
          }),
      }
    })

    vi.doMock('@/lib/auth/current', () => ({
      requireUser: async () => USUARIO,
      requireAdmin: async () => USUARIO,
      tenantOf: () => ({ orgId: ORG2, userId: ADMIN2, isAdmin: true }),
    }))

    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }))
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    vi.doUnmock('@/lib/auth/current')
    vi.doUnmock('next/cache')
    await admin`DELETE FROM organizations WHERE id = ${ORG2}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM lead_activities WHERE lead_id = ${LEAD2}`
    await admin`DELETE FROM leads WHERE id = ${LEAD2}`
    await admin`INSERT INTO leads (id, org_id, contact_id, pipeline_id, stage_id, title, value_cents, source, status)
      VALUES (${LEAD2}, ${ORG2}, ${CONTATO2}, ${PIPE2}, ${NOVO2}, 'Uma venda', 25000, 'manual', 'aberto')`
  })

  async function lead() {
    const [linha] = await admin<{ status: string; stage_id: string }[]>`
      SELECT status, stage_id FROM leads WHERE id = ${LEAD2}`
    return linha!
  }

  it('o lead ganho vai para a coluna de ganho, e não some', async () => {
    const { mudarStatusAction } = await import('@/app/(app)/leads/actions')

    const form = new FormData()
    form.append('leadId', LEAD2)
    form.append('status', 'ganho')
    await mudarStatusAction({}, form)

    const depois = await lead()
    expect(depois.status).toBe('ganho')
    // Sem isto o lead continuava em "Novo" com status ganho — invisível no
    // funil, que lista por etapa e filtrava por status.
    expect(depois.stage_id).toBe(GANHO2)

    const funil = await comoAdmin2((tx) => montarPipeline(tx))
    const colunaGanho = funil.find((c) => c.stageId === GANHO2)
    expect(colunaGanho?.total, 'a coluna Ganho ficou vazia').toBe(1)
    expect(Number(colunaGanho?.somaCents ?? 0)).toBe(25000)
  })

  it('o lead perdido vai para a coluna de perdido, com o motivo', async () => {
    const { mudarStatusAction } = await import('@/app/(app)/leads/actions')

    const form = new FormData()
    form.append('leadId', LEAD2)
    form.append('status', 'perdido')
    form.append('motivo', 'achou caro')
    await mudarStatusAction({}, form)

    const depois = await lead()
    expect(depois.status).toBe('perdido')
    expect(depois.stage_id).toBe(PERDIDO2)

    const [motivo] = await admin<{ lost_reason: string }[]>`
      SELECT lost_reason FROM leads WHERE id = ${LEAD2}`
    expect(motivo?.lost_reason).toBe('achou caro')
  })

  it('reabrir devolve o status e NÃO arrasta o lead de volta para "Novo"', async () => {
    const { mudarStatusAction } = await import('@/app/(app)/leads/actions')

    const ganhar = new FormData()
    ganhar.append('leadId', LEAD2)
    ganhar.append('status', 'ganho')
    await mudarStatusAction({}, ganhar)

    const reabrir = new FormData()
    reabrir.append('leadId', LEAD2)
    reabrir.append('status', 'aberto')
    await mudarStatusAction({}, reabrir)

    const depois = await lead()
    expect(depois.status).toBe('aberto')
    /*
     * A etapa fica onde está. Reabrir é dizer "ainda estou trabalhando isto",
     * não "esqueça tudo que andei" — mandar o lead de volta para a primeira
     * coluna apagaria o histórico de avanço dele sem ninguém ter pedido.
     */
    expect(depois.stage_id).toBe(GANHO2)
  })

  it('o funil mostra o que fechou; um ano depois, não', async () => {
    const { mudarStatusAction } = await import('@/app/(app)/leads/actions')

    const form = new FormData()
    form.append('leadId', LEAD2)
    form.append('status', 'ganho')
    await mudarStatusAction({}, form)

    expect((await comoAdmin2((tx) => montarPipeline(tx))).find((c) => c.stageId === GANHO2)?.total).toBe(1)

    // Sem o corte, um ano de vendas se acumularia numa coluna que ninguém rola
    // até o fim, e a soma no cabeçalho pararia de responder "como foi o mês".
    await admin`UPDATE leads SET stage_changed_at = now() - interval '60 days' WHERE id = ${LEAD2}`
    expect((await comoAdmin2((tx) => montarPipeline(tx))).find((c) => c.stageId === GANHO2)?.total).toBe(0)
  })

  it('o lead aberto aparece por quanto tempo for preciso', async () => {
    // O corte vale só para quem fechou: um lead antigo e ainda aberto é
    // justamente o que não pode sumir da vista.
    await admin`UPDATE leads SET stage_changed_at = now() - interval '400 days' WHERE id = ${LEAD2}`

    const funil = await comoAdmin2((tx) => montarPipeline(tx))
    expect(funil.find((c) => c.stageId === NOVO2)?.total).toBe(1)
  })
})
