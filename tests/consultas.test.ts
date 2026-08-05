import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { listarPlataformas } from '@/db/queries/sources'
import { buscarMensagem, chaveEmUso, listarMensagens } from '@/db/queries/messages'
import { buscarFluxo, listarFluxos } from '@/db/queries/flows'
import { eventosPorTipo, resumoNoAr } from '@/db/queries/no-ar'

/**
 * Consultas das telas, EXECUTADAS contra um Postgres de verdade.
 *
 * Existe porque uma query pode passar no `tsc`, no lint e no `next build` e
 * ainda ser recusada pelo banco. Foi o que aconteceu com a contagem de eventos
 * da tela de plataformas: o Drizzle renderizava `sources.id` sem qualificar a
 * tabela dentro da projeção, o Postgres resolvia o `"id"` solto como
 * `events_raw.id`, e a tela quebrava em produção com uuid = bigint.
 *
 * Precisa dos mesmos endereços de tests/rls.test.ts:
 *   TEST_DATABASE_URL_ADMIN → dono das tabelas, monta o cenário
 *   TEST_DATABASE_URL       → papel mandafy_app, com RLS aplicado
 * Sem eles a suíte é pulada.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('c1')
const ADMIN = uid('c2')
const ORIGEM_A = uid('c3')
const ORIGEM_B = uid('c4')

describe.skipIf(!habilitado)('Consultas das telas contra o Postgres', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  /** Mesma mecânica de withTenant(), sem depender das variáveis de ambiente. */
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
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Consultas', 'consultas-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'consultas-admin@teste.local', 'x', 'admin')`

      // Duas plataformas: uma com eventos, outra sem — a contagem precisa
      // distinguir zero de "não apareceu no agrupamento".
      await tx`INSERT INTO sources (id, org_id, name, ingest_token) VALUES
        (${ORIGEM_A}, ${ORG}, 'Com eventos', 'consultas-token-a'),
        (${ORIGEM_B}, ${ORG}, 'Sem eventos', 'consultas-token-b')`

      await tx`INSERT INTO events_raw (source_id, payload) VALUES
        (${ORIGEM_A}, '{"a":1}'::jsonb),
        (${ORIGEM_A}, '{"a":2}'::jsonb),
        (${ORIGEM_A}, '{"a":3}'::jsonb)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM events_raw WHERE source_id IN (${ORIGEM_A}, ${ORIGEM_B})`
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('lista as plataformas com o total de eventos recebidos', async () => {
    const lista = await comoUsuario(listarPlataformas)

    const porNome = new Map(lista.map((p) => [p.name, p]))
    expect(porNome.get('Com eventos')?.recebidos).toBe(3)
    expect(porNome.get('Sem eventos')?.recebidos).toBe(0)
  })

  it('não conta eventos de outra organização', async () => {
    const outraOrg = uid('d1')
    const outraOrigem = uid('d3')

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Org Vizinha', 'consultas-vizinha')`
      await tx`INSERT INTO sources (id, org_id, name, ingest_token) VALUES
        (${outraOrigem}, ${outraOrg}, 'Da vizinha', 'consultas-token-c')`
      await tx`INSERT INTO events_raw (source_id, payload) VALUES (${outraOrigem}, '{"x":1}'::jsonb)`
    })

    try {
      const lista = await comoUsuario(listarPlataformas)
      expect(lista.map((p) => p.name).sort()).toEqual(['Com eventos', 'Sem eventos'])
    } finally {
      await admin`DELETE FROM events_raw WHERE source_id = ${outraOrigem}`
      await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
    }
  })

  it('devolve lista vazia quando não há plataforma conectada', async () => {
    const vazia = uid('e1')
    const usuarioVazio = uid('e2')

    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${vazia}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${vazia}, 'Org Vazia', 'consultas-vazia')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${usuarioVazio}, ${vazia}, 'Admin', 'consultas-vazio@teste.local', 'x', 'admin')`
    })

    try {
      const lista = await db.transaction(async (tx) => {
        await tx.execute(sql`
          select
            set_config('app.org_id',   ${vazia}, true),
            set_config('app.user_id',  ${usuarioVazio}, true),
            set_config('app.is_admin', 'true', true)
        `)
        return listarPlataformas(tx as Tx)
      })
      expect(lista).toEqual([])
    } finally {
      await admin`DELETE FROM organizations WHERE id = ${vazia}`
    }
  })

  describe('mensagens (§3.4, §6.1)', () => {
    const MENSAGEM = uid('c9')

    it('lista com os canais ligados e as variantes customizadas', async () => {
      await admin.begin(async (tx) => {
        await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
          (${MENSAGEM}, ${ORG}, 'pix_lembrete_1', 'Lembrete de PIX', 'Oi {{nome}}')`
        await tx`INSERT INTO message_variants (message_id, channel, enabled, synced, body) VALUES
          (${MENSAGEM}, 'whatsapp', true,  true,  NULL),
          (${MENSAGEM}, 'telegram', true,  true,  NULL),
          (${MENSAGEM}, 'email',    false, true,  NULL),
          (${MENSAGEM}, 'sms',      true,  false, 'Oi {{nome}}, curto')`
      })

      try {
        const lista = await comoUsuario(listarMensagens)
        const mensagem = lista.find((m) => m.key === 'pix_lembrete_1')

        expect(mensagem?.canaisAtivos).toEqual(['whatsapp', 'sms', 'telegram'])
        expect(mensagem?.customizadas).toBe(1)
      } finally {
        await admin`DELETE FROM messages WHERE id = ${MENSAGEM}`
      }
    })

    it('busca traz a mensagem com as quatro variantes', async () => {
      await admin.begin(async (tx) => {
        await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
          (${MENSAGEM}, ${ORG}, 'boas_vindas', 'Boas-vindas', 'Oi')`
        await tx`INSERT INTO message_variants (message_id, channel) VALUES
          (${MENSAGEM}, 'whatsapp'), (${MENSAGEM}, 'telegram'),
          (${MENSAGEM}, 'email'), (${MENSAGEM}, 'sms')`
      })

      try {
        const completa = await comoUsuario((tx) => buscarMensagem(tx, MENSAGEM))
        expect(completa?.mensagem.key).toBe('boas_vindas')
        expect(completa?.variantes).toHaveLength(4)
      } finally {
        await admin`DELETE FROM messages WHERE id = ${MENSAGEM}`
      }
    })

    it('mensagem de outra organização não é encontrada', async () => {
      const outraOrg = uid('f1')
      const outraMsg = uid('f2')

      await admin.begin(async (tx) => {
        await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
        await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Vizinha', 'consultas-msg-vizinha')`
        await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
          (${outraMsg}, ${outraOrg}, 'secreta', 'Secreta', 'x')`
      })

      try {
        // RLS devolve nada; a página trata como inexistente, sem confirmar
        // que a mensagem existe em outro lugar.
        expect(await comoUsuario((tx) => buscarMensagem(tx, outraMsg))).toBeNull()
      } finally {
        await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
      }
    })

    it('chaveEmUso só enxerga a própria organização', async () => {
      const outraOrg = uid('f3')
      const outraMsg = uid('f4')

      await admin.begin(async (tx) => {
        await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
        await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Vizinha 2', 'consultas-msg-viz2')`
        await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
          (${outraMsg}, ${outraOrg}, 'compartilhada', 'X', 'x')`
        await tx`INSERT INTO messages (id, org_id, key, name, body) VALUES
          (${MENSAGEM}, ${ORG}, 'minha', 'Minha', 'x')`
      })

      try {
        // A mesma chave em outra org não conflita — a unicidade é (org_id, key).
        expect(await comoUsuario((tx) => chaveEmUso(tx, ORG, 'compartilhada'))).toBe(false)
        expect(await comoUsuario((tx) => chaveEmUso(tx, ORG, 'minha'))).toBe(true)
        // Editar a própria mensagem não conflita consigo mesma.
        expect(await comoUsuario((tx) => chaveEmUso(tx, ORG, 'minha', MENSAGEM))).toBe(false)
      } finally {
        await admin`DELETE FROM messages WHERE id = ${MENSAGEM}`
        await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
      }
    })
  })

  describe('fluxos (§5)', () => {
    const FLUXO = uid('c20')
    const MSG_A = uid('c21')
    const MSG_B = uid('c22')

    beforeEach(async () => {
      await admin.begin(async (tx) => {
        await tx`DELETE FROM flow_steps WHERE flow_id = ${FLUXO}`
        await tx`DELETE FROM flows WHERE id = ${FLUXO}`
        await tx`DELETE FROM messages WHERE id IN (${MSG_A}, ${MSG_B})`

        await tx`INSERT INTO messages (id, org_id, key, name, body, active) VALUES
          (${MSG_A}, ${ORG}, 'passo_a', 'Passo A',
           ${'{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}! Seu PIX de **{{valor_cents|moeda}}** ainda não caiu.'}, true),
          (${MSG_B}, ${ORG}, 'passo_b', 'Passo B', 'oi', false)`
        await tx`INSERT INTO flows (id, org_id, name, trigger_event, cancel_on, cancel_key_template)
          VALUES (${FLUXO}, ${ORG}, 'Recuperação', 'order.created',
                  ARRAY['order.paid'], 'order:{{external_id}}')`
        await tx`INSERT INTO flow_steps (flow_id, position, delay_seconds, message_id, send_at_local) VALUES
          (${FLUXO}, 1, 300,  ${MSG_A}, NULL),
          (${FLUXO}, 2, 1200, ${MSG_B}, '10:00')`
      })
    })

    afterAll(async () => {
      await admin`DELETE FROM flow_steps WHERE flow_id = ${FLUXO}`
      await admin`DELETE FROM flows WHERE id = ${FLUXO}`
      await admin`DELETE FROM messages WHERE id IN (${MSG_A}, ${MSG_B})`
    })

    it('a lista traz o gatilho, os passos e o aviso de mensagem pausada', async () => {
      const lista = await comoUsuario(listarFluxos)
      const fluxo = lista.find((f) => f.id === FLUXO)

      expect(fluxo?.triggerEvent).toBe('order.created')
      expect(fluxo?.passos).toBe(2)
      // Um fluxo ativo com mensagem pausada não envia nada e não avisa sozinho.
      expect(fluxo?.temMensagemPausada).toBe(true)
    })

    it('o detalhe mostra o tempo ACUMULADO, não o do passo', async () => {
      const completo = await comoUsuario((tx) => buscarFluxo(tx, FLUXO))

      // +5min e depois +20min viram "+5 min" e "+25 min" desde o gatilho.
      expect(completo?.passos.map((p) => p.offsetLabel)).toEqual(['+5 min', '+25 min'])
      expect(completo?.passos.map((p) => p.delaySeconds)).toEqual([300, 1200])
    })

    /*
     * A tela do fluxo mostrava só o NOME da mensagem, e nome não é conteúdo:
     * "Boas-vindas" não diz se o texto está em branco, se ainda fala de rifa ou
     * se é o que a pessoa espera receber. Conferir exigia abrir outra tela por
     * passo — e por isso ninguém conferia.
     */
    it('o detalhe traz o TEXTO de cada passo, pronto para ler', async () => {
      const completo = await comoUsuario((tx) => buscarFluxo(tx, FLUXO))
      const primeiro = completo?.passos[0]

      // Compilado com o contato de exemplo: sem `{{…}}`, sem spintax e sem os
      // marcadores de negrito, que viram ruído numa linha sem negrito de verdade.
      expect(primeiro?.amostra).toContain('Maria')
      expect(primeiro?.amostra).toContain('R$ 5,00')
      expect(primeiro?.amostra).not.toMatch(/[{}|*]/)
      // Uma linha só: a lista corta em duas, e a quebra desperdiçaria metade.
      expect(primeiro?.amostra).not.toContain('\n')
    })

    it('a amostra é estável entre carregamentos, apesar do spintax', async () => {
      // Semente presa ao id do passo. Sem isso a tela mudaria de texto sozinha a
      // cada F5, o que parece defeito.
      const uma = await comoUsuario((tx) => buscarFluxo(tx, FLUXO))
      const outra = await comoUsuario((tx) => buscarFluxo(tx, FLUXO))

      expect(uma?.passos.map((p) => p.amostra)).toEqual(outra?.passos.map((p) => p.amostra))
    })

    it('a hora marcada do passo chega à tela', async () => {
      const completo = await comoUsuario((tx) => buscarFluxo(tx, FLUXO))

      // `time` do Postgres volta como '10:00:00'; a tela lê '10:00'. Sem o corte
      // a lista mostraria os segundos que ninguém digitou.
      expect(completo?.passos.map((p) => p.sendAtLocal)).toEqual([null, '10:00'])
    })

    /*
     * "O que está ativo e rodando?" — a pergunta que ninguém conseguia responder.
     *
     * As duas consultas cruzam três tabelas particionadas ou agregadas, e são
     * exatamente o tipo que passa no `tsc` e o Postgres recusa. Pior: sob RLS
     * elas não falham, devolvem ZERO LINHA — e a tela diria "nada acontecendo"
     * num sistema saudável.
     */
    describe('o que está no ar (§10.3)', () => {
      beforeEach(async () => {
        await admin`DELETE FROM notification_daily_stats WHERE org_id = ${ORG}`
        await admin`DELETE FROM events WHERE org_id = ${ORG}`

        // O gatilho do fluxo chegando de verdade.
        await admin`INSERT INTO events (org_id, source_id, type, external_id, occurred_at) VALUES
          (${ORG}, ${ORIGEM_A}, 'order.created', 'P-1', now()),
          (${ORG}, ${ORIGEM_A}, 'order.created', 'P-2', now()),
          (${ORG}, ${ORIGEM_A}, 'order.paid',    'P-1', now())`

        await admin`INSERT INTO notification_daily_stats (org_id, day, channel, status, flow_id, total)
          VALUES (${ORG}, current_date, 'whatsapp', 'sent', ${FLUXO}, 7)`
      })

      it('conta os envios do fluxo e os eventos do gatilho', async () => {
        const resumo = await comoUsuario(resumoNoAr)
        const fluxo = resumo.fluxos.find((f) => f.id === FLUXO)

        // Do agregado, nunca de COUNT(*) em notifications (§13.2).
        expect(fluxo?.envios).toBe(7)
        expect(fluxo?.gatilhos).toBe(2)
      })

      it('acusa o evento que chega e nenhum fluxo escuta', async () => {
        // `order.paid` chega e ninguém dispara com ele — é o caso que responde
        // "configurei tudo e não sai nada". `order.created` tem o fluxo da
        // fixture escutando, e por isso NÃO pode aparecer aqui.
        const resumo = await comoUsuario(resumoNoAr)
        const tipos = resumo.semOuvinte.map((e) => e.type)

        expect(tipos).toContain('order.paid')
        expect(tipos).not.toContain('order.created')
        expect(resumo.ligados).toBe(1)
      })

      it('pausar o fluxo faz o gatilho dele virar evento sem ouvinte', async () => {
        // Fluxo pausado NÃO conta como ouvinte, de propósito: "o evento está
        // chegando e o fluxo está desligado" é justamente o que a pessoa
        // precisa enxergar, não o que deve tranquilizá-la.
        await admin`UPDATE flows SET active = false WHERE id = ${FLUXO}`
        try {
          const resumo = await comoUsuario(resumoNoAr)
          expect(resumo.semOuvinte.map((e) => e.type)).toContain('order.created')
          expect(resumo.ligados).toBe(0)
        } finally {
          await admin`UPDATE flows SET active = true WHERE id = ${FLUXO}`
        }
      })

      it('os eventos da plataforma vêm agrupados por tipo, com o último horário', async () => {
        const tipos = await comoUsuario((tx) => eventosPorTipo(tx, ORIGEM_A))

        expect(tipos.find((t) => t.type === 'order.created')?.total).toBe(2)
        expect(tipos.find((t) => t.type === 'order.paid')?.total).toBe(1)
        expect(tipos[0]?.ultimo).toBeInstanceOf(Date)
      })

      it('a plataforma sem eventos devolve lista vazia, não erro', async () => {
        expect(await comoUsuario((tx) => eventosPorTipo(tx, ORIGEM_B))).toEqual([])
      })
    })

    it('fluxo de outra organização não é encontrado', async () => {
      const outraOrg = uid('c25')
      const outroFluxo = uid('c26')

      await admin.begin(async (tx) => {
        await tx`DELETE FROM organizations WHERE id = ${outraOrg}`
        await tx`INSERT INTO organizations (id, name, slug) VALUES (${outraOrg}, 'Vizinha 3', 'consultas-fluxo-viz')`
        await tx`INSERT INTO flows (id, org_id, name, trigger_event) VALUES
          (${outroFluxo}, ${outraOrg}, 'Secreto', 'order.created')`
      })

      try {
        expect(await comoUsuario((tx) => buscarFluxo(tx, outroFluxo))).toBeNull()
      } finally {
        await admin`DELETE FROM flows WHERE id = ${outroFluxo}`
        await admin`DELETE FROM organizations WHERE id = ${outraOrg}`
      }
    })
  })
})
