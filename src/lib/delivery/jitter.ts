import type { JitterMode } from '@/db/schema/enums'

/**
 * Perfis de randomização (§7.2).
 *
 * O atraso não é enfeite: mensagens saindo em intervalo constante são o padrão
 * mais fácil de detectar, e detecção significa número banido. O modo `humano`
 * existe justamente porque uma distribuição UNIFORME também é um padrão
 * estatístico — só que menos óbvio.
 *
 * Aplicável em três níveis (global → fluxo → passo); o mais específico vence.
 */

export type PerfilJitter = {
  mode: JitterMode
  minSeconds: number
  maxSeconds: number
}

/** Fonte de aleatoriedade injetável — é o que torna o sorteio testável. */
export type Aleatorio = () => number

/**
 * Sorteia o atraso, em segundos.
 *
 * `instantaneo` devolve 0: transacional crítico (pagamento aprovado) não pode
 * esperar, e um atraso ali é pior que o risco que ele evita.
 */
export function sortearAtraso(perfil: PerfilJitter, aleatorio: Aleatorio = Math.random): number {
  const min = Math.max(0, Math.min(perfil.minSeconds, perfil.maxSeconds))
  const max = Math.max(0, Math.max(perfil.minSeconds, perfil.maxSeconds))

  switch (perfil.mode) {
    case 'instantaneo':
      return 0

    case 'fixo':
      // No modo fixo o valor é o mínimo; o máximo é ignorado de propósito, para
      // que trocar de faixa para fixo não mude o comportamento sem aviso.
      return min

    case 'faixa':
      return min === max ? min : min + Math.floor(aleatorio() * (max - min + 1))

    case 'humano':
      return humano(min, max, aleatorio)
  }
}

/**
 * Distribuição enviesada para o meio da faixa (§7.2).
 *
 * Média de três sorteios uniformes — soma de uniformes converge para uma curva
 * em sino (Irwin–Hall). Três é o suficiente: concentra no meio sem nunca sair
 * dos extremos, e continua barato de calcular a cada envio.
 */
function humano(min: number, max: number, aleatorio: Aleatorio): number {
  if (min === max) return min

  const media = (aleatorio() + aleatorio() + aleatorio()) / 3
  return min + Math.round(media * (max - min))
}

/**
 * Prévia de §7.2: "os próximos 10 envios sairiam em: 12s, 19s, 8s, 24s, 15s…".
 *
 * É o que dá a sensação de estar mexendo num mixer em vez de preencher um
 * formulário — e, mais importante, mostra na hora que uma faixa de 0 a 2
 * segundos não protege nada.
 */
export function previaAtrasos(
  perfil: PerfilJitter,
  quantidade = 10,
  aleatorio: Aleatorio = Math.random,
): number[] {
  return Array.from({ length: quantidade }, () => sortearAtraso(perfil, aleatorio))
}

/** "12s", "1min 30s", "2min" — o rótulo que aparece na prévia. */
export function formatarAtraso(segundos: number): string {
  if (segundos <= 0) return 'imediato'
  if (segundos < 60) return `${segundos}s`

  const minutos = Math.floor(segundos / 60)
  const resto = segundos % 60
  return resto === 0 ? `${minutos}min` : `${minutos}min ${resto}s`
}

/** Os quatro perfis que o seed cria (§7.2). */
export const PERFIS_PADRAO = [
  { name: 'Instantâneo', mode: 'instantaneo', minSeconds: 0, maxSeconds: 0 },
  { name: 'Seguro', mode: 'humano', minSeconds: 8, maxSeconds: 25 },
  { name: 'Conservador', mode: 'humano', minSeconds: 30, maxSeconds: 90 },
  { name: 'Disparo em massa', mode: 'humano', minSeconds: 45, maxSeconds: 180 },
] as const satisfies readonly (PerfilJitter & { name: string })[]
