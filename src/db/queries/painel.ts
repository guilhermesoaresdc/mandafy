import { and, asc, count, eq, gte, inArray, lte, min, sql } from 'drizzle-orm'
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
  /** A hora marcada da mensagem vencida mais antiga que continua esperando. */
  vencidaDesde: Date | null
  falhas24h: number
  recuperadoCents: number

  /*
   * O QUE A OPERAÇÃO VENDEU, e não só o que o motor mandou.
   *
   * O painel abria com cinco números sobre o próprio Mandafy — enviadas, taxa
   * de entrega, fila, falhas. Todos úteis para saber se o sistema está de pé, e
   * nenhum deles responde à primeira pergunta de quem toca uma banca: quanto
   * entrou hoje e quantos clientes novos chegaram. Esses dois números existiam
   * no banco desde a Fase 2, em `events`, e não apareciam em tela nenhuma.
   */
  /** Soma dos `order.paid` de hoje. É o faturamento do dia. */
  compradoHojeCents: number
  /** Quantas apostas foram pagas hoje. */
  comprasHoje: number
  /** Quantos `user.created` chegaram hoje. */
  cadastrosHoje: number
  /** Os mesmos três ontem, para a comparação. */
  compradoOntemCents: number
  cadastrosOntem: number
  /**
   * Quanto a banca PAGOU em prêmio hoje.
   *
   * Sem ele, o painel mostrava só o dinheiro entrando — e faturamento sem o
   * prêmio ao lado não diz como foi o dia. Um dia de R$ 3 mil vendidos com R$ 5
   * mil premiados é um prejuízo que a tela apresentava como recorde.
   */
  premiadoHojeCents: number
  premiosHoje: number
}

/** O que conta como "saiu" para a taxa de entrega. */
const SAIU: NotificationStatus[] = ['sent', 'delivered', 'read']
const CONFIRMADO: NotificationStatus[] = ['delivered', 'read']
const FALHOU: NotificationStatus[] = ['failed', 'dead']

function diaUtc(instante: Date): string {
  return instante.toISOString().slice(0, 10)
}

/** O fuso da banca. "Hoje" é o dia de quem opera, não o do servidor. */
const FUSO_OPERACAO = process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo'

/** `2026-08-08` no fuso da operação — a mesma chave que o SQL agrupa. */
function diaLocal(instante: Date): string {
  return instante.toLocaleDateString('en-CA', { timeZone: FUSO_OPERACAO })
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

  /*
   * A VENCIDA MAIS ANTIGA.
   *
   * "500 na fila" não distingue uma operação movimentada de uma operação
   * parada: a fila cheia é normal às 19h de um sábado de sorteio. O que não é
   * normal é uma mensagem cuja hora marcada já passou continuar esperando —
   * isso só acontece quando o batimento não está vazando a fila, e é o número
   * que separa "tem muita coisa para sair" de "não está saindo nada".
   */
  const [vencida] = await tx
    .select({ quando: min(notifications.scheduledFor) })
    .from(notifications)
    .where(
      and(
        inArray(notifications.status, ['queued', 'scheduled']),
        lte(notifications.scheduledFor, agora),
      ),
    )

  const [falhas] = await tx
    .select({ total: count() })
    .from(notifications)
    .where(
      and(
        gte(notifications.createdAt, new Date(agora.getTime() - 24 * 3600 * 1000)),
        inArray(notifications.status, FALHOU),
      ),
    )

  const negocio = await movimentoDoDia(tx, agora)

  return {
    enviadasHoje: saiuHoje,
    taxaEntrega: saiuHoje === 0 ? null : confirmado / saiuHoje,
    naFila: fila?.total ?? 0,
    vencidaDesde: vencida?.quando ?? null,
    falhas24h: falhas?.total ?? 0,
    recuperadoCents: await recuperado(tx, agora),
    ...negocio,
  }
}

/**
 * Compras e cadastros de hoje e de ontem, numa consulta só.
 *
 * O CORTE É O DIA DE BRASÍLIA, e não as últimas 24 horas.
 *
 * "Quanto vendi hoje" é uma pergunta sobre o dia do calendário de quem
 * pergunta. Uma janela móvel de 24h responde outra coisa — às 9h da manhã ela
 * incluiria metade do movimento de ontem, que é justamente o dia com que a
 * pessoa quer comparar. `AT TIME ZONE` faz o agrupamento no fuso da operação.
 *
 * Dois dias de `events` é uma partição ou duas: o `occurred_at >= ontem` poda o
 * resto, e sem esse corte a soma varreria a tabela inteira a cada carregamento
 * do painel (§13.2).
 */
