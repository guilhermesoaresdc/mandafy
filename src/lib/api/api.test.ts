import { describe, expect, it } from 'vitest'
import {
  chaveDoHeader,
  gerarChave,
  hashChave,
  prefixoVisivel,
  PREFIXO_LIVE,
  PREFIXO_TEST,
  temEscopo,
} from './keys'
import {
  assinar,
  proximaTentativaEm,
  verificar,
  BACKOFF_SEGUNDOS,
  FALHAS_PARA_DESATIVAR,
  TOLERANCIA_SEGUNDOS,
} from './webhooks'

describe('chaves de API (§12.1)', () => {
  it('gera com o prefixo do ambiente', () => {
    expect(gerarChave('live').startsWith(PREFIXO_LIVE)).toBe(true)
    expect(gerarChave('test').startsWith(PREFIXO_TEST)).toBe(true)
  })

  it('duas chaves nunca são iguais', () => {
    const chaves = new Set(Array.from({ length: 200 }, () => gerarChave()))
    expect(chaves.size).toBe(200)
  })

  it('o hash é estável e diferente da chave', () => {
    const chave = gerarChave()
    expect(hashChave(chave)).toBe(hashChave(chave))
    expect(hashChave(chave)).not.toContain(chave)
    expect(hashChave(chave)).toHaveLength(64)
  })

  it('o prefixo visível mostra o suficiente para reconhecer, e nada mais', () => {
    const chave = `${PREFIXO_LIVE}abcdefghijklmnop`
    const visivel = prefixoVisivel(chave)

    expect(visivel).toBe(`${PREFIXO_LIVE}abcd…`)
    // Não pode conter a chave inteira — é justamente o ponto.
    expect(chave.startsWith(visivel.replace('…', ''))).toBe(true)
    expect(visivel.length).toBeLessThan(chave.length)
  })

  it('lê a chave do header Bearer', () => {
    const chave = gerarChave()
    expect(chaveDoHeader(`Bearer ${chave}`)).toBe(chave)
    expect(chaveDoHeader(`bearer ${chave}`)).toBe(chave)
  })

  it('recusa header sem Bearer ou com prefixo estranho', () => {
    expect(chaveDoHeader(null)).toBeNull()
    expect(chaveDoHeader('')).toBeNull()
    expect(chaveDoHeader('Basic abc')).toBeNull()
    expect(chaveDoHeader('Bearer sk_live_naoehnossa')).toBeNull()
  })

  it('escopo ausente é negado', () => {
    const chave = { orgId: 'o', keyId: 'k', escopos: ['messages:send'], ambiente: 'live' as const }
    expect(temEscopo(chave, 'messages:send')).toBe(true)
    expect(temEscopo(chave, 'contacts:write')).toBe(false)
  })

  it('chave sem escopo nenhum não faz nada', () => {
    const chave = { orgId: 'o', keyId: 'k', escopos: [], ambiente: 'live' as const }
    expect(temEscopo(chave, 'messages:send')).toBe(false)
  })
})

describe('assinatura dos webhooks (§12.3)', () => {
  const SEGREDO = 'whsec_teste'
  const CORPO = JSON.stringify({ event: 'message.sent', data: { id: 1 } })
  const AGORA = new Date('2026-07-30T12:00:00Z')

  it('assina no formato t=…,v1=…', () => {
    expect(assinar(CORPO, SEGREDO, AGORA)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
  })

  it('a própria assinatura é aceita na verificação', () => {
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    expect(verificar(CORPO, cabecalho, SEGREDO, AGORA)).toEqual({ ok: true })
  })

  it('corpo alterado invalida', () => {
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    expect(verificar(`${CORPO} `, cabecalho, SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: 'invalida',
    })
  })

  it('segredo errado invalida', () => {
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    expect(verificar(CORPO, cabecalho, 'outro', AGORA).ok).toBe(false)
  })

  it('assinatura velha é recusada — é a proteção contra replay', () => {
    /*
     * O timestamp entra na MENSAGEM assinada, não só num header à parte.
     * Assinar apenas o corpo deixaria a assinatura válida para sempre, e quem
     * capturasse uma entrega poderia reenviá-la meses depois.
     */
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    const depois = new Date(AGORA.getTime() + (TOLERANCIA_SEGUNDOS + 1) * 1000)

    expect(verificar(CORPO, cabecalho, SEGREDO, depois)).toEqual({ ok: false, motivo: 'expirada' })
  })

  it('dentro da tolerância continua válida', () => {
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    const quase = new Date(AGORA.getTime() + (TOLERANCIA_SEGUNDOS - 10) * 1000)

    expect(verificar(CORPO, cabecalho, SEGREDO, quase).ok).toBe(true)
  })

  it('relógio adiantado do outro lado também é tolerado', () => {
    const cabecalho = assinar(CORPO, SEGREDO, AGORA)
    const antes = new Date(AGORA.getTime() - 60_000)
    expect(verificar(CORPO, cabecalho, SEGREDO, antes).ok).toBe(true)
  })

  it('header malformado é recusado sem estourar', () => {
    for (const ruim of ['', 'lixo', 't=abc,v1=xyz', 'v1=semtimestamp', 't=123']) {
      expect(verificar(CORPO, ruim, SEGREDO, AGORA).ok).toBe(false)
    }
  })

  it('assinatura de tamanho diferente não passa', () => {
    const timestamp = Math.floor(AGORA.getTime() / 1000)
    expect(verificar(CORPO, `t=${timestamp},v1=curta`, SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: 'invalida',
    })
  })
})

describe('backoff dos webhooks (§12.3)', () => {
  it('segue 1min, 5min, 30min, 2h, 12h', () => {
    expect(BACKOFF_SEGUNDOS).toEqual([60, 300, 1800, 7200, 43_200])
  })

  it('a espera cresce a cada falha', () => {
    expect(proximaTentativaEm(0)).toBe(60)
    expect(proximaTentativaEm(1)).toBe(300)
    expect(proximaTentativaEm(3)).toBe(7200)
  })

  it('na quinta falha desiste, e o webhook é desativado', () => {
    expect(proximaTentativaEm(FALHAS_PARA_DESATIVAR)).toBeNull()
    expect(proximaTentativaEm(FALHAS_PARA_DESATIVAR + 3)).toBeNull()
  })
})
