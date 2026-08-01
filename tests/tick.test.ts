import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'

/**
 * O batimento que substitui o worker (§7.1, §8.1).
 *
 * Roda contra Postgres de verdade porque é lá que tudo o que importa acontece:
 * a seleção do que venceu, a comparação-e-troca que impede envio duplo e o
 * respeito ao teto diário. Testar isso com objetos em memória testaria outra
 * coisa.
 *
 * O provedor é o único ponto simulado — mandar mensagem de verdade num teste
 * seria queimar número.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('c01')
const CONTATO = uid('c02')
const INSTANCIA = uid('c03')

/** Toda chamada ao provedor que o tick fez. */
const enviados: string[] = []
let respostaDoProvedor: 'ok' | 'falha_temporaria' | 'falha_permanente' = 'ok'

vi.mock('@/lib/channels', async (original) => {
  const real = await original<typeof import('@/lib/channels')>()
  return {
    ...real,
    enviarPeloCanal: (destino: { para: string }) => {
      enviados.push(destino.para)

      if (respostaDoProvedor === 'ok') {
        return Promise.resolve({
          ok: true,
          provider: 'evolution',
          providerMessageId: `m-${enviados.length}`,
        })
      }

      return Promise.resolve({
        ok: false,
        provider: 'evolution',
        codigo: 'provedor_fora',
        mensagem: 'simulado',
        reenviavel: respostaDoProvedor === 'falha_temporaria',
      })
    },
  }
})

