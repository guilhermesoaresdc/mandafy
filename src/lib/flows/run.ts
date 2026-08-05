import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@/db'
import { flows, flowSteps, jitterProfiles, messages } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { createLogger } from '@/lib/logger'
import { cancelarPorChave, enfileirarEnvio, type ResultadoCanal } from '@/lib/delivery/enqueue'
import type { PerfilJitter } from '@/lib/delivery/jitter'
import type { DadosVariaveis } from '@/lib/messages/variables'
import { montarChave } from './cancel-key'
import { atende } from './conditions'
import { planejarCascata } from './schedule'

/**
 * Motor de cadência (§5).
 *
 * Um evento canônico chega e duas coisas acontecem, nesta ordem:
 *
 *  1. CANCELAR o que este evento cancela. Primeiro, sempre. Se `order.paid`
 *     também dispara um fluxo de recibo, cancelar depois abriria uma janela em
 *     que o lembrete de PIX e o recibo estariam ambos na fila.
 *  2. DISPARAR os fluxos cujo gatilho é este evento.
 */

const log = createLogger('fluxos')

/**
 * O relógio da operação — o mesmo para a janela de silêncio e para o horário
 * fixo de um passo.
 *
 * `organizations.timezone` existe e é onde isto vai morar no dia em que houver
 * uma banca fora do horário de Brasília. Enquanto for uma constante, ela fica
 * com NOME e num lugar só: duas cópias de `'America/Sao_Paulo'` espalhadas pelo
 * arquivo é como uma delas muda sozinha.
 */
const FUSO_DA_OPERACAO = 'America/Sao_Paulo'

export type EventoParaFluxo = {
  orgId: string
  tipo: string
  contactId: string | null
  eventId?: number | null
  dados: DadosVariaveis
}

export type ResultadoFluxo = {
  flowId: string
  flowName: string
  disparado: boolean
  motivo?: string
  cancelKey?: string | null
  envios: ResultadoCanal[]
}

export type ResultadoEvento = {
  cancelados: number
  fluxos: ResultadoFluxo[]
}

/**
 * Processa um evento canônico contra os fluxos da organização.
 *
 * `agora` entra por parâmetro para que o teste consiga posicionar o relógio.
 */
export async function processarEvento(
  tx: Tx,
  evento: EventoParaFluxo,
  agora = new Date(),
): Promise<ResultadoEvento> {
  const ativos = await tx
    .select()
    .from(flows)
    .where(and(eq(flows.orgId, evento.orgId), eq(flows.active, true)))

  // ── 1. Cancelar (§5.1) ──
  const cancelados = await cancelarPeloEvento(tx, evento, ativos)

  // ── 2. Disparar ──
  const disparaveis = ativos
    .filter((f) => f.triggerEvent === evento.tipo)
    // Prioridade menor primeiro: é o fluxo mais específico, e ele deve ocupar
    // a cota diária do contato antes do genérico.
    .sort((a, b) => a.priority - b.priority)

  const resultados: ResultadoFluxo[] = []

  for (const fluxo of disparaveis) {
    resultados.push(await dispararFluxo(tx, fluxo, evento, agora))
  }

  return { cancelados, fluxos: resultados }
}

/** Cancela tudo que este evento cancela, em todos os fluxos que o listam. */
async function cancelarPeloEvento(
  tx: Tx,
  evento: EventoParaFluxo,
  ativos: (typeof flows.$inferSelect)[],
): Promise<number> {
  const queCancelam = ativos.filter((f) => f.cancelOn.includes(evento.tipo))
  if (queCancelam.length === 0) return 0

  // Fluxos diferentes podem usar o mesmo modelo de chave; cancelar duas vezes
  // a mesma chave não é errado, mas é uma varredura à toa numa tabela grande.
  const chaves = new Set<string>()
  for (const fluxo of queCancelam) {
    const resultado = montarChave(fluxo.cancelKeyTemplate, evento.dados)
    if (resultado.ok) {
      chaves.add(resultado.chave)
      continue
    }

    /*
     * Sem chave não há como cancelar, e isso é grave: significa que os envios
     * agendados vão sair mesmo com o pedido pago. Loga o nome do campo que
     * faltou — nunca o valor (§14.1).
     */
    log.warn('evento de cancelamento sem chave', {
      flowId: fluxo.id,
      evento: evento.tipo,
      faltando: resultado.faltando,
    })
  }

  let total = 0
  for (const chave of chaves) {
    const { cancelados } = await cancelarPorChave(tx, evento.orgId, chave)
    total += cancelados
  }

  if (total > 0) {
    log.info('envios cancelados por evento', { evento: evento.tipo, total })
  }

  return total
}

