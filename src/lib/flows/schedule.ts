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
  /** `'10:00'` no fuso da organização. Nulo = o instante da cascata. */
  sendAtLocal?: string | null
}

export type PassoAgendado = {
  stepId: string
  position: number
  /** Segundos desde o gatilho — a soma acumulada. */
  offsetSeconds: number
  quando: Date
}

/** `'10:00'`, `'10:30'`, `'9:5'` → minutos desde a meia-noite. `null` se não der. */
export function lerHorario(texto: string): number | null {
  const match = /^(\d{1,2})\s*[:h]\s*(\d{1,2})?$/.exec(texto.trim())
  if (!match) return null

  const hora = Number(match[1])
  const minuto = Number(match[2] ?? '0')
  if (hora > 23 || minuto > 59) return null

  return hora * 60 + minuto
}

/** Minutos desde a meia-noite → `'10:00'`, que é o formato gravado. */
export function formatarHorario(minutos: number): string {
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Que horas são, no fuso pedido, num dado instante — em minutos desde a
 * meia-noite.
 *
 * Via `Intl`, e não via aritmética de fuso: o Brasil já teve horário de verão e
 * pode voltar a ter, e somar `-3h` na mão erra por uma hora durante meses sem
 * que nada acuse. Quem sabe as regras é o banco de fusos do runtime.
 */
function minutosLocais(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instante)

  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0')
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0')
  // `hour12: false` produz 24 à meia-noite em alguns runtimes.
  return (hora % 24) * 60 + minuto
}

/**
 * Empurra o instante para a próxima ocorrência de uma hora local.
 *
 * SEMPRE PARA A FRENTE, nunca para trás. Puxar para trás faria o passo 2 sair
 * antes do passo 1 — a cascata inteira depende de a ordem se manter, e um
 * "obrigado pela aposta" chegando antes da confirmação é o tipo de defeito que
 * o cliente vê e nós não.
 *
 * Se já é exatamente a hora pedida, fica onde está: adiar 24 horas por causa de
 * um segundo de arredondamento seria pior que qualquer imprecisão.
 */
export function noHorarioLocal(instante: Date, minutosAlvo: number, fuso: string): Date {
  const agora = minutosLocais(instante, fuso)
  const faltam = (minutosAlvo - agora + 1440) % 1440

  /*
   * Os segundos e milissegundos do instante original saem fora: a pessoa pediu
   * "às 10:00", e 10:00:37 não é o que ela escreveu. O jitter (§7.2) volta a
   * espalhar isso depois, que é onde o espalhamento deve morar.
   */
  const alvo = new Date(instante.getTime() + faltam * 60_000)
  alvo.setSeconds(0, 0)
  return alvo
}

/**
 * Converte atrasos relativos em instantes absolutos.
 *
 * O atraso de cada passo é relativo ao anterior porque é assim que se pensa uma
 * cadência ("cinco minutos depois, mais vinte, depois duas horas"). O
 * agendamento precisa do acumulado.
 *
 * O horário fixo, quando existe, é aplicado DEPOIS do acumulado — "dois dias
 * depois, às 10h" —, e o acumulado do passo seguinte continua contando do
 * atraso, não do horário. Encadear a partir do horário faria mexer numa hora
 * arrastar toda a cadência abaixo dela, que não é o que "+2 dias" quer dizer.
 */
export function planejarCascata(
  passos: readonly PassoParaAgendar[],
  gatilho: Date,
  /** Fuso da organização, para os passos com horário fixo. */
  fuso = 'America/Sao_Paulo',
): PassoAgendado[] {
  const ordenados = [...passos].sort((a, b) => a.position - b.position)

  let acumulado = 0
  return ordenados.map((passo) => {
    acumulado += Math.max(0, passo.delaySeconds)
    const cru = new Date(gatilho.getTime() + acumulado * 1000)

    const alvo = passo.sendAtLocal ? lerHorario(passo.sendAtLocal) : null

    return {
      stepId: passo.id,
      position: passo.position,
      offsetSeconds: acumulado,
      quando: alvo === null ? cru : noHorarioLocal(cru, alvo, fuso),
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
