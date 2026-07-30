import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'

/**
 * Isolamento multi-tenant no BANCO (§9.4).
 *
 * A spec é explícita: "Consultor só enxerga os próprios leads — garantido no
 * banco (RLS), não só na UI". Estes testes conectam com o papel da aplicação
 * (`mandafy_app`, sem BYPASSRLS) e tentam ver o que não deveriam.
 *
 * Precisa de dois endereços de banco:
 *   TEST_DATABASE_URL_ADMIN → dono das tabelas, monta o cenário
 *   TEST_DATABASE_URL       → papel mandafy_app, é quem tem RLS aplicado
 * Sem eles, a suíte é pulada — `npm test` continua rodando em máquina limpa.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG_A = uid('a1')
const ORG_B = uid('b1')
const ADMIN_A = uid('a2')
const CONSULTOR_A = uid('a3')
const CONSULTOR_A2 = uid('a4')
const LEAD_DO_CONSULTOR = uid('a5')
const LEAD_DE_OUTRO = uid('a6')
const LEAD_ORG_B = uid('b5')

describe.skipIf(!habilitado)('RLS — isolamento entre organizações e consultores', () => {
  let admin: postgres.Sql
  let app: postgres.Sql

  /** Roda uma consulta com o contexto de tenant, como faz `withTenant()`. */
  async function comoUsuario<T>(
    ctx: { orgId: string; userId: string; isAdmin: boolean },
    consulta: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    return app.begin(async (tx) => {
      await tx`
        SELECT set_config('app.org_id', ${ctx.orgId}, true),
               set_config('app.user_id', ${ctx.userId}, true),
               set_config('app.is_admin', ${ctx.isAdmin ? 'true' : 'false'}, true)
      `
      return consulta(tx)
    }) as Promise<T>
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })

    // Cenário: duas organizações; na A, um admin e dois consultores; três leads.
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`

      await tx`INSERT INTO organizations (id, name, slug) VALUES
        (${ORG_A}, 'Org A', 'rls-org-a'), (${ORG_B}, 'Org B', 'rls-org-b')`

      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN_A},      ${ORG_A}, 'Admin A',      'rls-admin-a@teste.local', 'x', 'admin'),
        (${CONSULTOR_A},  ${ORG_A}, 'Consultor A',  'rls-c1-a@teste.local',    'x', 'consultor'),
        (${CONSULTOR_A2}, ${ORG_A}, 'Consultor A2', 'rls-c2-a@teste.local',    'x', 'consultor')`

      const contatoA = uid('a7')
      const contatoB = uid('b7')
      await tx`INSERT INTO contacts (id, org_id, name) VALUES
        (${contatoA}, ${ORG_A}, 'Contato A'), (${contatoB}, ${ORG_B}, 'Contato B')`

      const pipeA = uid('a8')
      const pipeB = uid('b8')
      const etapaA = uid('a9')
      const etapaB = uid('b9')
      await tx`INSERT INTO pipelines (id, org_id, name) VALUES
        (${pipeA}, ${ORG_A}, 'Funil A'), (${pipeB}, ${ORG_B}, 'Funil B')`
      await tx`INSERT INTO pipeline_stages (id, pipeline_id, name, position) VALUES
        (${etapaA}, ${pipeA}, 'Novo', 0), (${etapaB}, ${pipeB}, 'Novo', 0)`

      await tx`INSERT INTO leads (id, org_id, contact_id, owner_id, pipeline_id, stage_id, title) VALUES
        (${LEAD_DO_CONSULTOR}, ${ORG_A}, ${contatoA}, ${CONSULTOR_A},  ${pipeA}, ${etapaA}, 'Lead do consultor'),
        (${LEAD_DE_OUTRO},     ${ORG_A}, ${contatoA}, ${CONSULTOR_A2}, ${pipeA}, ${etapaA}, 'Lead de outro consultor'),
        (${LEAD_ORG_B},        ${ORG_B}, ${contatoB}, NULL,            ${pipeB}, ${etapaB}, 'Lead da org B')`

      // Sessão usada pelo teste do caminho de autenticação.
      await tx`INSERT INTO sessions (id, user_id, expires_at)
               VALUES ('sessao-de-teste', ${CONSULTOR_A}, now() + interval '1 day')`
    })
  })

  afterAll(async () => {
    if (admin) {
      await admin`DELETE FROM organizations WHERE id IN (${ORG_A}, ${ORG_B})`
      await admin.end({ timeout: 5 })
    }
    if (app) await app.end({ timeout: 5 })
  })

  it('o papel da aplicação NÃO ignora RLS — se ignorasse, todo o resto seria teatro', async () => {
    const [row] = await app<{ bypass: boolean; superuser: boolean }[]>`
      SELECT rolbypassrls AS bypass, rolsuper AS superuser
      FROM pg_roles WHERE rolname = current_user
    `
    expect(row?.bypass).toBe(false)
    expect(row?.superuser).toBe(false)
  })

  it('sem contexto de tenant, nenhum lead é visível', async () => {
    const leads = await app`SELECT id FROM leads`
    expect(leads).toHaveLength(0)
  })

  /**
   * O caminho de autenticação roda ANTES de existir contexto de tenant — é ele
   * que descobre a qual organização o usuário pertence. Se qualquer uma das
   * três tabelas envolvidas ficar invisível nesse momento, toda sessão válida
   * é tratada como inválida e o app entra em laço de redirecionamento.
   *
   * Foi exatamente o que aconteceu em produção: `organizations` filtrava com
   * `id = mandafy_current_org()`, que sem contexto compara com NULL e resulta
   * em nulo — nunca verdadeiro.
   */
  describe('caminho de autenticação sem contexto de tenant', () => {
    it.each([['sessions'], ['users'], ['organizations']])(
      '%s é legível para o papel da aplicação',
      async (tabela) => {
        const linhas = await app`SELECT 1 FROM ${app(tabela)} LIMIT 1`
        expect(linhas.length).toBeGreaterThan(0)
      },
    )

    it('a junção completa devolve o usuário — é a query real de validateSessionToken', async () => {
      const [linha] = await app<{ user_id: string; org_id: string; org_name: string }[]>`
        SELECT u.id AS user_id, u.org_id, o.name AS org_name
        FROM sessions s
        INNER JOIN users u         ON u.id = s.user_id
        INNER JOIN organizations o ON o.id = u.org_id
        WHERE s.id = ${'sessao-de-teste'}
        LIMIT 1
      `
      expect(linha).toBeDefined()
      expect(linha?.org_id).toBe(ORG_A)
    })
  })

  it('admin enxerga todos os leads da própria organização', async () => {
    const leads = await comoUsuario(
      { orgId: ORG_A, userId: ADMIN_A, isAdmin: true },
      (tx) => tx`SELECT id FROM leads`,
    )
    expect(leads.map((l) => l.id).sort()).toEqual([LEAD_DO_CONSULTOR, LEAD_DE_OUTRO].sort())
  })

  it('consultor enxerga APENAS o próprio lead', async () => {
    const leads = await comoUsuario(
      { orgId: ORG_A, userId: CONSULTOR_A, isAdmin: false },
      (tx) => tx`SELECT id FROM leads`,
    )
    expect(leads.map((l) => l.id)).toEqual([LEAD_DO_CONSULTOR])
  })

  it('consultor não alcança lead alheio nem pedindo pelo id', async () => {
    const leads = await comoUsuario(
      { orgId: ORG_A, userId: CONSULTOR_A, isAdmin: false },
      (tx) => tx`SELECT id FROM leads WHERE id = ${LEAD_DE_OUTRO}`,
    )
    expect(leads).toHaveLength(0)
  })

  it('consultor não consegue sequestrar lead alheio com UPDATE', async () => {
    await comoUsuario(
      { orgId: ORG_A, userId: CONSULTOR_A, isAdmin: false },
      (tx) => tx`UPDATE leads SET owner_id = ${CONSULTOR_A} WHERE id = ${LEAD_DE_OUTRO}`,
    )

    const [lead] = await admin<{ owner_id: string }[]>`
      SELECT owner_id FROM leads WHERE id = ${LEAD_DE_OUTRO}
    `
    expect(lead?.owner_id).toBe(CONSULTOR_A2)
  })

  it('consultor não consegue criar lead em nome de outro', async () => {
    await expect(
      comoUsuario(
        { orgId: ORG_A, userId: CONSULTOR_A, isAdmin: false },
        (tx) => tx`
          INSERT INTO leads (org_id, contact_id, owner_id, pipeline_id, stage_id, title)
          SELECT ${ORG_A}, contact_id, ${CONSULTOR_A2}, pipeline_id, stage_id, 'Contrabando'
          FROM leads WHERE id = ${LEAD_DO_CONSULTOR}
        `,
      ),
    ).rejects.toThrow()
  })

  it('admin de uma organização não vê nada da outra', async () => {
    const leads = await comoUsuario(
      { orgId: ORG_A, userId: ADMIN_A, isAdmin: true },
      (tx) => tx`SELECT id FROM leads WHERE id = ${LEAD_ORG_B}`,
    )
    expect(leads).toHaveLength(0)
  })

  it('contatos também respeitam a fronteira da organização', async () => {
    const contatos = await comoUsuario(
      { orgId: ORG_A, userId: ADMIN_A, isAdmin: true },
      (tx) => tx`SELECT id, org_id FROM contacts`,
    )
    expect(contatos.length).toBeGreaterThan(0)
    expect(contatos.every((c) => c.org_id === ORG_A)).toBe(true)
  })

  it('escrever com org_id de outra organização é rejeitado', async () => {
    await expect(
      comoUsuario(
        { orgId: ORG_A, userId: ADMIN_A, isAdmin: true },
        (tx) => tx`INSERT INTO contacts (org_id, name) VALUES (${ORG_B}, 'Invasor')`,
      ),
    ).rejects.toThrow()
  })

  it('atividades de lead herdam a visibilidade do lead', async () => {
    await admin`
      INSERT INTO lead_activities (lead_id, user_id, type, content)
      VALUES (${LEAD_DE_OUTRO}, ${CONSULTOR_A2}, 'nota', 'nota privada')
    `

    const atividades = await comoUsuario(
      { orgId: ORG_A, userId: CONSULTOR_A, isAdmin: false },
      (tx) => tx`SELECT id FROM lead_activities`,
    )
    expect(atividades).toHaveLength(0)
  })
})

