import { WARMUP_LADDER } from '@/db/schema/enums'

/**
 * Aquecimento e rodízio de números (§7.3).
 *
 * A Evolution API roda sobre o WhatsApp Web e não é API oficial: o WhatsApp
 * detecta comportamento automatizado e bane números — e número banido
 * raramente volta. Esta é a lógica que separa "funciona" de "funcionou por
 * duas semanas".
 *
 * Duas regras vêm da spec e são o coração disto:
 *  - a escada SÓ avança com taxa de falha abaixo de 3%;
 *  - qualquer sinal de degradação REBAIXA o estágio e alerta.
 */

export type EstagioAquecimento = (typeof WARMUP_LADDER)[number]

/** Dias mínimos no estágio antes de poder subir (coluna "Dias" de §7.3). */
const DIAS_MINIMOS = [3, 7, 14, 30, 60, Number.POSITIVE_INFINITY] as const

/** Acima disso a escada não sobe, e degradação repetida faz descer. */
export const FALHA_MAXIMA = 0.03

export function estagioDe(stage: number): EstagioAquecimento {
  const indice = Math.min(Math.max(0, Math.trunc(stage)), WARMUP_LADDER.length - 1)
  return WARMUP_LADDER[indice]!
}

export type InstanciaWhatsapp = {
  id: string
  name: string
  status: 'conectando' | 'conectado' | 'desconectado' | 'banido'
  warmupStage: number
  warmupStartedAt: Date | null
  dailyCap: number
  minIntervalSeconds: number
  sentToday: number
  lastSentAt: Date | null
  failureRate24h: number
  weight: number
  active: boolean
}

// ── Escada ───────────────────────────────────────────────────────────────────

export type DecisaoEscada =
  | { acao: 'manter'; estagio: number; motivo: string }
  | { acao: 'subir'; estagio: number; motivo: string }
  | { acao: 'rebaixar'; estagio: number; motivo: string }

/**
 * Para onde o estágio deve ir.
 *
 * `desconexoesRecentes` e `falhasSeguidas` são os "sinais de degradação" que a
 * spec cita. Rebaixar é sempre avaliado antes de subir: uma instância pode ter
 * dias suficientes E estar degradando ao mesmo tempo, e nesse caso subir seria
 * acelerar rumo ao banimento.
 */
export function avaliarEscada(
  instancia: Pick<InstanciaWhatsapp, 'warmupStage' | 'warmupStartedAt' | 'failureRate24h'>,
  agora: Date,
  sinais: { desconexoesRecentes?: number; falhasSeguidas?: number } = {},
): DecisaoEscada {
  const atual = instancia.warmupStage

  if ((sinais.falhasSeguidas ?? 0) >= 5) {
    return {
      acao: 'rebaixar',
      estagio: Math.max(0, atual - 1),
      motivo: 'cinco falhas seguidas',
    }
  }

  if ((sinais.desconexoesRecentes ?? 0) >= 3) {
    return {
      acao: 'rebaixar',
      estagio: Math.max(0, atual - 1),
      motivo: 'desconexões repetidas',
    }
  }

  if (instancia.failureRate24h > FALHA_MAXIMA) {
    return {
      acao: atual > 0 ? 'rebaixar' : 'manter',
      estagio: Math.max(0, atual - 1),
      motivo: `taxa de falha em ${(instancia.failureRate24h * 100).toFixed(1)}%, acima de 3%`,
    }
  }

  if (atual >= WARMUP_LADDER.length - 1) {
    return { acao: 'manter', estagio: atual, motivo: 'já está no topo da escada' }
  }

  if (!instancia.warmupStartedAt) {
    return { acao: 'manter', estagio: atual, motivo: 'aquecimento ainda não começou' }
  }

  const dias = (agora.getTime() - instancia.warmupStartedAt.getTime()) / (24 * 3600 * 1000)
  const necessarios = DIAS_MINIMOS[atual] ?? Number.POSITIVE_INFINITY

  if (dias < necessarios) {
    const faltam = Math.ceil(necessarios - dias)
    return { acao: 'manter', estagio: atual, motivo: `faltam ${faltam} dia(s) neste estágio` }
  }

  return {
    acao: 'subir',
    estagio: atual + 1,
    motivo: `${Math.floor(dias)} dias e falha em ${(instancia.failureRate24h * 100).toFixed(1)}%`,
  }
}

/** Os limites que acompanham o estágio — gravados junto na promoção. */
export function limitesDoEstagio(stage: number): { dailyCap: number; minIntervalSeconds: number } {
  const estagio = estagioDe(stage)
  return { dailyCap: estagio.dailyCap, minIntervalSeconds: estagio.minIntervalSeconds }
}

// ── Rodízio ──────────────────────────────────────────────────────────────────

export type MotivoIndisponivel = 'desconectada' | 'banida' | 'pausada' | 'teto_diario' | 'intervalo'

export type Disponibilidade =
  | { disponivel: true }
  | { disponivel: false; motivo: MotivoIndisponivel; liberaEm?: Date }

