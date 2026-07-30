import { describe, expect, it } from 'vitest'
import { formatarAtraso, PERFIS_PADRAO, previaAtrasos, sortearAtraso } from './jitter'

/** Aleatoriedade controlada: devolve a sequência dada, ciclando. */
function fixo(...valores: number[]): () => number {
  let i = 0
  return () => valores[i++ % valores.length]!
}

describe('sortearAtraso (§7.2)', () => {
  it('instantâneo não atrasa — transacional crítico não pode esperar', () => {
    expect(sortearAtraso({ mode: 'instantaneo', minSeconds: 30, maxSeconds: 90 })).toBe(0)
  })

  it('fixo usa o mínimo e ignora o máximo', () => {
    expect(sortearAtraso({ mode: 'fixo', minSeconds: 15, maxSeconds: 90 })).toBe(15)
  })

  it('faixa fica dentro dos limites, inclusive nas pontas', () => {
    const perfil = { mode: 'faixa' as const, minSeconds: 8, maxSeconds: 25 }
    expect(sortearAtraso(perfil, fixo(0))).toBe(8)
    expect(sortearAtraso(perfil, fixo(0.9999))).toBe(25)
  })

  it('faixa nunca escapa dos limites em mil sorteios', () => {
    const perfil = { mode: 'faixa' as const, minSeconds: 8, maxSeconds: 25 }
    for (let i = 0; i < 1000; i += 1) {
      const valor = sortearAtraso(perfil)
      expect(valor).toBeGreaterThanOrEqual(8)
      expect(valor).toBeLessThanOrEqual(25)
    }
  })

  it('humano também respeita os limites', () => {
    const perfil = { mode: 'humano' as const, minSeconds: 8, maxSeconds: 25 }
    for (let i = 0; i < 1000; i += 1) {
      const valor = sortearAtraso(perfil)
      expect(valor).toBeGreaterThanOrEqual(8)
      expect(valor).toBeLessThanOrEqual(25)
    }
  })

  it('humano concentra no meio — é o que o diferencia de faixa', () => {
    // Uma distribuição uniforme também é um padrão detectável; a curva em sino
    // é o ponto do modo humano.
    const perfil = { mode: 'humano' as const, minSeconds: 0, maxSeconds: 100 }
    const amostra = Array.from({ length: 5000 }, () => sortearAtraso(perfil))
    const noMeio = amostra.filter((v) => v >= 33 && v <= 67).length / amostra.length

    // Uniforme daria ~35%; a média de três uniformes fica bem acima disso.
    expect(noMeio).toBeGreaterThan(0.6)
  })

  it('faixa invertida (min > max) não quebra', () => {
    const valor = sortearAtraso({ mode: 'faixa', minSeconds: 90, maxSeconds: 30 })
    expect(valor).toBeGreaterThanOrEqual(30)
    expect(valor).toBeLessThanOrEqual(90)
  })

  it('faixa de um valor só devolve sempre esse valor', () => {
    expect(sortearAtraso({ mode: 'faixa', minSeconds: 12, maxSeconds: 12 })).toBe(12)
    expect(sortearAtraso({ mode: 'humano', minSeconds: 12, maxSeconds: 12 })).toBe(12)
  })

  it('segundos negativos viram zero', () => {
    expect(sortearAtraso({ mode: 'fixo', minSeconds: -5, maxSeconds: 0 })).toBe(0)
  })
})

describe('prévia do mixer (§7.2)', () => {
  it('devolve a quantidade pedida', () => {
    expect(previaAtrasos({ mode: 'humano', minSeconds: 8, maxSeconds: 25 })).toHaveLength(10)
  })

  it('mostra na hora que uma faixa apertada não protege nada', () => {
    const previa = previaAtrasos({ mode: 'faixa', minSeconds: 0, maxSeconds: 2 }, 10)
    expect(previa.every((v) => v <= 2)).toBe(true)
  })
})

describe('formatarAtraso', () => {
  it('zero é imediato', () => {
    expect(formatarAtraso(0)).toBe('imediato')
  })

  it('abaixo de um minuto sai em segundos', () => {
    expect(formatarAtraso(42)).toBe('42s')
  })

  it('minuto cheio não mostra segundos', () => {
    expect(formatarAtraso(120)).toBe('2min')
  })

  it('minuto quebrado mostra os dois', () => {
    expect(formatarAtraso(90)).toBe('1min 30s')
  })
})

describe('perfis do seed (§7.2)', () => {
  it('traz os quatro da spec', () => {
    expect(PERFIS_PADRAO.map((p) => p.name)).toEqual([
      'Instantâneo',
      'Seguro',
      'Conservador',
      'Disparo em massa',
    ])
  })

  it('Seguro é a faixa 8–25s que a spec recomenda para WhatsApp', () => {
    const seguro = PERFIS_PADRAO.find((p) => p.name === 'Seguro')
    expect([seguro?.minSeconds, seguro?.maxSeconds]).toEqual([8, 25])
  })
})
