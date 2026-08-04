import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { reaplicarModelos } from '@/db/reaplicar-modelos'
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
    expect(telegram?.buttons?.[0]?.text).toBe(modelo.variantes?.telegram?.buttons?.[0]?.text)
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
