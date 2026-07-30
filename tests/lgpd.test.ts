import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { anonimizarContato, descadastrar, exportarContato } from '@/lib/lgpd'
import { autenticar, gerarChave, hashChave, prefixoVisivel } from '@/lib/api/keys'

/**
 * LGPD e chaves de API contra um Postgres de verdade (§12.1, §14.1).
 *
 * O que precisa ser provado aqui é que a anonimização REALMENTE remove o dado —
 * não só do contato, mas do corpo das mensagens que já saíram, que é onde o
 * nome da pessoa aparece por extenso.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('d01')
const OUTRA_ORG = uid('d02')
const USUARIO = uid('d03')
const CONTATO = uid('d04')
const MENSAGEM = uid('d05')

describe.skipIf(!habilitado)('LGPD e API (§12, §14)', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  function comoOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${orgId}, true),
               set_config('app.user_id', ${USUARIO}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  const como = <T,>(fn: (tx: Tx) => Promise<T>) => comoOrg(ORG, fn)

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id IN (${ORG}, ${OUTRA_ORG})`
      await tx`INSERT INTO organizations (id, name, slug) VALUES
        (${ORG}, 'Org LGPD', 'lgpd-org'), (${OUTRA_ORG}, 'Outra', 'lgpd-outra')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${USUARIO}, ${ORG}, 'Admin', 'lgpd-admin@teste.local', 'x', 'admin')`

      await tx`INSERT INTO contacts (id, org_id, name, phone_e164, email, cpf, external_id, optin_at, total_orders)
        VALUES (${CONTATO}, ${ORG}, 'Maria Aparecida', '+5511988887777', 'maria@teste.local',
                '12345678900', 'PLAT-1', now(), 2)`

      await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
        (${MENSAGEM}, ${ORG}, 'lembrete', 'Lembrete', 'oi')`

      await tx`INSERT INTO notifications (org_id, contact_id, message_id, channel, status, rendered_body, rendered_subject)
        VALUES
        (${ORG}, ${CONTATO}, ${MENSAGEM}, 'whatsapp', 'delivered', 'Oi Maria Aparecida, seu PIX de R$ 49,90', NULL),
        (${ORG}, ${CONTATO}, ${MENSAGEM}, 'email',    'sent',      'Oi Maria Aparecida', 'Seu PIX')`

      await tx`INSERT INTO events (org_id, type, contact_id, external_id, occurred_at, data)
        VALUES (${ORG}, 'order.paid', ${CONTATO}, 'PED-1', now(), '{"valor_cents": 4990}'::jsonb)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id IN (${ORG}, ${OUTRA_ORG})`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  describe('exportação (§14.1)', () => {
    it('traz tudo que o sistema sabe sobre a pessoa', async () => {
      const dados = await como((tx) => exportarContato(tx, CONTATO))

      expect(dados?.contato.nome).toBe('Maria Aparecida')
      expect(dados?.contato.telefone).toBe('+5511988887777')
      expect(dados?.contato.cpf).toBe('12345678900')
      expect(dados?.notificacoes).toHaveLength(2)
      expect(dados?.eventos).toHaveLength(1)
    })

    it('inclui o corpo exato do que foi enviado', async () => {
      // O titular tem direito de saber o que recebeu.
      const dados = await como((tx) => exportarContato(tx, CONTATO))
      expect(JSON.stringify(dados?.notificacoes)).toContain('Oi Maria Aparecida')
    })

    it('contato de outra organização não é exportável', async () => {
      expect(await comoOrg(OUTRA_ORG, (tx) => exportarContato(tx, CONTATO))).toBeNull()
    })
  })

  describe('anonimização (§14.1)', () => {
    it('remove nome, telefone, e-mail e CPF', async () => {
      await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))

      const [linha] = (await admin`
        SELECT name, phone_e164, email, cpf, external_id FROM contacts WHERE id = ${CONTATO}
      `) as unknown as {
        name: string
        phone_e164: string | null
        email: string | null
        cpf: string | null
        external_id: string | null
      }[]

      expect(linha?.name).toBe('Contato anonimizado')
      expect(linha?.phone_e164).toBeNull()
      expect(linha?.email).toBeNull()
      expect(linha?.cpf).toBeNull()
      expect(linha?.external_id).toBeNull()
    })

    it('limpa o CORPO das mensagens — é lá que o nome aparece por extenso', async () => {
      // Sem isto, a anonimização seria teatro: o nome continuaria legível no
      // histórico de tudo que já foi enviado.
      const r = await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))
      expect(r.notificacoesLimpas).toBe(2)

      const linhas = (await admin`
        SELECT rendered_body, rendered_subject FROM notifications WHERE contact_id = ${CONTATO}
      `) as unknown as { rendered_body: string; rendered_subject: string | null }[]

      expect(linhas.every((l) => l.rendered_body === '[anonimizado]')).toBe(true)
      expect(linhas.every((l) => l.rendered_subject === null)).toBe(true)
    })

    it('preserva os agregados — é o ponto de anonimizar em vez de apagar', async () => {
      await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))

      const [contato] = (await admin`
        SELECT total_orders FROM contacts WHERE id = ${CONTATO}`) as unknown as {
        total_orders: number
      }[]
      const [envios] = (await admin`
        SELECT count(*)::int AS n FROM notifications WHERE contact_id = ${CONTATO}`) as unknown as {
        n: number
      }[]

      expect(contato?.total_orders).toBe(2)
      expect(envios?.n).toBe(2)
    })

    it('deixa o contato descadastrado de todos os canais', async () => {
      await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))

      const [linha] = (await admin`
        SELECT opted_out_at, optin_whatsapp, optin_email, optin_sms, optin_telegram
        FROM contacts WHERE id = ${CONTATO}`) as unknown as {
        opted_out_at: Date | null
        optin_whatsapp: boolean
        optin_email: boolean
        optin_sms: boolean
        optin_telegram: boolean
      }[]

      expect(linha?.opted_out_at).not.toBeNull()
      expect(linha?.optin_whatsapp).toBe(false)
      expect(linha?.optin_email).toBe(false)
    })

    it('dois contatos anonimizados não colidem no índice único', async () => {
      /*
       * Anonimizar zerando telefone e e-mail com STRING VAZIA quebraria no
       * segundo contato: os índices únicos são parciais (`IS NOT NULL`), então
       * duas strings vazias colidiriam. Por isso vai `null`.
       */
      const segundo = uid('d10')
      await admin`INSERT INTO contacts (id, org_id, name, phone_e164, email)
        VALUES (${segundo}, ${ORG}, 'João', '+5511911112222', 'joao@teste.local')`

      await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))
      const r = await como((tx) => anonimizarContato(tx, ORG, segundo, USUARIO))

      expect(r.anonimizado).toBe(true)
    })

    it('registra na auditoria sem repetir o dado que saiu', async () => {
      await como((tx) => anonimizarContato(tx, ORG, CONTATO, USUARIO))

      const [registro] = (await admin`
        SELECT action, entity_id, before, after FROM audit_log
        WHERE org_id = ${ORG} AND action = 'lgpd.anonimizar'`) as unknown as {
        action: string
        entity_id: string
        before: unknown
        after: unknown
      }[]

      expect(registro?.entity_id).toBe(CONTATO)
      // Guardar o valor antigo na auditoria anularia a anonimização.
      expect(registro?.before).toBeNull()
      expect(registro?.after).toBeNull()
    })

    it('contato de outra organização não é anonimizável', async () => {
      const r = await comoOrg(OUTRA_ORG, (tx) => anonimizarContato(tx, OUTRA_ORG, CONTATO, USUARIO))
      expect(r.anonimizado).toBe(false)

      const [linha] = (await admin`
        SELECT name FROM contacts WHERE id = ${CONTATO}`) as unknown as { name: string }[]
      expect(linha?.name).toBe('Maria Aparecida')
    })
  })

  describe('descadastro (§14.1)', () => {
    it('sem canal, sai de tudo e marca opt-out global', async () => {
      expect(await como((tx) => descadastrar(tx, ORG, CONTATO))).toBe(true)

      const [linha] = (await admin`
        SELECT opted_out_at, optin_sms FROM contacts WHERE id = ${CONTATO}`) as unknown as {
        opted_out_at: Date | null
        optin_sms: boolean
      }[]

      expect(linha?.opted_out_at).not.toBeNull()
      expect(linha?.optin_sms).toBe(false)

      const [supressoes] = (await admin`
        SELECT count(*)::int AS n FROM suppressions WHERE contact_id = ${CONTATO}`) as unknown as {
        n: number
      }[]
      expect(supressoes?.n).toBe(4)
    })

    it('com canal, sai só daquele — e NÃO marca opt-out global', async () => {
      await como((tx) => descadastrar(tx, ORG, CONTATO, { canal: 'sms' }))

      const [linha] = (await admin`
        SELECT opted_out_at, optin_sms, optin_whatsapp FROM contacts WHERE id = ${CONTATO}
      `) as unknown as { opted_out_at: Date | null; optin_sms: boolean; optin_whatsapp: boolean }[]

      // Quem pediu para sair do SMS não pediu para sair do WhatsApp.
      expect(linha?.optin_sms).toBe(false)
      expect(linha?.optin_whatsapp).toBe(true)
      expect(linha?.opted_out_at).toBeNull()
    })

    it('descadastrar duas vezes não estoura', async () => {
      expect(await como((tx) => descadastrar(tx, ORG, CONTATO))).toBe(true)
      expect(await como((tx) => descadastrar(tx, ORG, CONTATO))).toBe(true)
    })

    it('contato inexistente devolve false em vez de estourar', async () => {
      expect(await como((tx) => descadastrar(tx, ORG, uid('dff')))).toBe(false)
    })
  })

  describe('autenticação por chave de API (§12.1)', () => {
    beforeEach(async () => {
      await admin`DELETE FROM api_keys WHERE org_id = ${ORG}`
    })

    async function criarChave(escopos: string[], revogada = false): Promise<string> {
      const chave = gerarChave('live')
      await admin`INSERT INTO api_keys (org_id, name, key_hash, key_prefix, scopes, revoked_at)
        VALUES (${ORG}, 'Teste', ${hashChave(chave)}, ${prefixoVisivel(chave)},
                ${escopos}, ${revogada ? new Date() : null})`
      return chave
    }

    it('chave válida devolve a organização e os escopos', async () => {
      const chave = await criarChave(['messages:send'])
      const r = await autenticar(db, `Bearer ${chave}`)

      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.chave.orgId).toBe(ORG)
        expect(r.chave.escopos).toEqual(['messages:send'])
        expect(r.chave.ambiente).toBe('live')
      }
    })

    it('chave revogada é recusada', async () => {
      const chave = await criarChave(['messages:send'], true)
      expect(await autenticar(db, `Bearer ${chave}`)).toEqual({ ok: false, motivo: 'revogada' })
    })

    it('chave inexistente é recusada', async () => {
      expect(await autenticar(db, `Bearer ${gerarChave()}`)).toEqual({
        ok: false,
        motivo: 'desconhecida',
      })
    })

    it('sem header é "ausente", não "inválida" — a mensagem ajuda a corrigir', async () => {
      expect(await autenticar(db, null)).toEqual({ ok: false, motivo: 'ausente' })
    })

    it('o valor em claro NÃO fica no banco', async () => {
      const chave = await criarChave(['messages:send'])

      const [linha] = (await admin`
        SELECT key_hash, key_prefix FROM api_keys WHERE org_id = ${ORG}`) as unknown as {
        key_hash: string
        key_prefix: string
      }[]

      expect(linha?.key_hash).not.toContain(chave)
      expect(linha?.key_prefix).not.toBe(chave)
      // Nem o prefixo visível permite reconstruir a chave.
      expect(chave.startsWith(linha!.key_prefix.replace('…', ''))).toBe(true)
      expect(linha!.key_prefix.length).toBeLessThan(chave.length)
    })
  })
})
