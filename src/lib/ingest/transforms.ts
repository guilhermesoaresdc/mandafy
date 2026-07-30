/**
 * Transformações aplicáveis a um campo mapeado (§4.2).
 *
 * Cada plataforma manda valor em formato próprio: reais com vírgula, centavos,
 * timestamp Unix, telefone sem código de país. O mapeamento declara a
 * transformação e nenhum código por plataforma é escrito.
 */

export const TRANSFORMS = [
  'reais_para_centavos',
  'centavos',
  'texto',
  'inteiro',
  'decimal',
  'booleano',
  'data_iso',
  'timestamp_unix',
  'minusculo',
  'maiusculo',
  'apenas_digitos',
] as const

export type TransformName = (typeof TRANSFORMS)[number]

export function isTransformName(value: string): value is TransformName {
  return (TRANSFORMS as readonly string[]).includes(value)
}

/**
 * Converte um valor monetário para centavos inteiros.
 *
 * Aceita as formas que aparecem na prática: `49.9`, `"49,90"`, `"R$ 1.234,56"`.
 * A distinção entre separador de milhar e decimal segue a convenção brasileira
 * quando há vírgula; sem vírgula, o ponto é decimal.
 *
 * Usa arredondamento sobre string em vez de aritmética de ponto flutuante:
 * `49.9 * 100` dá 4989.999... em IEEE 754, e um centavo perdido por pedido é
 * dinheiro errado no recibo do cliente.
 */
export function reaisParaCentavos(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Math.round(value * 100)
  }

  if (typeof value !== 'string') return undefined

  const bruto = value.replace(/[^\d.,-]/g, '').trim()
  if (bruto === '' || bruto === '-') return undefined

  let normalizado: string
  if (bruto.includes(',')) {
    // Vírgula é o decimal: pontos são separadores de milhar.
    normalizado = bruto.replace(/\./g, '').replace(',', '.')
  } else {
    // Sem vírgula: um único ponto é decimal; vários são milhar (1.234.567).
    const pontos = (bruto.match(/\./g) ?? []).length
    normalizado = pontos > 1 ? bruto.replace(/\./g, '') : bruto
  }

  const n = Number(normalizado)
  if (!Number.isFinite(n)) return undefined
  return Math.round(n * 100)
}

function paraInteiro(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return undefined
  const n = Number(value.replace(/[^\d.,-]/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

function paraBooleano(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (['true', '1', 'sim', 'yes', 'y', 's', 'pago', 'paid'].includes(v)) return true
  if (['false', '0', 'nao', 'não', 'no', 'n'].includes(v)) return false
  return undefined
}

function paraDataIso(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString()

  if (typeof value === 'number') {
    // Segundos ou milissegundos: acima de 10^11 já é milissegundo.
    const ms = value > 1e11 ? value : value * 1000
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }

  if (typeof value !== 'string') return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** Aplica a transformação. Valor incompatível resulta em `undefined`. */
export function applyTransform(value: unknown, transform: TransformName): unknown {
  if (value === null || value === undefined) return undefined

  switch (transform) {
    case 'reais_para_centavos':
      return reaisParaCentavos(value)
    case 'centavos':
    case 'inteiro':
      return paraInteiro(value)
    case 'decimal': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
      return Number.isFinite(n) ? n : undefined
    }
    case 'texto':
      return typeof value === 'object' ? undefined : String(value)
    case 'booleano':
      return paraBooleano(value)
    case 'data_iso':
      return paraDataIso(value)
    case 'timestamp_unix': {
      const iso = paraDataIso(value)
      return iso ? Math.floor(new Date(iso).getTime() / 1000) : undefined
    }
    case 'minusculo':
      return typeof value === 'object' ? undefined : String(value).toLowerCase()
    case 'maiusculo':
      return typeof value === 'object' ? undefined : String(value).toUpperCase()
    case 'apenas_digitos':
      return typeof value === 'object' ? undefined : String(value).replace(/\D/g, '')
  }
}

/** Rótulos em português para a tela de mapeamento (§11.7). */
export const TRANSFORM_LABELS: Record<TransformName, string> = {
  reais_para_centavos: 'Reais → centavos',
  centavos: 'Já está em centavos',
  texto: 'Texto',
  inteiro: 'Número inteiro',
  decimal: 'Número decimal',
  booleano: 'Sim ou não',
  data_iso: 'Data',
  timestamp_unix: 'Data → segundos',
  minusculo: 'Minúsculas',
  maiusculo: 'MAIÚSCULAS',
  apenas_digitos: 'Só os dígitos',
}
