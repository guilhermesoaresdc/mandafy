/**
 * Agendamento em cascata (§5.1).
 *
 * Quando `order.created` chega, os quatro passos são enfileirados DE UMA VEZ,
 * todos carregando a mesma `cancel_key`. Não é o passo 1 que agenda o passo 2:
 *
 *  - se fosse encadeado, cancelar exigiria alcançar um passo que ainda não
 *    existe, e o cancelamento precisaria de estado próprio;
 *  - um passo que falha levaria a cadeia inteira junto;
 *  - a barra de pulso (§11.6) não teria o que mostrar — os próximos 60 minutos
 *    só existem se já estiverem agendados.
 *
 * O preço é que um passo cancelado precisa ser cancelado explicitamente. É
 * exatamente o que `cancelarPorChave` faz, e é uma operação só.
 */

export type PassoParaAgendar = {
  id: string
  position: number
  /** Relativo ao passo ANTERIOR, não ao início do fluxo (§3.5). */
  delaySeconds: number
}

export type PassoAgendado = {
  stepId: string
  position: number
  /** Segundos desde o gatilho — a soma acumulada. */
  offsetSeconds: number
  quando: Date
}

/**
 * Converte atrasos relativos em instantes absolutos.
 *
 * O atraso de cada passo é relativo ao anterior porque é assim que se pensa uma
 * cadência ("cinco minutos depois, mais vinte, depois duas horas"). O
 * agendamento precisa do acumulado.
 */
export function planejarCascata(
  passos: readonly PassoParaAgendar[],
  gatilho: Date,
): PassoAgendado[] {
  const ordenados = [...passos].sort((a, b) => a.position - b.position)

  let acumulado = 0
  return ordenados.map((passo) => {
    acumulado += Math.max(0, passo.delaySeconds)
    return {
      stepId: passo.id,
      position: passo.position,
      offsetSeconds: acumulado,
      quando: new Date(gatilho.getTime() + acumulado * 1000),
    }
  })
}

/** "+5 min", "+2 h", "+20 h", "imediato" — os rótulos da tela do fluxo. */
export function formatarOffset(segundos: number): string {
  if (segundos <= 0) return 'imediato'
  if (segundos < 60) return `+${segundos} s`

  const minutos = Math.round(segundos / 60)
  if (minutos < 60) return `+${minutos} min`

  const horas = segundos / 3600
  if (horas < 48) {
    const arredondado = Math.round(horas * 10) / 10
    return `+${Number.isInteger(arredondado) ? arredondado : arredondado.toFixed(1)} h`
  }

  return `+${Math.round(horas / 24)} dias`
}

/** Aceita "5min", "2h", "20 h", "3 dias", "0". Para o editor de passos. */
export function lerAtraso(texto: string): number | null {
  const limpo = texto.trim().toLowerCase()
  if (limpo === '' || limpo === '0') return 0

  const match = /^(\d+(?:[.,]\d+)?)\s*(s|seg|segundos?|m|min|minutos?|h|hora?s?|d|dias?)?$/.exec(limpo)
  if (!match) return null

  const quantidade = Number((match[1] ?? '0').replace(',', '.'))
  if (!Number.isFinite(quantidade)) return null

  const unidade = match[2] ?? 'min'

  if (unidade.startsWith('s')) return Math.round(quantidade)
  if (unidade.startsWith('h')) return Math.round(quantidade * 3600)
  if (unidade.startsWith('d')) return Math.round(quantidade * 86400)
  return Math.round(quantidade * 60)
}
