import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'

/**
 * O gatilho e o que cancela, agora editáveis (§5.1).
 *
 * O QUE MUDOU E POR QUE PRECISA DE TESTE
 *
 * `triggerEvent` e `cancelOn` não estavam no schema da ação, então o evento era
 * escrito uma vez pelo seed e virava imutável. Acrescentá-los abre três buracos
 * que o `tsc` não vê:
 *
 *   O gatilho vem de um `<select>`, e `<select>` é sugestão. Um valor fora de
 *   `CANONICAL_EVENTS` gravado em `flows.trigger_event` faria um fluxo que
 *   nunca casa com evento nenhum — e a tela mostraria tudo normal.
 *
 *   `cancelOn` vem de caixas de seleção com o MESMO nome. `formData.get()`
 *   traria só a primeira: marcar três e salvar deixaria o fluxo cancelando por
 *   uma. É o tipo de perda que responde "Salvo." em verde.
 *
 *   E cancelar SEM chave é o pior estado possível: o fluxo agenda os envios e
 *   nada consegue pará-los. A guarda existia e olhava o valor GRAVADO, não o
 *   enviado — quem marcasse "para sozinho" e salvasse na mesma vez passava por
 *   ela, porque no banco ainda não havia nada para cancelar.
 *
 * Roda como `mandafy_app`, com RLS aplicado.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`
const ORG = uid('fa1')
const ADMIN = uid('fa2')
const FLUXO = uid('fa3')

const USUARIO = {
  id: ADMIN,
  orgId: ORG,
  isAdmin: true,
  role: 'admin' as const,
  name: 'Admin',
  email: 'gatilho@teste.local',
  orgName: 'Org Gatilho',
}

describe.skipIf(!habilitado)('§5.1 — o gatilho e o que cancela', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>
  let acoes: typeof import('@/app/(app)/fluxos/actions')

  async function estadoDoFluxo(): Promise<{
    trigger_event: string
    cancel_on: string[]
    cancel_key_template: string | null
    active: boolean
  }> {
    const [linha] = (await admin`
      SELECT trigger_event, cancel_on, cancel_key_template, active
      FROM flows WHERE id = ${FLUXO}`) as unknown as [
      { trigger_event: string; cancel_on: string[]; cancel_key_template: string | null; active: boolean },
    ]
    return linha
  }

  /** O formulário como a tela o envia. */
  function formulario(campos: Record<string, string | string[]>): FormData {
    const fd = new FormData()
    fd.set('id', FLUXO)
    fd.set('nome', 'Recuperação')
    fd.set('maxPorDia', '4')
    for (const [chave, valor] of Object.entries(campos)) {
      if (Array.isArray(valor)) for (const v of valor) fd.append(chave, v)
      else fd.set(chave, valor)
    }
    return fd
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Gatilho', 'gatilho-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'gatilho-admin@teste.local', 'x', 'admin')`

    vi.doMock('@/db', async () => {
      const real = await vi.importActual<typeof import('@/db')>('@/db')
      return {
        ...real,
        withTenant: <T,>(_ctx: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> =>
          db.transaction(async (tx) => {
            await tx.execute(sql`
              select
                set_config('app.org_id',   ${ORG}, true),
                set_config('app.user_id',  ${ADMIN}, true),
                set_config('app.is_admin', 'true', true)
            `)
            return fn(tx as Tx)
          }),
      }
    })

    vi.doMock('@/lib/auth/current', () => ({
      requireAdmin: async () => USUARIO,
      tenantOf: () => ({ orgId: ORG, userId: ADMIN, isAdmin: true }),
    }))
    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }))
    vi.doMock('next/navigation', () => ({ redirect: () => {} }))

    acoes = await import('@/app/(app)/fluxos/actions')
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    vi.doUnmock('@/lib/auth/current')
    vi.doUnmock('next/cache')
    vi.doUnmock('next/navigation')
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM flows WHERE id = ${FLUXO}`
    await admin`INSERT INTO flows (id, org_id, name, trigger_event, active)
                VALUES (${FLUXO}, ${ORG}, 'Recuperação', 'order.created', false)`
  })

  it('troca o evento que dispara — antes era imutável', async () => {
    const r = await acoes.salvarFluxoAction({}, formulario({ triggerEvent: 'order.paid' }))

    expect(r).toMatchObject({ ok: true })
    expect((await estadoDoFluxo()).trigger_event).toBe('order.paid')
  })

  it('recusa um evento que não existe, em vez de gravar', async () => {
    // `<select>` é sugestão: quem manda o formulário na mão manda o que quiser,
    // e um valor fora do catálogo faria um fluxo que nunca casa com nada.
    const r = await acoes.salvarFluxoAction({}, formulario({ triggerEvent: 'inventado.agora' }))

    expect(r.ok).toBeUndefined()
    expect((await estadoDoFluxo()).trigger_event).toBe('order.created')
  })

  it('guarda TODOS os eventos marcados, e não só o primeiro', async () => {
    // São caixas com o mesmo nome: `formData.get()` traria uma, e o fluxo
    // passaria a cancelar por um evento de três — respondendo "Salvo.".
    const r = await acoes.salvarFluxoAction(
      {},
      formulario({
        triggerEvent: 'order.created',
        cancelOn: ['order.paid', 'order.cancelled', 'order.expired'],
        cancelKeyTemplate: 'order:{{external_id}}',
      }),
    )

    expect(r).toMatchObject({ ok: true })
    expect((await estadoDoFluxo()).cancel_on.sort()).toEqual([
      'order.cancelled',
      'order.expired',
      'order.paid',
    ])
  })

  /*
   * A GUARDA OLHAVA O BANCO, E NÃO O QUE FOI ENVIADO.
   *
   * `completo.fluxo.cancelOn.length > 0` lê o valor JÁ GRAVADO. Quem marcasse
   * "para sozinho" e salvasse na mesma vez passaria por ela — no banco ainda
   * não havia nada para cancelar — e ficaria com um fluxo que cancela sem
   * chave: agenda os envios e nada consegue pará-los.
   */
  it('recusa cancelar sem chave já na primeira vez que se marca', async () => {
    const r = await acoes.salvarFluxoAction(
      {},
      formulario({ triggerEvent: 'order.created', cancelOn: ['order.paid'], cancelKeyTemplate: '' }),
    )

    expect(r.erro).toContain('chave')
    expect((await estadoDoFluxo()).cancel_on).toEqual([])
  })

  it('e uma chave sem variável continua recusada — cancelaria todo mundo de uma vez', async () => {
    const r = await acoes.salvarFluxoAction(
      {},
      formulario({
        triggerEvent: 'order.created',
        cancelOn: ['order.paid'],
        cancelKeyTemplate: 'order:fixo',
      }),
    )

    expect(r.erro).toContain('variável')
  })

  it('desmarcar tudo grava lista vazia, e não mantém o que estava', async () => {
    await admin`UPDATE flows SET cancel_on = ARRAY['order.paid'],
                cancel_key_template = 'order:{{external_id}}' WHERE id = ${FLUXO}`

    const r = await acoes.salvarFluxoAction({}, formulario({ triggerEvent: 'order.created' }))

    expect(r).toMatchObject({ ok: true })
    expect((await estadoDoFluxo()).cancel_on).toEqual([])
  })

  /*
   * ── LIGAR UM FLUXO QUE NÃO TEM COMO RODAR ──
   *
   * `INTERNAL_EVENTS` é descrito no esquema como "gerado internamente pelo
   * Mandafy" e nada no sistema os gera. Quem liga espera, nada acontece, e o
   * painel diz "o evento nunca chegou" — culpando a plataforma, que está sã.
   */
  it('não ativa fluxo cujo evento o Mandafy não gera', async () => {
    await admin`UPDATE flows SET trigger_event = 'contact.inactive_7d' WHERE id = ${FLUXO}`

    const fd = new FormData()
    fd.set('id', FLUXO)
    fd.set('ativar', '1')
    await acoes.alternarFluxoAction(fd)

    expect((await estadoDoFluxo()).active).toBe(false)
  })

  it('mas ativa se um evento desse tipo já tiver chegado de verdade', async () => {
    // A recusa é sobre "não tem como rodar", não sobre o nome do evento: uma
    // plataforma PODE mapear algo dela para este tipo, e aí o fluxo roda.
    await admin`UPDATE flows SET trigger_event = 'contact.inactive_7d' WHERE id = ${FLUXO}`
    const [origem] = (await admin`
      INSERT INTO sources (org_id, name, ingest_token)
      VALUES (${ORG}, 'Plataforma', 'gatilho-token') RETURNING id`) as unknown as [{ id: string }]
    await admin`
      INSERT INTO events (org_id, source_id, type)
      VALUES (${ORG}, ${origem.id}, 'contact.inactive_7d')`

    try {
      const fd = new FormData()
      fd.set('id', FLUXO)
      fd.set('ativar', '1')
      await acoes.alternarFluxoAction(fd)

      expect((await estadoDoFluxo()).active).toBe(true)
    } finally {
      await admin`DELETE FROM events WHERE org_id = ${ORG}`
      await admin`DELETE FROM sources WHERE org_id = ${ORG}`
    }
  })

  it('cria um fluxo novo, pausado e vazio', async () => {
    const fd = new FormData()
    fd.set('nome', 'Cadastro novo')
    fd.set('triggerEvent', 'user.created')
    await acoes.criarFluxoAction(fd)

    const [criado] = (await admin`
      SELECT trigger_event, active FROM flows
      WHERE org_id = ${ORG} AND name = 'Cadastro novo'`) as unknown as [
      { trigger_event: string; active: boolean },
    ]

    expect(criado.trigger_event).toBe('user.created')
    // Ativo com zero passos dispararia no primeiro evento e não mandaria nada:
    // "criei e não aconteceu nada" seria correto e inútil como resposta.
    expect(criado.active).toBe(false)
  })
})
