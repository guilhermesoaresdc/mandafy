import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { buscarMensagem } from '@/db/queries/messages'
import { CHANNELS } from '@/db/schema/enums'
import { linhasDoModelo, acharModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS, type ModeloMensagem } from '@/lib/messages/modelos'
import { resumoDosModelos } from '@/lib/messages/galeria'

/**
 * Modelos de mensagem (§5.2, §6.1, §11.7).
 *
 * O QUE ESTA SUÍTE EXISTE PARA IMPEDIR
 *
 * Duas telas criam mensagem a partir do catálogo: o seed, na primeira subida, e
 * "Nova mensagem". Enquanto cada uma montava as próprias linhas, elas
 * divergiram em três pontos VISÍVEIS — a tela ligava o SMS que o seed desliga,
 * não gravava o assunto do e-mail, e nascia com tudo sincronizado, de modo que
 * a primeira edição do corpo apagava o texto escrito para aquele canal.
 *
 * Nada disso quebra o `tsc`, o lint ou o build: são valores certos em colunas
 * certas. Só um teste que grava e lê de volta os pega.
 *
 * A parte pura roda sempre. A que grava precisa dos mesmos endereços de
 * tests/rls.test.ts — e roda como `mandafy_app`, com RLS aplicado, porque é
 * exatamente lá que este projeto já viu insert virar zero linha em silêncio.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('e01')
const ADMIN = uid('e02')

/**
 * O único modelo com variantes escritas à mão — e o único que liga o SMS.
 *
 * Não é coincidência: quem escreve texto próprio para um canal é justamente
 * quem tem motivo para ligá-lo. Nos demais, o SMS é decisão do PASSO do fluxo
 * (a "última chance" da cadência de PIX), não da mensagem.
 */
const COM_VARIANTES = 'bicho_resultado_premiado'

describe('§6.1 — o catálogo de modelos', () => {
  it('todo modelo tem chave, nome e corpo', () => {
    for (const modelo of MENSAGENS) {
      expect(modelo.key, 'chave em formato de identificador').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(modelo.name.length).toBeGreaterThan(1)
      expect(modelo.body.trim().length).toBeGreaterThan(0)
    }
  })

  it('não há chave repetida', () => {
    const chaves = MENSAGENS.map((m) => m.key)
    expect(new Set(chaves).size).toBe(chaves.length)
  })

  it('o SMS nasce desligado em todo modelo, menos onde foi pedido (§8.4)', () => {
    for (const modelo of MENSAGENS) {
      const sms = linhasDoModelo(modelo).variantes.find((v) => v.channel === 'sms')
      // O canal mais caro do sistema não se liga por omissão. Quem o liga é o
      // PASSO do fluxo que precisa dele — na cadência de PIX, só a "última
      // chance", onde o valor recuperado paga os centavos.
      expect(sms?.enabled, `SMS em ${modelo.key}`).toBe(modelo.key === COM_VARIANTES)
    }
  })

  it('o assunto do modelo vira o assunto do e-mail', () => {
    // O catálogo é `as const`: cada entrada tem o tipo exato do que escreveram
    // nela, e `subject` não existe nas que não declaram um. Ler pelo tipo comum
    // é o que permite perguntar.
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      if (!modelo.subject) continue
      const email = linhasDoModelo(modelo).variantes.find((v) => v.channel === 'email')
      expect(email?.subject, `assunto em ${modelo.key}`).toBeTruthy()
    }
  })

  it('variante escrita à mão nasce DESSINCRONIZADA; as outras, sincronizadas', () => {
    const modelo = acharModelo(MENSAGENS, COM_VARIANTES)
    expect(modelo).not.toBeNull()

    const { variantes } = linhasDoModelo(modelo!)

    for (const variante of variantes) {
      const escrita = Boolean(modelo!.variantes?.[variante.channel])

      /*
       * `synced` fica indefinido quando não há variante escrita — e é o certo:
       * a coluna tem `default true`. O que NÃO pode acontecer é o contrário,
       * um texto feito para o canal nascer sincronizado: a primeira edição do
       * corpo principal o apagaria.
       */
      expect(variante.synced ?? true, `synced de ${variante.channel}`).toBe(!escrita)
    }
  })

  it('o Telegram sai com parse_mode HTML e os outros não', () => {
    for (const modelo of MENSAGENS) {
      for (const variante of linhasDoModelo(modelo).variantes) {
        expect(variante.parseMode).toBe(variante.channel === 'telegram' ? 'HTML' : undefined)
      }
    }
  })

  it('a chave pode ser desviada pelo chamador, sem mexer no resto', () => {
    const modelo = acharModelo(MENSAGENS, 'boas_vindas')!
    const linhas = linhasDoModelo(modelo, 'boas_vindas_2')

    // A tela precisa disto: criar "Boas-vindas" duas vezes é uso legítimo.
    expect(linhas.mensagem.key).toBe('boas_vindas_2')
    expect(linhas.mensagem.body).toBe(modelo.body)
  })

  it('modelo inexistente devolve nada, em vez de estourar', () => {
    expect(acharModelo(MENSAGENS, 'nao_existe')).toBeNull()
    expect(acharModelo(MENSAGENS, '')).toBeNull()
    expect(acharModelo(MENSAGENS, undefined)).toBeNull()
  })
})

