import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verificação de assinatura de webhook de entrada (§4.3) e deduplicação.
 */

/**
 * `sha256(source_id + corpo)`.
 *
 * Plataformas fazem retry com frequência; se o hash já apareceu nas últimas
 * 24h, o evento é ignorado com 200 (§4.3). O `source_id` entra no hash para
 * que dois conectores diferentes com corpo idêntico não se anulem.
 */
export function dedupeHash(sourceId: string, rawBody: string): string {
  return createHash('sha256').update(`${sourceId}:${rawBody}`).digest('hex')
}

export type SignatureCheck =
  | { present: false }
  | { present: true; valid: boolean; reason?: 'formato' | 'assinatura' | 'tempo' }

/** Tolerância contra replay, em milissegundos (§12.3 usa a mesma para saída). */
const TOLERANCIA_MS = 5 * 60 * 1000

function compararEmTempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // timingSafeEqual exige mesmo comprimento; comprimentos diferentes já são
  // desiguais, e revelar isso não entrega informação útil ao atacante.
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Valida a assinatura no formato `t=<unix>,v1=<hex>` sobre `timestamp.corpo`,
 * que é a convenção mais comum (Stripe e derivados) e a que a spec adota para
 * os webhooks de saída em §12.3.
 *
 * Aceita também a forma simples — apenas o hex do HMAC sobre o corpo —, porque
 * várias plataformas de sorteio assinam assim.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | null,
  agora: number = Date.now(),
): SignatureCheck {
  if (!secret) return { present: false }
  if (!header || header.trim() === '') return { present: true, valid: false, reason: 'formato' }

  const partes = header.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.split('=')
    if (k && v) acc[k.trim().toLowerCase()] = v.trim()
    return acc
  }, {})

  const timestamp = partes.t
  const assinatura = partes.v1 ?? partes.sha256 ?? partes.signature

  /*
   * Forma simples: o HMAC é sobre o corpo apenas, sem timestamp. Vale tanto
   * para o hex puro quanto para `sha256=<hex>`, que é como várias plataformas
   * de sorteio assinam. Sem timestamp não há proteção contra replay — mas a
   * alternativa seria recusar a integração inteira, e a deduplicação de §4.3
   * já limita o estrago de um reenvio.
   */
  if (!timestamp) {
    const hex = (assinatura ?? header).trim().replace(/^sha256=/i, '')
    if (!/^[0-9a-f]{64}$/i.test(hex)) return { present: true, valid: false, reason: 'formato' }
    const esperado = createHmac('sha256', secret).update(rawBody).digest('hex')
    const valid = compararEmTempoConstante(hex.toLowerCase(), esperado)
    return valid
      ? { present: true, valid: true }
      : { present: true, valid: false, reason: 'assinatura' }
  }

  if (!assinatura) return { present: true, valid: false, reason: 'formato' }

  const emSegundos = Number(timestamp)
  if (!Number.isFinite(emSegundos)) return { present: true, valid: false, reason: 'formato' }

  if (Math.abs(agora - emSegundos * 1000) > TOLERANCIA_MS) {
    return { present: true, valid: false, reason: 'tempo' }
  }

  const esperado = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const valid = compararEmTempoConstante(assinatura.toLowerCase(), esperado)
  return valid ? { present: true, valid: true } : { present: true, valid: false, reason: 'assinatura' }
}

/** Token de ingestão: vai na URL do webhook, então precisa ser opaco e curto. */
export function generateIngestToken(): string {
  // 24 bytes em base64url dão 32 caracteres sem `+`, `/` ou `=`, seguros em URL.
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.hrtime.bigint()}`)
    .digest('base64url')
    .slice(0, 32)
}