async function movimentoDoDia(
  tx: Tx,
  agora: Date,
): Promise<{
  compradoHojeCents: number
  comprasHoje: number
  cadastrosHoje: number
  compradoOntemCents: number
  cadastrosOntem: number
  premiadoHojeCents: number
  premiosHoje: number
}> {
  const desde = new Date(agora.getTime() - 48 * 3600 * 1000).toISOString()

  const linhas = await tx.execute<{
    dia: string
    pagos: number
    valor: string | number | null
    cadastros: number
    premios: number
    premiado: string | number | null
  }>(sql`
    SELECT
      (occurred_at AT TIME ZONE ${FUSO_OPERACAO})::date::text AS dia,
      count(*) FILTER (WHERE type = 'order.paid')::int AS pagos,
      COALESCE(SUM((data ->> 'valor_cents')::bigint) FILTER (WHERE type = 'order.paid'), 0) AS valor,
      count(*) FILTER (WHERE type = 'user.created')::int AS cadastros,
      count(*) FILTER (WHERE type = 'ticket.awarded')::int AS premios,
      -- O prêmio pode chegar em retorno_cents (quanto a aposta paga) ou em
      -- valor_cents (quanto foi creditado): depende de como a plataforma nomeia
      -- no evento de premiação. O COALESCE aceita os dois, na ordem em que o
      -- mapeamento sugerido os coloca. Sem isso, metade das bancas veria
      -- "R$ 0,00 em prêmios" com o dinheiro tendo saído.
      COALESCE(SUM(
        COALESCE((data ->> 'retorno_cents')::bigint, (data ->> 'valor_cents')::bigint)
      ) FILTER (WHERE type = 'ticket.awarded'), 0) AS premiado
    FROM events
    WHERE occurred_at >= ${desde}::timestamptz
      AND type IN ('order.paid', 'user.created', 'ticket.awarded')
    GROUP BY 1
  `)

  const hoje = diaLocal(agora)
  const ontem = diaLocal(new Date(agora.getTime() - 24 * 3600 * 1000))
  const doDia = (dia: string) => linhas.find((l) => l.dia === dia)

  return {
    compradoHojeCents: Number(doDia(hoje)?.valor ?? 0),
    comprasHoje: doDia(hoje)?.pagos ?? 0,
    cadastrosHoje: doDia(hoje)?.cadastros ?? 0,
    compradoOntemCents: Number(doDia(ontem)?.valor ?? 0),
    cadastrosOntem: doDia(ontem)?.cadastros ?? 0,
    premiadoHojeCents: Number(doDia(hoje)?.premiado ?? 0),
    premiosHoje: doDia(hoje)?.premios ?? 0,
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

export type DiaDoMovimento = {
  /** `2026-08-08`, no fuso da operação. */
  dia: string
  /** `08/08` — o rótulo curto do eixo. */
  rotulo: string
  cadastros: number
  compras: number
  valorCents: number
}

/**
 * O movimento dia a dia — a matéria-prima dos gráficos de evolução.
 *
 * Uma consulta para as duas curvas: cadastro e compra saem da mesma varredura
 * de `events`, e separá-las em duas consultas dobraria a leitura da tabela mais
 * escrita do sistema por nenhuma vantagem.
 *
 * Os dias SEM movimento entram com zero. Sem isso a curva ligaria segunda a
 * quinta como se quarta não existisse — e um fim de semana parado viraria uma
 * subida suave em vez do buraco que é.
 */
export async function movimentoPorDia(
  tx: Tx,
  dias = 14,
  agora = new Date(),
): Promise<DiaDoMovimento[]> {
  const desde = new Date(agora.getTime() - dias * 24 * 3600 * 1000)

  const linhas = await tx.execute<{
    dia: string
    cadastros: number
    compras: number
    valor: string | number | null
  }>(sql`
    SELECT
      (occurred_at AT TIME ZONE ${FUSO_OPERACAO})::date::text AS dia,
      count(*) FILTER (WHERE type = 'user.created')::int AS cadastros,
      count(*) FILTER (WHERE type = 'order.paid')::int AS compras,
      COALESCE(SUM((data ->> 'valor_cents')::bigint) FILTER (WHERE type = 'order.paid'), 0) AS valor
    FROM events
    WHERE occurred_at >= ${desde.toISOString()}::timestamptz
      AND type IN ('order.paid', 'user.created')
    GROUP BY 1
  `)

  const porDia = new Map(linhas.map((l) => [l.dia, l]))
  const saida: DiaDoMovimento[] = []

  for (let i = dias - 1; i >= 0; i -= 1) {
    const data = new Date(agora.getTime() - i * 24 * 3600 * 1000)
    const dia = diaLocal(data)
    const linha = porDia.get(dia)

    saida.push({
      dia,
      rotulo: data.toLocaleDateString('pt-BR', {
        timeZone: FUSO_OPERACAO,
        day: '2-digit',
        month: '2-digit',
      }),
      cadastros: linha?.cadastros ?? 0,
      compras: linha?.compras ?? 0,
      valorCents: Number(linha?.valor ?? 0),
    })
  }

  return saida
}

export type FunilDoPeriodo = {
  dias: number
  cadastros: number
  apostas: number
  pagas: number
  premiadas: number
}

/**
 * De cadastro a prêmio: onde a operação perde gente (§10.3).
 *
 * As quatro contagens são de EVENTOS, não de pessoas distintas — e a diferença
 * está declarada no rótulo da tela. Contar pessoas exigiria `count(distinct
 * contact_id)` sobre a tabela mais quente do banco, quatro vezes, a cada
 * carregamento do painel; e a leitura que interessa ("de cada dez apostas,
 * quantas são pagas") é sobre apostas mesmo.
 */
export async function funilDoPeriodo(
  tx: Tx,
  dias = 7,
  agora = new Date(),
): Promise<FunilDoPeriodo> {
  const desde = new Date(agora.getTime() - dias * 24 * 3600 * 1000)

  const [linha] = await tx
    .select({
      cadastros: sql<number>`count(*) FILTER (WHERE type = 'user.created')::int`,
      apostas: sql<number>`count(*) FILTER (WHERE type = 'order.created')::int`,
      pagas: sql<number>`count(*) FILTER (WHERE type = 'order.paid')::int`,
      premiadas: sql<number>`count(*) FILTER (WHERE type = 'ticket.awarded')::int`,
    })
    .from(events)
    .where(
      and(
        gte(events.occurredAt, desde),
        inArray(events.type, ['user.created', 'order.created', 'order.paid', 'ticket.awarded']),
      ),
    )

  return {
    dias,
    cadastros: linha?.cadastros ?? 0,
    apostas: linha?.apostas ?? 0,
    pagas: linha?.pagas ?? 0,
    premiadas: linha?.premiadas ?? 0,
  }
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
