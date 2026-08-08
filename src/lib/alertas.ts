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
  /**
   * Para onde ir, quando há um lugar.
   *
   * REGRA PERMANENTE: se a frase de um alerta manda abrir uma tela, ela está
   * errada. Este campo existe porque `acao` dizia, por extenso, "Abra o
   * histórico filtrado por este canal" — uma instrução de navegação escrita à
   * mão para uma tela que nem aceitava ser apontada. Ou vira link, ou a frase
   * não deveria mencionar a outra tela.
   */
  href?: string
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
  /**
   * Está tudo de pé para trabalhar?
   *
   * Nenhum dos três campos acima sabe se existe UM canal conectado, se o
   * batimento está vivo, ou se algum evento chegou e não achou fluxo. Uma banca
   * recém-conectada via oito zeros e nenhum aviso; com o agendador morto, nada
   * saía e a tela dizia "fila vazia". Os quatro campos abaixo são o que faltava
   * para o painel responder "dá para enviar alguma coisa agora?".
   */
  prontidao?: readonly ProntidaoDeCanal[]
  /** Quando o batimento rodou pela última vez. Nulo = nunca rodou. */
  batimento?: Date | null
  /** Fluxos ligados, e os tipos de evento que chegaram sem ninguém escutando. */
  noAr?: { ligados: number; semOuvinte: readonly { type: string; total: number }[] } | null
  /** A mensagem vencida mais antiga que continua esperando. */
  vencidaDesde?: Date | null
  agora?: Date
}

/** O que `prontidaoDosCanais` devolve, sem arrastar o módulo de entrega. */
export type ProntidaoDeCanal = {
  canal: Channel
  pronto: boolean
  motivo: string | null
}

/**
 * Quanto tempo sem batimento antes de dizer que parou.
 *
 * O batimento é de hora em hora. Três horas é atraso que nenhuma execução
 * normal produz — e é curto o bastante para a pessoa descobrir no mesmo turno,
 * não no dia seguinte.
 */
const HORAS_SEM_BATIMENTO = 3

/** Uma mensagem vencida há mais que isto não está "quase saindo". */
const MINUTOS_VENCIDA = 15

export function avaliarAlertas(estado: EstadoParaAlertas): Alerta[] {
  const alertas: Alerta[] = []
  const agora = estado.agora ?? new Date()

  /*
   * ── O QUE IMPEDE O SISTEMA DE TRABALHAR ──
   *
   * Vem antes de tudo porque é de outra natureza: os alertas abaixo dizem que
   * algo está indo mal, estes dizem que nada está indo. Uma banca sem canal
   * conectado não tem taxa de falha nem fila grande — tem oito zeros e um
   * silêncio, e era o que a tela mostrava.
   */

  // Nenhum canal pronto: nem os fluxos ligados têm por onde sair.
  if (estado.prontidao && estado.prontidao.length > 0) {
    const prontos = estado.prontidao.filter((p) => p.pronto)

    if (prontos.length === 0) {
      /*
       * O motivo já está escrito em português dentro de `prontidaoDosCanais`
       * ("falta a chave do provedor de SMS", "nenhum número de WhatsApp
       * conectado") e era usado só na tela de um fluxo. A informação existia; o
       * painel é que não perguntava.
       */
      const motivos = estado.prontidao
        .filter((p) => p.motivo)
        .map((p) => `${CHANNEL_LABELS[p.canal]}: ${p.motivo}`)
        .join('; ')

      alertas.push({
        nivel: 'critico',
        titulo: 'Nenhum canal conectado',
        acao: motivos
          ? `Nada pode sair, nem os fluxos ligados. ${motivos}.`
          : 'Nada pode sair, nem os fluxos ligados.',
        href: '/canais',
      })
    } else {
      // Canal que caiu sozinho, com pelo menos um outro de pé: não é o fim da
      // operação, mas some do rodízio sem ninguém perceber.
      for (const p of estado.prontidao) {
        if (p.pronto || !p.motivo?.includes('desligado sozinho')) continue
        alertas.push({
          nivel: 'critico',
          canal: p.canal,
          titulo: `${CHANNEL_LABELS[p.canal]} caiu e foi desligado`,
          acao: `${p.motivo}.`,
          href: '/canais',
        })
      }
    }
  }

  /*
   * O batimento parado é o modo de falha mais silencioso que existe aqui: as
   * mensagens continuam sendo agendadas, o painel continua somando, e nada
   * sai. "Fila vazia" e "nada agendado" são a mesma tela de um sistema
   * saudável e de um sistema morto.
   */
  if (estado.batimento !== undefined) {
    const horas = estado.batimento
      ? (agora.getTime() - estado.batimento.getTime()) / 3_600_000
      : Infinity

    if (horas >= HORAS_SEM_BATIMENTO) {
      alertas.push({
        nivel: 'critico',
        titulo: 'As mensagens não estão saindo',
        acao: estado.batimento
          ? `O disparo automático parou há ${Math.floor(horas)}h. Confira o agendador em Configurações → Sistema.`
          : 'O disparo automático nunca rodou. Configure o agendador em Configurações → Sistema.',
        href: '/configuracoes/sistema',
      })
    }
  }

  // Vencida e parada: o batimento pode estar vivo e ainda assim não vazar.
  if (estado.vencidaDesde) {
    const minutos = Math.floor((agora.getTime() - estado.vencidaDesde.getTime()) / 60_000)
    if (minutos >= MINUTOS_VENCIDA) {
      alertas.push({
        nivel: 'atencao',
        titulo: `A mensagem mais antiga espera há ${minutos} min`,
        acao: 'Passou da hora marcada e não saiu. Veja o que está preso na fila.',
        href: '/historico?status=queued,scheduled',
      })
    }
  }

  /*
   * Evento chegando sem ninguém escutando.
   *
   * Esta era a resposta certa no lugar errado: a lista já existia, no ÚLTIMO
   * bloco da página, depois de gráficos e do funil. É a pergunta que traz a
   * pessoa ao painel — "cadastrei e nada aconteceu" — respondida abaixo da
   * dobra de quem rolou até o fim.
   */
  if (estado.noAr) {
    const semOuvinte = estado.noAr.semOuvinte
    const total = semOuvinte.reduce((s, e) => s + e.total, 0)

    if (total > 0) {
      alertas.push({
        nivel: 'critico',
        titulo: `${total} evento(s) chegaram e nenhum fluxo escuta`,
        acao: 'A plataforma está mandando, o Mandafy está recebendo, e não há fluxo ligado para esses avisos.',
        href: '/fluxos',
      })
    } else if (estado.noAr.ligados === 0) {
      alertas.push({
        nivel: 'atencao',
        titulo: 'Nenhum fluxo ligado',
        acao: 'Os eventos chegam e não viram mensagem. Ligue ao menos um fluxo.',
        href: '/fluxos',
      })
    }
  }

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
      acao: 'Veja o erro que se repete.',
      href: `/historico?canais=${canal.canal}&status=failed,dead&horas=24`,
    })
  }

  // ── Fila (§10.4) ──
  if (estado.naFila > LIMIARES.filaPendente) {
    alertas.push({
      nivel: 'atencao',
      titulo: `${estado.naFila} envios esperando`,
      acao: 'Confira se o worker está no ar e se algum número não caiu.',
      href: '/historico?status=queued,scheduled',
    })
  }

  // Crítico primeiro: quem olha de relance tem de ver o pior no topo.
  return alertas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'critico' ? -1 : 1))
}
