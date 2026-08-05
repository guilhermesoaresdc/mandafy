import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { reaplicarModelos, reaplicarNaConexao } from '@/db/reaplicar-modelos'
import { linhasDoModelo, acharModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS } from '@/lib/messages/modelos'

/**
 * Reaplicar o catálogo por cima do que já está gravado (§5.2).
 *
 * O QUE ESTA SUÍTE PROTEGE
 *
 * Um comando que reescreve o texto que sai para o cliente tem dois modos de
 * falha, e os dois são caros:
 *
 *   não atualizar o que devia   o cliente continua recebendo o texto errado, e
 *                               ninguém percebe porque a tela não muda
 *   atualizar o que NÃO devia   apaga o texto que alguém ajustou à mão, e não
 *                               há como recuperar
 *
 * O segundo é o que este arquivo existe para impedir. A regra é comparar o
 * corpo gravado com as digitais do que o seed já escreveu — e é preciso
 * exercitá-la contra o banco de verdade, porque é lá que ela decide.
 *
 * Roda com o papel DONO das tabelas, como o comando: ele não tem contexto de
 * tenant, e é justamente esse o ponto — atualiza todas as organizações.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const habilitado = Boolean(ADMIN_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('f01')

/** Um modelo qualquer do catálogo serve; este tem variantes escritas à mão. */
const CHAVE = 'bilhete_premiado'

/**
 * Um corpo que o seed JÁ escreveu um dia — o da versão de rifa.
 *
 * Precisa ser um texto histórico de verdade, não inventado: é exatamente a
 * digital dele que autoriza a sobrescrita. Se alguém mexer em `HISTORICOS` sem
 * cuidado, este teste é o que denuncia.
 */
const CORPO_ANTIGO = `🏆 *{{nome|primeiro_nome|"Parabéns"}}, você foi premiado!*

Prêmio: *{{premio|"seu prêmio"}}*
Campanha: {{campanha|"do sorteio"}}

Nossa equipe entra em contato para combinar a entrega.`

