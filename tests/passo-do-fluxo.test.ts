import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'

/**
 * Ajustar um passo do fluxo pela tela (§5.1).
 *
 * O QUE MUDOU E POR QUE PRECISA DE TESTE
 *
 * O passo só sabia mudar de tempo. Agora muda também a MENSAGEM e a HORA — e as
 * duas coisas novas abrem buracos que o `tsc` não vê:
 *
 *   a mensagem vem de um `<select>`, e `<select>` é sugestão. `flow_steps` não
 *   tem `org_id`: a política de RLS dele olha o FLUXO, não a mensagem. Um id de
 *   outra banca passaria pela política, passaria pela chave estrangeira, e o
 *   passo apontaria para a mensagem de outra organização — vazamento de dado
 *   entre inquilinos gravado por um formulário legítimo.
 *
 *   a hora vem de um campo de texto e vira coluna `time`. Um valor que o
 *   Postgres recusa derruba a ação; um que ele ACEITA e não é o que a pessoa
 *   digitou sai na hora errada, dias depois, sem nada acusando.
 *
 * Roda como `mandafy_app`, com RLS aplicado, porque é lá que as duas decidem.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('a01')
const OUTRA_ORG = uid('a02')
const ADMIN = uid('a03')
const FLUXO = uid('a04')
const MSG_MINHA = uid('a05')
const MSG_OUTRA = uid('a06')
const MSG_ALVO = uid('a07')

describe.skipIf(!habilitado)('§5.1 — ajustar o passo de um fluxo', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const USUARIO = {
    id: ADMIN,
    orgId: ORG,
    name: 'Admin',
    email: 'passo-admin@teste.local',
    role: 'admin' as const,
    isAdmin: true,
    orgName: 'Banca',
    orgSlug: 'passo-org',
    timezone: 'America/Sao_Paulo',
  }

  /**
   * NA ORDEM, e não `DELETE FROM organizations` direto.
   *
   * `flow_steps.message_id` é RESTRICT: a cascata da organização até `messages`
   * esbarra nos passos, e a limpeza estoura no fim de uma suíte inteiramente
   * verde — ou, pior, no começo da próxima, deixando lixo que faz o `INSERT`
   * falhar por chave duplicada.
   */
  async function limpar() {
    await admin`DELETE FROM flow_steps WHERE flow_id IN
      (SELECT id FROM flows WHERE org_id IN (${ORG}, ${OUTRA_ORG}))`
    await admin`DELETE FROM flows WHERE org_id IN (${ORG}, ${OUTRA_ORG})`
    await admin`DELETE FROM messages WHERE org_id IN (${ORG}, ${OUTRA_ORG})`
    await admin`DELETE FROM organizations WHERE id IN (${ORG}, ${OUTRA_ORG})`
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await limpar()
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${ORG}, 'Banca', 'passo-org'),
      (${OUTRA_ORG}, 'Outra banca', 'passo-outra')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'passo-admin@teste.local', 'x', 'admin')`

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
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    vi.doUnmock('@/lib/auth/current')
    vi.doUnmock('next/cache')
    await limpar()
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM flow_steps WHERE flow_id = ${FLUXO}`
    await admin`DELETE FROM flows WHERE id = ${FLUXO}`
    await admin`DELETE FROM messages WHERE id IN (${MSG_MINHA}, ${MSG_OUTRA}, ${MSG_ALVO})`

    await admin`INSERT INTO messages (id, org_id, key, name, body) VALUES
      (${MSG_MINHA}, ${ORG},       'minha', 'A minha', 'oi'),
      (${MSG_ALVO},  ${ORG},       'alvo',  'A outra minha', 'oi'),
      (${MSG_OUTRA}, ${OUTRA_ORG}, 'deles', 'A da outra banca', 'oi')`

    await admin`INSERT INTO flows (id, org_id, name, trigger_event)
      VALUES (${FLUXO}, ${ORG}, 'Boas-vindas', 'user.created')`
    await admin`INSERT INTO flow_steps (id, flow_id, position, delay_seconds, message_id)
      VALUES (${uid('a08')}, ${FLUXO}, 1, 0, ${MSG_MINHA})`
  })

  /** Roda a ação com os campos que o formulário manda. */
  async function ajustar(campos: Record<string, string>) {
    const { salvarPassoAction } = await import('@/app/(app)/fluxos/actions')

    const form = new FormData()
    form.append('flowId', FLUXO)
    form.append('stepId', uid('a08'))
    for (const [nome, valor] of Object.entries(campos)) form.append(nome, valor)

    return salvarPassoAction({}, form)
  }

  async function passo() {
    const [linha] = await admin<
      { delay_seconds: number; send_at_local: string | null; message_id: string }[]
    >`SELECT delay_seconds, send_at_local::text, message_id FROM flow_steps WHERE id = ${uid('a08')}`
    return linha!
  }

  it('troca a mensagem do passo', async () => {
    const r = await ajustar({ atraso: '0', hora: '', messageId: MSG_ALVO })

    expect(r.ok).toBe(true)
    expect((await passo()).message_id).toBe(MSG_ALVO)
  })

  /*
   * O caso que justifica o arquivo. A política de `flow_steps` olha o fluxo, e
   * o fluxo é meu — então nem o RLS nem a chave estrangeira recusariam isto.
   */
  it('RECUSA mensagem de outra organização, em vez de gravá-la', async () => {
    const r = await ajustar({ atraso: '0', hora: '', messageId: MSG_OUTRA })

    expect(r.erro).toBeTruthy()
    // E o passo continua apontando para onde apontava.
    expect((await passo()).message_id).toBe(MSG_MINHA)
  })

  it('grava a hora marcada no formato da coluna', async () => {
    const r = await ajustar({ atraso: '2 dias', hora: '10:00', messageId: MSG_MINHA })

    expect(r.ok).toBe(true)
    const linha = await passo()
    expect(linha.delay_seconds).toBe(2 * 86400)
    expect(linha.send_at_local).toBe('10:00:00')
  })

  it('aceita "18h" e normaliza — a pessoa escreve como pensa', async () => {
    await ajustar({ atraso: '0', hora: '18h', messageId: MSG_MINHA })
    expect((await passo()).send_at_local).toBe('18:00:00')
  })

  it('campo de hora vazio limpa a marcação, e o passo volta à cascata', async () => {
    await ajustar({ atraso: '0', hora: '10:00', messageId: MSG_MINHA })
    expect((await passo()).send_at_local).toBe('10:00:00')

    // Tirar a hora precisa ser possível: sem isso, marcar por engano seria
    // permanente, e a recuperação de PIX não pode ter hora marcada.
    await ajustar({ atraso: '0', hora: '', messageId: MSG_MINHA })
    expect((await passo()).send_at_local).toBeNull()
  })

  it('hora impossível é recusada com explicação, e nada é gravado', async () => {
    const r = await ajustar({ atraso: '0', hora: '25:00', messageId: MSG_MINHA })

    expect(r.erro).toContain('horário')
    expect((await passo()).send_at_local).toBeNull()
  })

  it('tempo ilegível continua sendo recusado', async () => {
    const r = await ajustar({ atraso: 'depois', hora: '', messageId: MSG_MINHA })

    expect(r.erro).toContain('tempo')
    expect((await passo()).delay_seconds).toBe(0)
  })

  it('sem messageId, mexe só no tempo — a mensagem fica onde estava', async () => {
    await ajustar({ atraso: '30min', hora: '' })

    const linha = await passo()
    expect(linha.delay_seconds).toBe(1800)
    expect(linha.message_id).toBe(MSG_MINHA)
  })

  it('passo de OUTRO fluxo não é alcançável pelo id', async () => {
    // O `where` casa `flow_steps.id` com `flow_id`, e o fluxo passa pelo RLS.
    // Sem isso, um stepId adivinhado mexeria no fluxo de outra banca.
    const alheio = uid('a09')
    await admin`INSERT INTO flows (id, org_id, name, trigger_event)
      VALUES (${uid('a10')}, ${OUTRA_ORG}, 'Deles', 'user.created')`
    await admin`INSERT INTO flow_steps (id, flow_id, position, delay_seconds, message_id)
      VALUES (${alheio}, ${uid('a10')}, 1, 0, ${MSG_OUTRA})`

    const { salvarPassoAction } = await import('@/app/(app)/fluxos/actions')
    const form = new FormData()
    form.append('flowId', uid('a10'))
    form.append('stepId', alheio)
    form.append('atraso', '99 dias')
    form.append('hora', '')
    await salvarPassoAction({}, form)

    const [linha] = await admin<{ delay_seconds: number }[]>`
      SELECT delay_seconds FROM flow_steps WHERE id = ${alheio}`
    expect(linha?.delay_seconds).toBe(0)

    await admin`DELETE FROM flows WHERE id = ${uid('a10')}`
  })

  it('o fluxo é lido de volta com o que foi salvo', async () => {
    await ajustar({ atraso: '2 dias', hora: '10:00', messageId: MSG_ALVO })

    const { buscarFluxo } = await import('@/db/queries/flows')
    const completo = await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${ADMIN}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return buscarFluxo(tx as Tx, FLUXO)
    })

    const p = completo?.passos[0]
    expect(p?.sendAtLocal).toBe('10:00')
    expect(p?.messageId).toBe(MSG_ALVO)
    expect(p?.offsetLabel).toBe('+2 dias')
  })

  it('a mensagem em branco é sinalizada, não escondida', async () => {
    await admin`UPDATE messages SET body = '' WHERE id = ${MSG_MINHA}`

    const { buscarFluxo } = await import('@/db/queries/flows')
    const completo = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${ORG}, true)`)
      return buscarFluxo(tx as Tx, FLUXO)
    })

    // A tela troca a amostra por um aviso: um passo apontando para mensagem
    // vazia não envia nada, e nada mais na linha revelaria isso.
    expect(completo?.passos[0]?.amostra).toBe('')
  })

  it('a mensagem em uso por um passo não pode ser apagada por baixo', async () => {
    /*
     * `flow_steps.message_id` é RESTRICT, e é o certo: um passo apontando para
     * uma mensagem que não existe mais é um fluxo que falha no disparo, longe
     * de quem apagou. O banco recusa antes.
     */
    await expect(admin`DELETE FROM messages WHERE id = ${MSG_MINHA}`).rejects.toThrow(
      /foreign key|flow_steps/i,
    )
  })

  it('a mensagem de outra organização nem aparece para escolher', async () => {
    const { listarMensagens } = await import('@/db/queries/messages')
    const lista = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${ORG}, true)`)
      return listarMensagens(tx as Tx)
    })

    // A defesa de verdade é a do servidor, testada acima. Esta é a primeira
    // camada: o RLS já não deixa a opção chegar ao seletor.
    expect(lista.some((m) => m.id === MSG_OUTRA)).toBe(false)
    expect(lista.some((m) => m.id === MSG_MINHA)).toBe(true)
  })
})

/** Fora do bloco de banco: o teste precisa existir mesmo sem Postgres à mão. */
describe('a leitura do que a pessoa digita na hora', () => {
  it('não confunde tempo com horário', async () => {
    const { lerAtraso, lerHorario } = await import('@/lib/flows/schedule')

    // "2h" é DURAÇÃO no campo de tempo e HORA no campo de horário. Os dois
    // campos ficam lado a lado, e o mesmo texto quer dizer coisas diferentes.
    expect(lerAtraso('2h')).toBe(7200)
    expect(lerHorario('2h')).toBe(120)

    // E o que vale num não vale no outro.
    expect(lerHorario('3 dias')).toBeNull()
    expect(lerAtraso('10:00')).toBeNull()
  })
})
