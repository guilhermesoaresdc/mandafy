import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { processarEvento } from '@/lib/flows/run'

/**
 * O cenário do PIX de §5.1, de ponta a ponta.
 *
 * A spec pede este teste por nome antes de considerar a Fase 5 pronta, e com
 * razão: mandar "finalize seu pagamento" para quem já pagou é o bug número 1
 * de sistemas de recuperação, e é o que faz uma operação perder credibilidade.
 *
 * Roda contra Postgres de verdade porque é lá que o cancelamento acontece — um
 * `UPDATE ... WHERE cancel_key = ... AND status IN ('queued','scheduled')`.
 * Testar isso com objetos em memória testaria outra coisa.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('a01')
const CONTATO = uid('a02')
const FLUXO = uid('a03')
const INSTANCIA = uid('a04')
const MSG = ['a11', 'a12', 'a13', 'a14'].map(uid)

const jobsRemovidos: string[] = []

vi.mock('@/lib/queue', async (original) => {
  const real = await original<typeof import('@/lib/queue')>()
  let contador = 0
  return {
    ...real,
    getQueue: () => ({
      add: () => Promise.resolve({ id: `job-${++contador}` }),
      remove: (id: string) => {
        jobsRemovidos.push(id)
        return Promise.resolve()
      },
    }),
  }
})

describe.skipIf(!habilitado)('§5.1 — o PIX abandonado, resolvido', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG}, true),
               set_config('app.user_id', ${ORG}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  type LinhaEnvio = {
    status: string
    scheduled_for: Date
    cancel_key: string | null
    step_id: string | null
    channel: string
  }

  async function envios(): Promise<LinhaEnvio[]> {
    return admin`
      SELECT status, scheduled_for, cancel_key, step_id, channel
      FROM notifications WHERE org_id = ${ORG} ORDER BY scheduled_for, channel
    ` as unknown as Promise<LinhaEnvio[]>
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    jobsRemovidos.length = 0

    await admin.begin(async (tx) => {
      // Ordem importa: flow_steps aponta para messages com RESTRICT, então os
      // passos têm de sair antes que a cascata da organização chegue às
      // mensagens.
      await tx`DELETE FROM flow_steps WHERE flow_id IN (SELECT id FROM flows WHERE org_id = ${ORG})`
      await tx`DELETE FROM flows WHERE org_id = ${ORG}`
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org PIX', 'pix-org')`
      await tx`INSERT INTO contacts (id, org_id, name, phone_e164, optin_at) VALUES
        (${CONTATO}, ${ORG}, 'Ana', '+5511988887777', now())`

      // O fluxo manda por WhatsApp, então precisa de um chip conectado — sem
      // ele o envio vira `skipped: sem_numero_conectado`.
      await tx`INSERT INTO wa_instances (id, org_id, name, evolution_url, instance_name, status, daily_cap, min_interval_seconds)
        VALUES (${INSTANCIA}, ${ORG}, 'Chip 1', 'http://evolution:8080', 'chip1', 'conectado', 1000, 5)`

      // As quatro mensagens do fluxo, só no WhatsApp para o teste ficar legível.
      const nomes = ['pix_lembrete_1', 'pix_lembrete_2', 'pix_ultima_chance', 'pix_expirou_oferta']
      for (const [i, id] of MSG.entries()) {
        await tx`INSERT INTO messages (id, org_id, key, name, category, body, ignore_quiet_hours)
          VALUES (${id}, ${ORG}, ${nomes[i]!}, ${nomes[i]!}, 'recuperacao',
                  'Oi {{nome}}, seu PIX de {{valor_cents|moeda}} está aberto.', true)`
        await tx`INSERT INTO message_variants (message_id, channel, enabled) VALUES
          (${id}, 'whatsapp', true), (${id}, 'email', false),
          (${id}, 'sms', false),     (${id}, 'telegram', false)`
      }

      // Fluxo "Recuperação de PIX", literalmente como a spec o descreve.
      await tx`INSERT INTO flows (id, org_id, name, trigger_event, cancel_on, cancel_key_template, quiet_hours_enabled)
        VALUES (${FLUXO}, ${ORG}, 'Recuperação de PIX', 'order.created',
                ARRAY['order.paid','order.cancelled'], 'order:{{external_id}}', false)`

      const atrasos = [5 * 60, 20 * 60, 95 * 60, 18 * 3600]
      for (const [i, id] of MSG.entries()) {
        await tx`INSERT INTO flow_steps (flow_id, position, delay_seconds, message_id)
          VALUES (${FLUXO}, ${i + 1}, ${atrasos[i]!}, ${id})`
      }
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM flow_steps WHERE flow_id IN (SELECT id FROM flows WHERE org_id = ${ORG})`
    await admin`DELETE FROM flows WHERE org_id = ${ORG}`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  const CRIADO = new Date('2026-07-30T15:00:00Z')
  const DADOS: Record<string, unknown> = { nome: 'Ana', external_id: '12345', valor_cents: 4990 }

  const orderCreated = (dados = DADOS, agora = CRIADO) =>
    comoSistema((tx) =>
      processarEvento(
        tx,
        { orgId: ORG, tipo: 'order.created', contactId: CONTATO, dados },
        agora,
      ),
    )

  const orderPaid = (dados = DADOS, agora = new Date(CRIADO.getTime() + 3 * 60_000)) =>
    comoSistema((tx) =>
      processarEvento(tx, { orgId: ORG, tipo: 'order.paid', contactId: CONTATO, dados }, agora),
    )

  it('order.created enfileira os 4 passos de uma vez, com a mesma chave', async () => {
    const r = await orderCreated()

    expect(r.fluxos[0]?.disparado).toBe(true)
    expect(r.fluxos[0]?.cancelKey).toBe('order:12345')

    const linhas = await envios()
    expect(linhas).toHaveLength(4)
    expect(linhas.every((l) => l.cancel_key === 'order:12345')).toBe(true)
    expect(linhas.every((l) => l.status === 'queued')).toBe(true)
  })

  it('os quatro ficam agendados em +5min, +25min, +2h e +20h, mais o jitter', async () => {
    await orderCreated()

    const offsets = (await envios()).map(
      (l) => (new Date(l.scheduled_for).getTime() - CRIADO.getTime()) / 60_000,
    )

    // A cascata dá 5/25/120/1200; o ritmo de §7.2 acrescenta alguns segundos a
    // cada um, para que dois pedidos criados no mesmo instante não saiam juntos.
    expect(offsets.map(Math.floor)).toEqual([5, 25, 120, 1200])
    expect(offsets.every((o, i) => o > [5, 25, 120, 1200][i]!)).toBe(true)
  })

  it('order.paid no minuto 3 cancela TODOS os quatro', async () => {
    // O cenário exato de §5.1.
    await orderCreated()
    const r = await orderPaid()

    expect(r.cancelados).toBe(4)
    expect((await envios()).every((l) => l.status === 'cancelled')).toBe(true)
  })

  it('order.cancelled também cancela — os dois eventos estão em cancel_on', async () => {
    await orderCreated()

    const r = await comoSistema((tx) =>
      processarEvento(
        tx,
        { orgId: ORG, tipo: 'order.cancelled', contactId: CONTATO, dados: DADOS },
        new Date(CRIADO.getTime() + 60_000),
      ),
    )

    expect(r.cancelados).toBe(4)
  })

  it('o que JÁ SAIU não é cancelado — o histórico não pode mentir', async () => {
    await orderCreated()

    // O passo 1 saiu no minuto 5; o pagamento chega no minuto 30.
    await admin`UPDATE notifications SET status = 'sent', sent_at = now()
      WHERE id = (SELECT id FROM notifications WHERE org_id = ${ORG}
                  ORDER BY scheduled_for LIMIT 1)`

    const r = await orderPaid(DADOS, new Date(CRIADO.getTime() + 30 * 60_000))

    expect(r.cancelados).toBe(3)

    const linhas = await envios()
    expect(linhas.filter((l) => l.status === 'sent')).toHaveLength(1)
    expect(linhas.filter((l) => l.status === 'cancelled')).toHaveLength(3)
  })

  it('cancela SÓ o pedido pago, não os outros na fila', async () => {
    /*
     * Dois pedidos em paralelo, de pessoas diferentes. Contatos diferentes de
     * propósito: o teto diário de §5.3 é POR CONTATO, e quatro envios do
     * primeiro pedido já ocupam a cota da Ana — o segundo pedido dela viraria
     * `frequency_cap`, que é outro comportamento e mereceria outro teste.
     */
    const outroContato = uid('a30')
    await admin`INSERT INTO contacts (id, org_id, name, phone_e164, optin_at)
      VALUES (${outroContato}, ${ORG}, 'Bruno', '+5511977776666', now())`

    await orderCreated()
    await comoSistema((tx) =>
      processarEvento(
        tx,
        {
          orgId: ORG,
          tipo: 'order.created',
          contactId: outroContato,
          dados: { ...DADOS, external_id: '99999' },
        },
        CRIADO,
      ),
    )

    expect(await envios()).toHaveLength(8)

    await orderPaid()

    const linhas = await envios()
    expect(linhas.filter((l) => l.cancel_key === 'order:12345').every((l) => l.status === 'cancelled')).toBe(true)
    expect(linhas.filter((l) => l.cancel_key === 'order:99999').every((l) => l.status === 'queued')).toBe(true)
  })

  it('a chave casa mesmo com o payload sujo do outro lado', async () => {
    // `order.created` traz " 12345 " e `order.paid` traz "12345". Se as duas
    // não casarem, o lembrete sai para quem pagou.
    await orderCreated({ ...DADOS, external_id: ' 12345 ' })
    const r = await orderPaid({ ...DADOS, external_id: '12345' })

    expect(r.cancelados).toBe(4)
  })

  it('remove os jobs do BullMQ junto', async () => {
    await orderCreated()
    jobsRemovidos.length = 0
    await orderPaid()

    expect(jobsRemovidos).toHaveLength(4)
  })

  it('order.paid de outro contato não cancela nada daqui', async () => {
    await orderCreated()

    await orderPaid({ ...DADOS, external_id: '77777' })

    expect((await envios()).every((l) => l.status === 'queued')).toBe(true)
  })

  it('sem external_id o fluxo NÃO dispara — melhor não agendar que não cancelar', async () => {
    // Quatro envios que nunca poderão ser cancelados são piores que zero.
    const r = await orderCreated({ nome: 'Ana', valor_cents: 4990 })

    expect(r.fluxos[0]?.disparado).toBe(false)
    expect(r.fluxos[0]?.motivo).toContain('chave de cancelamento')
    expect(await envios()).toHaveLength(0)
  })

  it('reenvio do mesmo webhook não duplica a cadência', async () => {
    await orderCreated()
    await orderCreated()

    // O dedupe_key é `<chave>:<passo>`, então o segundo disparo não cria linha.
    expect((await envios()).filter((l) => l.status === 'queued')).toHaveLength(4)
  })

  it('fluxo pausado não dispara nem cancela', async () => {
    await admin`UPDATE flows SET active = false WHERE id = ${FLUXO}`

    const r = await orderCreated()
    expect(r.fluxos).toHaveLength(0)
    expect(await envios()).toHaveLength(0)
  })

  it('condição de entrada barra o que não interessa', async () => {
    await admin`UPDATE flows SET entry_conditions = '{"valor_cents":{"maior_que":10000}}'::jsonb
      WHERE id = ${FLUXO}`

    const r = await orderCreated()
    expect(r.fluxos[0]?.disparado).toBe(false)
    expect(r.fluxos[0]?.motivo).toContain('condições de entrada')

    const acima = await orderCreated({ ...DADOS, external_id: '55555', valor_cents: 20_000 })
    expect(acima.fluxos[0]?.disparado).toBe(true)
  })

  it('cancelar vem ANTES de disparar no mesmo evento', async () => {
    /*
     * `order.paid` cancela o lembrete E dispara o recibo. Se disparasse
     * primeiro, haveria uma janela em que os dois estariam na fila — e o
     * cancelamento poderia levar o recibo junto, já que compartilham a chave.
     */
    const recibo = uid('a20')
    const fluxoRecibo = uid('a21')

    await admin.begin(async (tx) => {
      await tx`INSERT INTO messages (id, org_id, key, name, category, body, ignore_quiet_hours)
        VALUES (${recibo}, ${ORG}, 'recibo', 'Recibo', 'transacional', 'Pagamento confirmado, {{nome}}!', true)`
      await tx`INSERT INTO message_variants (message_id, channel, enabled) VALUES
        (${recibo}, 'whatsapp', true), (${recibo}, 'email', false),
        (${recibo}, 'sms', false),     (${recibo}, 'telegram', false)`
      await tx`INSERT INTO flows (id, org_id, name, trigger_event, cancel_on, cancel_key_template, quiet_hours_enabled)
        VALUES (${fluxoRecibo}, ${ORG}, 'Pagamento confirmado', 'order.paid',
                ARRAY[]::text[], NULL, false)`
      await tx`INSERT INTO flow_steps (flow_id, position, delay_seconds, message_id)
        VALUES (${fluxoRecibo}, 1, 0, ${recibo})`
    })

    await orderCreated()
    const r = await orderPaid()

    expect(r.cancelados).toBe(4)

    const linhas = await envios()
    expect(linhas.filter((l) => l.status === 'cancelled')).toHaveLength(4)
    // O recibo entrou e continua de pé.
    expect(linhas.filter((l) => l.status === 'queued')).toHaveLength(1)
  })
})
