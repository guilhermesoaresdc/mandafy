import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import { contacts, leads } from '@/db/schema'
import type { Tx } from '@/db'
import { lerCsv, mapearColunas } from '@/lib/leads/csv'
import { conferir, limparCpf, paraCentavos, type LinhaRejeitada } from '@/lib/leads/conferir'
import { importarContatos } from '@/lib/leads/importar'

/**
 * Importação de lista, contra um Postgres de verdade (§9.1, §14.1).
 *
 * O teste que justifica o arquivo é `não ressuscita quem pediu para sair`.
 * Todos os outros protegem contra erro visível — dado gravado torto, que
 * alguém percebe e conserta. Aquele protege contra erro invisível: mensagem
 * enviada a quem já tinha dito não, descoberta pela pessoa que recebeu.
 *
 * Precisa dos mesmos endereços de tests/rls.test.ts. Sem eles a suíte é pulada.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`

const ORG = uid('f1')
const ADMIN = uid('f2')
const PIPELINE = uid('f3')
const ETAPA_1 = uid('f4')
const ETAPA_2 = uid('f5')

describe.skipIf(!habilitado)('§9.1 — importação de lista', () => {
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

  /** Lê o CSV, mapeia sozinho e importa — o caminho inteiro da tela. */
  async function importarCsv(texto: string, opcoes: { criarLeads?: boolean } = {}) {
    const arquivo = lerCsv(texto)
    const mapa = mapearColunas(arquivo.colunas)
    const conferencia = conferir(arquivo.linhas, mapa)
    const resultado = await comoUsuario((tx) =>
      importarContatos(tx, ORG, conferencia.validas, opcoes),
    )
    return { conferencia, resultado }
  }

  const buscarPorTelefone = (telefone: string) =>
    comoUsuario(async (tx) => {
      const [c] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.orgId, ORG), eq(contacts.phoneE164, telefone)))
        .limit(1)
      return c
    })

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })
  })

  beforeEach(async () => {
    await admin.begin(async (tx) => {
      await tx`DELETE FROM organizations WHERE id = ${ORG}`
      await tx`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Org Importação', 'importacao-org')`
      await tx`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
        (${ADMIN}, ${ORG}, 'Admin', 'importacao-admin@teste.local', 'x', 'admin')`
      await tx`INSERT INTO pipelines (id, org_id, name, is_default) VALUES
        (${PIPELINE}, ${ORG}, 'Padrão', true)`
      await tx`INSERT INTO pipeline_stages (id, pipeline_id, name, position) VALUES
        (${ETAPA_1}, ${PIPELINE}, 'Novo', 0),
        (${ETAPA_2}, ${PIPELINE}, 'Contatado', 1)`
    })
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 5 })
    await app.end({ timeout: 5 })
  })

  it('cria os contatos do arquivo', async () => {
    const { resultado } = await importarCsv(
      'nome;telefone;email\n' +
        'Maria Silva;11988887777;maria@exemplo.com\n' +
        'João Souza;11977776666;joao@exemplo.com\n',
    )

    expect(resultado).toMatchObject({ criados: 2, atualizados: 0, preservados: 0 })

    const maria = await buscarPorTelefone('+5511988887777')
    expect(maria?.name).toBe('Maria Silva')
    expect(maria?.email).toBe('maria@exemplo.com')
    // Quem importa declara ter base legal, e a declaração fica com data (§14.1).
    expect(maria?.optinSource).toBe('import')
    expect(maria?.optinAt).toBeInstanceOf(Date)
  })

  /*
   * O teste que este módulo existe para passar.
   *
   * A planilha do cliente quase sempre inclui a base antiga inteira, e nela
   * está quem pediu para sair. Um upsert ingênuo devolve essa pessoa à régua
   * de disparo e ninguém percebe — até ela receber.
   */
  it('não ressuscita quem pediu para sair', async () => {
    await importarCsv('nome;telefone\nMaria;11988887777\n')

    await admin`
      UPDATE contacts
         SET opted_out_at = now(),
             optout_reason = 'pediu para sair',
             optin_whatsapp = false,
             optin_sms = false,
             optin_email = false,
             optin_telegram = false
       WHERE org_id = ${ORG} AND phone_e164 = '+5511988887777'`

    const { resultado } = await importarCsv('nome;telefone;email\nMaria;11988887777;maria@exemplo.com\n')

    expect(resultado.preservados).toBe(1)
    expect(resultado.atualizados).toBe(0)
    expect(resultado.criados).toBe(0)

    const maria = await buscarPorTelefone('+5511988887777')
    expect(maria?.optedOutAt).not.toBeNull()
    expect(maria?.optinWhatsapp).toBe(false)
    expect(maria?.optinSms).toBe(false)
    expect(maria?.optinEmail).toBe(false)
    expect(maria?.optinTelegram).toBe(false)
  })

  /* Planilha completa o que falta; não sobrescreve o que o sistema já sabe. */
  it('preenche o vazio sem apagar o que já havia', async () => {
    await importarCsv('nome;telefone\nMaria Silva;11988887777\n')
    await importarCsv('nome;telefone;email;cpf\nMARIA DA SILVA;11988887777;maria@exemplo.com;123.456.789-09\n')

    const maria = await buscarPorTelefone('+5511988887777')
    expect(maria?.name).toBe('Maria Silva')
    expect(maria?.email).toBe('maria@exemplo.com')
    expect(maria?.cpf).toBe('12345678909')
  })

  it('acumula as etiquetas em vez de trocá-las', async () => {
    await importarCsv('telefone;tags\n11988887777;vip\n')
    await importarCsv('telefone;tags\n11988887777;vip,black\n')

    const maria = await buscarPorTelefone('+5511988887777')
    expect([...(maria?.tags ?? [])].sort()).toEqual(['black', 'vip'])
  })

  it('reconhece o mesmo contato pelo external_id mesmo com telefone novo', async () => {
    await importarCsv('external_id;nome;telefone\nAP-99;Maria;11988887777\n')
    const { resultado } = await importarCsv('external_id;nome;telefone\nAP-99;Maria;11966665555\n')

    expect(resultado.criados).toBe(0)
    expect(resultado.atualizados).toBe(1)

    const total = await comoUsuario(async (tx) => {
      const linhas = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.orgId, ORG))
      return linhas.length
    })
    expect(total).toBe(1)
  })

  it('descarta a linha repetida dentro do próprio arquivo', async () => {
    const { conferencia, resultado } = await importarCsv(
      'nome;telefone\nMaria;11988887777\nMaria S.;11988887777\n',
    )

    expect(conferencia.repetidas).toBe(1)
    expect(resultado.criados).toBe(1)
  })

  /*
   * Só o banco sabe que estas duas linhas são a mesma pessoa: uma casa pelo
   * telefone, a outra pelo e-mail. `conferir` não tem como ver isso — para ela
   * são chaves diferentes. Sem o controle no lado da gravação, a segunda vira
   * contato novo e bate no índice único.
   */
  it('junta duas linhas que caem no mesmo contato por chaves diferentes', async () => {
    await importarCsv('nome;telefone;email\nMaria;11988887777;maria@exemplo.com\n')

    const { resultado } = await importarCsv(
      'nome;telefone;email\nMaria;11988887777;\nMaria de novo;;maria@exemplo.com\n',
    )

    expect(resultado.criados).toBe(0)
    expect(resultado.atualizados).toBe(1)

    const total = await comoUsuario(async (tx) =>
      (await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.orgId, ORG))).length,
    )
    expect(total).toBe(1)
  })

  /* Planilha grande é o caso em que o modo linha a linha morria no tempo. */
  it('dá conta de um arquivo grande de uma vez', async () => {
    const linhas = Array.from(
      { length: 1200 },
      (_, i) => `Pessoa ${i};119${String(80000000 + i).padStart(8, '0')}`,
    ).join('\n')

    const { resultado } = await importarCsv(`nome;telefone\n${linhas}\n`, { criarLeads: true })

    expect(resultado.criados).toBe(1200)
    expect(resultado.leadsCriados).toBe(1200)

    // E de novo: nem contato duplicado, nem lead duplicado.
    const repetida = await importarCsv(`nome;telefone\n${linhas}\n`, { criarLeads: true })
    expect(repetida.resultado.criados).toBe(0)
    expect(repetida.resultado.leadsCriados).toBe(0)
  })

  it('rejeita quem não tem como ser contatado', async () => {
    const { conferencia, resultado } = await importarCsv(
      'nome;telefone;email\nMaria;11988887777;\nFantasma;;\nRuim;123;\n',
    )

    expect(resultado.criados).toBe(1)
    expect(conferencia.rejeitadas.map((r: LinhaRejeitada) => r.linha)).toEqual([3, 4])
    expect(conferencia.rejeitadas[0]?.motivo).toBe('sem telefone e sem e-mail')
    expect(conferencia.rejeitadas[1]?.motivo).toContain('123')
  })

  it('só e-mail já basta para importar', async () => {
    const { resultado } = await importarCsv('nome;email\nMaria;maria@exemplo.com\n')
    expect(resultado.criados).toBe(1)
  })

  it('cria lead quando pedido, e só então', async () => {
    const semLead = await importarCsv('nome;telefone\nMaria;11988887777\n')
    expect(semLead.resultado.leadsCriados).toBe(0)

    const comLead = await importarCsv('nome;telefone;valor\nMaria;11988887777;1.234,56\n', {
      criarLeads: true,
    })
    expect(comLead.resultado.leadsCriados).toBe(1)

    const [lead] = await comoUsuario((tx) =>
      tx.select().from(leads).where(eq(leads.orgId, ORG)),
    )
    expect(lead?.title).toBe('Maria')
    expect(lead?.valueCents).toBe(123456)
    expect(lead?.stageId).toBe(ETAPA_1)
    expect(lead?.source).toBe('importacao')
  })

  /* Importar a mesma planilha duas vezes é acidente comum. */
  it('reimportar não duplica o lead aberto', async () => {
    const csv = 'nome;telefone\nMaria;11988887777\n'
    await importarCsv(csv, { criarLeads: true })
    const segunda = await importarCsv(csv, { criarLeads: true })

    expect(segunda.resultado.leadsCriados).toBe(0)
  })

  /* Lead ganho e fechado não impede a próxima oportunidade com a mesma pessoa. */
  it('cria lead novo quando o anterior já foi fechado', async () => {
    const csv = 'nome;telefone\nMaria;11988887777\n'
    await importarCsv(csv, { criarLeads: true })
    await admin`UPDATE leads SET status = 'ganho' WHERE org_id = ${ORG}`

    const segunda = await importarCsv(csv, { criarLeads: true })
    expect(segunda.resultado.leadsCriados).toBe(1)
  })

  /*
   * Exportar, ajustar na planilha e importar de volta é o caminho mais usado
   * de todos — e o mais fácil de quebrar, porque ninguém remapeia coluna.
   */
  it('aceita de volta o CSV que o próprio sistema exporta', async () => {
    /*
     * Byte a byte como a rota de exportação escreve: BOM, tudo entre aspas, e
     * o telefone com o `\t` que a rota põe na frente do `+` para o Excel não
     * ler como fórmula. Reescrever isso "limpo" no teste seria testar um
     * arquivo que ninguém tem.
     */
    const doExport =
      '﻿lead,contato,telefone,email,etapa,status,responsavel,valor_cents,origem,criado_em,ultimo_evento\n' +
      '"Oportunidade Maria","Maria Silva","\t+5511988887777","maria@exemplo.com","Novo",' +
      '"aberto","","15000","importacao","2026-01-01T00:00:00.000Z",""\n'

    const { conferencia, resultado } = await importarCsv(doExport, { criarLeads: true })

    expect(conferencia.rejeitadas).toEqual([])
    expect(resultado.criados).toBe(1)

    const [lead] = await comoUsuario((tx) => tx.select().from(leads).where(eq(leads.orgId, ORG)))
    expect(lead?.title).toBe('Oportunidade Maria')
    expect(lead?.valueCents).toBe(15000)
  })
})

