import { describe, expect, it } from 'vitest'
import { classifyDbError, redactCredentials } from './db-errors'
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

  it.each([['ENETUNREACH'], ['EHOSTUNREACH'], ['EAFNOSUPPORT']])(
    'reconhece rede sem rota (%s) — a assinatura de IPv6 em ambiente IPv4',
    (code) => {
      const { reason, hint } = classifyDbError({ code })
      expect(reason).toBe('rede_inalcancavel')
      expect(hint).toContain('pooler')
    },
  )

  it('reconhece o "Tenant or user not found" do Supavisor', () => {
    const { reason, hint } = classifyDbError(new Error('Tenant or user not found'))
    expect(reason).toBe('tenant_desconhecido')
    // As duas causas reais precisam estar na dica.
    expect(hint).toContain('ref-do-projeto')
    expect(hint).toContain('aws-0')
  })

  it('reconhece falha de TLS', () => {
    expect(classifyDbError(new Error('self-signed certificate in chain')).reason).toBe(
      'tls_recusado',
    )
  })

  it('no desconhecido, entrega a mensagem do driver para fechar o diagnóstico', () => {
    const erro = Object.assign(new Error('algo bem específico aconteceu'), { code: 'XX000' })
    const { reason, code, detail } = classifyDbError(erro)
    expect(reason).toBe('erro_desconhecido')
    expect(code).toBe('XX000')
    expect(detail).toContain('algo bem específico')
  })

  /**
   * O Drizzle embrulha todo erro do driver. Sem percorrer `cause`, qualquer
   * falha de banco vira "erro desconhecido" com a mensagem inútil
   * "Failed query: SELECT 1" — foi exatamente o que aconteceu em produção.
   */
  describe('erros embrulhados pelo Drizzle', () => {
    function drizzleWrap(causa: unknown) {
      return Object.assign(new Error('Failed query: SELECT 1\nparams: '), { cause: causa })
    }

    it('enxerga a credencial recusada através do invólucro', () => {
      const erro = drizzleWrap(Object.assign(new Error('password authentication failed'), {
        code: '28P01',
      }))
      expect(classifyDbError(erro).reason).toBe('credencial_recusada')
    })

    it('enxerga o tenant desconhecido do Supavisor através do invólucro', () => {
      const erro = drizzleWrap(new Error('Tenant or user not found'))
      expect(classifyDbError(erro).reason).toBe('tenant_desconhecido')
    })

    it('enxerga rede sem rota através do invólucro', () => {
      const erro = drizzleWrap(Object.assign(new Error('connect ENETUNREACH'), {
        code: 'ENETUNREACH',
      }))
      expect(classifyDbError(erro).reason).toBe('rede_inalcancavel')
    })

    it('enxerga migration pendente através de duas camadas', () => {
      const erro = drizzleWrap(drizzleWrap(Object.assign(new Error('relation does not exist'), {
        code: '42P01',
      })))
      expect(classifyDbError(erro).reason).toBe('migrations_pendentes')
    })

    it('quando nada é reconhecido, mostra a mensagem interna e não a do invólucro', () => {
      const erro = drizzleWrap(new Error('detalhe que importa'))
      const { detail } = classifyDbError(erro)
      expect(detail).toContain('detalhe que importa')
      expect(detail).not.toContain('Failed query')
    })

    it('não entra em laço infinito com ciclo de causas', () => {
      const a: { cause?: unknown } & Error = new Error('a')
      const b: { cause?: unknown } & Error = new Error('b')
      a.cause = b
      b.cause = a
      expect(() => classifyDbError(a)).not.toThrow()
    })
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

  it('remove credenciais do detail — é ele que vai para uma página pública', () => {
    const erro = new Error(
      'falhou em postgresql://mandafy_app.abc:MinhaSenha123@aws-1-sa-east-1.pooler.supabase.com:6543/postgres',
    )
    const { detail } = classifyDbError(erro)
    expect(detail).toBeDefined()
    expect(detail).not.toContain('MinhaSenha123')
    expect(detail).not.toContain('mandafy_app.abc')
    // O host continua visível, porque é justamente o que precisa ser conferido.
    expect(detail).toContain('pooler.supabase.com')
  })
})

describe('redactCredentials', () => {
  it.each([
    [
      'postgresql://usuario:senha@host:5432/db',
      'postgresql://***@host:5432/db',
    ],
    [
      'rediss://default:token-secreto@x.upstash.io:6379',
      'rediss://***@x.upstash.io:6379',
    ],
    ['host=x password=segredo dbname=y', 'host=x password=*** dbname=y'],
  ])('redige %s', (entrada, esperado) => {
    expect(redactCredentials(entrada)).toBe(esperado)
  })

  it('deixa intacta a mensagem sem credencial', () => {
    expect(redactCredentials('connection refused')).toBe('connection refused')
  })
})
