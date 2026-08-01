import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { contacts, suppressions } from '@/db/schema'
import { estadoDosCanais } from '@/db/queries/channels'
import { bloquearCanal, descadastrar } from '@/lib/lgpd'

/**
 * Retorno dos canais, EXECUTADO contra um Postgres de verdade (regra 5).
 *
 * O que se protege aqui não é a forma do payload — isso já está coberto, sem
 * banco, em `src/lib/channels/retorno.test.ts`. É o que só o Postgres sabe
 * dizer:
 *
 *   1. a função `mandafy_canal_por_token` de drizzle/0019 existe, tem a
 *      assinatura que a rota chama e ATRAVESSA o RLS. Se ela falhasse aqui, os
 *      três webhooks responderiam 401 para toda chamada legítima — que é
 *      exatamente o defeito que 0016 encontrou na ingestão;
 *   2. `bloquearCanal` grava o motivo certo e não vira opt-out por engano.
 *
 * Precisa dos mesmos endereços de tests/rls.test.ts. Sem eles a suíte é pulada.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('e1')
const OUTRA_ORG = uid('e2')
const ADMIN = uid('e3')
const CONTATO = uid('e4')

const TOKEN_EMAIL = 'retorno-email-token-de-teste'
const TOKEN_SMS = 'retorno-sms-token-de-teste'

describe.skipIf(!habilitado)('Retorno dos canais contra o Postgres', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoUsuario<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id IN (${ORG}, ${OUTRA_ORG})`
      await tx`INSERT INTO organizations (id, name, slug) VALUES
        (${ORG}, 'Org Retorno', 'retorno-org'),
        (${OUTRA_ORG}, 'Org Vizinha', 'retorno-vizinha')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'retorno-admin@teste.local', 'x', 'admin')`

      await tx`INSERT INTO channel_configs (org_id, channel, provider, is_default, webhook_token, credentials_encrypted) VALUES
        (${ORG}, 'email', 'resend', true, ${TOKEN_EMAIL}, '\\x00'::bytea),
        (${ORG}, 'sms',   'smsdev', true, ${TOKEN_SMS},   '\\x00'::bytea)`
    })
  })

  beforeEach(async () => {
    await admin`DELETE FROM contacts WHERE id = ${CONTATO}`
    await admin`INSERT INTO contacts (id, org_id, name, email, phone_e164) VALUES
      (${CONTATO}, ${ORG}, 'Fulano', 'fulano@exemplo.com', '+5588999999999')`
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id IN (${ORG}, ${OUTRA_ORG})`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  describe('mandafy_canal_por_token (drizzle/0019)', () => {
    /**
     * O teste que justifica o arquivo. A chamada roda pelo papel `mandafy_app`
     * SEM `set_config('app.org_id')` — exatamente como a rota, que atende um
     * provedor de fora, sem sessão. Um SELECT direto aqui devolveria zero
     * linhas por causa do RLS, e o retorno seria descartado em silêncio.
     */
    it('acha o canal sem contexto de tenant, atravessando o RLS', async () => {
      const linhas = await app`SELECT id, org_id, channel, provider, active
                               FROM mandafy_canal_por_token(${TOKEN_EMAIL})`

      expect(linhas).toHaveLength(1)
      expect(linhas[0]).toMatchObject({
        org_id: ORG,
        channel: 'email',
        provider: 'resend',
        active: true,
      })
    })

    it('devolve o canal certo para cada token — um por canal', async () => {
      const linhas = await app`SELECT channel FROM mandafy_canal_por_token(${TOKEN_SMS})`
      expect(linhas[0]?.channel).toBe('sms')
    })

    it('token desconhecido não devolve nada', async () => {
      const linhas = await app`SELECT id FROM mandafy_canal_por_token('nao-existe-este-token')`
      expect(linhas).toHaveLength(0)
    })

    it('o mesmo token não pode existir em duas organizações', async () => {
      await expect(
        admin`INSERT INTO channel_configs (org_id, channel, provider, webhook_token) VALUES
              (${OUTRA_ORG}, 'email', 'resend', ${TOKEN_EMAIL})`,
      ).rejects.toThrow()
    })
  })

  it('a tela de canais devolve o token para montar o endereço', async () => {
    const canais = await comoUsuario(estadoDosCanais)
    const email = canais.find((c) => c.canal === 'email')

    expect(email?.webhookToken).toBe(TOKEN_EMAIL)
    // Canal nunca configurado não tem endereço para mostrar.
    expect(canais.find((c) => c.canal === 'telegram')?.webhookToken).toBeNull()
  })

  describe('bloquearCanal (§8.3, §14.1)', () => {
    async function bloqueiosDe(canal: 'email' | 'sms') {
      return comoUsuario((tx) =>
        tx
          .select({ reason: suppressions.reason, detail: suppressions.detail })
          .from(suppressions)
          .where(and(eq(suppressions.contactId, CONTATO), eq(suppressions.channel, canal))),
      )
    }

    /*
     * A distinção que o arquivo inteiro existe para preservar: bounce grava
     * `hard_bounce`, não `optout`. Gravar como opt-out faria a tela de
     * privacidade dizer que a pessoa pediu para sair — e é esse registro que se
     * apresenta quando a fiscalização pergunta quem pediu o quê.
     */
    it('hard bounce grava o motivo técnico, não opt-out', async () => {
      const ok = await comoUsuario((tx) =>
        bloquearCanal(tx, ORG, CONTATO, 'email', 'hard_bounce', 'endereço não existe'),
      )

      expect(ok).toBe(true)
      expect(await bloqueiosDe('email')).toEqual([
        { reason: 'hard_bounce', detail: 'endereço não existe' },
      ])
    })

    it('bounce NÃO marca opt-out global nem derruba o consentimento', async () => {
      await comoUsuario((tx) =>
        bloquearCanal(tx, ORG, CONTATO, 'email', 'hard_bounce', 'endereço não existe'),
      )

      const [contato] = await comoUsuario((tx) =>
        tx
          .select({
            optedOutAt: contacts.optedOutAt,
            optinEmail: contacts.optinEmail,
            optinWhatsapp: contacts.optinWhatsapp,
          })
          .from(contacts)
          .where(eq(contacts.id, CONTATO)),
      )

      expect(contato?.optedOutAt).toBeNull()
      expect(contato?.optinEmail).toBe(true)
      // E-mail morto não diz nada sobre o WhatsApp da mesma pessoa.
      expect(contato?.optinWhatsapp).toBe(true)
    })

    it('reclamação de spam derruba o consentimento daquele canal', async () => {
      await comoUsuario((tx) =>
        bloquearCanal(tx, ORG, CONTATO, 'email', 'complaint', 'marcou como spam'),
      )

      const [contato] = await comoUsuario((tx) =>
        tx
          .select({ optinEmail: contacts.optinEmail, optinSms: contacts.optinSms })
          .from(contacts)
          .where(eq(contacts.id, CONTATO)),
      )

      expect(contato?.optinEmail).toBe(false)
      expect(contato?.optinSms).toBe(true)
    })

    /*
     * O provedor repete o mesmo bounce a cada tentativa. Sem isto, cada
     * repetição viraria uma linha idêntica no log de auditoria.
     */
    it('bounce repetido não duplica nem registra auditoria de novo', async () => {
      const primeira = await comoUsuario((tx) =>
        bloquearCanal(tx, ORG, CONTATO, 'email', 'hard_bounce', 'endereço não existe'),
      )
      const segunda = await comoUsuario((tx) =>
        bloquearCanal(tx, ORG, CONTATO, 'email', 'hard_bounce', 'endereço não existe'),
      )

      expect(primeira).toBe(true)
      expect(segunda).toBe(false)
      expect(await bloqueiosDe('email')).toHaveLength(1)
    })

    it('contato de outra organização não é bloqueável', async () => {
      const ok = await comoUsuario((tx) =>
        bloquearCanal(tx, OUTRA_ORG, CONTATO, 'email', 'hard_bounce', 'x'),
      )
      expect(ok).toBe(false)
    })
  })

  /**
   * O caminho do Telegram: `/parar` bloqueia, `/start` de volta desbloqueia.
   *
   * Sem a remoção da supressão, religar o opt-in não bastaria — a guarda 2
   * (§5.3) consulta `suppressions`, e o `/start` seria um botão que não faz
   * nada.
   */
  it('/parar cria supressão de telegram que o /start remove', async () => {
    await comoUsuario((tx) =>
      descadastrar(tx, ORG, CONTATO, { canal: 'telegram', motivo: 'pediu /parar', quem: null }),
    )

    const depoisDoParar = await comoUsuario((tx) =>
      tx
        .select({ reason: suppressions.reason })
        .from(suppressions)
        .where(and(eq(suppressions.contactId, CONTATO), eq(suppressions.channel, 'telegram'))),
    )
    expect(depoisDoParar).toEqual([{ reason: 'optout' }])

    // O que a rota do /start faz.
    await comoUsuario((tx) =>
      tx
        .delete(suppressions)
        .where(
          and(
            eq(suppressions.orgId, ORG),
            eq(suppressions.contactId, CONTATO),
            eq(suppressions.channel, 'telegram'),
            eq(suppressions.reason, 'optout'),
          ),
        ),
    )

    const depoisDoStart = await comoUsuario((tx) =>
      tx
        .select({ reason: suppressions.reason })
        .from(suppressions)
        .where(and(eq(suppressions.contactId, CONTATO), eq(suppressions.channel, 'telegram'))),
    )
    expect(depoisDoStart).toHaveLength(0)
  })
})
