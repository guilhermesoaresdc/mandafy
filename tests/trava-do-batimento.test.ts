import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'

/**
 * A trava do batimento (§7.1).
 *
 * O QUE ESTE ARQUIVO EXISTE PARA IMPEDIR
 *
 * O cron chamava `/api/cron` a cada minuto, recebia `200 OK` em seis segundos,
 * sem uma falha sequer — e nada acontecia. O evento recebido ficava "na fila"
 * para sempre, o painel mostrava zero enviadas e zero na fila, e o histórico só
 * tinha os envios de teste feitos à mão. O sistema inteiro parado, com todos os
 * sinais verdes.
 *
 * A causa era `pg_try_advisory_lock`, que é uma trava de SESSÃO. Atrás do
 * pooler da Supabase em modo transação — obrigatório na Vercel — cada consulta
 * pode cair numa sessão de backend diferente: quem pegou a trava não é quem
 * tenta soltá-la, o `pg_advisory_unlock` devolve `false` sem soltar nada, e a
 * sessão original guarda a trava enquanto viver no pool.
 *
 * Nada disso aparece em teste que roda com conexão direta, que é o caso aqui.
 * Por isso o que se prende abaixo não é o pooler: é a PROPRIEDADE que fez a
 * troca ser necessária — a trava tem de ser soltável por quem não a pegou, e
 * tem de vencer sozinha se ninguém soltar.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const CHAVE = 'batimento.trava'

describe.skipIf(!habilitado)('§7.1 — a trava do batimento', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    /*
     * `max: 4` de propósito, e é o coração do arquivo.
     *
     * Com uma conexão só, toda consulta cairia na mesma sessão de backend e um
     * advisory lock funcionaria — o teste passaria verde sobre o bug que
     * derrubou a produção. Várias conexões aproximam o comportamento do pooler:
     * a chamada que solta pode não ser a que pegou.
     */
    app = postgres(APP_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(app, { schema })

    vi.doMock('@/db', async () => {
      const real = await vi.importActual<typeof import('@/db')>('@/db')
      return { ...real, db }
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    await admin`DELETE FROM system_state WHERE key = ${CHAVE}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM system_state WHERE key = ${CHAVE}`
  })

  async function importar() {
    return import('@/lib/manutencao')
  }

  it('o primeiro batimento pega a trava', async () => {
    const { pegarTrava } = await importar()
    expect(await pegarTrava()).toBe(true)
  })

  it('o segundo, sobreposto, não pega — e não fica esperando', async () => {
    const { pegarTrava } = await importar()

    expect(await pegarTrava()).toBe(true)
    // Duas invocações em paralelo dobrariam a cadência de envio do mesmo chip,
    // que é o que §7.2 existe para segurar.
    expect(await pegarTrava()).toBe(false)
  })

  it('depois de solta, o próximo pega — e este é o caso que falhava', async () => {
    const { pegarTrava, soltarTrava } = await importar()

    expect(await pegarTrava()).toBe(true)
    await soltarTrava()

    /*
     * Com o advisory lock, `soltarTrava` podia rodar noutra sessão e devolver
     * `false` sem soltar nada. Daí em diante TODO batimento respondia "ocupado"
     * com 200, e o sistema ficava parado sem nenhum sinal de erro.
     */
    expect(await pegarTrava()).toBe(true)
  })

  it('vence sozinha quando ninguém solta', async () => {
    const { pegarTrava } = await importar()

    expect(await pegarTrava()).toBe(true)

    // Um processo morto no meio — a Vercel corta a função no teto de duração —
    // não pode parar o sistema até alguém reiniciar o banco.
    await admin`UPDATE system_state SET ran_at = now() - interval '2 hours' WHERE key = ${CHAVE}`
    expect(await pegarTrava()).toBe(true)
  })

  it('não vence antes da hora', async () => {
    const { pegarTrava } = await importar()

    expect(await pegarTrava()).toBe(true)
    // Um minuto depois o batimento anterior ainda pode estar rodando: o teto de
    // duração da função é 60s.
    await admin`UPDATE system_state SET ran_at = now() - interval '30 seconds' WHERE key = ${CHAVE}`
    expect(await pegarTrava()).toBe(false)
  })

  it('duas tentativas ao MESMO TEMPO: exatamente uma vence', async () => {
    const { pegarTrava } = await importar()

    /*
     * Ler e depois escrever abriria a janela em que as duas leem "livre" antes
     * de qualquer uma gravar, e as duas sairiam batendo. `INSERT … ON CONFLICT
     * DO UPDATE … WHERE` decide dentro de um comando só.
     */
    const resultados = await Promise.all([
      pegarTrava(),
      pegarTrava(),
      pegarTrava(),
      pegarTrava(),
    ])

    expect(resultados.filter(Boolean)).toHaveLength(1)
  })

  it('roda com o papel da aplicação, que é quem chama de verdade', async () => {
    const { pegarTrava, soltarTrava } = await importar()

    /*
     * `system_state` já teve RLS ligado por um clique no painel do Supabase e
     * passou a recusar toda escrita — foi o que a migration 0022 consertou. A
     * trava escreve nessa mesma tabela, sem contexto de organização: se a
     * política mudar, ela para de pegar e o batimento morre de novo, calado.
     */
    const [quem] = await db.execute<{ papel: string }>(sql`SELECT current_user AS papel`)
    expect(quem?.papel, 'o teste precisa rodar como o papel da aplicação').toBe('mandafy_app')

    expect(await pegarTrava()).toBe(true)
    await soltarTrava()
    expect(await pegarTrava()).toBe(true)
  })

  it('a trava não sobrescreve o carimbo das tarefas — mesma tabela, chaves distintas', async () => {
    const { pegarTrava, soltarTrava, ultimaExecucao, TAREFAS } = await importar()

    /*
     * A trava mora na MESMA tabela que `manutencao.horaria` e
     * `manutencao.diaria`. Uma chave trocada faria cada batimento carimbar a
     * manutenção como recém-executada — e o cartão "As mensagens estão saindo?"
     * ficaria verde para sempre, medindo a trava em vez da manutenção.
     */
    const marca = new Date('2020-01-02T03:04:05.000Z')
    await admin`
      INSERT INTO system_state (key, ran_at) VALUES (${TAREFAS.horaria}, ${marca})
      ON CONFLICT (key) DO UPDATE SET ran_at = ${marca}`

    await pegarTrava()
    await soltarTrava()

    expect((await ultimaExecucao(TAREFAS.horaria))?.toISOString()).toBe(marca.toISOString())

    await admin`DELETE FROM system_state WHERE key = ${TAREFAS.horaria}`
  })
})
