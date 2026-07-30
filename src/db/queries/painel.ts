import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, events, messages, notificationDailyStats, notifications } from '@/db/schema'
import { CHANNELS, type Channel, type NotificationStatus } from '@/db/schema/enums'

/**
 * Os cinco números do topo e a barra de pulso (§10.3, §11.6).
 *
 * Regra de §13.2: contadores vêm de `notification_daily_stats`, nunca de um
 * `COUNT(*)` em tabela grande. A exceção é a fila — "na fila" é sobre AGORA, e
 * o agregado do dia não sabe disso. O índice parcial
 * `notifications_scheduled_idx` cobre esse caso, e a contagem só olha o que
 * ainda não saiu.
 */

export type MetricasPainel = {
  enviadasHoje: number
  /** Entregues ÷ enviadas. `null` quando não houve envio — 0% mentiria. */
  taxaEntrega: number | null
  naFila: number
  falhas24h: number
  recuperadoCents: number
}

/** O que conta como "saiu" para a taxa de entrega. */
const SAIU: NotificationStatus[] = ['sent', 'delivered', 'read']
const CONFIRMADO: NotificationStatus[] = ['delivered', 'read']
const FALHOU: NotificationStatus[] = ['failed', 'dead']

function diaUtc(instante: Date): string {
  return instante.toISOString().slice(0, 10)
}

export async function metricasDoPainel(tx: Tx, agora = new Date()): Promise<MetricasPainel> {
  const hoje = diaUtc(agora)
  const ontem = diaUtc(new Date(agora.getTime() - 24 * 3600 * 1000))

  const agregados = await tx
    .select({
      day: notificationDailyStats.day,
      status: notificationDailyStats.status,
      total: notificationDailyStats.total,
    })
    .from(notificationDailyStats)
    .where(gte(notificationDailyStats.day, ontem))

  const somar = (dias: string[], status: readonly string[]): number =>
    agregados
      .filter((a) => dias.includes(a.day) && status.includes(a.status))
      .reduce((soma, a) => soma + Number(a.total), 0)

  const enviadasHoje = somar([hoje], SAIU)
  const confirmadasHoje = somar([hoje], CONFIRMADO)

  /*
   * O agregado é consolidado de hora em hora pela manutenção, então o que
   * aconteceu nos últimos minutos ainda não está lá. Para "enviadas hoje" isso
   * seria um número visivelmente errado numa tela que se olha o tempo todo, e
   * a contagem ao vivo de HOJE toca uma partição só.
   */
  const inicioDoDia = new Date(`${hoje}T00:00:00.000Z`)

  const [aoVivo] = await tx
    .select({
      saiu: sql<number>`count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int`,
      confirmado: sql<number>`count(*) FILTER (WHERE status IN ('delivered','read'))::int`,
    })
    .from(notifications)
    .where(gte(notifications.createdAt, inicioDoDia))

  const saiuHoje = Math.max(enviadasHoje, aoVivo?.saiu ?? 0)
  const confirmado = Math.max(confirmadasHoje, aoVivo?.confirmado ?? 0)

  const [fila] = await tx
    .select({ total: count() })
    .from(notifications)
    .where(inArray(notifications.status, ['queued', 'scheduled']))

  const [falhas] = await tx
    .select({ total: count() })
    .from(notifications)
    .where(
      and(
        gte(notifications.createdAt, new Date(agora.getTime() - 24 * 3600 * 1000)),
        inArray(notifications.status, FALHOU),
      ),
    )

  return {
    enviadasHoje: saiuHoje,
    taxaEntrega: saiuHoje === 0 ? null : confirmado / saiuHoje,
    naFila: fila?.total ?? 0,
    falhas24h: falhas?.total ?? 0,
    recuperadoCents: await recuperado(tx, agora),
  }
}

/**
 * Quanto foi recuperado (§10.3).
 *
 * A definição honesta: valor dos `order.paid` de contatos que receberam um
 * envio de fluxo de recuperação nas 24 horas anteriores ao pagamento. Não é
 * atribuição de receita com modelo — a spec já diz que essa é a "versão
 * simples" (§19), e prometer mais do que se mede seria pior que não medir.
 */
