import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Junta classes resolvendo conflitos do Tailwind (a última vence). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Centavos → 'R$ 1.234,56'. Valores monetários são sempre inteiros em centavos. */
export function formatBRL(cents: number): string {
  return BRL.format(cents / 100)
}

const INTEIRO = new Intl.NumberFormat('pt-BR')

export function formatNumber(value: number): string {
  return INTEIRO.format(value)
}

/** 0.942 → '94,2%' */
export function formatPercent(ratio: number, decimals = 1): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(ratio)
}

/**
 * E.164 → formato brasileiro legível: +5588999999999 → '+55 (88) 99999-9999'.
 * Números fora do padrão brasileiro voltam como vieram.
 */
export function formatarTelefone(e164: string): string {
  const match = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  if (!match) return e164
  const [, ddd, prefixo, sufixo] = match
  return `+55 (${ddd}) ${prefixo}-${sufixo}`
}

const HORA = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'America/Sao_Paulo',
})

/** Horário no formato do log de §10.1: '14:32:07'. */
export function formatarHora(date: Date): string {
  return HORA.format(date)
}
