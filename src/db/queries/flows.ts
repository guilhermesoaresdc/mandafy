import { asc, desc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@/db'
import { flows, flowSteps, jitterProfiles, messages } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { formatarOffset, planejarCascata } from '@/lib/flows/schedule'
import { descrever } from '@/lib/flows/conditions'
import { compilar } from '@/lib/messages/compile'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { sementeDeTexto } from '@/lib/messages/spintax'

/** Consultas dos fluxos (§5). Fora dos componentes para poderem ser testadas. */

/**
 * O texto do passo pronto para ser lido na tela do fluxo.
 *
 * Compilado com o contato de exemplo, como a galeria de "nova mensagem" já faz:
 * `{{nome|primeiro_nome|"tudo bem"}}` não responde "o que a pessoa vai receber",
 * e "Oi Maria! Sua conta está pronta" responde.
 *
 * `previa: true` de propósito. Variável sem exemplo vira `{{nome}}` visível em
 * vez de derrubar a linha — a tela do fluxo é vitrine, não envio, e um passo
 * que some da lista porque o texto tem uma variável nova seria bem pior do que
 * um `{{…}}` à mostra.
 *
 * A semente vem do id do passo: sem ela o spintax sortearia outra alternativa a
 * cada carregamento, e a tela mudaria de texto sozinha — que parece defeito.
 */
function amostraDe(corpo: string, semente: string): string {
  if (!corpo.trim()) return ''

  const compilada = compilar(corpo, {
    canal: 'whatsapp',
    dados: CONTATO_EXEMPLO,
    semente: sementeDeTexto(semente),
    previa: true,
  })

  return (compilada.ok ? compilada.corpo : corpo)
    // Os marcadores do WhatsApp viram ruído numa linha sem negrito de verdade.
    .replace(/[*_~]/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
}

export type PassoResumo = {
  id: string
  position: number
  delaySeconds: number
  /** Acumulado desde o gatilho — é o que a pessoa lê como "+2 h". */
  offsetLabel: string
  /** `'10:00'` quando o passo tem hora marcada; nulo quando segue a cascata. */
  sendAtLocal: string | null
  messageId: string
  messageName: string
  messageKey: string
  messageAtiva: boolean
  /**
   * O texto que vai sair, já compilado com o contato de exemplo.
   *
   * A tela do fluxo mostrava só o NOME da mensagem, e nome não é conteúdo:
   * "Boas-vindas" não diz se o texto ainda fala de rifa, se está em branco ou
   * se é o que a pessoa espera. Quem quisesse conferir tinha de abrir outra
   * tela, ler, e voltar — para cada passo. Ler é o passo zero de confiar que o
   * fluxo faz o que diz.
   */
  amostra: string
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
        .select({
          id: messages.id,
          name: messages.name,
          key: messages.key,
          active: messages.active,
          body: messages.body,
        })
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
      sendAtLocal: linha.sendAtLocal ? linha.sendAtLocal.slice(0, 5) : null,
      messageId: linha.messageId,
      messageName: mensagem?.name ?? 'mensagem removida',
      messageKey: mensagem?.key ?? '',
      messageAtiva: mensagem?.active ?? false,
      amostra: amostraDe(mensagem?.body ?? '', linha.id),
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
