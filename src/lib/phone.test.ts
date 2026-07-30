import { describe, expect, it } from 'vitest'
import { isMobileBR, normalizePhoneBR, toE164 } from './phone'

/**
 * O contato é único por (org_id, phone_e164). Se a mesma pessoa entrar em três
 * formatos diferentes, viram três contatos — e ela recebe a mesma mensagem
 * três vezes. Este arquivo é o que impede isso.
 */
describe('normalizePhoneBR', () => {
  it.each([
    ['já em E.164', '+5588999999999'],
    ['sem o mais', '5588999999999'],
    ['sem DDI', '88999999999'],
    ['com máscara', '(88) 99999-9999'],
    ['com espaços e traço', '88 99999 9999'],
    ['com zero de operadora', '088999999999'],
    ['com DDI e máscara', '+55 (88) 99999-9999'],
  ])('%s → +5588999999999', (_caso, entrada) => {
    expect(toE164(entrada)).toBe('+5588999999999')
  })

  it('acrescenta o nono dígito a celular antigo de 8 dígitos', () => {
    // 9 no começo do número indica celular; ganhou o nono dígito.
    expect(toE164('8899999999')).toBe('+5588999999999')
    expect(toE164('11 98765-4321')).toBe('+5511987654321')
  })

  it('NÃO acrescenta nono dígito a telefone fixo', () => {
    // Fixo começa em 2–5 e continua com 8 dígitos.
    expect(toE164('11 3333-4444')).toBe('+551133334444')
    expect(toE164('(21) 2222-3333')).toBe('+552122223333')
  })

  it('DDD 55 não é confundido com o DDI 55', () => {
    // 55 99999-9999 é Santa Maria (RS), não um número com DDI duplicado.
    expect(toE164('55999999999')).toBe('+5555999999999')
  })

  it.each([
    ['vazio', '', 'vazio'],
    ['nulo', null, 'vazio'],
    ['só texto', 'liga pra mim', 'vazio'],
    ['curto demais', '99999', 'curto'],
    ['longo demais', '5588999999999999', 'longo'],
    ['DDD inexistente', '10999999999', 'ddd_invalido'],
    ['DDD 00', '00999999999', 'ddd_invalido'],
  ])('recusa %s', (_caso, entrada, motivo) => {
    const r = normalizePhoneBR(entrada)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe(motivo)
  })

  it('preserva número internacional que não é do Brasil', () => {
    // Inventar DDD brasileiro para um estrangeiro seria pior que aceitá-lo.
    expect(toE164('+1 415 555 2671')).toBe('+14155552671')
    expect(toE164('+351 912 345 678')).toBe('+351912345678')
  })

  it('é idempotente: normalizar duas vezes dá o mesmo', () => {
    const uma = toE164('(88) 9 9999-9999')
    expect(uma).toBeTruthy()
    expect(toE164(uma)).toBe(uma)
  })

  it('formatos diferentes da MESMA pessoa colapsam num só contato', () => {
    const formas = [
      '+5588999999999',
      '5588999999999',
      '88999999999',
      '(88) 99999-9999',
      '88 9 9999-9999',
      '088999999999',
    ]
    const normalizados = new Set(formas.map(toE164))
    expect(normalizados.size).toBe(1)
  })
})

describe('isMobileBR', () => {
  it('distingue celular de fixo', () => {
    expect(isMobileBR('+5588999999999')).toBe(true)
    expect(isMobileBR('+551133334444')).toBe(false)
  })

  it('número não brasileiro não é classificado', () => {
    expect(isMobileBR('+14155552671')).toBe(false)
  })
})
