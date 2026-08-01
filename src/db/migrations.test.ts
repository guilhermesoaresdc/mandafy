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