async function dispararFluxo(
  tx: Tx,
  fluxo: typeof flows.$inferSelect,
  evento: EventoParaFluxo,
  agora: Date,
): Promise<ResultadoFluxo> {
  const base = { flowId: fluxo.id, flowName: fluxo.name, envios: [] as ResultadoCanal[] }

  if (!evento.contactId) {
    return { ...base, disparado: false, motivo: 'evento sem contato' }
  }

  if (!atende(fluxo.entryConditions, evento.dados)) {
    return { ...base, disparado: false, motivo: 'condições de entrada não atendidas' }
  }

  const passos = await tx
    .select()
    .from(flowSteps)
    .where(eq(flowSteps.flowId, fluxo.id))
    .orderBy(asc(flowSteps.position))

  if (passos.length === 0) return { ...base, disparado: false, motivo: 'fluxo sem passos' }

  /*
   * A chave é obrigatória quando o fluxo declara eventos de cancelamento.
   * Agendar quatro envios que nunca poderão ser cancelados é pior do que não
   * agendar: é mandar "finalize seu pagamento" para quem já pagou.
   */
  let cancelKey: string | null = null
  if (fluxo.cancelOn.length > 0) {
    const resultado = montarChave(fluxo.cancelKeyTemplate, evento.dados)
    if (!resultado.ok) {
      log.error('fluxo não disparado: chave de cancelamento incompleta', {
        flowId: fluxo.id,
        faltando: resultado.faltando,
      })
      return {
        ...base,
        disparado: false,
        motivo: `sem chave de cancelamento (falta ${resultado.faltando.join(', ')})`,
      }
    }
    cancelKey = resultado.chave
  }

  const perfis = await carregarPerfis(tx, [
    fluxo.jitterProfileId,
    ...passos.map((p) => p.jitterProfileId),
  ])

  /*
   * O MESMO fuso da janela de silêncio, logo abaixo, e de propósito: se o
   * horário do passo e a janela lessem relógios diferentes, um passo marcado
   * para "às 8:00" poderia cair dentro de uma janela que termina "às 8:00" e
   * ser adiado para o dia seguinte — sem nada na tela explicando.
   */
  const agenda = planejarCascata(passos, agora, FUSO_DA_OPERACAO)
  const envios: ResultadoCanal[] = []

  for (const marcado of agenda) {
    const passo = passos.find((p) => p.id === marcado.stepId)
    if (!passo) continue

    // Condição do passo, avaliada no momento do agendamento. Condição que
    // depende do futuro (§3.5 "se não comprou") é do passo, não daqui.
    if (!atende(passo.conditions, evento.dados)) continue

    // Ritmo: passo → fluxo → padrão. O mais específico vence (§7.2).
    const perfil = perfis.get(passo.jitterProfileId ?? '') ?? perfis.get(fluxo.jitterProfileId ?? '')

    const resultados = await enfileirarEnvio(
      tx,
      {
        orgId: evento.orgId,
        contactId: evento.contactId,
        messageId: passo.messageId,
        ...(passo.channelsOverride
          ? { canais: passo.channelsOverride as Channel[] }
          : {}),
        dados: evento.dados,
        cancelKey,
        // Um mesmo pedido não pode gerar o mesmo passo duas vezes, mesmo que a
        // plataforma reenvie o webhook.
        dedupeKey: cancelKey ? `${cancelKey}:${passo.id}` : null,
        flowId: fluxo.id,
        stepId: passo.id,
        eventId: evento.eventId ?? null,
        ...(perfil ? { perfil } : {}),
        ...(fluxo.quietHoursEnabled
          ? {
              janela: {
                inicio: fluxo.quietStart.slice(0, 5),
                fim: fluxo.quietEnd.slice(0, 5),
                fuso: FUSO_DA_OPERACAO,
              },
            }
          : {}),
      },
      // Cada passo é agendado para o SEU instante, não para agora: é isso que
      // faz a cascata sair inteira de uma vez com horários diferentes.
      marcado.quando,
    )

    envios.push(...resultados)
  }

  return { ...base, disparado: true, cancelKey, envios }
}

async function carregarPerfis(
  tx: Tx,
  ids: (string | null)[],
): Promise<Map<string, PerfilJitter>> {
  const validos = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (validos.length === 0) return new Map()

  const linhas = await tx
    .select()
    .from(jitterProfiles)
    .where(inArray(jitterProfiles.id, validos))

  return new Map(
    linhas.map((linha) => [
      linha.id,
      { mode: linha.mode, minSeconds: linha.minSeconds, maxSeconds: linha.maxSeconds },
    ]),
  )
}

/** As mensagens que um fluxo usa — a tela lista para não deixar passo órfão. */
export async function mensagensDoFluxo(
  tx: Tx,
  flowId: string,
): Promise<Map<string, { name: string; key: string; active: boolean }>> {
  const passos = await tx
    .select({ messageId: flowSteps.messageId })
    .from(flowSteps)
    .where(eq(flowSteps.flowId, flowId))

  const ids = [...new Set(passos.map((p) => p.messageId))]
  if (ids.length === 0) return new Map()

  const linhas = await tx
    .select({ id: messages.id, name: messages.name, key: messages.key, active: messages.active })
    .from(messages)
    .where(inArray(messages.id, ids))

  return new Map(linhas.map((l) => [l.id, { name: l.name, key: l.key, active: l.active }]))
}