describe('§11.7 — a galeria de "nova mensagem"', () => {
  const resumos = resumoDosModelos()

  it('mostra um cartão por modelo, na mesma ordem', () => {
    expect(resumos.map((r) => r.key)).toEqual(MENSAGENS.map((m) => m.key))
  })

  it('a amostra é texto pronto, não o corpo cru', () => {
    for (const resumo of resumos) {
      expect(resumo.amostra.length).toBeGreaterThan(10)

      // Spintax resolvido e sem marcador de formatação: o cartão é vitrine.
      expect(resumo.amostra, `spintax em ${resumo.key}`).not.toMatch(/[{}|*_~]/)

      // Uma linha só — o cartão corta em duas, e quebra de linha no meio
      // desperdiçaria metade do espaço.
      expect(resumo.amostra).not.toContain('\n')
    }
  })

  it('a amostra é estável entre chamadas, apesar do spintax', () => {
    // Semente fixa a partir da chave. Sem isso a galeria mudaria de texto a
    // cada carregamento da página, o que parece defeito.
    expect(resumoDosModelos().map((r) => r.amostra)).toEqual(resumos.map((r) => r.amostra))
  })

  it('cada cartão anuncia canais, e nenhum anuncia SMS por omissão', () => {
    for (const resumo of resumos) {
      expect(resumo.canais.length).toBeGreaterThan(0)
      expect(resumo.canais.includes('sms')).toBe(resumo.key === COM_VARIANTES)
    }
  })
})

