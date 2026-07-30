/**
 * Janela de silêncio (§7.4).
 *
 * Padrão 21h–08h no fuso do contato. A regra que importa: mensagem que cairia
 * na janela é **reagendada**, não descartada — e reagendada para a abertura
 * MAIS o jitter, não para 08:00:00 cravado. Sem o jitter, tudo o que a noite
 * acumulou sairia no mesmo segundo, e um pico de centenas de mensagens às oito
 * da manhã é exatamente o padrão que queima número.
 */

export type JanelaSilencio = {
  /** "21:00" */
  inicio: string
  /** "08:00" */
  fim: string
  /** IANA, ex. America/Sao_Paulo. */
  fuso: string
}

export const JANELA_PADRAO: JanelaSilencio = {
  inicio: '21:00',
  fim: '08:00',
  fuso: 'America/Sao_Paulo',
}

function minutosDe(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return null

  const hora = Number(match[1])
  const minuto = Number(match[2])
  if (hora > 23 || minuto > 59) return null

  return hora * 60 + minuto
}

/**
 * Que horas são, no fuso da janela, no instante dado.
 *
 * Usa `Intl` em vez de aritmética com o deslocamento: horário de verão muda o
 * deslocamento, e somar `-3` fixo erraria por uma hora nos períodos em que ele
 * estivesse valendo.
 */
function relogioLocal(instante: Date, fuso: string): { minutos: number; ano: number; mes: number; dia: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instante)

  const pegar = (tipo: Intl.DateTimeFormatPartTypes): number =>
    Number(partes.find((p) => p.type === tipo)?.value ?? '0')

  // `hour12: false` produz 24 para a meia-noite em alguns ambientes.
  const hora = pegar('hour') % 24

  return {
    minutos: hora * 60 + pegar('minute'),
    ano: pegar('year'),
    mes: pegar('month'),
    dia: pegar('day'),
  }
}

/** O instante em que o relógio local marca `minutos` no dia informado. */
function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  minutos: number,
  fuso: string,
): Date {
  const hora = Math.floor(minutos / 60)
  const minuto = minutos % 60

  // Chuta em UTC e corrige pela diferença que o próprio fuso reporta. Uma
  // passada basta fora das transições de horário de verão; a segunda cobre
  // o dia em que o deslocamento muda.
  let palpite = Date.UTC(ano, mes - 1, dia, hora, minuto)
  for (let i = 0; i < 2; i += 1) {
    const local = relogioLocal(new Date(palpite), fuso)
    const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto)
    const obtido = Date.UTC(local.ano, local.mes - 1, local.dia, Math.floor(local.minutos / 60), local.minutos % 60)
    if (obtido === alvo) break
    palpite += alvo - obtido
  }

  return new Date(palpite)
}

/**
 * Está dentro da janela?
 *
 * A janela atravessa a meia-noite (21h → 08h), então a comparação é uma união
 * de dois intervalos, não um `entre`. Errar isso silencia o dia inteiro em vez
 * da noite.
 */
export function dentroDaJanela(instante: Date, janela: JanelaSilencio = JANELA_PADRAO): boolean {
  const inicio = minutosDe(janela.inicio)
  const fim = minutosDe(janela.fim)
  if (inicio === null || fim === null) return false

  // Janela vazia (mesmo horário nos dois lados) significa "sem silêncio".
  if (inicio === fim) return false

  const agora = relogioLocal(instante, janela.fuso).minutos

  return inicio < fim
    ? agora >= inicio && agora < fim
    : agora >= inicio || agora < fim
}

export type Reagendamento =
  | { silenciado: false; quando: Date }
  | { silenciado: true; quando: Date; abertura: Date }

/**
 * Onde este envio realmente cabe.
 *
 * `atrasoSegundos` é o jitter já sorteado. Ele é somado à abertura da janela
 * para espalhar a fila da manhã (§7.4) — e é somado ao instante original
 * quando não há silêncio, para que a mesma função sirva aos dois casos.
 */
export function agendar(
  instante: Date,
  atrasoSegundos: number,
  janela: JanelaSilencio = JANELA_PADRAO,
  opcoes: { ignorarSilencio?: boolean } = {},
): Reagendamento {
  const desejado = new Date(instante.getTime() + atrasoSegundos * 1000)

  // Transacional crítico fura a janela (§7.4). É configurável por mensagem.
  if (opcoes.ignorarSilencio) return { silenciado: false, quando: desejado }
  if (!dentroDaJanela(desejado, janela)) return { silenciado: false, quando: desejado }

  const abertura = proximaAbertura(desejado, janela)
  return {
    silenciado: true,
    abertura,
    quando: new Date(abertura.getTime() + atrasoSegundos * 1000),
  }
}

/** O próximo instante em que a janela abre, a partir de `instante`. */
export function proximaAbertura(instante: Date, janela: JanelaSilencio = JANELA_PADRAO): Date {
  const fim = minutosDe(janela.fim)
  if (fim === null) return instante

  const local = relogioLocal(instante, janela.fuso)
  const hoje = instanteLocal(local.ano, local.mes, local.dia, fim, janela.fuso)

  if (hoje.getTime() > instante.getTime()) return hoje

  // Já passou da abertura de hoje (estamos na parte noturna): é a de amanhã.
  const amanha = new Date(instante.getTime() + 24 * 3600 * 1000)
  const localAmanha = relogioLocal(amanha, janela.fuso)
  return instanteLocal(localAmanha.ano, localAmanha.mes, localAmanha.dia, fim, janela.fuso)
}
