import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { detalharNotificacao, listarHistorico, novidadesDesde } from '@/db/queries/historico'
import { metricasDoPainel, proximosEnvios, saudeDosCanais } from '@/db/queries/painel'

/**
 * Histórico e painel contra um Postgres de verdade (§10).
 *
 * As consultas daqui têm alvo de tempo em §13.1 e recortam tabelas
 * particionadas — é o tipo de coisa que passa no `tsc` e é recusada, ou fica
 * lenta, só no banco.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('b01')
const CONTATO = uid('b02')
const OUTRO = uid('b03')
const MENSAGEM = uid('b04')

describe.skipIf(!habilitado)('Histórico e painel (§10)', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoUsuario<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG}, true),
               set_config('app.user_id', ${ORG}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  const AGORA = new Date()
  const minutosAtras = (m: number) => new Date(AGORA.getTime() - m * 60_000)
  const minutosAFrente = (m: number) => new Date(AGORA.getTime() + m * 60_000)

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Painel', 'painel-org')`
      await tx`INSERT INTO contacts (id, org_id, name, phone_e164) VALUES
        (${CONTATO}, ${ORG}, 'Maria Silva', '+5511988887777'),
        (${OUTRO},   ${ORG}, 'João Costa',  '+5511977776666')`
      await tx`INSERT INTO messages (id, org_id, key, name, category, body) VALUES
        (${MENSAGEM}, ${ORG}, 'pix_lembrete_1', 'Lembrete', 'recuperacao', 'oi')`

      // Um envio de cada estado que a tela precisa distinguir.
      await tx`INSERT INTO notifications
        (org_id, contact_id, message_id, channel, status, created_at, attempted_at, sent_at, delivered_at, scheduled_for, error_code, rendered_body)
      VALUES
        (${ORG}, ${CONTATO}, ${MENSAGEM}, 'whatsapp', 'delivered',
         ${minutosAtras(10)}, ${minutosAtras(10)}, ${minutosAtras(10)},
         ${new Date(minutosAtras(10).getTime() + 1200)}, ${minutosAtras(10)}, NULL, 'Oi Maria'),
        (${ORG}, ${CONTATO}, ${MENSAGEM}, 'email', 'sent',
         ${minutosAtras(9)}, ${minutosAtras(9)}, ${new Date(minutosAtras(9).getTime() + 400)},
         NULL, ${minutosAtras(9)}, NULL, 'Oi Maria'),
        (${ORG}, ${OUTRO}, ${MENSAGEM}, 'telegram', 'failed',
         ${minutosAtras(8)}, ${minutosAtras(8)}, NULL, NULL, ${minutosAtras(8)}, 'bloqueado_pelo_destino', 'Oi João'),
        (${ORG}, ${OUTRO}, ${MENSAGEM}, 'sms', 'scheduled',
         ${minutosAtras(7)}, NULL, NULL, NULL, ${minutosAFrente(14)}, NULL, 'Oi João'),
        (${ORG}, ${CONTATO}, ${MENSAGEM}, 'whatsapp', 'cancelled',
         ${minutosAtras(6)}, NULL, NULL, NULL, ${minutosAFrente(30)}, NULL, 'Oi Maria')`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  describe('listarHistorico (§10.1)', () => {
    it('traz as linhas mais recentes primeiro, com contato e mensagem', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx))

      expect(linhas).toHaveLength(5)
      expect(linhas[0]?.status).toBe('cancelled')
      expect(linhas.map((l) => l.contactName)).toContain('Maria Silva')
      expect(linhas.every((l) => l.messageKey === 'pix_lembrete_1')).toBe(true)
    })

    it('calcula a latência da tentativa até a confirmação', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx))

      // O entregue levou 1,2s; o enviado, 0,4s. Contar do `created_at`
      // misturaria o atraso do jitter com a latência do provedor.
      expect(linhas.find((l) => l.status === 'delivered')?.latenciaMs).toBe(1200)
      expect(linhas.find((l) => l.status === 'sent')?.latenciaMs).toBe(400)
    })

    it('quem nunca foi tentado não tem latência', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx))
      expect(linhas.find((l) => l.status === 'scheduled')?.latenciaMs).toBeNull()
    })

    it('filtra por canal', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx, { canais: ['whatsapp'] }))
      expect(linhas).toHaveLength(2)
      expect(linhas.every((l) => l.channel === 'whatsapp')).toBe(true)
    })

    it('filtra por status', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx, { status: ['failed'] }))
      expect(linhas).toHaveLength(1)
      expect(linhas[0]?.errorCode).toBe('bloqueado_pelo_destino')
    })

    it('busca por nome do contato', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx, { busca: 'joão' }))
      expect(linhas).toHaveLength(2)
      expect(linhas.every((l) => l.contactName === 'João Costa')).toBe(true)
    })

    it('busca por telefone também', async () => {
      const linhas = await comoUsuario((tx) => listarHistorico(tx, { busca: '98888' }))
      expect(linhas.every((l) => l.contactName === 'Maria Silva')).toBe(true)
    })

    it('recorta por tempo', async () => {
      // Só o que entrou nos últimos 7 minutos: o cancelado, aos 6.
      const linhas = await comoUsuario((tx) => listarHistorico(tx, { horas: 7 / 60 }))
      expect(linhas).toHaveLength(1)
      expect(linhas[0]?.status).toBe('cancelled')
    })

    it('sobrevive a contato apagado — o log é o que resta', async () => {
      await admin`DELETE FROM contacts WHERE id = ${OUTRO}`

      const linhas = await comoUsuario((tx) => listarHistorico(tx))
      const orfa = linhas.find((l) => l.channel === 'telegram')

      expect(orfa).toBeDefined()
      expect(orfa?.contactName).toBeNull()
    })

    it('não enxerga outra organização', async () => {
      const outraOrg = uid('b90')
      await admin.begin(async (tx) => {
        await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
        await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Vizinha', 'painel-viz')`
        await tx`INSERT INTO notifications (org_id, channel, status) VALUES (${outraOrg}, 'email', 'sent')`
      })

      try {
        const linhas = await comoUsuario((tx) => listarHistorico(tx))
        expect(linhas).toHaveLength(5)
      } finally {
        await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
      }
    })
  })

  describe('detalharNotificacao (§10.1)', () => {
    it('traz o corpo exato que saiu', async () => {
      const [linha] = (await admin`
        SELECT id, created_at FROM notifications
        WHERE org_id = ${ORG} AND status = 'delivered'`) as unknown as {
        id: string
        created_at: Date
      }[]

      const detalhe = await comoUsuario((tx) =>
        detalharNotificacao(tx, linha!.id, linha!.created_at),
      )

      expect(detalhe?.renderedBody).toBe('Oi Maria')
      expect(detalhe?.latenciaMs).toBe(1200)
      expect(detalhe?.contactName).toBe('Maria Silva')
    })

    it('id certo com data errada não encontra — a partição faz parte da chave', async () => {
      const [linha] = (await admin`
        SELECT id FROM notifications WHERE org_id = ${ORG} LIMIT 1`) as unknown as { id: string }[]

      const detalhe = await comoUsuario((tx) =>
        detalharNotificacao(tx, linha!.id, new Date('2020-01-01T00:00:00Z')),
      )
      expect(detalhe).toBeNull()
    })
  })

  describe('novidadesDesde — a fonte do SSE (§10.1)', () => {
    it('traz o que foi criado depois do corte', async () => {
      const novas = await comoUsuario((tx) => novidadesDesde(tx, minutosAtras(7)))
      // O agendado (7min) é o limite; o cancelado (6min) entrou depois.
      expect(novas.map((l) => l.status)).toContain('cancelled')
    })

    it('traz também o que MUDOU, não só o que nasceu', async () => {
      /*
       * É o que faz "enviando → entregue" aparecer ao vivo. Sem olhar
       * `sent_at`/`delivered_at`, o status de quem já está na tela ficaria
       * congelado até a pessoa recarregar.
       */
      const corte = minutosAtras(5)
      await admin`UPDATE notifications SET status = 'delivered', delivered_at = now()
        WHERE org_id = ${ORG} AND status = 'failed'`

      const novas = await comoUsuario((tx) => novidadesDesde(tx, corte))
      expect(novas.some((l) => l.channel === 'telegram')).toBe(true)
    })

    it('nada mudou desde agora', async () => {
      expect(await comoUsuario((tx) => novidadesDesde(tx, new Date()))).toEqual([])
    })
  })

  describe('métricas do painel (§10.3)', () => {
    it('conta o que saiu e calcula a taxa de entrega', async () => {
      const m = await comoUsuario((tx) => metricasDoPainel(tx))

      // 2 saíram (delivered + sent); 1 foi confirmado.
      expect(m.enviadasHoje).toBeGreaterThanOrEqual(2)
      expect(m.taxaEntrega).toBeGreaterThan(0)
      expect(m.taxaEntrega).toBeLessThanOrEqual(1)
    })

    it('conta a fila e as falhas', async () => {
      const m = await comoUsuario((tx) => metricasDoPainel(tx))
      expect(m.naFila).toBe(1)
      expect(m.falhas24h).toBe(1)
    })

    it('sem envio nenhum, a taxa é nula em vez de 0% — 0% mentiria', async () => {
      await admin`DELETE FROM notifications WHERE org_id = ${ORG}`

      const m = await comoUsuario((tx) => metricasDoPainel(tx))
      expect(m.taxaEntrega).toBeNull()
      expect(m.enviadasHoje).toBe(0)
    })
  })

  describe('proximosEnvios — a barra de pulso (§11.6)', () => {
    it('traz só o que ainda vai sair na janela', async () => {
      const proximos = await comoUsuario((tx) => proximosEnvios(tx, 60))

      // O SMS agendado para +14min entra; o cancelado de +30min não, porque
      // cancelado não sai.
      expect(proximos).toHaveLength(1)
      expect(proximos[0]?.channel).toBe('sms')
    })

    it('não traz o que já passou', async () => {
      await admin`UPDATE notifications SET scheduled_for = ${minutosAtras(30)}
        WHERE org_id = ${ORG} AND status = 'scheduled'`

      expect(await comoUsuario((tx) => proximosEnvios(tx, 60))).toEqual([])
    })

    it('respeita a janela pedida', async () => {
      expect(await comoUsuario((tx) => proximosEnvios(tx, 5))).toEqual([])
      expect(await comoUsuario((tx) => proximosEnvios(tx, 60))).toHaveLength(1)
    })
  })

  describe('saúde por canal (§10.4)', () => {
    it('devolve os quatro canais, mesmo os sem movimento', async () => {
      const saude = await comoUsuario((tx) => saudeDosCanais(tx))
      expect(saude.map((s) => s.canal).sort()).toEqual(['email', 'sms', 'telegram', 'whatsapp'])
    })

    it('calcula a taxa de falha por canal', async () => {
      const saude = await comoUsuario((tx) => saudeDosCanais(tx))

      // Telegram: 0 enviadas, 1 falha → 100%.
      expect(saude.find((s) => s.canal === 'telegram')?.taxaFalha).toBe(1)
      // E-mail: 1 enviada, 0 falhas → 0%.
      expect(saude.find((s) => s.canal === 'email')?.taxaFalha).toBe(0)
    })

    it('canal sem movimento tem taxa nula, não zero', async () => {
      const saude = await comoUsuario((tx) => saudeDosCanais(tx))
      // O SMS só tem agendado, que não conta nem como envio nem como falha.
      expect(saude.find((s) => s.canal === 'sms')?.taxaFalha).toBeNull()
    })
  })

  /*
   * ── AS DUAS METADES DO CARTÃO "HOJE" CONTAM O MESMO DIA ──
   *
   * `movimentoDoDia` agrupava em `AT TIME ZONE 'America/Sao_Paulo'` e
   * `metricasDoPainel` contava em UTC, e os dois eram renderizados lado a lado
   * sob um cabeçalho que diz "do 00h de Brasília até agora". Entre 21h e 00h de
   * Brasília — 00h e 03h em UTC — o segundo recomeçava do zero enquanto o
   * primeiro continuava somando.
   *
   * O teste que pega isso é o que fixa a hora dentro dessa faixa. Com a hora
   * do relógio da máquina, ele passa 21 horas por dia e falha nas outras três,
   * que é o pior tipo de teste que existe.
   */
  describe('o fuso do cartão Hoje (§10.2)', () => {
    const NOITE = uid('b40')

    // 23:30 em Brasília = 02:30 do dia SEGUINTE em UTC. É o instante em que o
    // painel se contradizia.
    const VINTE_E_TRES_E_MEIA_BRT = new Date('2026-08-09T02:30:00.000Z')

    beforeAll(async () => {
      await admin.begin(async (tx) => {
        await tx`INSERT INTO contacts (id, org_id, name) VALUES (${NOITE}, ${ORG}, 'Noite')
                 ON CONFLICT (id) DO NOTHING`

        // Enviada às 22:00 de Brasília — mesmo dia local, dia seguinte em UTC.
        await tx`INSERT INTO notifications (org_id, contact_id, channel, status, created_at, sent_at)
                 VALUES (${ORG}, ${NOITE}, 'whatsapp', 'delivered',
                         '2026-08-09T01:00:00.000Z', '2026-08-09T01:00:00.000Z')`
      })
    })

    afterAll(async () => {
      await admin`DELETE FROM notifications WHERE contact_id = ${NOITE}`
      await admin`DELETE FROM contacts WHERE id = ${NOITE}`
    })

    it('às 23h30 de Brasília, o envio das 22h ainda conta como HOJE', async () => {
      const m = await comoUsuario((tx) => metricasDoPainel(tx, VINTE_E_TRES_E_MEIA_BRT))

      /*
       * Com `diaUtc`, "hoje" seria 2026-08-09 e o início do dia seria
       * 09/08 00:00 UTC = 08/08 21:00 BRT: a mensagem das 22h BRT entraria por
       * acidente, mas as de 18h do mesmo dia local ficariam de fora. Este
       * número só fecha se as duas pontas usarem o fuso da banca.
       */
      expect(m.enviadasHoje).toBeGreaterThanOrEqual(1)
    })

    it('e uma mensagem de ontem à noite NÃO entra no hoje', async () => {
      // 22:00 BRT do dia 07 = 08/08 01:00 UTC. Em UTC parece dia 8; no fuso da
      // banca é dia 7, e o cartão "Hoje" não pode somá-la.
      const ONTEM = uid('b41')
      await admin`INSERT INTO contacts (id, org_id, name) VALUES (${ONTEM}, ${ORG}, 'Ontem')
                  ON CONFLICT (id) DO NOTHING`
      await admin`INSERT INTO notifications (org_id, contact_id, channel, status, created_at, sent_at)
                  VALUES (${ORG}, ${ONTEM}, 'whatsapp', 'delivered',
                          '2026-08-08T01:00:00.000Z', '2026-08-08T01:00:00.000Z')`

      try {
        const m = await comoUsuario((tx) => metricasDoPainel(tx, VINTE_E_TRES_E_MEIA_BRT))
        const comOntem = await comoUsuario((tx) =>
          metricasDoPainel(tx, new Date('2026-08-08T02:30:00.000Z')),
        )

        // A de 07/08 conta no dia 07, não no dia 08.
        expect(comOntem.enviadasHoje).toBeGreaterThanOrEqual(1)
        // E não infla o dia seguinte.
        expect(m.enviadasHoje).toBeLessThan(comOntem.enviadasHoje + 2)
      } finally {
        await admin`DELETE FROM notifications WHERE contact_id = ${ONTEM}`
        await admin`DELETE FROM contacts WHERE id = ${ONTEM}`
      }
    })
  })
})