describe.skipIf(!habilitado)('§7.1 — batimento sem worker', () => {
  let admin: postgres.Sql
  let tick: typeof import('@/lib/delivery/tick')

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    tick = await import('@/lib/delivery/tick')

    await admin`
      INSERT INTO organizations (id, name, slug)
      VALUES (${ORG}, 'Tick', 'tick-teste')
      ON CONFLICT (id) DO NOTHING`

    await admin`
      INSERT INTO contacts (id, org_id, name, phone_e164, optin_whatsapp)
      VALUES (${CONTATO}, ${ORG}, 'Tick', '+5511900000001', true)
      ON CONFLICT (id) DO NOTHING`

    /*
     * A apikey cifrada é necessária: sem ela `resolverCanal` para em
     * `sem_credencial` antes de chegar ao provedor, e o teste mediria o guarda
     * de configuração em vez do batimento.
     */
    const { encryptSecret } = await import('@/lib/crypto')
    const apikey = encryptSecret(JSON.stringify({ apikey: 'chave-de-teste' }))

    await admin`
      INSERT INTO wa_instances (id, org_id, name, evolution_url, instance_name,
                                apikey_encrypted, status, min_interval_seconds,
                                daily_cap, sent_today)
      VALUES (${INSTANCIA}, ${ORG}, 'Chip teste', 'http://127.0.0.1:1', 'tick-chip',
              ${apikey}, 'conectado', 0, 100, 0)
      ON CONFLICT (id) DO NOTHING`

    // Sem configuração de canal o envio para em `sem_credencial` antes de
    // chegar ao provedor — e o teste mediria o guarda, não o batimento.
    await admin`
      INSERT INTO channel_configs (org_id, channel, provider, active, is_default)
      VALUES (${ORG}, 'whatsapp', 'evolution', true, true)
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await admin`DELETE FROM notifications WHERE org_id = ${ORG}`
    await admin`DELETE FROM channel_configs WHERE org_id = ${ORG}`
    await admin`DELETE FROM wa_instances WHERE org_id = ${ORG}`
    await admin`DELETE FROM contacts WHERE org_id = ${ORG}`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
  })

  beforeEach(async () => {
    enviados.length = 0
    respostaDoProvedor = 'ok'
    await admin`DELETE FROM notifications WHERE org_id = ${ORG}`
    await admin`UPDATE wa_instances SET sent_today = 0, last_sent_at = NULL,
                min_interval_seconds = 0, daily_cap = 100 WHERE id = ${INSTANCIA}`
  })

  /** Cria uma notificação pronta para sair em `daqui` segundos. */
  async function agendar(
    daquiSegundos: number,
    extra: { status?: string; attempts?: number } = {},
  ): Promise<{ id: string }> {
    const [linha] = await admin<{ id: string }[]>`
      INSERT INTO notifications
        (org_id, contact_id, channel, status, scheduled_for, provider_instance,
         rendered_body, attempts)
      VALUES (
        ${ORG}, ${CONTATO}, 'whatsapp', ${extra.status ?? 'queued'},
        now() + make_interval(secs => ${daquiSegundos}),
        ${INSTANCIA}, 'oi', ${extra.attempts ?? 0}
      )
      RETURNING id`

    if (!linha) throw new Error('não inseriu a notificação de teste')
    return linha
  }

  async function estado(id: string): Promise<{ status: string; attempts: number }> {
    const [l] = await admin<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM notifications WHERE id = ${id}`
    if (!l) throw new Error('notificação de teste sumiu')
    return l
  }

  it('envia o que já venceu', async () => {
    const n = await agendar(-60)

    const r = await tick.tickDeEnvio(20_000)

    expect(r.enviados).toBe(1)
    expect(enviados).toEqual(['+5511900000001'])
    expect((await estado(n.id)).status).toBe('sent')
  })

  it('NÃO envia o que ainda não venceu', async () => {
    /*
     * O teste mais importante do arquivo. É o §5.1 inteiro: se o batimento
     * ignorasse `scheduled_for`, a cascata sairia toda na primeira passada e o
     * cancelamento por pagamento nunca teria o que cancelar.
     */
    const n = await agendar(3600)

    const r = await tick.tickDeEnvio(20_000)

    expect(r.enviados).toBe(0)
    expect(enviados).toEqual([])
    expect((await estado(n.id)).status).toBe('queued')
  })

  it('duas passadas simultâneas não enviam a mesma duas vezes', async () => {
    /*
     * Dois cron atrasados podem se sobrepor. O worker tinha a garantia de
     * entrega única do BullMQ; aqui a garantia é a comparação-e-troca na
     * transição para `sending`. Sem ela, o cliente recebe a mensagem dobrada.
     */
    await agendar(-60)

    const [a, b] = await Promise.all([
      tick.tickDeEnvio(20_000),
      tick.tickDeEnvio(20_000),
    ])

    expect(a.enviados + b.enviados).toBe(1)
    expect(enviados).toHaveLength(1)
  })

  it('respeita o teto diário do chip', async () => {
    await admin`UPDATE wa_instances SET daily_cap = 2, sent_today = 2 WHERE id = ${INSTANCIA}`
    await agendar(-60)

    const r = await tick.tickDeEnvio(20_000)

    // Não é falha: é a regra de §7.3 valendo. Marcar como falha poluiria a
    // taxa que decide a escada de aquecimento.
    expect(r.enviados).toBe(0)
    expect(r.falhas).toBe(0)
    expect(enviados).toEqual([])
  })

  it('espaça envios do mesmo chip pelo intervalo mínimo', async () => {
    await admin`UPDATE wa_instances SET min_interval_seconds = 1 WHERE id = ${INSTANCIA}`
    await agendar(-60)
    await agendar(-60)

    const comecou = Date.now()
    const r = await tick.tickDeEnvio(20_000)
    const levou = Date.now() - comecou

    expect(r.enviados).toBe(2)
    // O segundo espera o intervalo do chip. Sem isso dois envios sairiam no
    // mesmo instante e o WhatsApp veria rajada.
    expect(levou).toBeGreaterThanOrEqual(900)
  })

  it('falha temporária vira `failed` e volta depois do backoff', async () => {
    respostaDoProvedor = 'falha_temporaria'
    const n = await agendar(-60)

    await tick.tickDeEnvio(20_000)
    expect((await estado(n.id)).status).toBe('failed')
    expect((await estado(n.id)).attempts).toBe(1)

    // Cedo demais: o backoff da 1ª tentativa é de 60s.
    expect(await tick.reativarFalhas(new Date())).toBe(0)
    expect((await estado(n.id)).status).toBe('failed')

    // Passado o backoff, volta para a fila.
    const daquiADuasHoras = new Date(Date.now() + 2 * 3600 * 1000)
    expect(await tick.reativarFalhas(daquiADuasHoras)).toBe(1)
    expect((await estado(n.id)).status).toBe('queued')
  })

  it('falha permanente não vira retry — vai direto para `dead`', async () => {
    respostaDoProvedor = 'falha_permanente'
    const n = await agendar(-60)

    await tick.tickDeEnvio(20_000)

    // Insistir num número sem WhatsApp só queima reputação (§8.1).
    expect((await estado(n.id)).status).toBe('dead')
    expect(await tick.reativarFalhas(new Date(Date.now() + 86_400_000))).toBe(0)
  })

  it('esgotadas as tentativas, vira `dead` e para de voltar', async () => {
    const n = await agendar(-60, { status: 'failed', attempts: tick.MAX_TENTATIVAS })
    await admin`UPDATE notifications SET attempted_at = now() - interval '2 days' WHERE id = ${n.id}`

    await tick.reativarFalhas(new Date())

    expect((await estado(n.id)).status).toBe('dead')
  })

  it('cancelada durante a espera não sai', async () => {
    const n = await agendar(-60, { status: 'cancelled' })

    const r = await tick.tickDeEnvio(20_000)

    expect(r.enviados).toBe(0)
    expect(enviados).toEqual([])
    expect((await estado(n.id)).status).toBe('cancelled')
  })

  it('para dentro do orçamento e avisa que sobrou', async () => {
    await admin`UPDATE wa_instances SET min_interval_seconds = 30 WHERE id = ${INSTANCIA}`
    await agendar(-60)
    await agendar(-60)

    // Orçamento pequeno: dá para o primeiro, não para esperar 30s pelo segundo.
    const r = await tick.tickDeEnvio(10_000)

    expect(r.enviados).toBe(1)
    expect(r.sobrou).toBe(true)
  })
})
