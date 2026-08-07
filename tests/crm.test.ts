import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import {
  cargaPorConsultor,
  contarLeads,
  detalharLead,
  listarLeads,
  montarPipeline,
} from '@/db/queries/leads'
import {
  criarLeadDoEvento,
  criarLeadsDosContatosDoWebhook,
  varrerLeadsAtrasados,
} from '@/lib/crm/criar-lead'

/**
 * CRM contra um Postgres de verdade (§9).
 *
 * O que importa provar aqui é §9.4: "Consultor só enxerga os próprios leads —
 * garantido no BANCO (RLS), não só na UI". Por isso os testes rodam com o papel
 * `mandafy_app`, que tem RLS aplicado, e o consultor tenta ver o que não é dele
 * pelas MESMAS consultas que a tela usa.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('c01')
const ADMIN = uid('c02')
const ANA = uid('c03')
const BRUNO = uid('c04')
const PIPELINE = uid('c05')
const ETAPA_NOVO = uid('c06')
const ETAPA_GANHO = uid('c07')
const CONTATO_ANA = uid('c08')
const CONTATO_BRUNO = uid('c09')
const LEAD_ANA = uid('c10')
const LEAD_BRUNO = uid('c11')

describe.skipIf(!habilitado)('CRM (§9)', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  function como<T>(userId: string, isAdmin: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG}, true),
               set_config('app.user_id', ${userId}, true),
               set_config('app.is_admin', ${isAdmin ? 'true' : 'false'}, true)
      `)
      return fn(tx as Tx)
    })
  }

  const comoAdmin = <T,>(fn: (tx: Tx) => Promise<T>) => como(ADMIN, true, fn)
  const comoAna = <T,>(fn: (tx: Tx) => Promise<T>) => como(ANA, false, fn)

  /**
   * A mensagem real do Postgres.
   *
   * O Drizzle embrulha o erro do driver num `DrizzleQueryError` cujo texto é
   * só "Failed query: …" — o motivo de verdade fica em `cause`.
   */
  function motivoDoBanco(erro: unknown): string {
    const partes: string[] = []
    let atual: unknown = erro
    for (let i = 0; i < 5 && atual instanceof Error; i += 1) {
      partes.push(atual.message)
      atual = (atual as { cause?: unknown }).cause
    }
    return partes.join(' | ')
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org CRM', 'crm-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'crm-admin@teste.local', 'x', 'admin'),
        (${ANA},   ${ORG}, 'Ana',   'crm-ana@teste.local',   'x', 'consultor'),
        (${BRUNO}, ${ORG}, 'Bruno', 'crm-bruno@teste.local', 'x', 'consultor')`

      await tx`INSERT INTO pipelines (id, org_id, name, is_default) VALUES (${PIPELINE}, ${ORG}, 'Padrão', true)`
      await tx`INSERT INTO pipeline_stages (id, pipeline_id, name, position, is_won, is_lost) VALUES
        (${ETAPA_NOVO},  ${PIPELINE}, 'Novo',  0, false, false),
        (${ETAPA_GANHO}, ${PIPELINE}, 'Ganho', 1, true,  false)`

      await tx`INSERT INTO contacts (id, org_id, name, phone_e164, total_orders) VALUES
        (${CONTATO_ANA},   ${ORG}, 'Cliente da Ana',   '+5511911111111', 0),
        (${CONTATO_BRUNO}, ${ORG}, 'Cliente do Bruno', '+5511922222222', 3)`

      await tx`INSERT INTO leads (id, org_id, contact_id, owner_id, pipeline_id, stage_id, title, value_cents, source) VALUES
        (${LEAD_ANA},   ${ORG}, ${CONTATO_ANA},   ${ANA},   ${PIPELINE}, ${ETAPA_NOVO}, 'Lead da Ana',   10000, 'manual'),
        (${LEAD_BRUNO}, ${ORG}, ${CONTATO_BRUNO}, ${BRUNO}, ${PIPELINE}, ${ETAPA_NOVO}, 'Lead do Bruno', 50000, 'manual')`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  describe('§9.4 — consultor só enxerga os próprios leads', () => {
    it('o administrador vê os dois', async () => {
      const lista = await comoAdmin(listarLeads)
      expect(lista.map((l) => l.title).sort()).toEqual(['Lead da Ana', 'Lead do Bruno'])
    })

    it('a Ana vê só o dela — pela MESMA consulta da tela', async () => {
      // O recorte não está na consulta: está no RLS. Se a política quebrar,
      // este teste falha, e é isso que ele existe para pegar.
      const lista = await comoAna(listarLeads)
      expect(lista.map((l) => l.title)).toEqual(['Lead da Ana'])
    })

    it('a contagem também respeita o recorte', async () => {
      expect(await comoAdmin(contarLeads)).toBe(2)
      expect(await comoAna(contarLeads)).toBe(1)
    })

    it('a Ana não abre o lead do Bruno nem sabendo o id', async () => {
      expect(await comoAna((tx) => detalharLead(tx, LEAD_BRUNO))).toBeNull()
      expect(await comoAna((tx) => detalharLead(tx, LEAD_ANA))).not.toBeNull()
    })

    it('o pipeline da Ana vem filtrado (§9.4)', async () => {
      const doAdmin = await comoAdmin((tx) => montarPipeline(tx))
      const daAna = await comoAna((tx) => montarPipeline(tx))

      const novoAdmin = doAdmin.find((c) => c.stageId === ETAPA_NOVO)
      const novoAna = daAna.find((c) => c.stageId === ETAPA_NOVO)

      expect(novoAdmin?.total).toBe(2)
      expect(novoAna?.total).toBe(1)
      // A soma da coluna também: R$ 600 para o admin, R$ 100 para a Ana.
      expect(novoAdmin?.somaCents).toBe(60000)
      expect(novoAna?.somaCents).toBe(10000)
    })

    it('a Ana não consegue mover o lead do Bruno', async () => {
      await comoAna(async (tx) => {
        await tx.execute(sql`UPDATE leads SET stage_id = ${ETAPA_GANHO} WHERE id = ${LEAD_BRUNO}`)
      })

      const [linha] = (await admin`
        SELECT stage_id FROM leads WHERE id = ${LEAD_BRUNO}`) as unknown as { stage_id: string }[]

      expect(linha?.stage_id).toBe(ETAPA_NOVO)
    })

    it('a Ana não consegue empurrar o próprio lead para outro consultor', async () => {
      /*
       * O `WITH CHECK` da política RECUSA a escrita, em vez de deixá-la passar
       * sem efeito. É a diferença que importa: o UPDATE que tira o lead do
       * próprio escopo estoura, e o banco recusa em voz alta.
       */
      const erro = await comoAna(async (tx) => {
        await tx.execute(sql`UPDATE leads SET owner_id = ${BRUNO} WHERE id = ${LEAD_ANA}`)
      }).catch((e: unknown) => e)

      expect(motivoDoBanco(erro)).toMatch(/row-level security/i)

      const [linha] = (await admin`
        SELECT owner_id FROM leads WHERE id = ${LEAD_ANA}`) as unknown as { owner_id: string }[]

      expect(linha?.owner_id).toBe(ANA)
    })

    it('mas o administrador reatribui à vontade (§9.4)', async () => {
      await comoAdmin(async (tx) => {
        await tx.execute(sql`UPDATE leads SET owner_id = ${BRUNO} WHERE id = ${LEAD_ANA}`)
      })

      const [linha] = (await admin`
        SELECT owner_id FROM leads WHERE id = ${LEAD_ANA}`) as unknown as { owner_id: string }[]

      expect(linha?.owner_id).toBe(BRUNO)
    })
  })

  describe('carga por consultor (§9.3)', () => {
    it('o administrador vê a carga de todos', async () => {
      const carga = await comoAdmin(cargaPorConsultor)
      expect(carga.get(ANA)).toBe(1)
      expect(carga.get(BRUNO)).toBe(1)
    })

    it('lead fechado não conta como carga', async () => {
      await admin`UPDATE leads SET status = 'ganho' WHERE id = ${LEAD_ANA}`

      const carga = await comoAdmin(cargaPorConsultor)
      expect(carga.get(ANA)).toBeUndefined()
      expect(carga.get(BRUNO)).toBe(1)
    })
  })

  describe('criação automática (§9.3)', () => {
    const evento = (tipo: string, contactId: string, dados: Record<string, unknown> = {}) => ({
      orgId: ORG,
      tipo,
      contactId,
      dados,
    })

    /*
     * O buraco que este bloco fecha: as três regras de §9.3 dependem de
     * comportamento — pagou, não pagou, sumiu — e nenhuma cobria o caso mais
     * comum do webhook, que é alguém se cadastrar pela primeira vez. Esse
     * cadastro virava contato e parava aí, invisível para o time comercial.
     */
    it('quem chega pela primeira vez vira lead, seja qual for o evento', async () => {
      const recemChegado = uid('c25')
      await admin`INSERT INTO contacts (id, org_id, name) VALUES (${recemChegado}, ${ORG}, 'Recém-chegado')`

      const r = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, { ...evento('user.created', recemChegado), contatoNovo: true }),
      )

      expect(r[0]).toMatchObject({ criado: true, regra: 'contato_novo' })
      if (r[0]?.criado) expect(r[0].ownerId, 'lead sem dono não é trabalhado').toBeTruthy()
    })

    it('quem já estava na base não vira lead a cada evento', async () => {
      const r = await comoAdmin((tx) => criarLeadDoEvento(tx, evento('user.created', CONTATO_ANA)))
      expect(r).toEqual([])
    })

    it('compra acima de R$ 200 cria lead e atribui no rodízio', async () => {
      const contatoNovo = uid('c20')
      await admin`INSERT INTO contacts (id, org_id, name) VALUES (${contatoNovo}, ${ORG}, 'Cliente Novo')`

      const r = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('order.paid', contatoNovo, { valor_cents: 25000 })),
      )

      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ criado: true, regra: 'compra_alta' })
      if (r[0]?.criado) expect(r[0].ownerId).toBeTruthy()
    })

    it('compra abaixo do limite não cria nada', async () => {
      const r = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('order.paid', CONTATO_ANA, { valor_cents: 5000 })),
      )
      expect(r).toEqual([])
    })

    it('reativação exige histórico de compra', async () => {
      // O contato da Ana tem total_orders = 0; o do Bruno, 3.
      const semHistorico = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('contact.inactive_30d', CONTATO_ANA)),
      )
      expect(semHistorico).toEqual([])

      const comHistorico = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('contact.inactive_30d', CONTATO_BRUNO)),
      )
      expect(comHistorico[0]).toMatchObject({ criado: true, regra: 'reativacao' })
    })

    it('não cria dois leads abertos pela mesma regra', async () => {
      const primeiro = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('contact.inactive_30d', CONTATO_BRUNO)),
      )
      const segundo = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('contact.inactive_30d', CONTATO_BRUNO)),
      )

      expect(primeiro[0]).toMatchObject({ criado: true })
      expect(segundo[0]).toMatchObject({ criado: false })
    })

    it('a regra com atraso NÃO cria na hora', async () => {
      // O lead do PIX abandonado só faz sentido se o pagamento não chegar.
      // Criar já e apagar depois encheria o funil de lead fantasma.
      const r = await comoAdmin((tx) =>
        criarLeadDoEvento(tx, evento('order.created', CONTATO_ANA, { valor_cents: 5000 })),
      )
      expect(r[0]).toMatchObject({ criado: false })
      expect(r[0]?.criado === false && r[0].motivo).toContain('aguardando')
    })
  })

  /*
   * A base que já estava no banco antes de a criação automática existir.
   *
   * A regra `contato_novo` só alcança quem chega depois dela. Todo cadastro que
   * a plataforma mandou antes é contato sem cartão nenhum — e é a maior parte
   * da base. Este é o comando que os traz para o funil, uma vez só.
   */
  describe('leads do que o webhook já trouxe (§9.3)', () => {
    const doWebhook = uid('c40')
    const queSaiu = uid('c41')
    const dePlanilha = uid('c42')

    beforeEach(async () => {
      await admin.begin(async (tx) => {
        // `last_event_at` é o que marca a origem: só a ingestão o preenche.
        await tx`INSERT INTO contacts (id, org_id, name, last_event_at, total_paid_cents) VALUES
          (${doWebhook}, ${ORG}, 'Veio da plataforma', now(), 15000)`
        await tx`INSERT INTO contacts (id, org_id, name, last_event_at, opted_out_at) VALUES
          (${queSaiu}, ${ORG}, 'Pediu para sair', now(), now())`
        // Sem `last_event_at`: veio de planilha, e criar cartão para a lista
        // importada é decisão de quem importa, não deste comando.
        await tx`INSERT INTO contacts (id, org_id, name) VALUES (${dePlanilha}, ${ORG}, 'Veio de planilha')`
      })
    })

    it('sem --aplicar não grava nada, e diz quantos entrariam', async () => {
      const r = await comoAdmin((tx) => criarLeadsDosContatosDoWebhook(tx, ORG))

      expect(r.criados).toBe(1)
      expect(r.pulados).toBe(1)

      const [contagem] = (await admin`
        SELECT count(*)::int AS n FROM leads WHERE contact_id = ${doWebhook}`) as unknown as {
        n: number
      }[]
      expect(contagem?.n, 'a simulação gravou').toBe(0)
    })

    it('com --aplicar o contato da plataforma vira cartão no funil', async () => {
      const r = await comoAdmin((tx) =>
        criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }),
      )
      expect(r.criados).toBe(1)

      const [lead] = (await admin`
        SELECT source, owner_id, value_cents, stage_id FROM leads WHERE contact_id = ${doWebhook}`) as unknown as {
        source: string
        owner_id: string | null
        value_cents: string
        stage_id: string
      }[]

      // Mesma origem e mesma etapa do caminho automático: para o funil, os dois
      // são a mesma coisa — alguém que chegou pela plataforma.
      expect(lead?.source).toBe('evento:contato_novo')
      expect(lead?.stage_id).toBe(ETAPA_NOVO)
      expect(lead?.owner_id, 'lead sem dono não é trabalhado').toBeTruthy()
      expect(Number(lead?.value_cents)).toBe(15000)
    })

    it('quem pediu para sair NÃO vira lead', async () => {
      await comoAdmin((tx) => criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }))

      const [contagem] = (await admin`
        SELECT count(*)::int AS n FROM leads WHERE contact_id = ${queSaiu}`) as unknown as {
        n: number
      }[]
      // Um lead é uma tarefa para um consultor ligar — que é o que a pessoa
      // recusou. A guarda de §5.3 cuida do disparo; aqui, o caminho humano.
      expect(contagem?.n).toBe(0)
    })

    it('quem veio de planilha fica de fora', async () => {
      await comoAdmin((tx) => criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }))

      const [contagem] = (await admin`
        SELECT count(*)::int AS n FROM leads WHERE contact_id = ${dePlanilha}`) as unknown as {
        n: number
      }[]
      expect(contagem?.n).toBe(0)
    })

    it('rodar duas vezes não duplica cartão', async () => {
      await comoAdmin((tx) => criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }))
      const segunda = await comoAdmin((tx) =>
        criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }),
      )

      expect(segunda.criados).toBe(0)

      const [contagem] = (await admin`
        SELECT count(*)::int AS n FROM leads WHERE contact_id = ${doWebhook}`) as unknown as {
        n: number
      }[]
      expect(contagem?.n).toBe(1)
    })

    it('quem já foi trabalhado e teve o lead fechado não volta ao funil', async () => {
      await comoAdmin((tx) => criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }))
      await admin`UPDATE leads SET status = 'perdido' WHERE contact_id = ${doWebhook}`

      const segunda = await comoAdmin((tx) =>
        criarLeadsDosContatosDoWebhook(tx, ORG, { aplicar: true }),
      )
      expect(segunda.criados).toBe(0)
    })
  })

  describe('varredura do PIX abandonado (§9.3)', () => {
    const contatoPix = uid('c30')

    beforeEach(async () => {
      await admin.begin(async (tx) => {
        await tx`INSERT INTO contacts (id, org_id, name) VALUES (${contatoPix}, ${ORG}, 'Cliente PIX')`
        await tx`INSERT INTO events (org_id, type, external_id, contact_id, occurred_at, data)
          VALUES (${ORG}, 'order.created', 'PED-999', ${contatoPix},
                  now() - interval '30 hours', '{"valor_cents": 7500}'::jsonb)`
      })
    })

    it('cria o lead de quem gerou o PIX e não pagou', async () => {
      const criados = await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))
      expect(criados).toBe(1)

      const lista = await comoAdmin(listarLeads)
      const novo = lista.find((l) => l.source === 'evento:pix_nao_pago_24h')
      expect(novo?.valueCents).toBe(7500)
    })

    it('NÃO cria para quem pagou depois', async () => {
      // A checagem de "não pagou" acontece agora, não no momento do evento — é
      // o que separa um funil real de um cheio de gente que pagou dez minutos
      // depois.
      await admin`INSERT INTO events (org_id, type, external_id, contact_id, occurred_at, data)
        VALUES (${ORG}, 'order.paid', 'PED-999', ${contatoPix}, now() - interval '29 hours', '{}'::jsonb)`

      expect(await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))).toBe(0)
    })

    it('NÃO cria para quem cancelou', async () => {
      await admin`INSERT INTO events (org_id, type, external_id, contact_id, occurred_at, data)
        VALUES (${ORG}, 'order.cancelled', 'PED-999', ${contatoPix}, now() - interval '29 hours', '{}'::jsonb)`

      expect(await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))).toBe(0)
    })

    it('não cria duas vezes o mesmo lead', async () => {
      expect(await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))).toBe(1)
      expect(await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))).toBe(0)
    })

    it('pedido recente ainda não conta', async () => {
      await admin`DELETE FROM events WHERE org_id = ${ORG}`
      await admin`INSERT INTO events (org_id, type, external_id, contact_id, occurred_at, data)
        VALUES (${ORG}, 'order.created', 'PED-888', ${contatoPix}, now() - interval '2 hours', '{}'::jsonb)`

      expect(await comoAdmin((tx) => varrerLeadsAtrasados(tx, ORG))).toBe(0)
    })
  })
})
