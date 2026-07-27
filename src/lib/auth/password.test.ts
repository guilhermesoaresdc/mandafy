import { describe, expect, it } from 'vitest'
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password'

describe('hashPassword', () => {
  it('gera hashes diferentes para a mesma senha (salt aleatório)', async () => {
    const a = await hashPassword('senha-bem-comprida')
    const b = await hashPassword('senha-bem-comprida')
    expect(a).not.toBe(b)
  })

  it('grava os parâmetros junto do hash, para permitir endurecer no futuro', async () => {
    const hash = await hashPassword('senha-bem-comprida')
    expect(hash.split('$')).toHaveLength(6)
    expect(hash.startsWith('scrypt$')).toBe(true)
  })

  it('recusa senha curta demais', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow()
  })

  it('nunca guarda a senha em claro', async () => {
    const hash = await hashPassword('minha-senha-secreta')
    expect(hash).not.toContain('minha-senha-secreta')
  })
})

describe('verifyPassword', () => {
  it('aceita a senha correta', async () => {
    const hash = await hashPassword('senha-bem-comprida')
    expect(await verifyPassword('senha-bem-comprida', hash)).toBe(true)
  })

  it('recusa a senha errada', async () => {
    const hash = await hashPassword('senha-bem-comprida')
    expect(await verifyPassword('senha-bem-compridA', hash)).toBe(false)
  })

  it('normaliza unicode: a mesma senha digitada de outra forma ainda entra', async () => {
    // 'á' composto (a + acento) vs. pré-composto — teclados diferentes produzem
    // sequências diferentes para o mesmo caractere.
    const composto = 'senha-ágil-longa'
    const precomposto = 'senha-ágil-longa'
    const hash = await hashPassword(composto)
    expect(await verifyPassword(precomposto, hash)).toBe(true)
  })

  it.each([
    ['vazio', ''],
    ['sem separadores', 'naoehumhash'],
    ['esquema desconhecido', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA=='],
    ['partes faltando', 'scrypt$16384$8$1'],
    ['salt e hash vazios', 'scrypt$16384$8$1$$'],
    ['N absurdo, tentativa de exaurir memória', 'scrypt$999999999$8$1$c2FsdA==$aGFzaA=='],
  ])('retorna false sem lançar para hash inválido: %s', async (_caso, stored) => {
    await expect(verifyPassword('qualquer-senha', stored)).resolves.toBe(false)
  })
})

describe('generatePassword', () => {
  it('gera senha do tamanho pedido e sem caracteres ambíguos', () => {
    const senha = generatePassword(32)
    expect(senha).toHaveLength(32)
    expect(senha).not.toMatch(/[0O1lI]/)
  })

  it('não repete entre chamadas', () => {
    expect(generatePassword()).not.toBe(generatePassword())
  })
})
