import { asc, count, desc, eq, inArray } from 'drizzle-orm'
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
  /**
   * O texto CRU da mensagem — é o que o editor do passo abre.
   *
   * `amostra` é o texto já compilado com o contato de exemplo, ótimo para ler e
   * inútil para editar: salvar o compilado gravaria "Olá MARIA APARECIDA" no
   * lugar de `{{nome}}` e todo mundo passaria a receber o nome da Maria.
   */
  messageBody: string
  /**
   * Em quantos OUTROS passos esta mesma mensagem é usada.
   *
   * Editar o texto aqui edita a mensagem, e a mensagem pode estar em mais
   * lugares. Sem este número, a tela deixaria alguém ajustar o lembrete de PIX
   * de um fluxo e mudar, sem saber, o de outro.
   */
  usadaEmOutrosPassos: number
  canais: Channel[] | null
  ritmo: string | null
}

/**
 * Um passo, do jeito que a LISTA precisa dele.
 *
 * Enxuto de propósito: `PassoResumo` traz corpo cru, canais, ritmo e contagem
 * de reúso — tudo que o editor usa e nada que um cartão de lista mostre. Nove
 * fluxos carregando o pacote inteiro seria pagar o custo do editor treze vezes
 * para desenhar treze linhas de texto.
 */
export type PassoNaLista = {
  /** `+5 min` — acumulado desde o gatilho, como §5.1 escreve. */
  offsetLabel: string
  messageName: string
  /** As primeiras palavras do texto que vai sair, já compilado. */
  amostra: string
  messageAtiva: boolean
}

export type FluxoResumo = {
  id: string
  name: string
  triggerEvent: string
  active: boolean
  cancelOn: string[]
  cancelKeyTemplate: string | null
  ritmo: string | null
  /**
   * Os passos, e não quantos são.
   *
   * Para responder "o que meus fluxos mandam hoje?" eram nove idas e voltas —
   * uma por fluxo, mais uma volta. E a resposta boa já existia uma tela
   * adiante: `amostraDe` compila o corpo com o contato de exemplo desde
   * sempre, e a tela do fluxo mostra o texto real de cada passo. O que faltava
   * era a lista fazer a mesma pergunta.
   */
  passos: PassoNaLista[]
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
    .select({
      id: flowSteps.id,
      flowId: flowSteps.flowId,
      messageId: flowSteps.messageId,
      position: flowSteps.position,
      delaySeconds: flowSteps.delaySeconds,
      sendAtLocal: flowSteps.sendAtLocal,
    })
    .from(flowSteps)
    .where(inArray(flowSteps.flowId, linhas.map((l) => l.id)))
    .orderBy(asc(flowSteps.position))

  const idsMensagens = [...new Set(passos.map((p) => p.messageId))]
  const mensagens = idsMensagens.length
    ? await tx
        .select({ id: messages.id, name: messages.name, body: messages.body, active: messages.active })
        .from(messages)
        .where(inArray(messages.id, idsMensagens))
    : []

  const porMensagem = new Map(mensagens.map((m) => [m.id, m]))
  const perfis = await mapaDeRitmos(tx, linhas.map((l) => l.jitterProfileId))

  return linhas.map((linha) => {
    const meus = passos.filter((p) => p.flowId === linha.id)

    // A mesma cascata da tela do fluxo: o rótulo é o ACUMULADO desde o
    // gatilho, não o atraso do passo. Dois passos de "+30 min" seguidos são
    // "+30 min" e "+1 h" para quem lê, e é assim que §5.1 escreve.
    const agenda = planejarCascata(meus, new Date(0))

    return {
      id: linha.id,
      name: linha.name,
      triggerEvent: linha.triggerEvent,
      active: linha.active,
      cancelOn: linha.cancelOn,
      cancelKeyTemplate: linha.cancelKeyTemplate,
      ritmo: linha.jitterProfileId ? (perfis.get(linha.jitterProfileId) ?? null) : null,
      passos: meus.map((passo) => {
        const mensagem = porMensagem.get(passo.messageId)
        const marcado = agenda.find((a) => a.stepId === passo.id)

        return {
          offsetLabel: formatarOffset(marcado?.offsetSeconds ?? 0),
          messageName: mensagem?.name ?? 'mensagem removida',
          amostra: amostraDe(mensagem?.body ?? '', passo.id),
          messageAtiva: mensagem?.active ?? false,
        }
      }),
      temMensagemPausada: meus.some((p) => porMensagem.get(p.messageId)?.active === false),
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

  /*
   * Onde mais cada mensagem aparece. Uma consulta para todas, e não uma por
   * passo: a cadência tem poucos passos, mas o padrão de "uma consulta por item
   * da lista" é o que transforma uma tela rápida numa tela lenta quando o
   * catálogo cresce.
   */
  const outrosUsos = idsMensagens.length
    ? await tx
        .select({ messageId: flowSteps.messageId, total: count() })
        .from(flowSteps)
        .where(inArray(flowSteps.messageId, idsMensagens))
        .groupBy(flowSteps.messageId)
    : []

  const usosPorMensagem = new Map(outrosUsos.map((u) => [u.messageId, Number(u.total)]))
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
      messageBody: mensagem?.body ?? '',
      // Menos este passo: o que interessa é "além daqui, onde mais?".
      usadaEmOutrosPassos: Math.max((usosPorMensagem.get(linha.messageId) ?? 1) - 1, 0),
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
