/**
 * Normalização de telefone para E.164 (§3.3).
 *
 * O contato é único por `(org_id, phone_e164)`. Se a mesma pessoa entrar como
 * `88 99999-9999`, `+5588999999999` e `5588999999999`, viram três contatos —
 * e a pessoa recebe a mesma mensagem três vezes. Normalizar na entrada é o que
 * impede isso.
 *
 * Regras brasileiras que importam:
 *  - DDI 55, DDD de 2 dígitos, número de 8 (fixo) ou 9 (celular) dígitos.
 *  - Celular ganhou o nono dígito: um número de 8 dígitos começando em 6–9 é
 *    celular antigo e recebe o `9` na frente. Fixo começa em 2–5 e não muda.
 */

const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
])

export type PhoneNormalizationResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'vazio' | 'curto' | 'longo' | 'ddd_invalido' | 'formato' }

/**
 * Normaliza para `+55DDNNNNNNNNN`.
 *
 * Números que já vêm com `+` e DDI diferente de 55 são preservados como estão,
 * apenas limpos: o sistema pode receber contato estrangeiro, e inventar um
 * DDD brasileiro para ele seria pior que aceitá-lo como veio.
 */
export function normalizePhoneBR(input: string | null | undefined): PhoneNormalizationResult {
  if (!input) return { ok: false, reason: 'vazio' }

  const tinhaMais = input.trim().startsWith('+')
  let digitos = input.replace(/\D/g, '')

  if (digitos === '') return { ok: false, reason: 'vazio' }

  // Internacional que não é Brasil: aceita como veio.
  if (tinhaMais && !digitos.startsWith('55')) {
    if (digitos.length < 8) return { ok: false, reason: 'curto' }
    if (digitos.length > 15) return { ok: false, reason: 'longo' }
    return { ok: true, e164: `+${digitos}` }
  }

  // Remove o DDI quando presente. Cuidado: um número de 13 dígitos começando
  // em 55 é DDI + DDD + 9 dígitos; um de 11 começando em 55 é o DDD 55 (RS).
  if (digitos.startsWith('55') && (digitos.length === 12 || digitos.length === 13)) {
    digitos = digitos.slice(2)
  }

  // Remove o zero de operadora em ligação interurbana (0 88 9...).
  if (digitos.length === 11 && digitos.startsWith('0')) digitos = digitos.slice(1)
  if (digitos.length === 12 && digitos.startsWith('0')) digitos = digitos.slice(1)

  if (digitos.length < 10) return { ok: false, reason: 'curto' }
  if (digitos.length > 11) return { ok: false, reason: 'longo' }

  const ddd = Number(digitos.slice(0, 2))
  if (!DDDS_VALIDOS.has(ddd)) return { ok: false, reason: 'ddd_invalido' }

  let numero = digitos.slice(2)

  // Celular antigo de 8 dígitos: acrescenta o nono. Fixo (2–5) não muda.
  if (numero.length === 8) {
    const primeiro = numero[0]!
    if (primeiro >= '6' && primeiro <= '9') numero = `9${numero}`
  }

  if (numero.length !== 8 && numero.length !== 9) return { ok: false, reason: 'formato' }

  return { ok: true, e164: `+55${String(ddd).padStart(2, '0')}${numero}` }
}

/** Conveniência: devolve o E.164 ou `null`. */
export function toE164(input: string | null | undefined): string | null {
  const resultado = normalizePhoneBR(input)
  return resultado.ok ? resultado.e164 : null
}

/**
 * Formato de leitura: `(11) 98888-7777`. É o que o filtro `|telefone` (§6.3)
 * coloca no corpo da mensagem — ninguém lê `+5511988887777` com naturalidade.
 *
 * Guarda-se sempre E.164; esta função é só apresentação. Número estrangeiro ou
 * que não normaliza volta como veio, sem inventar máscara brasileira.
 */
export function formatPhoneBR(input: string | null | undefined): string | null {
  const e164 = toE164(input)
  if (!e164) return null

  const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  if (!match) return e164

  return `(${match[1]}) ${match[2]}-${match[3]}`
}

/** Um E.164 brasileiro de celular tem 9 dígitos após o DDD. */
export function isMobileBR(e164: string): boolean {
  const match = /^\+55(\d{2})(\d{8,9})$/.exec(e164)
  if (!match) return false
  return (match[2] ?? '').length === 9
}
