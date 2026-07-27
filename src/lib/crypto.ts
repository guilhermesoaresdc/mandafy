import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { serverEnv } from '@/env'

/**
 * Criptografia das credenciais de provedor em repouso (§14.1).
 *
 * AES-256-GCM: cifra e autentica ao mesmo tempo. A tag de autenticação é
 * verificada na decifragem, então um valor adulterado no banco falha em vez de
 * devolver lixo silenciosamente.
 *
 * Layout do payload: iv(12) || tag(16) || ciphertext
 * A chave vem de ENCRYPTION_KEY (32 bytes em hex) e nunca é gravada no banco.
 */

const IV_LENGTH = 12 // recomendado para GCM
const TAG_LENGTH = 16

function key(): Buffer {
  const raw = Buffer.from(serverEnv().ENCRYPTION_KEY, 'hex')
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY precisa ter exatamente 32 bytes (64 caracteres hex).')
  }
  return raw
}

export function encryptSecret(plaintext: string): Buffer {
  // IV novo a cada chamada: reusar IV em GCM quebra a cifra por completo.
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decryptSecret(payload: Buffer): string {
  if (payload.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Credencial cifrada inválida: payload curto demais.')
  }

  const iv = payload.subarray(0, IV_LENGTH)
  const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  // `final()` lança se a tag não conferir — é a verificação de integridade.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
