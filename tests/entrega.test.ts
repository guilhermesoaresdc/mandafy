import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { cancelarPorChave, enfileirarEnvio } from '@/lib/delivery/enqueue'

/**
 * O caminho de enfileiramento contra um Postgres de verdade.
 *
 * Cobre o que os testes puros de `lib/delivery` não alcançam: que as guardas
 * viram LINHA no banco com o motivo certo, que o corpo compilado é gravado, e
 * que o cancelamento por chave (§5.1) pega só o que ainda não saiu.
 *
 * O Redis é dublado — o que interessa aqui é o estado no Postgres, e exigir um
 * Redis de pé transformaria um teste de lógica num teste de infraestrutura.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('e01')
const USUARIO = uid('e02')
const CONTATO = uid('e03')
const MENSAGEM = uid('e04')

const jobsAdicionados: { fila: string; opts: unknown }[] = []
const jobsRemovidos: string[] = []

vi.mock('@/lib/queue', async (original) => {
  const real = await original<typeof import('@/lib/queue')>()
  return {
    ...real,
    getQueue: (nome: string) => ({
      add: (_n: string, _d: unknown, opts: unknown) => {
        jobsAdicionados.push({ fila: nome, opts })
        return Promise.resolve({ id: `job-${jobsAdicionados.length}` })
      },
      remove: (id: string) => {
        jobsRemovidos.push(id)
        return Promise.resolve()
      },
    }),
  }
})

describe.skipIf(!habilitado)('Enfileiramento de envio (§5.3, §8.1)', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG}, true),
               set_config('app.user_id', ${USUARIO}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  /** Estado das notificações do contato, para conferir o que foi gravado. */
  async function notificacoes(): Promise<
    { channel: string; status: string; error_code: string | null; rendered_body: string | null }[]
  > {
    return admin`
      SELECT channel, status, error_code, rendered_body
      FROM notifications WHERE org_id = ${ORG} ORDER BY channel
    ` as unknown as Promise<
      { channel: string; status: string; error_code: string | null; rendered_body: string | null }[]
    >
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    jobsAdicionados.length = 0
    jobsRemovidos.length = 0

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Entrega', 'entrega-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${USUARIO}, ${ORG}, 'Admin', 'entrega-admin@teste.local', 'x', 'admin')`

      await tx`INSERT INTO contacts (id, org_id, name, phone_e164, email, telegram_chat_id, optin_at) VALUES
        (${CONTATO}, ${ORG}, 'Ana', '+5511988887777', 'ana@teste.local', 999, now())`

      await tx`INSERT INTO messages (id, org_id, key, name, category, body, ignore_quiet_hours) VALUES
        (${MENSAGEM}, ${ORG}, 'lembrete', 'Lembrete', 'transacional',
         'Oi {{nome}}, seu PIX de {{valor_cents|moeda}} está aberto.', true)`

      await tx`INSERT INTO message_variants (message_id, channel, enabled) VALUES
        (${MENSAGEM}, 'whatsapp', true), (${MENSAGEM}, 'telegram', true),
        (${MENSAGEM}, 'email', true),    (${MENSAGEM}, 'sms', false)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  const DADOS = { nome: 'Ana', valor_cents: 4990 }

  it('enfileira os canais ligados e grava o corpo compilado', async () => {
    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    const enfileirados = resultados.filter((r) => r.situacao === 'enfileirado')
    expect(enfileirados.map((r) => r.canal).sort()).toEqual(['email', 'telegram'])

    // WhatsApp não sai: nenhum número conectado nesta organização. Vira linha
    // para o histórico explicar, em vez de o envio sumir sem rastro.
    expect(resultados.find((r) => r.canal === 'whatsapp')).toMatchObject({
      situacao: 'pulado',
      motivo: 'sem_numero_conectado',
    })

    const linhas = await notificacoes()
    const telegram = linhas.find((l) => l.channel === 'telegram')
    expect(telegram?.status).toBe('queued')
    // O corpo gravado é o que o cliente receberia, com as variáveis resolvidas.
    expect(telegram?.rendered_body).toContain('R$ 49,90')
    expect(telegram?.rendered_body).not.toContain('{{')
  })

  it('canal desligado não entra no envio nem vira linha', async () => {
    // Registrar um pulo por canal desligado a cada envio encheria uma tabela
    // particionada de alta escrita com ruído.
    await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    expect((await notificacoes()).find((l) => l.channel === 'sms')).toBeUndefined()
  })

  it('mas PEDIR um canal desligado vira `skipped` com o motivo', async () => {
    // Aí o pulo é informação: você pediu e não saiu, eis o porquê.
    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['sms'],
        dados: DADOS,
      }),
    )

    expect(resultados[0]).toMatchObject({ situacao: 'pulado', motivo: 'canal_desligado' })
    expect((await notificacoes()).find((l) => l.channel === 'sms')).toMatchObject({
      status: 'skipped',
      error_code: 'canal_desligado',
    })
  })

  it('opt-out global bloqueia todos os canais', async () => {
    await admin`UPDATE contacts SET opted_out_at = now() WHERE id = ${CONTATO}`

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    expect(resultados.every((r) => r.situacao === 'pulado')).toBe(true)
    expect((await notificacoes()).every((l) => l.error_code === 'optout')).toBe(true)
  })

  it('supressão bloqueia só o canal suprimido', async () => {
    await admin`INSERT INTO suppressions (org_id, contact_id, channel, reason)
      VALUES (${ORG}, ${CONTATO}, 'email', 'hard_bounce')`

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    expect(resultados.find((r) => r.canal === 'email')).toMatchObject({
      situacao: 'pulado',
      motivo: 'suppressed',
    })
    expect(resultados.find((r) => r.canal === 'telegram')?.situacao).toBe('enfileirado')
  })

  it('promocional sem opt-in não sai (§14.1)', async () => {
    await admin`UPDATE contacts SET optin_at = NULL WHERE id = ${CONTATO}`
    await admin`UPDATE messages SET category = 'relacionamento' WHERE id = ${MENSAGEM}`

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    expect(resultados.every((r) => r.situacao === 'pulado')).toBe(true)
    expect((await notificacoes()).every((l) => l.error_code === 'sem_optin')).toBe(true)
  })

  it('sem endereço para o canal, pula só aquele canal', async () => {
    await admin`UPDATE contacts SET telegram_chat_id = NULL WHERE id = ${CONTATO}`

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, { orgId: ORG, contactId: CONTATO, messageId: MENSAGEM, dados: DADOS }),
    )

    expect(resultados.find((r) => r.canal === 'telegram')).toMatchObject({ motivo: 'sem_destino' })
    expect(resultados.find((r) => r.canal === 'email')?.situacao).toBe('enfileirado')
  })

  it('variável faltando derruba a notificação, não manda `{{nome}}` literal', async () => {
    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['telegram'],
        dados: {},
      }),
    )

    expect(resultados[0]).toMatchObject({ situacao: 'falhou', motivo: 'variavel_ausente' })

    const linha = (await notificacoes()).find((l) => l.channel === 'telegram')
    expect(linha).toMatchObject({ status: 'failed', error_code: 'variavel_ausente' })
    expect(linha?.rendered_body).toBeNull()
  })

  it('grava o queue_job_id — a linha precisa ser reencontrável', async () => {
    /*
     * Regressão de um bug caro e silencioso: o Postgres guarda `timestamptz`
     * com microssegundo, o `Date` do JS só tem milissegundo. A chave primária
     * desta tabela particionada é (id, created_at), então um `now()` com
     * microssegundos tornava a linha inalcançável por qualquer UPDATE vindo do
     * JS. Nenhum envio conseguia gravar o próprio resultado.
     */
    await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['telegram'],
        dados: DADOS,
      }),
    )

    const [linha] = (await admin`
      SELECT queue_job_id, created_at = date_trunc('milliseconds', created_at) AS ms
      FROM notifications WHERE org_id = ${ORG} AND channel = 'telegram'
    `) as unknown as { queue_job_id: string | null; ms: boolean }[]

    expect(linha?.queue_job_id).toBeTruthy()
    expect(linha?.ms).toBe(true)
  })

  it('o job vai para a fila do canal, com o atraso do agendamento', async () => {
    await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['telegram'],
        dados: DADOS,
      }),
    )

    expect(jobsAdicionados).toHaveLength(1)
    expect(jobsAdicionados[0]?.fila).toBe('telegram')
    expect(jobsAdicionados[0]?.opts).toMatchObject({ delay: expect.any(Number) })
  })

  it('teto diário por contato bloqueia depois de 4 (§5.3)', async () => {
    // Quatro notificações já contam; a quinta não passa.
    for (let i = 0; i < 4; i += 1) {
      await admin`INSERT INTO notifications (org_id, contact_id, channel, status)
        VALUES (${ORG}, ${CONTATO}, 'email', 'sent')`
    }

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['telegram'],
        dados: DADOS,
      }),
    )

    expect(resultados[0]).toMatchObject({ situacao: 'pulado', motivo: 'frequency_cap' })
  })

  it('o teste manual ignora o teto — quatro testes não podem travar a tarde', async () => {
    for (let i = 0; i < 6; i += 1) {
      await admin`INSERT INTO notifications (org_id, contact_id, channel, status)
        VALUES (${ORG}, ${CONTATO}, 'email', 'sent')`
    }

    const resultados = await comoSistema((tx) =>
      enfileirarEnvio(tx, {
        orgId: ORG,
        contactId: CONTATO,
        messageId: MENSAGEM,
        canais: ['telegram'],
        dados: DADOS,
        teste: true,
      }),
    )

    expect(resultados[0]?.situacao).toBe('enfileirado')
  })

  it('dedupe_key repetido em 24h é pulado', async () => {
    const pedido = {
      orgId: ORG,
      contactId: CONTATO,
      messageId: MENSAGEM,
      canais: ['telegram'] as const,
      dados: DADOS,
      dedupeKey: 'pedido-1:lembrete',
    }

    expect((await comoSistema((tx) => enfileirarEnvio(tx, pedido)))[0]?.situacao).toBe('enfileirado')
    expect((await comoSistema((tx) => enfileirarEnvio(tx, pedido)))[0]).toMatchObject({
      motivo: 'duplicate',
    })
  })
})

