import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { listarFluxos } from '@/db/queries/flows'
import { seedFlows } from '@/db/seed-flows'
import { RITMOS, semearFunilPadrao, semearRitmos } from '@/db/seed-org'
import { MENSAGENS } from '@/lib/messages/modelos'

/**
 * Semear pela interface (§5.2, §7.2, §9.2).
 *
 * O QUE ESTE ARQUIVO PROTEGE
 *
 * A tela de fluxos vazia mandava rodar `npm run db:seed`. Quem opera o Mandafy
 * trabalha pelo navegador, então isso era uma porta sem maçaneta — e virou
 * botão. Só que o caminho do botão é diferente do caminho do comando em dois
 * pontos que não aparecem em `tsc`, `eslint` nem `next build`:
 *
 *   1. O botão roda como `mandafy_app`, COM RLS. O comando roda como dono do
 *      banco, que ignora RLS. Uma política errada aqui não dá erro: devolve
 *      zero linha, o código conclui "não existe" e tenta inserir tudo de novo.
 *   2. Os fluxos casam com o ritmo POR NOME. Sem os perfis gravados antes, os
 *      nove nascem com `jitter_profile_id` nulo, em silêncio, e a coluna some
 *      da tela.
 *
 * Por isso a suíte roda com os dois papéis, como tests/rls.test.ts.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('f01')
const PESSOA = uid('f02')

describe.skipIf(!habilitado)('Semear a organização pela interface', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  /** O mesmo contexto que `withTenant` monta na Server Action. */
  async function comoAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${PESSOA}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  /** É isto que `criarFluxosModeloAction` faz, na ordem em que faz. */
  async function trazerOsModelos() {
    return comoAdmin(async (tx) => {
      const ritmos = await semearRitmos(tx, ORG)
      const modelos = await seedFlows(tx, ORG)
      return { ritmos, ...modelos }
    })
  }

  /*
   * A ordem importa: `flow_steps.message_id` é FK com onDelete RESTRICT, então
   * apagar a organização primeiro esbarra nos passos que ainda apontam para as
   * mensagens. É a mesma proteção que impede alguém de apagar pela tela uma
   * mensagem que um fluxo usa.
   */
  async function limpar() {
    await admin`DELETE FROM flow_steps WHERE flow_id IN (SELECT id FROM flows WHERE org_id = ${ORG})`
    await admin`DELETE FROM flows WHERE org_id = ${ORG}`
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  afterAll(async () => {
    if (!habilitado) return
    await limpar()
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    // Organização nova a cada caso: semear é idempotente, e testar a
    // idempotência exige começar do zero de propósito.
    await limpar()
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Semear', 'semear-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${PESSOA}, ${ORG}, 'Admin', 'semear-admin@teste.local', 'x', 'admin')`
  })

  it('o botão cria os nove fluxos e o catálogo inteiro, com RLS ligado', async () => {
    const feito = await trazerOsModelos()

    expect(feito.ritmos).toBe(RITMOS.length)
    expect(feito.fluxos).toBe(9)
    // Contra o tamanho do catálogo, e não contra um número escrito à mão:
    // ele já mudou uma vez quando dois modelos viraram um.
    expect(feito.mensagens).toBe(MENSAGENS.length)
  })

  it('todo fluxo nasce COM ritmo — o vínculo é por nome e degrada calado', async () => {
    await trazerOsModelos()

    const fluxos = await comoAdmin(listarFluxos)

    /*
     * Se os ritmos não forem semeados antes, `perfilPorNome.get()` devolve
     * indefinido, o fluxo grava `jitter_profile_id` nulo e nada acusa: sem
     * erro, sem aviso, e a coluna "ritmo" simplesmente some da lista. O envio
     * passa a sair sem espaçamento nenhum entre mensagens — que é o oposto do
     * que §7.2 existe para garantir.
     */
    for (const fluxo of fluxos) {
      expect(fluxo.ritmo, `ritmo de "${fluxo.name}"`).not.toBeNull()
    }
  })

  it('todo fluxo nasce PAUSADO', async () => {
    await trazerOsModelos()

    // Modelo ativo mandaria texto de exemplo no primeiro evento que chegasse, e
    // a pessoa descobriria pelo cliente.
    const fluxos = await comoAdmin(listarFluxos)
    expect(fluxos.every((f) => !f.active)).toBe(true)
  })

  it('clicar duas vezes não duplica nada', async () => {
    await trazerOsModelos()
    const segunda = await trazerOsModelos()

    // Dois cliques por impaciência são o modo de uso esperado.
    expect(segunda).toEqual({ ritmos: 0, fluxos: 0, mensagens: 0 })

    const fluxos = await comoAdmin(listarFluxos)
    expect(fluxos).toHaveLength(9)
  })

  it('o funil padrão nasce com as cinco etapas, e só uma vez', async () => {
    expect(await comoAdmin((tx) => semearFunilPadrao(tx, ORG))).toBe(true)
    expect(await comoAdmin((tx) => semearFunilPadrao(tx, ORG))).toBe(false)

    const [linha] = await admin<{ etapas: number }[]>`
      SELECT count(*)::int AS etapas
      FROM pipeline_stages s
      JOIN pipelines p ON p.id = s.pipeline_id
      WHERE p.org_id = ${ORG}`

    expect(linha?.etapas).toBe(5)
  })

  it('um padrão já existente não é atropelado nem quebra a inserção', async () => {
    /*
     * `jitter_profiles_one_default_uq` é índice único PARCIAL em (org_id) onde
     * `is_default`. O `onConflictDoNothing` mira em (org_id, name) e não cobre
     * esse índice: inserir "Seguro" como padrão numa organização que já tem
     * outro padrão levantaria violação de unicidade e derrubaria a ação
     * inteira — o botão responderia erro com a tela ainda vazia.
     */
    await admin`INSERT INTO jitter_profiles (org_id, name, mode, min_seconds, max_seconds, is_default)
      VALUES (${ORG}, 'Meu ritmo', 'humano', 5, 10, true)`

    const criados = await comoAdmin((tx) => semearRitmos(tx, ORG))
    expect(criados).toBe(RITMOS.length)

    const [linha] = await admin<{ padroes: number; nome: string }[]>`
      SELECT count(*) FILTER (WHERE is_default)::int AS padroes,
             max(name) FILTER (WHERE is_default) AS nome
      FROM jitter_profiles WHERE org_id = ${ORG}`

    // Continua havendo UM padrão, e é o que a organização já tinha escolhido.
    expect(linha?.padroes).toBe(1)
    expect(linha?.nome).toBe('Meu ritmo')
  })

  it('semear com um orgId que não é o do contexto NÃO grava', async () => {
    const outra = uid('f99')

    /*
     * A defesa de fundo. `seedFlows` recebe a organização por parâmetro e não a
     * lê do contexto, então passar um id vindo de formulário seria escrever no
     * tenant errado — se o RLS deixasse. O WITH CHECK da política é quem
     * recusa, e este caso é o que prova que ele está ligado.
     */
    await expect(comoAdmin((tx) => seedFlows(tx, outra))).rejects.toThrow()

    const [linha] = await admin<{ total: number }[]>`
      SELECT count(*)::int AS total FROM messages WHERE org_id = ${outra}`
    expect(linha?.total).toBe(0)
  })
})
