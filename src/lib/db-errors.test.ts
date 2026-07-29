import { describe, expect, it } from 'vitest'
import { classifyDbError } from './db-errors'
import { ConfigError } from '@/env'

/**
 * A classificação existe para que quem está configurando o sistema descubra a
 * causa em uma leitura. Cada código aqui corresponde a um erro real que já
 * aconteceu — ou que acontece de forma previsível — ao subir num provedor novo.
 */
describe('classifyDbError', () => {
  it('reconhece ambiente incompleto', () => {
    const erro = new ConfigError('faltou tudo', ['DATABASE_URL', 'REDIS_URL'])
    expect(classifyDbError(erro).reason).toBe('configuracao_ausente')
  })

  it('reconhece tabela inexistente como migration pendente', () => {
    // 42P01 é o que o Postgres devolve quando o schema nunca foi aplicado —
    // o erro mais comum em ambiente recém-criado.
    expect(classifyDbError({ code: '42P01' }).reason).toBe('migrations_pendentes')
  })

  it.each([['28P01'], ['28000']])('reconhece credencial recusada (%s)', (code) => {
    const { reason, hint } = classifyDbError({ code })
    expect(reason).toBe('credencial_recusada')
    // A dica precisa lembrar do escape, que é a causa real na maioria das vezes.
    expect(hint).toContain('%23')
  })

  it.each([['ENOTFOUND'], ['EAI_AGAIN']])('reconhece host inexistente (%s)', (code) => {
    expect(classifyDbError({ code }).reason).toBe('host_nao_resolve')
  })

  it.each([['ETIMEDOUT'], ['ECONNREFUSED']])('reconhece ausência de resposta (%s)', (code) => {
    expect(classifyDbError({ code }).reason).toBe('sem_resposta')
  })

  it('reconhece timeout pela mensagem quando não há código', () => {
    expect(classifyDbError(new Error('Connection timed out')).reason).toBe('sem_resposta')
  })

  it('cai no desconhecido sem quebrar, e aponta para o healthcheck', () => {
    const { reason, hint } = classifyDbError(new Error('algo inesperado'))
    expect(reason).toBe('erro_desconhecido')
    expect(hint).toContain('/api/health')
  })

  it.each([[null], [undefined], ['texto solto'], [42]])(
    'não quebra com entrada estranha: %s',
    (entrada) => {
      expect(() => classifyDbError(entrada)).not.toThrow()
    },
  )

  it('nunca vaza detalhe de conexão na dica', () => {
    const erro = Object.assign(
      new Error('connect ETIMEDOUT postgresql://mandafy_app:senha@host:6543/postgres'),
      { code: 'ETIMEDOUT' },
    )
    const { hint } = classifyDbError(erro)
    expect(hint).not.toContain('senha')
    expect(hint).not.toContain('mandafy_app')
  })
})