describe.skipIf(!habilitado)('§5.2 — reaplicar o catálogo', () => {
  let admin: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const modelo = acharModelo(MENSAGENS, CHAVE)!
  const atual = linhasDoModelo(modelo).mensagem

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    db = drizzle(admin, { schema })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug)
                VALUES (${ORG}, 'Org Modelos', 'reaplicar-org')`
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
  })

  async function semear(corpo: string): Promise<string> {
    const [linha] = await db
      .insert(schema.messages)
      .values({ orgId: ORG, key: CHAVE, name: 'Nome antigo', body: corpo })
      .returning({ id: schema.messages.id })

    await db.insert(schema.messageVariants).values(
      (['whatsapp', 'email', 'sms', 'telegram'] as const).map((channel) => ({
        messageId: linha!.id,
        channel,
      })),
    )

    return linha!.id
  }

  async function corpoDe(id: string): Promise<string> {
    const [linha] = await db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
    return linha!.body
  }

  it('simulação não escreve nada', async () => {
    const id = await semear(CORPO_ANTIGO)

    const r = await reaplicarModelos(false, ADMIN_URL!)
    expect(r.some((x) => x.key === CHAVE && x.desfecho === 'reaplicado')).toBe(true)

    // O relatório disse que atualizaria — e o banco continua como estava.
    expect(await corpoDe(id)).toBe(CORPO_ANTIGO)
  })

  it('texto que o seed escreveu é atualizado', async () => {
    const id = await semear(CORPO_ANTIGO)

    await reaplicarModelos(true, ADMIN_URL!)

    expect(await corpoDe(id)).toBe(atual.body)
  })

  /*
   * O teste que justifica o arquivo. Apagar texto que alguém escreveu é o dano
   * que este comando pode causar e não dá para desfazer.
   */
  it('texto EDITADO À MÃO nunca é sobrescrito', async () => {
    const editado = `${CORPO_ANTIGO}\n\nParágrafo que a pessoa acrescentou.`
    const id = await semear(editado)

    const r = await reaplicarModelos(true, ADMIN_URL!)

    expect(r.some((x) => x.key === CHAVE && x.desfecho === 'editado')).toBe(true)
    expect(await corpoDe(id)).toBe(editado)
  })

  it('as variantes acompanham o corpo', async () => {
    const id = await semear(CORPO_ANTIGO)

    await reaplicarModelos(true, ADMIN_URL!)

    const variantes = await db
      .select()
      .from(schema.messageVariants)
      .where(eq(schema.messageVariants.messageId, id))

    const email = variantes.find((v) => v.channel === 'email')
    const sms = variantes.find((v) => v.channel === 'sms')
    const telegram = variantes.find((v) => v.channel === 'telegram')

    // Atualizar só o corpo deixaria o assunto falando de campanha enquanto o
    // texto fala de aposta — pior que não atualizar nada.
    expect(email?.subject).toBe(modelo.variantes?.email?.subject)
    expect(sms?.stripAccents).toBe(true)
    /*
     * O botão do Telegram, quando o modelo tem um — e `null` quando não tem.
     * Comparar as duas pontas com `?.` deixava o caso passar por vacuidade no
     * dia em que o botão saiu do modelo: `undefined === undefined`.
     */
    expect(telegram?.buttons ?? null).toEqual(
      modelo.variantes?.telegram?.buttons ? [...modelo.variantes.telegram.buttons] : null,
    )
    // Variante escrita à mão nasce dessincronizada: editar o corpo depois não
    // pode apagar um texto feito de propósito para aquele canal.
    expect(email?.synced).toBe(false)
  })

  /*
   * Ligar e desligar canal é decisão de operação. O comando não tem o direito
   * de religar um SMS que alguém desligou por causa do custo.
   */
  it('não mexe em canal ligado ou desligado', async () => {
    const id = await semear(CORPO_ANTIGO)

    await db
      .update(schema.messageVariants)
      .set({ enabled: false })
      .where(
        and(
          eq(schema.messageVariants.messageId, id),
          eq(schema.messageVariants.channel, 'sms'),
        ),
      )

    await reaplicarModelos(true, ADMIN_URL!)

    const [sms] = await db
      .select({ enabled: schema.messageVariants.enabled })
      .from(schema.messageVariants)
      .where(
        and(
          eq(schema.messageVariants.messageId, id),
          eq(schema.messageVariants.channel, 'sms'),
        ),
      )

    expect(sms?.enabled).toBe(false)
  })

  it('rodar de novo não muda nada', async () => {
    const id = await semear(CORPO_ANTIGO)

    await reaplicarModelos(true, ADMIN_URL!)
    const [antes] = await db
      .select({ updatedAt: schema.messages.updatedAt })
      .from(schema.messages)
      .where(eq(schema.messages.id, id))

    const segunda = await reaplicarModelos(true, ADMIN_URL!)

    // Já em dia: nem sequer escreve, então `updated_at` não se move.
    expect(segunda.some((x) => x.key === CHAVE && x.desfecho === 'em_dia')).toBe(true)
    const [depois] = await db
      .select({ updatedAt: schema.messages.updatedAt })
      .from(schema.messages)
      .where(eq(schema.messages.id, id))
    expect(depois?.updatedAt.getTime()).toBe(antes?.updatedAt.getTime())
  })

  /*
   * O texto que está gravado AGORA, na instalação em produção, e que precisa
   * ser reconhecido como escrito pelo sistema.
   *
   * Esta é a metade do arquivo que o comentário de `HISTORICOS` pede e que
   * ninguém lembra de fazer: ao reescrever um modelo, a digital da versão que
   * SAI tem de entrar na lista. Sem ela o comando classifica o texto antigo
   * como "editado à mão", não toca em nada e reporta sucesso — e a atualização
   * nunca chega a quem mais precisa dela.
   *
   * Este corpo é o da cadência de PIX escrita para um payload que a plataforma
   * não manda: quatro variáveis obrigatórias — `palpite`, `sorteio`,
   * `fecha_em`, `link_pagamento` — que faziam todo lembrete falhar com
   * `variavel_ausente`. É exatamente a instalação que a atualização conserta.
   */
  it('reconhece o texto da versão anterior, e não o trata como edição à mão', async () => {
    const ANTERIOR = `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Vi que|Notei que|Percebi que} o PIX de **{{valor_cents|moeda}}** da sua aposta ainda não caiu.