export function disponibilidade(instancia: InstanciaWhatsapp, agora: Date): Disponibilidade {
  if (!instancia.active) return { disponivel: false, motivo: 'pausada' }
  if (instancia.status === 'banido') return { disponivel: false, motivo: 'banida' }
  if (instancia.status !== 'conectado') return { disponivel: false, motivo: 'desconectada' }

  if (instancia.sentToday >= instancia.dailyCap) {
    return { disponivel: false, motivo: 'teto_diario' }
  }

  // Intervalo mínimo entre envios do MESMO número (§7.3). É por instância, não
  // por fila: duas filas empurrando o mesmo chip é o mesmo chip disparando.
  if (instancia.lastSentAt) {
    const liberaEm = new Date(instancia.lastSentAt.getTime() + instancia.minIntervalSeconds * 1000)
    if (liberaEm > agora) return { disponivel: false, motivo: 'intervalo', liberaEm }
  }

  return { disponivel: true }
}

/**
 * Escolhe a instância do próximo envio.
 *
 * Peso ponderado pelo espaço que ainda resta no teto do dia: um número com 500
 * de folga recebe mais que um com 10, mesmo com o mesmo peso configurado. Sem
 * isso, o rodízio empurraria todo mundo contra o teto ao mesmo tempo e a fila
 * pararia junto.
 *
 * Determinístico dado `aleatorio` — o teste consegue fixar a escolha.
 */
export function escolherInstancia(
  instancias: readonly InstanciaWhatsapp[],
  agora: Date,
  aleatorio: () => number = Math.random,
): { escolhida: InstanciaWhatsapp } | { escolhida: null; proximaLiberacao: Date | null } {
  const aptas = instancias.filter((i) => disponibilidade(i, agora).disponivel)

  if (aptas.length === 0) {
    // Nenhuma agora: quem chamou precisa saber para QUANDO reagendar, em vez de
    // ficar tentando de novo em laço.
    const liberacoes = instancias
      .map((i) => {
        const d = disponibilidade(i, agora)
        return d.disponivel ? null : (d.liberaEm ?? null)
      })
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())

    return { escolhida: null, proximaLiberacao: liberacoes[0] ?? null }
  }

  const pesos = aptas.map((i) => Math.max(1, i.weight) * Math.max(1, i.dailyCap - i.sentToday))
  const total = pesos.reduce((soma, p) => soma + p, 0)

  let sorteio = aleatorio() * total
  for (let i = 0; i < aptas.length; i += 1) {
    sorteio -= pesos[i]!
    if (sorteio < 0) return { escolhida: aptas[i]! }
  }

  return { escolhida: aptas[aptas.length - 1]! }
}

/**
 * Escolhe a instância no momento do AGENDAMENTO, que é diferente do envio.
 *
 * Um passo marcado para daqui a 20 horas não pode ser decidido pelo teto de
 * hoje nem pelo intervalo desde o último envio: às 11h de amanhã, `sentToday`
 * já terá sido zerado e o intervalo há muito terá passado. Perguntar
 * "está disponível agora?" faria a cascata do PIX perder os passos longos.
 *
 * Então aqui só o que é ESTÁVEL conta: a instância existe, está ligada e não
 * foi banida. O ritmo instantâneo é responsabilidade da fila daquele chip, que
 * já roda a 1 msg/4s, e da checagem no momento do envio.
 *
 * Desconectada continua elegível de propósito — chip cai e volta o tempo todo,
 * e descartar um envio de +2h por causa de uma queda de agora seria perder
 * mensagem por um problema que já terá passado.
 */
export function escolherParaAgendamento(
  instancias: readonly InstanciaWhatsapp[],
  aleatorio: () => number = Math.random,
): InstanciaWhatsapp | null {
  const elegiveis = instancias.filter((i) => i.active && i.status !== 'banido')
  if (elegiveis.length === 0) return null

  // Peso ponderado pelo teto, não pela folga: a folga de hoje não diz nada
  // sobre a capacidade de amanhã.
  const pesos = elegiveis.map((i) => Math.max(1, i.weight) * Math.max(1, i.dailyCap))
  const total = pesos.reduce((soma, p) => soma + p, 0)

  let sorteio = aleatorio() * total
  for (let i = 0; i < elegiveis.length; i += 1) {
    sorteio -= pesos[i]!
    if (sorteio < 0) return elegiveis[i]!
  }

  return elegiveis[elegiveis.length - 1]!
}

/** Semáforo do painel de saúde (§7.3). */
export type Semaforo = 'verde' | 'ambar' | 'vermelho'

export function semaforo(instancia: InstanciaWhatsapp): { cor: Semaforo; texto: string } {
  if (instancia.status === 'banido') return { cor: 'vermelho', texto: 'número banido' }
  if (!instancia.active) return { cor: 'ambar', texto: 'pausado por você' }
  if (instancia.status === 'desconectado') return { cor: 'vermelho', texto: 'desconectado' }
  if (instancia.status === 'conectando') return { cor: 'ambar', texto: 'conectando' }

  if (instancia.failureRate24h > FALHA_MAXIMA) {
    return { cor: 'vermelho', texto: `falha em ${(instancia.failureRate24h * 100).toFixed(1)}%` }
  }

  const usoDoTeto = instancia.dailyCap === 0 ? 1 : instancia.sentToday / instancia.dailyCap
  if (usoDoTeto >= 1) return { cor: 'ambar', texto: 'teto do dia atingido' }
  if (usoDoTeto >= 0.8) return { cor: 'ambar', texto: 'perto do teto do dia' }

  return { cor: 'verde', texto: 'saudável' }
}
