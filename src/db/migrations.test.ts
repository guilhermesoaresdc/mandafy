import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations.generated'

/**
 * O módulo embutido está em dia com `drizzle/*.sql`?
 *
 * Existe porque a defasagem entre os dois é invisível: `tsc`, `eslint` e
 * `next build` passam com uma migration nova que ninguém embutiu, e o sintoma
 * só aparece em produção — a tabela que a tela espera não existe.
 *
 * Este teste é o que permite embutir sem medo. Arquivo novo em `drizzle/` sem
 * rodar `npm run db:embutir` quebra aqui, e não lá.
 */

const PASTA = join(process.cwd(), 'drizzle')

describe('migrations embutidas', () => {
  it('cobrem exatamente os arquivos de drizzle/, na mesma ordem', async () => {
    const noDisco = (await readdir(PASTA))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, 'en'))

    expect(MIGRATIONS.map((m) => m.nome)).toEqual(noDisco)
  })

  it('têm o mesmo conteúdo do disco', async () => {
    for (const migration of MIGRATIONS) {
      const doDisco = await readFile(join(PASTA, migration.nome), 'utf8')
      expect(migration.sql, `${migration.nome} está defasada — rode npm run db:embutir`).toBe(
        doDisco,
      )
    }
  })

  it('têm checksum coerente com o próprio conteúdo', () => {
    for (const migration of MIGRATIONS) {
      expect(createHash('sha256').update(migration.sql).digest('hex')).toBe(migration.checksum)
    }
  })

  it('estão numeradas em sequência, sem buraco nem repetição', () => {
    // Um número repetido significa duas migrations aplicadas em ordem
    // imprevisível entre máquinas — o tipo de coisa que só aparece quando o
    // banco de um ambiente diverge do outro.
    const numeros = MIGRATIONS.map((m) => Number(m.nome.slice(0, 4)))
    expect(numeros).toEqual(numeros.map((_, i) => i))
  })
})

/**
 * A recusa do banco traduzida em instrução.
 *
 * `permission denied for schema public` é exato, correto e mudo. Quem opera
 * pelo navegador leu isso, concluiu que o botão não servia para nada e voltou a
 * colar SQL à mão no painel do Supabase — o que funciona para o esquema e
 * deixa `_migrations` sem saber, então a tela segue dizendo "14 pendentes" para
 * sempre e cada deploy tenta aplicá-las de novo.
 *
 * A causa é sempre a mesma e cabe numa frase, e é essa frase que este bloco
 * prende.
 */
describe('o erro que explica o que fazer', () => {
  it('reconhece a falta de permissão pelo código, não pela frase', async () => {
    const { explicarFalha } = await import('./migrate')

    // A frase do Postgres varia com a versão e com o idioma do servidor; o
    // SQLSTATE, não. Casar só por texto quebraria num banco em pt-BR.
    const erro = Object.assign(new Error('algo que não parece permissão'), { code: '42501' })
    expect(explicarFalha(erro)).toContain('DATABASE_URL_ADMIN')
  })

  it('reconhece também pela frase, para quem não traz o código', async () => {
    const { explicarFalha } = await import('./migrate')

    // Alguns drivers embrulham o erro e perdem o `code` no caminho.
    const texto = explicarFalha(new Error('permission denied for schema public'))
    expect(texto).toContain('DATABASE_URL_ADMIN')
    // A mensagem original continua ali: é ela que casa com o que o Supabase
    // mostra, e sem ela a explicação parece falar de outro problema.
    expect(texto).toContain('permission denied for schema public')
  })

  it('diz que a correção NÃO é dar permissão ao papel da aplicação', async () => {
    const { explicarFalha } = await import('./migrate')
    const texto = explicarFalha(new Error('permission denied for schema public'))

    /*
     * O atalho óbvio — `GRANT CREATE ON SCHEMA public TO mandafy_app` — resolve
     * o sintoma e desmonta o isolamento entre organizações, que é a única coisa
     * separando uma banca da outra. A mensagem precisa apontar para o dono.
     */
    expect(texto).toMatch(/dono do banco/)
    expect(texto).toMatch(/postgres/)
  })

  it('não inventa explicação para erro que não é de permissão', async () => {
    const { explicarFalha } = await import('./migrate')

    // Sintaxe quebrada não se conserta com variável de ambiente, e mandar
    // alguém mexer em produção por causa dela custa uma tarde.
    const texto = explicarFalha(new Error('syntax error at or near "CREAT"'))
    expect(texto).toBe('syntax error at or near "CREAT"')
    expect(texto).not.toContain('DATABASE_URL_ADMIN')
  })

  it('aguenta o que não é Error', async () => {
    const { explicarFalha } = await import('./migrate')
    // Vem de `catch`, que recebe qualquer coisa. Estourar aqui trocaria uma
    // mensagem ruim por uma tela branca.
    expect(explicarFalha('caiu')).toBe('caiu')
    expect(explicarFalha(null)).toBe('null')
  })
})

/**
 * Toda migration pode rodar duas vezes.
 *
 * Não é elegância: é o que torna seguro reaplicar por cima de um banco em que
 * alguém já colou parte do SQL à mão, que é exatamente a situação de quem
 * migrou pelo painel do Supabase antes de `DATABASE_URL_ADMIN` existir. Sem
 * isto, a saída seria conferir arquivo por arquivo antes de clicar.
 *
 * O teste é textual e por isso grosseiro — mas o modo de falha que ele pega é
 * o de alguém escrever `CREATE TABLE x` sem guarda num arquivo novo, que é
 * justamente o descuido comum.
 */
describe('reaplicar é seguro', () => {
  it('nenhuma cria tabela, índice ou coluna sem guarda', async () => {
    const { MIGRATIONS } = await import('./migrations.generated')

    // `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` e `CREATE TYPE` são os que
    // estouram na segunda passagem. `CREATE OR REPLACE` e `DROP … IF EXISTS`
    // já são idempotentes por construção.
    const perigosos =
      /\b(CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|ADD\s+COLUMN|CREATE\s+TYPE)\b(?!\s+IF\s+NOT\s+EXISTS)/gi

    for (const m of MIGRATIONS) {
      const sql = m.sql
        // Comentários: este repositório cita SQL dentro deles o tempo todo.
        .replace(/--[^\n]*/g, '')
        /*
         * E o corpo de tudo que vem entre cifrões — `DO $$ … $$` e
         * `CREATE OR REPLACE FUNCTION … AS $fn$ … $fn$`.
         *
         * Lá dentro a guarda existe e é OUTRA: o SQL é montado em string e
         * executado por `EXECUTE`, protegido por um `IF to_regclass(…) IS NULL`
         * de verdade, que um teste textual não tem como enxergar. É o caso das
         * partições diárias de 0009. E a função em si já é idempotente pelo
         * `OR REPLACE`.
         *
         * O que sobra é o SQL de primeiro nível, que é onde o descuido comum
         * mora: um `CREATE TABLE x (…)` digitado sem guarda num arquivo novo.
         */
        .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, '')

      const achados = [...sql.matchAll(perigosos)].map((x) => x[0])

      expect(achados, `${m.nome} tem DDL sem IF NOT EXISTS: ${achados.join(', ')}`).toEqual([])
    }
  })
})