{{modalidade|"Sua aposta"}} em **{{palpite}}** no **{{sorteio}}**.
As apostas fecham às **{{fecha_em|hora}}**.

Finaliza aqui: {{link_pagamento}}`

    const [linha] = await db
      .insert(schema.messages)
      .values({ orgId: ORG, key: 'pix_lembrete_1', name: 'Lembrete de PIX', body: ANTERIOR })
      .returning({ id: schema.messages.id })

    const r = await reaplicarModelos(true, ADMIN_URL!)
    expect(r.some((x) => x.key === 'pix_lembrete_1' && x.desfecho === 'reaplicado')).toBe(true)

    const novo = await corpoDe(linha!.id)
    expect(novo).toBe(linhasDoModelo(acharModelo(MENSAGENS, 'pix_lembrete_1')!).mensagem.body)

    // E o texto que chegou não depende de campo nenhum além do que o webhook
    // manda — é o motivo da troca, não um efeito colateral dela.
    expect(novo).not.toContain('{{link_pagamento}}')
  })

  it('reconhece modelo aposentado que ficou no banco', async () => {
    await db.insert(schema.messages).values({
      orgId: ORG,
      key: 'bicho_resultado_premiado',
      name: 'Deu no seu bicho — resultado premiado',
      body: 'qualquer coisa',
    })

    const r = await reaplicarModelos(false, ADMIN_URL!)

    expect(r.some((x) => x.key === 'bicho_resultado_premiado' && x.desfecho === 'orfa')).toBe(true)

    await admin`DELETE FROM messages WHERE org_id = ${ORG} AND key = 'bicho_resultado_premiado'`
  })

  /*
   * O caso que a suíte completa revelou: com o papel da APLICAÇÃO, o RLS faz o
   * SELECT devolver zero linhas e o comando reportava "nada a atualizar" —
   * falha silenciosa, e a pior possível, porque quem lê isso conclui que os
   * modelos já estavam em dia.
   */
  it('recusa rodar com o papel da aplicação, em vez de não fazer nada', async () => {
    const APP_URL = process.env.TEST_DATABASE_URL
    if (!APP_URL) return

    await semear(CORPO_ANTIGO)

    await expect(reaplicarModelos(true, APP_URL)).rejects.toThrow(/papel da aplicação/)
  })
})

/**
 * O MESMO trabalho pelo botão do painel — e é outro caminho de verdade.
 *
 * O comando abre conexão de dono e recusa o papel da aplicação, o que está
 * certo para ele. O botão não pode fazer nem uma coisa nem outra: na hospedagem
 * de quem opera pelo navegador existe uma variável de banco só, apontando para
 * `mandafy_app`. A primeira versão do botão chamava o comando e respondia com a
 * explicação de por que não ia fazer nada — o consertar-pelo-painel que era o
 * motivo inteiro de ele existir.
 *
 * Aqui ele roda como `mandafy_app`, com RLS aplicado e `app.org_id` definido,
 * que é exatamente a situação de produção. E é a situação em que este projeto
 * já viu, quatro vezes, uma escrita atualizar ZERO linhas sem erro nenhum.
 */
const APP_URL = process.env.TEST_DATABASE_URL
const doisPapeis = Boolean(ADMIN_URL && APP_URL)

describe.skipIf(!doisPapeis)('§5.2 — reaplicar pelo painel, com o papel da aplicação', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let comoApp: PostgresJsDatabase<typeof schema>

  const ORG_A = uid('f11')
  const ORG_B = uid('f12')
  const USUARIO = uid('f13')

  const atual = linhasDoModelo(acharModelo(MENSAGENS, CHAVE)!).mensagem

  /** Mesma mecânica de withTenant(), sem depender das variáveis de ambiente. */
  async function naOrg<T>(orgId: string, fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>) {
    return comoApp.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${orgId}, true),
          set_config('app.user_id',  ${USUARIO}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as unknown as PostgresJsDatabase<typeof schema>)
    })
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    comoApp = drizzle(app, { schema })

    for (const org of [ORG_A, ORG_B]) {
      await admin`DELETE FROM organizations WHERE id = ${org}`
    }
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${ORG_A}, 'Org A', 'reaplicar-painel-a'),
      (${ORG_B}, 'Org B', 'reaplicar-painel-b')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${USUARIO}, ${ORG_A}, 'Admin', 'reaplicar-painel@teste.local', 'x', 'admin')`
  })

  afterAll(async () => {
    if (!doisPapeis) return
    for (const org of [ORG_A, ORG_B]) {
      await admin`DELETE FROM organizations WHERE id = ${org}`
    }
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id IN (${ORG_A}, ${ORG_B})`

    for (const org of [ORG_A, ORG_B]) {
      const [linha] = await admin<{ id: string }[]>`
        INSERT INTO messages (org_id, key, name, body)
        VALUES (${org}, ${CHAVE}, 'Nome antigo', ${CORPO_ANTIGO})
        RETURNING id`
      await admin`
        INSERT INTO message_variants (message_id, channel)
        SELECT ${linha!.id}::uuid, unnest(ARRAY['whatsapp','email','sms','telegram'])`
    }
  })

  async function corpoNa(org: string): Promise<string> {
    const [linha] = await admin<{ body: string }[]>`
      SELECT body FROM messages WHERE org_id = ${org} AND key = ${CHAVE}`
    return linha!.body
  }

  it('enxerga a mensagem e a atualiza — o RLS não engole a escrita', async () => {
    const r = await naOrg(ORG_A, (tx) => reaplicarNaConexao(tx, true, ORG_A))

    // Zero linha aqui seria o modo de falha desta base de código: sem erro, sem
    // aviso, e "nada a atualizar" na tela.
    expect(r.some((x) => x.key === CHAVE && x.desfecho === 'reaplicado')).toBe(true)
    expect(await corpoNa(ORG_A)).toBe(atual.body)
  })

  it('não toca na mensagem de OUTRA organização', async () => {
    await naOrg(ORG_A, (tx) => reaplicarNaConexao(tx, true, ORG_A))

    expect(await corpoNa(ORG_B)).toBe(CORPO_ANTIGO)
  })

  it('a simulação continua não escrevendo nada', async () => {
    const r = await naOrg(ORG_A, (tx) => reaplicarNaConexao(tx, false, ORG_A))

    expect(r.some((x) => x.key === CHAVE && x.desfecho === 'reaplicado')).toBe(true)
    expect(await corpoNa(ORG_A)).toBe(CORPO_ANTIGO)
  })

  it('texto editado à mão continua intocado também por aqui', async () => {
    const editado = `${CORPO_ANTIGO}\n\nParágrafo que a pessoa acrescentou.`
    await admin`UPDATE messages SET body = ${editado} WHERE org_id = ${ORG_A} AND key = ${CHAVE}`

    const r = await naOrg(ORG_A, (tx) => reaplicarNaConexao(tx, true, ORG_A))

    expect(r.some((x) => x.key === CHAVE && x.desfecho === 'editado')).toBe(true)
    expect(await corpoNa(ORG_A)).toBe(editado)
  })

  it('as variantes acompanham, e elas herdam o RLS da mensagem', async () => {
    await naOrg(ORG_A, (tx) => reaplicarNaConexao(tx, true, ORG_A))

    /*
     * `message_variants` não tem `org_id`: a política dela é "a mensagem
     * precisa estar visível". Uma escrita que passa na tabela pai e falha na
     * filha deixaria o corpo novo com o assunto velho — e é o tipo de coisa que
     * só aparece na caixa de entrada de alguém.
     */
    const [email] = await admin<{ subject: string | null; synced: boolean }[]>`
      SELECT v.subject, v.synced
      FROM message_variants v
      JOIN messages m ON m.id = v.message_id
      WHERE m.org_id = ${ORG_A} AND m.key = ${CHAVE} AND v.channel = 'email'`

    const modelo = acharModelo(MENSAGENS, CHAVE)!
    expect(email?.subject).toBe(modelo.variantes?.email?.subject)
    expect(email?.synced).toBe(false)
  })
})
