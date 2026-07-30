import { describe, expect, it } from 'vitest'
import { getByPath, listLeafPaths, parsePath } from './path'

/**
 * A extração roda sobre payload de webhook — dado que vem de fora e pode ser
 * qualquer coisa. Nenhum caminho pode lançar; o pior resultado aceitável é
 * `undefined`.
 */
describe('getByPath', () => {
  const payload = {
    event: 'qrcode_pago',
    data: {
      user: { id: 42, name: 'Maria', phone: '(88) 99999-9999' },
      order: { id: 'ord_1', amount: 49.9, tickets: 10 },
      items: [{ sku: 'a' }, { sku: 'b' }],
    },
    vazio: null,
  }

  it.each([
    ['$.event', 'qrcode_pago'],
    ['$.data.user.name', 'Maria'],
    ['$.data.order.amount', 49.9],
    ['$.data.items[0].sku', 'a'],
    ['$.data.items[1].sku', 'b'],
    ['$.data.items[*].sku', 'a'],
    ['data.user.id', 42],
  ])('lê %s', (caminho, esperado) => {
    expect(getByPath(payload, caminho)).toBe(esperado)
  })

  it.each([
    ['caminho inexistente', '$.data.nada'],
    ['atravessa nulo', '$.vazio.qualquer'],
    ['índice fora do array', '$.data.items[9].sku'],
    ['índice em objeto', '$.data.user[0]'],
    ['chave em array', '$.data.items.sku'],
    ['índice negativo', '$.data.items[-1]'],
    ['índice não numérico', '$.data.items[abc]'],
  ])('devolve undefined: %s', (_caso, caminho) => {
    expect(getByPath(payload, caminho)).toBeUndefined()
  })

  it('não expõe propriedade de primitivo', () => {
    // `"Maria".length` não é acesso legítimo de payload.
    expect(getByPath(payload, '$.data.user.name.length')).toBeUndefined()
  })

  it('não alcança o protótipo', () => {
    expect(getByPath(payload, '$.constructor')).toBeUndefined()
    expect(getByPath(payload, '$.__proto__.polui')).toBeUndefined()
  })

  it.each([[null], [undefined], ['texto'], [42], [[]]])(
    'não quebra com payload estranho: %s',
    (entrada) => {
      expect(() => getByPath(entrada, '$.a.b.c')).not.toThrow()
    },
  )

  it('limita a profundidade', () => {
    const fundo = '$.' + Array.from({ length: 100 }, (_, i) => `n${i}`).join('.')
    expect(getByPath(payload, fundo)).toBeUndefined()
  })
})

describe('parsePath', () => {
  it('aceita as três formas de escrever a raiz', () => {
    expect(parsePath('$.a.b')).toEqual(parsePath('a.b'))
    expect(parsePath('$a.b')).toEqual(parsePath('a.b'))
  })
})

describe('listLeafPaths', () => {
  it('lista os caminhos folha para a tela de mapeamento', () => {
    const caminhos = listLeafPaths({
      event: 'x',
      data: { user: { id: 1, name: 'a' }, itens: [{ sku: 'z' }, { sku: 'w' }] },
    })

    expect(caminhos).toContain('$.event')
    expect(caminhos).toContain('$.data.user.id')
    expect(caminhos).toContain('$.data.user.name')
    // Só o primeiro elemento do array: os demais têm a mesma forma, e listar
    // todos transformaria um payload grande numa lista inútil.
    expect(caminhos).toContain('$.data.itens[0].sku')
    expect(caminhos.filter((c) => c.includes('itens'))).toHaveLength(1)
  })

  it('os caminhos listados realmente resolvem', () => {
    const payload = { a: { b: [{ c: 'valor' }] }, n: 1, s: 'texto' }
    for (const caminho of listLeafPaths(payload)) {
      expect(getByPath(payload, caminho)).toBeDefined()
    }
  })

  it('respeita o limite e não estoura com payload gigante', () => {
    const enorme: Record<string, number> = {}
    for (let i = 0; i < 5000; i += 1) enorme[`campo${i}`] = i
    expect(listLeafPaths(enorme, 50)).toHaveLength(50)
  })
})
