import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Hash de senha com scrypt do `node:crypto`.
 *
 * Por que scrypt e não argon2/bcrypt: é memória-dura, recomendado pela OWASP e
 * vem no Node — sem dependência nativa para compilar. Isso mantém a imagem
 * Docker Alpine simples e o deploy em serverless viável, que era a exigência.
 *
 * Formato armazenado: scrypt$N$r$p$salt-base64$hash-base64
 * Guardar os parâmetros junto permite endurecê-los no futuro sem invalidar as
 * senhas já cadastradas.
 */

// `promisify` escolhe a sobrecarga de 3 argumentos do scrypt; precisamos da de
// 4, que aceita os parâmetros de custo. O tipo explícito também dispensa
// converter o retorno para Buffer em cada chamada.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

const N = 2 ** 16 // custo de CPU/memória
const r = 8 // tamanho do bloco
const p = 1 // paralelismo
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/** scrypt precisa de 128 * N * r bytes; a folga evita erro de maxmem. */
const MAX_MEM = 128 * N * r * 2

export { MIN_PASSWORD_LENGTH } from './regras'
import { MIN_PASSWORD_LENGTH } from './regras'

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`)
  }

  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  })

  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$')
}

/**
 * Verifica a senha em tempo constante.
 * Retorna `false` para qualquer formato inválido em vez de lançar: um hash
 * corrompido no banco não deve derrubar a rota de login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6) return false

  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts
  if (scheme !== 'scrypt') return false

  const parsedN = Number(rawN)
  const parsedR = Number(rawR)
  const parsedP = Number(rawP)
  if (!Number.isInteger(parsedN) || !Number.isInteger(parsedR) || !Number.isInteger(parsedP)) {
    return false
  }
  // Impede que um hash adulterado no banco force uma alocação absurda.
  if (parsedN < 2 || parsedN > 2 ** 20 || parsedR < 1 || parsedR > 32 || parsedP < 1 || parsedP > 16) {
    return false
  }

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(rawSalt ?? '', 'base64')
    expected = Buffer.from(rawHash ?? '', 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: parsedN,
      r: parsedR,
      p: parsedP,
      maxmem: 128 * parsedN * parsedR * 2,
    })

    // timingSafeEqual exige comprimentos iguais; derivamos exatamente o
    // tamanho esperado justamente para poder usá-lo.
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

/** Senha aleatória legível, usada pelo seed quando nenhuma é informada. */
export function generatePassword(length = 20): string {
  // Sem caracteres ambíguos (0/O, 1/l/I) — a senha é lida do console.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length]
  }
  return out
}