async function recuperado(tx: Tx, agora: Date): Promise<number> {
  const desde = new Date(agora.getTime() - 24 * 3600 * 1000)

  /*
   * O corte ABSOLUTO em `created_at` é o que faz esta consulta ser viável.
   *
   * A condição que interessa é `n.sent_at` entre o pagamento e 24h antes dele —
   * mas ela é CORRELACIONADA com a linha do evento, e o Postgres não consegue
   * podar partição com isso: o plano vira um seq scan em TODAS as partições de
   * `notifications`, a cada carregamento do painel.
   *
   * Como só olhamos pagamentos das últimas 24h, e a mensagem de recuperação
   * precisa ter saído nas 24h anteriores ao pagamento, nada fora das últimas
   * 48h pode entrar na conta. Esse limite é constante, então a poda funciona.
   */
  const limiteParticao = new Date(agora.getTime() - 48 * 3600 * 1000).toISOString()

  const [linha] = await tx
    .select({
      total: sql<number>`COALESCE(SUM((${events.data} ->> 'valor_cents')::bigint), 0)::bigint`,
    })
    .from(events)
    .where(
      and(
        eq(events.type, 'order.paid'),
        gte(events.occurredAt, desde),
        sql`${events.contactId} IS NOT NULL`,
        // Recebeu recuperação antes de pagar.
        sql`EXISTS (
          SELECT 1 FROM ${notifications} n
          JOIN ${messages} m ON m.id = n.message_id
          WHERE n.contact_id = ${events.contactId}
            AND m.category = 'recuperacao'
            AND n.status IN ('sent','delivered','read')
            AND n.created_at >= ${limiteParticao}::timestamptz
            AND n.sent_at BETWEEN ${events.occurredAt} - interval '24 hours' AND ${events.occurredAt}
        )`,
      ),
    )

  return Number(linha?.total ?? 0)
}

export type EnvioAgendado = {
  id: string
  createdAt: Date
  channel: Channel
  scheduledFor: Date
  contactName: string | null
  messageKey: string | null
}

/**
 * Os próximos envios (§10.3) e a matéria-prima da barra de pulso (§11.6).
 *
 * A barra mostra os próximos 60 minutos; a lista, os próximos que vierem. Uma
 * consulta só serve às duas, e o índice parcial de `scheduled_for` cobre o
 * caminho inteiro.
 */
export async function proximosEnvios(
  tx: Tx,
  minutos = 60,
  limite = 200,
  agora = new Date(),
): Promise<EnvioAgendado[]> {
  const ate = new Date(agora.getTime() + minutos * 60_000)

  const linhas = await tx
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      channel: notifications.channel,
      scheduledFor: notifications.scheduledFor,
      contactName: contacts.name,
      messageKey: messages.key,
    })
    .from(notifications)
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .leftJoin(messages, eq(messages.id, notifications.messageId))
    .where(
      and(
        inArray(notifications.status, ['queued', 'scheduled']),
        gte(notifications.scheduledFor, agora),
        lte(notifications.scheduledFor, ate),
      ),
    )
    .orderBy(asc(notifications.scheduledFor))
    .limit(limite)

  return linhas.flatMap((linha) =>
    linha.scheduledFor
      ? [
          {
            id: linha.id,
            createdAt: linha.createdAt,
            channel: linha.channel,
            scheduledFor: linha.scheduledFor,
            contactName: linha.contactName,
            messageKey: linha.messageKey,
          },
        ]
      : [],
  )
}

export type SaudeCanal = {
  canal: Channel
  enviadas24h: number
  falhas24h: number
  /** 0 a 1. `null` quando não houve envio — 0% de falha mentiria. */
  taxaFalha: number | null
}

/** Taxa de falha por canal nas últimas 24h — a base do alerta de §10.4. */
export async function saudeDosCanais(tx: Tx, agora = new Date()): Promise<SaudeCanal[]> {
  const desde = new Date(agora.getTime() - 24 * 3600 * 1000)

  const linhas = await tx
    .select({
      channel: notifications.channel,
      enviadas: sql<number>`count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int`,
      falhas: sql<number>`count(*) FILTER (WHERE status IN ('failed','dead'))::int`,
    })
    .from(notifications)
    .where(gte(notifications.createdAt, desde))
    .groupBy(notifications.channel)

  const porCanal = new Map(linhas.map((l) => [l.channel, l]))

  return CHANNELS.map((canal) => {
    const linha = porCanal.get(canal)
    const enviadas = linha?.enviadas ?? 0
    const falhas = linha?.falhas ?? 0
    const total = enviadas + falhas

    return {
      canal,
      enviadas24h: enviadas,
      falhas24h: falhas,
      taxaFalha: total === 0 ? null : falhas / total,
    }
  })
}
