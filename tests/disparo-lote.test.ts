import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, inArray, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { configurarCanais } from './stubs/canais'
import * as schema from '@/db/schema'
import { notifications } from '@/db/schema'
import type { Tx } from '@/db'
import { enfileirarEnvio } from '@/lib/delivery/enqueue'
import { listarMensagensParaDisparo } from '@/db/queries/messages'

/**
 * Disparo manual para uma lista (§5, §9.1).
 *
 * O disparo em lote não reimplementa a entrega: ele chama `enfileirarEnvio`
 * uma vez por contato. O que estes testes provam é justamente isso — que
 * mandar para uma lista NÃO é um atalho que pula as guardas.
 *
 * É o lugar onde pular seria mais tentador e mais caro: um erro aqui sai
 * multiplicado pelo tamanho da base, e "mandei para quem tinha pedido para
 * sair" não se desfaz.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('b1')
const ADMIN = uid('b2')
const MSG = uid('b3')
const QUEM_RECEBE = uid('b4')
const QUEM_SAIU = uid('b5')

describe.skipIf(!habilitado)('§5 — disparo manual para uma lista', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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

  /** O mesmo que a ação faz por contato — é ela que estamos exercitando. */
  const disparar = (contactId: string, dados: Record<string, string>, loteId = 'lote-1') =>
    comoAdmin((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId,
        messageId: MSG,
        dados,
        dedupeKey: `lote:${loteId}:${contactId}`,
      }),
    )

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Disparo', 'disparo-org')`
      await configurarCanais(tx as unknown as postgres.Sql, ORG)
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'disparo-admin@teste.local', 'x', 'admin')`

      // Mensagem transacional: não exige opt-in explícito, e usa uma variável
      // que o contato não tem — exatamente o caso que a tela pergunta.
      await tx`INSERT INTO messages (id, org_id, key, name, category, body, active) VALUES
        (${MSG}, ${ORG}, 'aviso-sorteio', 'Aviso de sorteio', 'transacional',
         'Oi {{nome|"parceiro"}}, o {{sorteio}} fecha em instantes!', true)`
      await tx`INSERT INTO message_variants (message_id, channel, enabled) VALUES
        (${MSG}, 'sms', true)`

      await tx`INSERT INTO contacts (id, org_id, name, phone_e164, optin_source, optin_at) VALUES
        (${QUEM_RECEBE}, ${ORG}, 'Recebe', '+5511900000001', 'import', now()),
        (${QUEM_SAIU},   ${ORG}, 'Saiu',   '+5511900000002', 'import', now())`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  /*
   * Conta só o que vai SAIR.
   *
   * Um pulo também vira linha em `notifications`, com status `skipped` — é de
   * propósito, para o Histórico poder explicar quem não recebeu e por quê.
   * Contar tudo diria que o descadastrado "recebeu".
   */
  const naFila = (contactId: string) =>
    comoAdmin(async (tx) =>
      (
        await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.orgId, ORG),
              eq(notifications.contactId, contactId),
              inArray(notifications.status, ['queued', 'scheduled']),
            ),
          )
      ).length,
    )

  it('enfileira com a variável que a tela preencheu', async () => {
    const r = await disparar(QUEM_RECEBE, { sorteio: 'PTV 18h' })

    expect(r.map((c) => c.situacao)).toEqual(['enfileirado'])
    expect(await naFila(QUEM_RECEBE)).toBe(1)
  })

  /*
   * A guarda que não pode ter exceção. Disparo em massa é onde alguém teria a
   * tentação de "mandar para todo mundo da lista" — e a lista, vinda de
   * planilha, quase sempre tem dentro quem já pediu para sair.
   */
  it('não manda para quem pediu para sair', async () => {
    await admin`UPDATE contacts SET opted_out_at = now() WHERE id = ${QUEM_SAIU}`

    const r = await disparar(QUEM_SAIU, { sorteio: 'PTV 18h' })

    expect(r).toEqual([{ canal: 'sms', situacao: 'pulado', motivo: 'optout' }])
    expect(await naFila(QUEM_SAIU)).toBe(0)
  })

  it('não manda pelo canal bloqueado para aquele contato', async () => {
    await admin`INSERT INTO suppressions (org_id, contact_id, channel, reason)
                VALUES (${ORG}, ${QUEM_SAIU}, 'sms', 'hard_bounce')`

    const r = await disparar(QUEM_SAIU, { sorteio: 'PTV 18h' })
    expect(r[0]).toMatchObject({ situacao: 'pulado', motivo: 'suppressed' })
  })

  /*
   * Clicar duas vezes, ou repetir uma leva depois de a rede cair, é o
   * acidente mais provável de todos numa tela de disparo — e o único cujo
   * dano chega ao cliente.
   */
  it('repetir o mesmo lote não manda de novo', async () => {
    await disparar(QUEM_RECEBE, { sorteio: 'PTV 18h' })
    const segunda = await disparar(QUEM_RECEBE, { sorteio: 'PTV 18h' })

    expect(segunda[0]).toMatchObject({ situacao: 'pulado', motivo: 'duplicate' })
    expect(await naFila(QUEM_RECEBE)).toBe(1)
  })

  /* Um disparo NOVO, mais tarde, tem de poder alcançar a mesma pessoa. */
  it('um lote diferente alcança quem já recebeu o anterior', async () => {
    await disparar(QUEM_RECEBE, { sorteio: 'PTV 14h' }, 'lote-1')
    const outro = await disparar(QUEM_RECEBE, { sorteio: 'PTV 18h' }, 'lote-2')

    expect(outro[0]?.situacao).toBe('enfileirado')
    expect(await naFila(QUEM_RECEBE)).toBe(2)
  })

  /*
   * Sem o valor da variável a mensagem não compila, e o envio não sai. É por
   * isso que a tela exige preencher ANTES de habilitar o botão: aqui já seria
   * tarde, e o relatório diria "falhou" sem dizer o que fazer.
   */
  it('sem o valor da variável, o envio falha em vez de sair pela metade', async () => {
    const r = await disparar(QUEM_RECEBE, {})

    expect(r[0]?.situacao).toBe('falhou')
    expect(await naFila(QUEM_RECEBE)).toBe(0)
  })
})

describe.skipIf(!habilitado)('§5 — mensagens oferecidas para disparo', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const ORG2 = uid('b6')
  const ADMIN2 = uid('b7')
  const ATIVA = uid('b8')
  const PAUSADA = uid('b9')

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG2}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG2}, 'Org Lista', 'disparo-lista')`
      await configurarCanais(tx as unknown as postgres.Sql, ORG2)
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN2}, ${ORG2}, 'Admin', 'disparo-lista@teste.local', 'x', 'admin')`
      await tx`INSERT INTO messages (id, org_id, key, name, category, body, active) VALUES
        (${ATIVA},   ${ORG2}, 'ativa',   'Aviso ativo',   'transacional', 'oi', true),
        (${PAUSADA}, ${ORG2}, 'pausada', 'Aviso pausado', 'transacional', 'oi', false)`
      await tx`INSERT INTO message_variants (message_id, channel, enabled) VALUES
        (${ATIVA}, 'whatsapp', true),
        (${ATIVA}, 'sms', false)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG2}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('oferece só a ativa, com os canais que estão ligados', async () => {
    const lista = await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG2}, true),
          set_config('app.user_id',  ${ADMIN2}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return listarMensagensParaDisparo(tx as Tx)
    })

    expect(lista.map((m) => m.name)).toEqual(['Aviso ativo'])
    // O canal desligado não aparece: prometer SMS que não sai é pior que não
    // prometer nada.
    expect(lista[0]?.canaisAtivos).toEqual(['whatsapp'])
    expect(lista[0]?.body).toBe('oi')
  })
})
