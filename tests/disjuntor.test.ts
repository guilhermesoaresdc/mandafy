import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import {
  FALHAS_PARA_DESLIGAR,
  ehFalhaDeCanal,
  registrarFalhaDeCanal,
  religarCanal,
  zerarFalhasDoCanal,
} from '@/lib/delivery/disjuntor'
import { resolverCanal } from '@/lib/delivery/config'

/**
 * O disjuntor do canal (§8.1).
 *
 * O QUE ESTE ARQUIVO PROTEGE, EM UMA FRASE
 *
 * Que um telefone errado não derrube o WhatsApp da banca inteira.
 *
 * O disjuntor desliga um canal depois de duas falhas iguais seguidas, e é uma
 * proteção contra o histórico encher com mil linhas do mesmo problema. Feito
 * sem cuidado, vira o estrago que deveria evitar: dois cadastros com número
 * inválido são duas falhas iguais seguidas, e o canal cairia para todo mundo
 * por causa de dois contatos.
 *
 * A regra que separa uma coisa da outra — falha DE CANAL contra falha DE
 * CONTATO — não tem como ser conferida lendo o código de quem chama. Ou existe
 * um teste que tenta derrubar o canal com `sem_whatsapp` e falha em derrubar,
 * ou a regra é uma intenção escrita num comentário.
 *
 * Precisa dos mesmos endereços de tests/rls.test.ts:
 *   TEST_DATABASE_URL_ADMIN → dono das tabelas, monta o cenário
 *   TEST_DATABASE_URL       → papel mandafy_app, com RLS aplicado
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, '0')}`
const ORG = uid('d01')

describe.skipIf(!habilitado)('§8.1 — o disjuntor do canal', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  async function comoSistema<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select set_config('app.org_id', ${ORG}, true),
               set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  async function estadoDoSms(): Promise<{
    active: boolean
    consecutive_failures: number
    last_error_code: string | null
    disabled_at: Date | null
    disabled_reason: string | null
  }> {
    const [linha] = (await admin`
      SELECT active, consecutive_failures, last_error_code, disabled_at, disabled_reason
      FROM channel_configs WHERE org_id = ${ORG} AND channel = 'sms' AND is_default`) as unknown as [
      {
        active: boolean
        consecutive_failures: number
        last_error_code: string | null
        disabled_at: Date | null
        disabled_reason: string | null
      },
    ]
    return linha
  }

  /** Uma falha de canal, como o envio a registraria. */
  const falhar = (codigo: string, mensagem = 'chave inválida') =>
    comoSistema((tx) => registrarFalhaDeCanal(tx, ORG, 'sms', codigo, mensagem, 'twilio'))

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Disjuntor', 'disjuntor-org')`
      await tx`INSERT INTO channel_configs (org_id, channel, provider, active, is_default)
               VALUES (${ORG}, 'sms', 'twilio', true, true)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('uma falha só conta, não desliga', async () => {
    expect(await falhar('credencial_recusada')).toBeNull()

    const estado = await estadoDoSms()
    expect(estado.active).toBe(true)
    expect(estado.consecutive_failures).toBe(1)
    expect(estado.last_error_code).toBe('credencial_recusada')
    expect(estado.disabled_at).toBeNull()
  })

  it('a segunda falha IGUAL desliga o canal e guarda o motivo', async () => {
    await falhar('credencial_recusada', 'saldo insuficiente')
    const desligou = await falhar('credencial_recusada', 'saldo insuficiente')

    expect(desligou).toMatchObject({
      canal: 'sms',
      codigo: 'credencial_recusada',
      falhas: FALHAS_PARA_DESLIGAR,
    })

    const estado = await estadoDoSms()
    expect(estado.active).toBe(false)
    expect(estado.disabled_at).not.toBeNull()
    expect(estado.disabled_reason).toBe('saldo insuficiente')
  })

  it('só desliga UMA vez: a terceira falha não devolve desligamento de novo', async () => {
    await falhar('credencial_recusada')
    await falhar('credencial_recusada')

    // Sem isto, cada mensagem do lote registraria um desligamento no log — que
    // é exatamente o barulho que o disjuntor existe para calar.
    expect(await falhar('credencial_recusada')).toBeNull()
  })

  it('falha com código DIFERENTE reinicia a contagem, e não desliga', async () => {
    await falhar('credencial_recusada')
    expect(await falhar('provedor_indisponivel')).toBeNull()

    const estado = await estadoDoSms()
    expect(estado.active).toBe(true)
    expect(estado.consecutive_failures).toBe(1)
    expect(estado.last_error_code).toBe('provedor_indisponivel')
  })

  /*
   * O TESTE QUE JUSTIFICA O ARQUIVO.
   *
   * `sem_whatsapp`, `destino_invalido` e `bloqueado_pelo_destino` são fatos de
   * UM contato. Duas pessoas com telefone errado seguidas na fila são duas
   * falhas iguais seguidas — e se elas contassem, o canal cairia para a base
   * inteira por causa de dois cadastros ruins.
   */
  it.each(['destino_invalido', 'sem_whatsapp', 'bloqueado_pelo_destino'])(
    'falha do contato (%s) NUNCA desliga o canal, por mais que se repita',
    async (codigo) => {
      for (let i = 0; i < 5; i += 1) {
        expect(await falhar(codigo)).toBeNull()
      }

      const estado = await estadoDoSms()
      expect(estado.active).toBe(true)
      expect(estado.consecutive_failures).toBe(0)
      expect(estado.last_error_code).toBeNull()
      expect(ehFalhaDeCanal(codigo)).toBe(false)
    },
  )

  it('um envio que sai zera a contagem', async () => {
    await falhar('credencial_recusada')
    await comoSistema((tx) => zerarFalhasDoCanal(tx, ORG, 'sms'))

    expect((await estadoDoSms()).consecutive_failures).toBe(0)

    // E a próxima falha volta a contar do 1 — "consecutivas" quer dizer
    // consecutivas, senão duas falhas separadas por mil envios desligariam.
    expect(await falhar('credencial_recusada')).toBeNull()
    expect((await estadoDoSms()).consecutive_failures).toBe(1)
  })

  it('desligado pelo disjuntor, o envio explica o motivo certo', async () => {
    await falhar('credencial_recusada', 'chave revogada')
    await falhar('credencial_recusada', 'chave revogada')

    const resolucao = await comoSistema((tx) => resolverCanal(tx, ORG, 'sms'))

    expect(resolucao.alvo).toBeNull()
    // A frase de "alguém desligou" mandaria procurar um interruptor que a
    // pessoa não mexeu.
    expect(resolucao.falta).not.toContain('desligado nas configurações')
    expect(resolucao.falta).toContain('chave revogada')
    expect(resolucao.falta).toContain('ligue de novo')
  })

  it('desligado por alguém continua dizendo que foi alguém', async () => {
    await admin`UPDATE channel_configs SET active = false WHERE org_id = ${ORG} AND channel = 'sms'`

    const resolucao = await comoSistema((tx) => resolverCanal(tx, ORG, 'sms'))
    expect(resolucao.falta).toContain('desligado nas configurações')
  })

  it('religar limpa tudo, inclusive a marca de quem desligou', async () => {
    await falhar('credencial_recusada')
    await falhar('credencial_recusada')

    await comoSistema((tx) => religarCanal(tx, ORG, 'sms'))

    const estado = await estadoDoSms()
    expect(estado).toMatchObject({
      active: true,
      consecutive_failures: 0,
      last_error_code: null,
      disabled_at: null,
      disabled_reason: null,
    })
  })

  it('sem linha de configuração, a primeira falha cria uma para poder desligar', async () => {
    await admin`DELETE FROM channel_configs WHERE org_id = ${ORG} AND channel = 'sms'`

    // Instalação que roda pelas variáveis de ambiente — a que mais erra
    // credencial, e onde o disjuntor não existiria sem isto.
    expect(await falhar('sem_credencial')).toBeNull()
    expect(await falhar('sem_credencial')).toMatchObject({ canal: 'sms' })

    expect((await estadoDoSms()).active).toBe(false)
  })
})
