import { describe, expect, it } from 'vitest'
import { applyTransform, reaisParaCentavos } from './transforms'

/**
 * Valor monetário é onde um erro custa dinheiro de verdade: o número aparece
 * no recibo que o cliente recebe.
 */
describe('reaisParaCentavos', () => {
  it.each([
    ['número simples', 49.9, 4990],
    ['número inteiro', 100, 10000],
    ['zero', 0, 0],
    ['centavos exatos', 0.01, 1],
    ['string com ponto', '49.90', 4990],
    ['string com vírgula', '49,90', 4990],
    ['com símbolo de moeda', 'R$ 49,90', 4990],
    ['com milhar e vírgula', 'R$ 1.234,56', 123456],
    ['com milhar sem decimal', '1.234.567', 123456700],
    ['negativo', -10.5, -1050],
  ])('%s: %s → %s centavos', (_caso, entrada, esperado) => {
    expect(reaisParaCentavos(entrada)).toBe(esperado)
  })

  /**
   * `49.9 * 100` em IEEE 754 dá 4989.999999999999. Sem arredondamento o
   * cliente veria R$ 49,89 num pedido de R$ 49,90 — e a diferença aparece no
   * total do dia.
   */
  it.each([[49.9], [19.99], [0.29], [1.005], [8.35], [1234.56]])(
    'não perde centavo por ponto flutuante: %s',
    (valor) => {
      expect(reaisParaCentavos(valor)).toBe(Math.round(valor * 100))
      expect(Number.isInteger(reaisParaCentavos(valor))).toBe(true)
    },
  )

  it.each([[null], [undefined], [''], ['abc'], [{}], [[]], [Infinity], [NaN]])(
    'devolve undefined para entrada inválida: %s',
    (entrada) => {
      expect(reaisParaCentavos(entrada)).toBeUndefined()
    },
  )
})

describe('applyTransform', () => {
  it.each([
    ['inteiro', '10', 10],
    ['inteiro', 10.7, 10],
    ['decimal', '10,5', 10.5],
    ['texto', 42, '42'],
    ['minusculo', 'MARIA', 'maria'],
    ['maiusculo', 'maria', 'MARIA'],
    ['apenas_digitos', '(88) 99999-9999', '88999999999'],
    ['apenas_digitos', '123.456.789-00', '12345678900'],
  ] as const)('%s: %s → %s', (transform, entrada, esperado) => {
    expect(applyTransform(entrada, transform)).toBe(esperado)
  })

  it.each([
    ['true', true],
    ['1', true],
    ['sim', true],
    ['pago', true],
    ['paid', true],
    ['false', false],
    ['0', false],
    ['nao', false],
    ['não', false],
  ] as const)('booleano reconhece %s', (entrada, esperado) => {
    expect(applyTransform(entrada, 'booleano')).toBe(esperado)
  })

  it('data_iso aceita ISO, timestamp em segundos e em milissegundos', () => {
    expect(applyTransform('2026-07-29T10:00:00Z', 'data_iso')).toBe('2026-07-29T10:00:00.000Z')
    // Segundos e milissegundos precisam dar o mesmo instante.
    const segundos = 1785060000
    expect(applyTransform(segundos, 'data_iso')).toBe(
      applyTransform(segundos * 1000, 'data_iso'),
    )
  })

  it('data_iso recusa data impossível em vez de inventar uma', () => {
    expect(applyTransform('não é data', 'data_iso')).toBeUndefined()
    expect(applyTransform('2026-13-45', 'data_iso')).toBeUndefined()
  })

  it.each([[null], [undefined]])('valor ausente resulta em undefined: %s', (entrada) => {
    expect(applyTransform(entrada, 'texto')).toBeUndefined()
    expect(applyTransform(entrada, 'inteiro')).toBeUndefined()
  })

  it('não converte objeto para texto — "[object Object]" nunca deve chegar ao cliente', () => {
    expect(applyTransform({ a: 1 }, 'texto')).toBeUndefined()
    expect(applyTransform([1, 2], 'texto')).toBeUndefined()
  })
})
