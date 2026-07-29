import { describe, expect, it } from 'vitest'
import { usesTransactionPooler } from './index'

/**
 * A detecção do pooler decide se ligamos prepared statements. Errar aqui
 * produz o pior tipo de bug: funciona em desenvolvimento e quebra só em
 * produção, com "prepared statement already exists" na primeira query.
 */
describe('usesTransactionPooler', () => {
  it.each([
    ['Supavisor em modo transação (porta 6543)', 'postgresql://u:p@aws-0-sa-east-1.pooler.supabase.com:6543/postgres'],
    ['host do pooler mesmo em outra porta', 'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres'],
    ['PgBouncer sinalizado por query string', 'postgresql://u:p@host:5432/db?pgbouncer=true'],
    ['PgBouncer com 1 em vez de true', 'postgresql://u:p@host:5432/db?pgbouncer=1'],
  ])('detecta: %s', (_caso, url) => {
    expect(usesTransactionPooler(url)).toBe(true)
  })

  it.each([
    ['conexão direta do Supabase', 'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres'],
    ['Postgres do docker compose', 'postgresql://mandafy_app:senha@postgres:5432/mandafy'],
    ['localhost', 'postgresql://mandafy:mandafy@127.0.0.1:5432/mandafy'],
    ['pgbouncer explicitamente desligado', 'postgresql://u:p@host:5432/db?pgbouncer=false'],
  ])('não detecta: %s', (_caso, url) => {
    expect(usesTransactionPooler(url)).toBe(false)
  })

  it('não quebra com string inválida', () => {
    expect(usesTransactionPooler('isso não é uma URL')).toBe(false)
    expect(usesTransactionPooler('')).toBe(false)
  })
})
