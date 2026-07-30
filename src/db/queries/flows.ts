import { asc, desc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@/db'
import { flows, flowSteps, jitterProfiles, messages } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { formatarOffset, planejarCascata } from '@/lib/flows/schedule'
import { descrever } from '@/lib/flows/conditions'

/** Consultas dos fluxos (§5). Fora dos componentes para poderem ser testadas. */

export type PassoResumo = {
  id: string
  position: number
  delaySeconds: number
  /** Acumulado desde o gatilho — é o que a pessoa lê como "+2 h". */
  offsetLabel: string
  messageId: string
  messageName: string
  messageKey: string
  messageAtiva: boolean
  canais: Channel[] | null
  ritmo: string | null
}

export type FluxoResumo = {
  id: string
  name: string
  triggerEvent: string
  active: boolean
  cancelOn: string[]
  cancelKeyTemplate: string | null
  ritmo: string | null
  passos: number
  /** Alguma mensagem do fluxo está pausada? A tela precisa avisar. */
  temMensagemPausada: boolean
}

export type FluxoCompleto = {
  fluxo: typeof flows.$inferSelect
  passos: PassoResumo[]
  condicoesEntrada: string[]
  ritmo: string | null
}

export async function listarFluxos(tx: Tx): Promise<FluxoResumo[]> {
  const linhas = await tx.select().from(flows).orderBy(desc(flows.active), asc(flows.name))
  if (linhas.length === 0) return []

  const passos = await tx
    .select({ flowId: flowSteps.flowId, messageId: flowSteps.messageId })
    .from(flowSteps)
    .where(inArray(flowSteps.flowId, linhas.map((l) => l.id)))

  const idsMensagens = [...new Set(passos.map((p) => p.messageId))]
  const mensagens = idsMensagens.length
    ? await tx
        .select({ id: messages.id, active: messages.active })
        .from(messages)
        .where(inArray(messages.id, idsMensagens))
    : []

  const ativaPorId = new Map(mensagens.map((m) => [m.id, m.active]))
  const perfis = await mapaDeRitmos(tx, linhas.map((l) => l.jitterProfileId))

  return linhas.map((linha) => {
    const meus = passos.filter((p) => p.flowId === linha.id)
    return {
      id: linha.id,
      name: linha.name,
      triggerEvent: linha.triggerEvent,
      active: linha.active,
      cancelOn: linha.cancelOn,
      cancelKeyTemplate: linha.cancelKeyTemplate,
      ritmo: linha.jitterProfileId ? (perfis.get(linha.jitterProfileId) ?? null) : null,
      passos: meus.length,
      temMensagemPausada: meus.some((p) => ativaPorId.get(p.messageId) === false),
    }
  })
}

export async function buscarFluxo(tx: Tx, id: string): Promise<FluxoCompleto | null> {
  const [fluxo] = await tx.select().from(flows).where(eq(flows.id, id)).limit(1)
  if (!fluxo) return null

  const linhas = await tx
    .select()
    .from(flowSteps)
    .where(eq(flowSteps.flowId, id))
    .orderBy(asc(flowSteps.position))

  const idsMensagens = [...new Set(linhas.map((l) => l.messageId))]
  const mensagens = idsMensagens.length
    ? await tx
        .select({ id: messages.id, name: messages.name, key: messages.key, active: messages.active })
        .from(messages)
        .where(inArray(messages.id, idsMensagens))
    : []

  const porId = new Map(mensagens.map((m) => [m.id, m]))
  const perfis = await mapaDeRitmos(tx, [
    fluxo.jitterProfileId,
    ...linhas.map((l) => l.jitterProfileId),
  ])

  // O rótulo "+2 h" é o ACUMULADO, não o atraso do passo: é assim que a pessoa
  // pensa a cadência, e é assim que §5.1 a escreve.
  const agenda = planejarCascata(linhas, new Date(0))

  const passos: PassoResumo[] = linhas.map((linha) => {
    const mensagem = porId.get(linha.messageId)
    const marcado = agenda.find((a) => a.stepId === linha.id)

    return {
      id: linha.id,
      position: linha.position,
      delaySeconds: linha.delaySeconds,
      offsetLabel: formatarOffset(marcado?.offsetSeconds ?? 0),
      messageId: linha.messageId,
      messageName: mensagem?.name ?? 'mensagem removida',
      messageKey: mensagem?.key ?? '',
      messageAtiva: mensagem?.active ?? false,
      canais: (linha.channelsOverride as Channel[] | null) ?? null,
      ritmo: linha.jitterProfileId ? (perfis.get(linha.jitterProfileId) ?? null) : null,
    }
  })

  return {
    fluxo,
    passos,
    condicoesEntrada: descrever(fluxo.entryConditions),
    ritmo: fluxo.jitterProfileId ? (perfis.get(fluxo.jitterProfileId) ?? null) : null,
  }
}

async function mapaDeRitmos(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const validos = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (validos.length === 0) return new Map()

  const linhas = await tx
    .select({ id: jitterProfiles.id, name: jitterProfiles.name })
    .from(jitterProfiles)
    .where(inArray(jitterProfiles.id, validos))

  return new Map(linhas.map((l) => [l.id, l.name]))
}