describe.skipIf(!habilitado)('Cancelamento por chave (§5.1)', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const ORG2 = uid('f01')
  const CONTATO2 = uid('f03')
  const INSTANCIA = uid('f04')

  async function comoSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG2}, true),
               set_config('app.user_id', ${ORG2}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    jobsRemovidos.length = 0
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG2}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG2}, 'Org Cancel', 'cancel-org')`
      await tx`INSERT INTO contacts (id, org_id, name) VALUES (${CONTATO2}, ${ORG2}, 'Ana')`

      // Um envio em cada estado que importa, todos com a MESMA chave.
      // WhatsApp sempre carrega a instância que enviaria: a fila dele é por
      // chip, e sem isso não há de qual fila remover o job.
      await tx`INSERT INTO notifications (org_id, contact_id, channel, status, cancel_key, queue_job_id, provider_instance) VALUES
        (${ORG2}, ${CONTATO2}, 'whatsapp', 'queued',    'order:12345', 'j1', ${INSTANCIA}),
        (${ORG2}, ${CONTATO2}, 'email',    'scheduled', 'order:12345', 'j2', NULL),
        (${ORG2}, ${CONTATO2}, 'sms',      'sent',      'order:12345', 'j3', NULL),
        (${ORG2}, ${CONTATO2}, 'telegram', 'delivered', 'order:12345', 'j4', NULL),
        (${ORG2}, ${CONTATO2}, 'email',    'queued',    'order:99999', 'j5', NULL)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG2}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('cancela o que ainda não saiu', async () => {
    const r = await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:12345'))
    expect(r.cancelados).toBe(2)

    const linhas = (await admin`
      SELECT channel, status FROM notifications WHERE org_id = ${ORG2} AND cancel_key = 'order:12345'
      ORDER BY channel
    `) as unknown as { channel: string; status: string }[]

    expect(linhas.find((l) => l.channel === 'whatsapp')?.status).toBe('cancelled')
    expect(linhas.find((l) => l.channel === 'email')?.status).toBe('cancelled')
  })

  it('NÃO mexe no que já saiu — o histórico não pode mentir', async () => {
    await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:12345'))

    const linhas = (await admin`
      SELECT channel, status FROM notifications WHERE org_id = ${ORG2} AND cancel_key = 'order:12345'
    `) as unknown as { channel: string; status: string }[]

    expect(linhas.find((l) => l.channel === 'sms')?.status).toBe('sent')
    expect(linhas.find((l) => l.channel === 'telegram')?.status).toBe('delivered')
  })

  it('não alcança outra chave', async () => {
    await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:12345'))

    const [outra] = (await admin`
      SELECT status FROM notifications WHERE org_id = ${ORG2} AND cancel_key = 'order:99999'
    `) as unknown as { status: string }[]

    expect(outra?.status).toBe('queued')
  })

  it('remove os jobs da fila, para não sobrar trabalho morto', async () => {
    await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:12345'))
    expect(jobsRemovidos.sort()).toEqual(['j1', 'j2'])
  })

  it('WhatsApp sem instância ainda cancela no banco', async () => {
    // Sem instância não dá para saber a fila (ela é por chip). O status no
    // banco continua sendo a verdade: o worker lê `cancelled` e não envia.
    await admin`UPDATE notifications SET provider_instance = NULL
      WHERE org_id = ${ORG2} AND channel = 'whatsapp'`

    const r = await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:12345'))
    expect(r.cancelados).toBe(2)
    expect(jobsRemovidos).toEqual(['j2'])

    const [linha] = (await admin`
      SELECT status FROM notifications WHERE org_id = ${ORG2} AND channel = 'whatsapp'
    `) as unknown as { status: string }[]
    expect(linha?.status).toBe('cancelled')
  })

  it('chave inexistente não faz nada e não estoura', async () => {
    const r = await comoSistema((tx) => cancelarPorChave(tx, ORG2, 'order:naoexiste'))
    expect(r).toEqual({ cancelados: 0, jobs: [] })
  })
})
