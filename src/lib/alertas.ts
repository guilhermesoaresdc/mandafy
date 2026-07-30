import type { Channel } from '@/db/schema/enums'
import { CHANNEL_LABELS } from '@/db/schema/enums'
import type { SaudeCanal } from '@/db/queries/painel'
import type { SaudeInstancia } from '@/db/queries/channels'
import { FALHA_MAXIMA } from '@/lib/delivery/warmup'

/**
 * Alertas do painel (§10.4).
 *
 * Puros: recebem o estado já lido e devolvem o que precisa de atenção. É o que
 * permite testar cada limiar sem banco — e limiar errado num alerta é pior que
 * alerta nenhum, porque ensina a ignorar o aviso.
 */

export const NIVEIS = ['critico', 'atencao'] as const
export type Nivel = (typeof NIVEIS)[number]

export type Alerta = {
  nivel: Nivel
  titulo: string
  /** O que fazer. Erro que só descreve o problema deixa a pessoa parada. */
  acao: string
  canal?: Channel
}

/** Os limiares de §10.4, num lugar só. */
export const LIMIARES = {
  /** Taxa de falha de um canal acima disso é alerta. */
  falhaCanal: 0.1,
  /** Fila acima disso significa que a operação não está vazando. */
  filaPendente: 500,
  /** Abaixo de tantos envios, a taxa de falha é ruído estatístico. */
  amostraMinima: 10,
} as const

export type EstadoParaAlertas = {
  canais: readonly SaudeCanal[]
  instancias: readonly SaudeInstancia[]
  naFila: number
}

export function avaliarAlertas(estado: EstadoParaAlertas): Alerta[] {
  const alertas: Alerta[] = []

  // ── Instâncias de WhatsApp (§10.4) ──
  for (const instancia of estado.instancias) {
    if (instancia.status === 'banido') {
      alertas.push({
        nivel: 'critico',
        canal: 'whatsapp',
        titulo: `${instancia.name} foi banido`,
        acao: 'Número banido raramente volta. Conecte outro chip e redistribua o rodízio.',
      })
      continue
    }

    if (!instancia.ativa) continue

    if (instancia.status === 'desconectado') {
      alertas.push({
        nivel: 'critico',
        canal: 'whatsapp',
        titulo: `${instancia.name} desconectou`,
        acao: 'Leia o QR Code de novo na Evolution. Enquanto isso, os envios ficam na fila.',
      })
    }

    if (instancia.falha24h > FALHA_MAXIMA) {
      alertas.push({
        nivel: 'atencao',
        canal: 'whatsapp',
        titulo: `${instancia.name} com ${(instancia.falha24h * 100).toFixed(1)}% de falha`,
        acao: 'Acima de 3% o aquecimento para de subir e o estágio é rebaixado. Reduza o volume neste número.',
      })
    }

    if (instancia.tetoDiario > 0 && instancia.enviadasHoje >= instancia.tetoDiario) {
      alertas.push({
        nivel: 'atencao',
        canal: 'whatsapp',
        titulo: `${instancia.name} bateu o teto do dia`,
        acao: 'Os envios migram para os outros números. Conecte mais um se isso virar rotina.',
      })
    }
  }

  // ── Taxa de falha por canal (§10.4) ──
  for (const canal of estado.canais) {
    const total = canal.enviadas24h + canal.falhas24h
    /*
     * Amostra pequena não gera alerta: 1 falha em 2 envios é 50%, e acordar
     * alguém por isso ensina a ignorar o aviso — que é como um sistema de
     * alertas morre.
     */
    if (total < LIMIARES.amostraMinima) continue
    if (canal.taxaFalha === null || canal.taxaFalha <= LIMIARES.falhaCanal) continue

    alertas.push({
      nivel: 'critico',
      canal: canal.canal,
      titulo: `${CHANNEL_LABELS[canal.canal]} falhando em ${(canal.taxaFalha * 100).toFixed(0)}%`,
      acao: 'Abra o histórico filtrado por este canal e veja o erro que se repete.',
    })
  }

  // ── Fila (§10.4) ──
  if (estado.naFila > LIMIARES.filaPendente) {
    alertas.push({
      nivel: 'atencao',
      titulo: `${estado.naFila} envios esperando`,
      acao: 'Confira se o worker está no ar e se algum número não caiu.',
    })
  }

  // Crítico primeiro: quem olha de relance tem de ver o pior no topo.
  return alertas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'critico' ? -1 : 1))
}