describe.skipIf(!habilitado)('§6.1 — o modelo gravado no banco', () => {
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

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Modelos', 'modelos-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'modelos-admin@teste.local', 'x', 'admin')`
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
  })

  /** O caminho que o seed e a tela compartilham, do modelo à linha. */
  async function gravar(chaveDoModelo: string, chave?: string): Promise<string> {
    const modelo = acharModelo(MENSAGENS, chaveDoModelo)!
    const linhas = linhasDoModelo(modelo, chave)

    return comoUsuario(async (tx) => {
      const [criada] = await tx
        .insert(schema.messages)
        .values({ orgId: ORG, ...linhas.mensagem })
        .returning({ id: schema.messages.id })

      // Zero linha aqui significa RLS recusando em silêncio — o modo de falha
      // mais caro deste projeto, e o motivo de este teste rodar como app.
      expect(criada, 'insert recusado pelo RLS').toBeTruthy()

      await tx
        .insert(schema.messageVariants)
        .values(linhas.variantes.map((v) => ({ messageId: criada!.id, ...v })))

      return criada!.id
    })
  }

  it('a mensagem chega ao banco com corpo, e a tela a lê de volta', async () => {
    const id = await gravar('boas_vindas')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    expect(lida).not.toBeNull()
    expect(lida!.mensagem.key).toBe('boas_vindas')
    expect(lida!.mensagem.body.trim().length).toBeGreaterThan(0)
    expect(lida!.variantes).toHaveLength(CHANNELS.length)
  })

  it('os canais do modelo valem na tela: SMS desligado, os outros ligados', async () => {
    const id = await gravar('boas_vindas')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const ligados = lida!.variantes.filter((v) => v.enabled).map((v) => v.channel)
    expect(ligados.sort()).toEqual(['email', 'telegram', 'whatsapp'])
  })

  it('o e-mail chega com assunto — sem ele a prévia mostra o nome da mensagem', async () => {
    const id = await gravar('pix_lembrete_1')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const email = lida!.variantes.find((v) => v.channel === 'email')
    expect(email?.subject?.trim()).toBeTruthy()
  })

  it('a variante escrita à mão chega dessincronizada e com o próprio texto', async () => {
    const id = await gravar(COM_VARIANTES)
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const sms = lida!.variantes.find((v) => v.channel === 'sms')
    expect(sms?.enabled).toBe(true)
    expect(sms?.synced).toBe(false)
    expect(sms?.body?.trim()).toBeTruthy()

    // O Telegram deste modelo leva botão, que é o que ele tem e os outros não.
    const telegram = lida!.variantes.find((v) => v.channel === 'telegram')
    expect(telegram?.parseMode).toBe('HTML')

    // Canal sem variante escrita continua espelhando o corpo principal.
    const whatsapp = lida!.variantes.find((v) => v.channel === 'whatsapp')
    expect(whatsapp?.synced).toBe(true)
    expect(whatsapp?.body).toBeNull()
  })

  it('o mesmo modelo cabe duas vezes, com chave desviada', async () => {
    await gravar('boas_vindas')
    const id = await gravar('boas_vindas', 'boas_vindas_2')

    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))
    expect(lida!.mensagem.key).toBe('boas_vindas_2')
    expect(lida!.mensagem.name).toBe('Boas-vindas')
  })
})

/**
 * A ação de "Nova mensagem", com o banco de verdade por baixo.
 *
 * Os arredores dela são do Next — sessão em cookie, `revalidatePath`,
 * `redirect` — e nenhum existe sob o Vitest. Substituí-los é o preço de
 * exercitar o que interessa: o desvio de chave quando o modelo já existe, e o
 * fato de a ação gravar pela MESMA função do seed.
 */
describe.skipIf(!habilitado)('§11.7 — criar mensagem a partir de um modelo', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const USUARIO = {
    id: ADMIN,
    orgId: ORG,
    name: 'Admin',
    email: 'modelos-admin@teste.local',
    role: 'admin' as const,
    isAdmin: true,
    orgName: 'Modelos',
    orgSlug: 'modelos-org',
    timezone: 'America/Sao_Paulo',
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Modelos', 'modelos-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'modelos-admin@teste.local', 'x', 'admin')`

    vi.doMock('@/db', () => ({
      withTenant: <T,>(_ctx: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            select
              set_config('app.org_id',   ${ORG}, true),
              set_config('app.user_id',  ${ADMIN}, true),
              set_config('app.is_admin', 'true', true)
          `)
          return fn(tx as Tx)
        }),
    }))

    vi.doMock('@/lib/auth/current', () => ({
      requireAdmin: async () => USUARIO,
      tenantOf: () => ({ orgId: ORG, userId: ADMIN, isAdmin: true }),
    }))

    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }))

    // `redirect` sinaliza por exceção também em produção. Aqui ela carrega o
    // destino, que é como o teste descobre o id da mensagem criada.
    vi.doMock('next/navigation', () => ({
      redirect: (destino: string) => {
        throw Object.assign(new Error('redirect'), { destino })
      },
    }))
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    vi.doUnmock('@/lib/auth/current')
    vi.doUnmock('next/cache')
    vi.doUnmock('next/navigation')
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
  })

  /** Roda a ação e devolve o id extraído do destino do redirect. */
  async function criar(campos: Record<string, string>): Promise<string> {
    const { criarMensagemAction } = await import('@/app/(app)/mensagens/actions')

    const form = new FormData()
    for (const [nome, valor] of Object.entries(campos)) form.append(nome, valor)

    try {
      const estado = await criarMensagemAction({}, form)
      throw new Error(`a ação não redirecionou: ${JSON.stringify(estado)}`)
    } catch (erro) {
      const destino = (erro as { destino?: string }).destino
      if (!destino) throw erro
      return destino.replace('/mensagens/', '')
    }
  }

  async function ler(id: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${ADMIN}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return buscarMensagem(tx as Tx, id)
    })
  }

  it('sem modelo, a mensagem nasce em branco — como antes', async () => {
    const id = await criar({ nome: 'Do zero', categoria: 'relacionamento' })
    const lida = await ler(id)

    expect(lida!.mensagem.key).toBe('do_zero')
    expect(lida!.mensagem.body).toBe('')
    expect(lida!.variantes).toHaveLength(CHANNELS.length)
  })

  it('com modelo, nasce idêntica à do catálogo', async () => {
    const modelo = acharModelo(MENSAGENS, COM_VARIANTES)!

    const id = await criar({
      nome: modelo.name,
      categoria: modelo.category,
      modelo: modelo.key,
    })
    const lida = await ler(id)

    // Chave do MODELO, não derivada do nome: é ela que a API pública usa
    // (§3.4) e que a documentação cita pelo nome.
    expect(lida!.mensagem.key).toBe(modelo.key)
    expect(lida!.mensagem.body).toBe(modelo.body)

    const sms = lida!.variantes.find((v) => v.channel === 'sms')
    expect(sms?.enabled, 'só este modelo liga o SMS').toBe(true)
    expect(sms?.synced, 'texto feito para o canal não pode nascer sincronizado').toBe(false)

    const email = lida!.variantes.find((v) => v.channel === 'email')
    expect(email?.subject?.trim(), 'assunto do e-mail').toBeTruthy()
  })

  it('o SMS continua desligado quando o modelo não o pede (§8.4)', async () => {
    const id = await criar({ nome: 'Boas-vindas', categoria: 'relacionamento', modelo: 'boas_vindas' })
    const lida = await ler(id)

    // A regressão que motivou tudo isto: a tela ligava os quatro canais, e a
    // mensagem saía pelo mais caro do sistema sem ninguém ter pedido.
    expect(lida!.variantes.find((v) => v.channel === 'sms')?.enabled).toBe(false)
  })

  it('o nome digitado vence o do modelo; a chave do modelo, não', async () => {
    const id = await criar({
      nome: 'Meu lembrete de PIX',
      categoria: 'recuperacao',
      modelo: 'pix_lembrete_1',
    })
    const lida = await ler(id)

    expect(lida!.mensagem.name).toBe('Meu lembrete de PIX')
    expect(lida!.mensagem.key).toBe('pix_lembrete_1')
    expect(lida!.mensagem.category).toBe('recuperacao')
  })

  it('o mesmo modelo duas vezes vira _2, sem conflito de chave', async () => {
    const primeiro = await criar({
      nome: 'Boas-vindas',
      categoria: 'relacionamento',
      modelo: 'boas_vindas',
    })
    const segundo = await criar({
      nome: 'Boas-vindas de novo',
      categoria: 'relacionamento',
      modelo: 'boas_vindas',
    })

    expect((await ler(primeiro))!.mensagem.key).toBe('boas_vindas')
    expect((await ler(segundo))!.mensagem.key).toBe('boas_vindas_2')
  })

  it('chave de modelo inventada cria em branco, sem erro na tela', async () => {
    // Vem de campo escondido: quem mexe no HTML consegue mandar qualquer
    // coisa, e o desfecho razoável é "criou vazia", não uma tela de erro.
    const id = await criar({ nome: 'Inventada', categoria: 'relacionamento', modelo: 'nao_existe' })
    const lida = await ler(id)

    expect(lida!.mensagem.key).toBe('inventada')
    expect(lida!.mensagem.body).toBe('')
  })
})