/**
 * Escrita em tabela de tenant SEM contexto declarado.
 *
 * Este é o modo de falha que derrubou o login em produção: a Server Action
 * gravava em `audit_log` fora de withTenant(), a política comparava org_id com
 * NULL, e a inserção era rejeitada — levando junto o login inteiro.
 *
 * A política está certa; quem estava errado era o chamador. Estes testes
 * fixam o contrato: sem contexto não escreve, com contexto escreve.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL || !process.env.TEST_DATABASE_URL_ADMIN)(
  'escrita exige contexto de tenant',
  () => {
    let admin: postgres.Sql
    let app: postgres.Sql
    const ORG = '00000000-0000-4000-8000-0000000000c1'
    const USER = '00000000-0000-4000-8000-0000000000c2'

    beforeAll(async () => {
      admin = postgres(process.env.TEST_DATABASE_URL_ADMIN!, { max: 1, onnotice: () => {} })
      app = postgres(process.env.TEST_DATABASE_URL!, { max: 2, onnotice: () => {} })
      await admin`DELETE FROM organizations WHERE id = ${ORG}`
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org C', 'rls-org-c')`
      await admin`INSERT INTO users (id, org_id, name, email, password_hash, role)
                  VALUES (${USER}, ${ORG}, 'Admin C', 'rls-c@teste.local', 'x', 'admin')`
    })

    afterAll(async () => {
      if (admin) {
        await admin`DELETE FROM organizations WHERE id = ${ORG}`
        await admin.end({ timeout: 5 })
      }
      if (app) await app.end({ timeout: 5 })
    })

    it('sem contexto, o INSERT em audit_log é rejeitado pela política', async () => {
      await expect(
        app`INSERT INTO audit_log (org_id, user_id, action) VALUES (${ORG}, ${USER}, 'auth.login')`,
      ).rejects.toThrow(/row-level security/i)
    })

    it('com contexto, o mesmo INSERT passa', async () => {
      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${ORG}, true),
                        set_config('app.user_id', ${USER}, true),
                        set_config('app.is_admin', 'true', true)`
        await tx`INSERT INTO audit_log (org_id, user_id, action)
                 VALUES (${ORG}, ${USER}, 'auth.login')`
      })

      const [linha] = await admin<{ total: number }[]>`
        SELECT count(*)::int AS total FROM audit_log WHERE org_id = ${ORG}
      `
      expect(linha?.total).toBe(1)
    })

    it('com contexto de OUTRA organização, o INSERT é rejeitado', async () => {
      await expect(
        app.begin(async (tx) => {
          await tx`SELECT set_config('app.org_id', ${'00000000-0000-4000-8000-0000000000ff'}, true)`
          await tx`INSERT INTO audit_log (org_id, user_id, action)
                   VALUES (${ORG}, ${USER}, 'auth.login')`
        }),
      ).rejects.toThrow(/row-level security/i)
    })
  },
)
