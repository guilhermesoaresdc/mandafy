import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { events, flows, notificationDailyStats } from '@/db/schema'

/**
 * "O que está ativo e rodando?" (§10.3, §11.7).
 *
 * A PERGUNTA QUE O SISTEMA NÃO SABIA RESPONDER
 *
 * O painel dizia quanto saiu; a tela de fluxos dizia o que está configurado.
 * Nenhuma das duas cruzava as coisas, e é no cruzamento que mora o modo de
 * falha mais caro deste sistema: a plataforma mandando evento, tudo verde na
 * tela, e nenhum fluxo escutando. Ninguém recebe nada, ninguém vê erro nenhum.
 *
 * O contrário também importa e é mais comum ainda: os fluxos-modelo nascem
 * PAUSADOS de propósito, então logo depois de instalar a resposta honesta é
 * "nada está no ar" — e nenhuma tela dizia isso.
 *
 * TRÊS CUIDADOS QUE ESTAS CONSULTAS CARREGAM
 *
 * 1. Rodam dentro de `withTenant`. Fora dele não há `app.org_id` e o RLS
 *    devolve ZERO LINHA sem erro — numa tela cuja função é dizer se está
 *    acontecendo coisa, esse é o pior resultado possível: ela mostraria
 *    "parado" num sistema saudável.
 * 2. O volume por fluxo sai de `notification_daily_stats`, e não de um
 *    `COUNT(*)` em `notifications` (§13.2). O agregado é consolidado de hora em
 *    hora, então a contagem não inclui os últimos minutos — irrelevante numa
 *    janela de sete dias, e o motivo de a interface dizer "7 dias" e nunca
 *    "agora".
 * 3. O corte de data é constante e absoluto. `events` e `notifications` são
 *    particionadas por dia; uma condição correlacionada faz o Postgres varrer
 *    todas as partições, e já custou isso neste projeto.
 */

const DIAS = 7

export type FluxoNoAr = {
  id: string
  name: string
  triggerEvent: string
  active: boolean
  /** Envios que este fluxo produziu na janela. Vem do agregado. */
  envios: number
  /** Eventos do tipo que dispara este fluxo, recebidos na janela. */
  gatilhos: number
}

export type ResumoNoAr = {
  fluxos: FluxoNoAr[]
  ligados: number
  total: number
  /**
   * Tipos de evento que chegaram e que nenhum fluxo LIGADO escuta.
   *
   * É a lista que responde "por que não saiu nada?" quando tudo parece certo.
   */
  semOuvinte: { type: string; total: number }[]
  dias: number
}

function diaUtc(instante: Date): string {
  return instante.toISOString().slice(0, 10)
}

export async function resumoNoAr(tx: Tx, agora = new Date()): Promise<ResumoNoAr> {
  const desde = new Date(agora.getTime() - DIAS * 24 * 3600 * 1000)

  const linhas = await tx
    .select({
      id: flows.id,
      name: flows.name,
      triggerEvent: flows.triggerEvent,
      active: flows.active,
    })
    .from(flows)
    .orderBy(desc(flows.active), flows.name)

  /*
   * Eventos por tipo, agrupados no banco.
   *
   * `occurred_at >= constante` é o que permite ao Postgres descartar as
   * partições antigas sem abri-las.
   */
  const eventos = await tx
    .select({ type: events.type, total: sql<number>`count(*)::int` })
    .from(events)
    .where(gte(events.occurredAt, desde))
    .groupBy(events.type)

  const porTipo = new Map(eventos.map((e) => [e.type, e.total]))

  /*
   * Envios por fluxo, do agregado. `flow_id` já está na chave primária de
   * `notification_daily_stats` desde a fase 6, e ninguém lia.
   */
  const ids = linhas.map((l) => l.id)
  const envios = ids.length
    ? await tx
        .select({
          flowId: notificationDailyStats.flowId,
          total: sql<number>`sum(${notificationDailyStats.total})::int`,
        })
        .from(notificationDailyStats)
        .where(
          and(
            gte(notificationDailyStats.day, diaUtc(desde)),
            inArray(notificationDailyStats.flowId, ids),
          ),
        )
        .groupBy(notificationDailyStats.flowId)
    : []

  const porFluxo = new Map(envios.map((e) => [e.flowId, e.total]))

  const fluxos: FluxoNoAr[] = linhas.map((linha) => ({
    id: linha.id,
    name: linha.name,
    triggerEvent: linha.triggerEvent,
    active: linha.active,
    envios: porFluxo.get(linha.id) ?? 0,
    gatilhos: porTipo.get(linha.triggerEvent) ?? 0,
  }))

  // Só fluxos LIGADOS contam como ouvinte: um fluxo pausado que escuta o evento
  // é exatamente o caso que a pessoa precisa enxergar, não o que a tranquiliza.
  const escutados = new Set(linhas.filter((l) => l.active).map((l) => l.triggerEvent))

  const semOuvinte = eventos
    .filter((e) => !escutados.has(e.type))
    .sort((a, b) => b.total - a.total)

  return {
    fluxos,
    ligados: linhas.filter((l) => l.active).length,
    total: linhas.length,
    semOuvinte,
    dias: DIAS,
  }
}

/**
 * Eventos recebidos por tipo, para a tela da plataforma.
 *
 * Construída sobre `events` e não sobre `events_raw`: a normalizada tem `org_id`
 * de verdade e política de tenant direta, enquanto a crua depende de um EXISTS
 * em `sources`. Além disso é a normalizada que os fluxos escutam — contar a crua
 * responderia "chegou algo", que não é a pergunta.
 */
export type EventoRecebido = { type: string; total: number; ultimo: Date }

export async function eventosPorTipo(
  tx: Tx,
  sourceId: string,
  agora = new Date(),
): Promise<EventoRecebido[]> {
  const desde = new Date(agora.getTime() - DIAS * 24 * 3600 * 1000)

  const linhas = await tx
    .select({
      type: events.type,
      total: sql<number>`count(*)::int`,
      // Texto, e não Date: num agregado o driver não sabe o tipo da coluna e
      // devolve o que o Postgres imprimiu. Anotar `sql<Date>` compilaria e
      // entregaria uma string com cara de data — mentira que só aparece quando
      // alguém chama `.toLocaleString()` nela.
      ultimo: sql<string>`max(${events.occurredAt})`,
    })
    .from(events)
    .where(and(eq(events.sourceId, sourceId), gte(events.occurredAt, desde)))
    .groupBy(events.type)

  return linhas
    .map((linha) => ({ ...linha, ultimo: new Date(linha.ultimo) }))
    .sort((a, b) => b.total - a.total)
}