describe('§9.1 — conversão de valor e documento', () => {
  /*
   * `10,50` virando R$ 1.050,00 é o erro que ninguém percebe até o relatório
   * de recuperado ficar cem vezes maior que a realidade.
   */
  it('lê o formato brasileiro e o americano', () => {
    expect(paraCentavos('10,50')).toBe(1050)
    expect(paraCentavos('1.234,56')).toBe(123456)
    expect(paraCentavos('1234.56')).toBe(123456)
    expect(paraCentavos('1,234.56')).toBe(123456)
    expect(paraCentavos('R$ 89,90')).toBe(8990)
    expect(paraCentavos('150')).toBe(15000)
  })

  it('valor ausente ou impossível vira zero, não NaN', () => {
    expect(paraCentavos('')).toBe(0)
    expect(paraCentavos('  ')).toBe(0)
    expect(paraCentavos('grátis')).toBe(0)
  })

  /* Quem escreve `valor` digita reais; quem escreve `valor_cents` é a máquina. */
  it('respeita a unidade que o cabeçalho declara', () => {
    const emReais = conferir(lerCsv('telefone;valor\n11988887777;150,00\n').linhas, {
      telefone: 'telefone',
      valor_cents: 'valor',
    })
    expect(emReais.validas[0]?.valorCents).toBe(15000)

    const jaEmCentavos = conferir(lerCsv('telefone;valor_cents\n11988887777;15000\n').linhas, {
      telefone: 'telefone',
      valor_cents: 'valor_cents',
    })
    expect(jaEmCentavos.validas[0]?.valorCents).toBe(15000)
  })

  it('CPF fica só com os dígitos, e malformado vira nulo', () => {
    expect(limparCpf('123.456.789-09')).toBe('12345678909')
    expect(limparCpf('123')).toBeNull()
    expect(limparCpf('')).toBeNull()
  })
})
