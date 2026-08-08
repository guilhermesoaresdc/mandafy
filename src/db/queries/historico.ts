import { and, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, messages, notifications } from '@/db/schema'
import { CHANNELS, NOTIFICATION_STATUSES, type Channel, type NotificationStatus } from '@/db/schema/enums'

/**
 * Histórico de envios (§10.1).
 *
 * A camada quente são 3 dias em partições diárias. Toda consulta carrega um
 * recorte de tempo — sem ele o Postgres varreria todas as partições, e o alvo
 * de 200ms de §13.1 morre na primeira semana de operação.
 */

/**
 * Lê uma lista de um `searchParams` ou de uma query string, descartando o que
 * não existe.
 *
 * Mora AQUI e não na rota SSE porque agora há três leitores do mesmo filtro —
 * a página, a rota de eventos e o link do CSV — e dois validadores para o mesmo
 * parâmetro é como duas telas passam a discordar sobre o que `status=falhou`
 * quer dizer. Devolve `undefined` quando não sobra nada válido: filtro vazio é
 * ausência de filtro, não filtro que não casa com nada.
 */
export function paramLista<T extends string>(
  valor: string | null | undefined,
  validos: readonly T[],
): T[] | undefined {
  if (!valor) return undefined
  const itens = valor.split(',').filter((v): v is T => (validos as readonly string[]).includes(v))
  return itens.length > 0 ? itens : undefined
}

export type FiltroHistorico = {
  canais?: readonly Channel[]
  status?: readonly NotificationStatus[]
  /** Horas para trás. O padrão são os 3 dias da camada quente. */
  horas?: number
  /** Nome, telefone ou e-mail do contato. */
  busca?: string
  /** Só os leads deste consultor (§9.4). */
  ownerId?: string | null
  limite?: number
  /** Paginação por cursor: traz o que é mais antigo que este instante. */
  antesDe?: Date | null
}

export type LinhaHistorico = {
  id: string
  createdAt: Date
  channel: Channel
  status: NotificationStatus
  contactId: string | null
  contactName: string | null
  messageKey: string | null
  /**
   * O nome que a pessoa deu à mensagem.
   *
   * Vem JUNTO com a chave, e não no lugar dela: a tela de operação mostra o
   * nome ("Lembrete de PIX"), o CSV e a API continuam exportando a chave
   * (`pix_lembrete_1`), que é contrato com quem integra. Antes só havia a
   * chave, e procurar "Lembrete de PIX" no histórico não achava nada — a
   * linha se chamava outra coisa.
   */
  messageName: string | null
  scheduledFor: Date | null
  sentAt: Date | null
  deliveredAt: Date | null
  errorCode: string | null
  /** Milissegundos entre a tentativa e a confirmação — a coluna "1.2s". */
  latenciaMs: number | null
}

const HORAS_PADRAO = 72

function condicoes(filtro: FiltroHistorico, agora: Date): SQL[] {
  const desde = new Date(agora.getTime() - (filtro.horas ?? HORAS_PADRAO) * 3600 * 1000)
  const lista: SQL[] = [gte(notifications.createdAt, desde)]

  if (filtro.antesDe) lista.push(lt(notifications.createdAt, filtro.antesDe))

  // Filtro vazio e filtro completo dão no mesmo; não vale gastar um IN com
  // todos os valores possíveis.
  if (filtro.canais?.length && filtro.canais.length < CHANNELS.length) {
    lista.push(inArray(notifications.channel, [...filtro.canais]))
  }

  if (filtro.status?.length && filtro.status.length < NOTIFICATION_STATUSES.length) {
    lista.push(inArray(notifications.status, [...filtro.status]))
  }

  if (filtro.busca && filtro.busca.trim() !== '') {
    const termo = `%${filtro.busca.trim()}%`
    /*
     * A busca vai por subconsulta em `contacts` em vez de join: `notifications`
     * é a tabela de maior volume, e um join com ILIKE nela obrigaria o
     * planejador a materializar o resultado antes de recortar o tempo.
     */
    const encontrados = sql`(
      SELECT c.id FROM ${contacts} c
      WHERE c.org_id = ${notifications.orgId}
        AND (c.name ILIKE ${termo} OR c.phone_e164 ILIKE ${termo} OR c.email ILIKE ${termo})
    )`
    lista.push(sql`${notifications.contactId} IN ${encontrados}` as SQL)
  }

  if (filtro.ownerId) {
    // Consultor só vê o que saiu para os leads dele (§9.4). O RLS já protege o
    // banco; isto é o recorte da tela.
    lista.push(
      sql`${notifications.contactId} IN (
        SELECT l.contact_id FROM leads l WHERE l.owner_id = ${filtro.ownerId}
      )` as SQL,
    )
  }

  return lista
}

export async function listarHistorico(
  tx: Tx,
  filtro: FiltroHistorico = {},
  agora = new Date(),
): Promise<LinhaHistorico[]> {
  const linhas = await tx
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      channel: notifications.channel,
      status: notifications.status,
      contactId: notifications.contactId,
      contactName: contacts.name,
      messageKey: messages.key,
      messageName: messages.name,
      scheduledFor: notifications.scheduledFor,
      attemptedAt: notifications.attemptedAt,
      sentAt: notifications.sentAt,
      deliveredAt: notifications.deliveredAt,
      errorCode: notifications.errorCode,
    })
    .from(notifications)
    // leftJoin: contato ou mensagem apagados não podem sumir com a linha do
    // log — o histórico é justamente o que sobrevive à exclusão.
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .leftJoin(messages, eq(messages.id, notifications.messageId))
    .where(and(...condicoes(filtro, agora)))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(filtro.limite ?? 100, 500))

  return linhas.map((linha) => ({
    id: linha.id,
    createdAt: linha.createdAt,
    channel: linha.channel,
    status: linha.status,
    contactId: linha.contactId,
    contactName: linha.contactName,
    messageKey: linha.messageKey,
    messageName: linha.messageName,
    scheduledFor: linha.scheduledFor,
    sentAt: linha.sentAt,
    deliveredAt: linha.deliveredAt,
    errorCode: linha.errorCode,
    latenciaMs: latencia(linha.attemptedAt, linha.sentAt, linha.deliveredAt),
  }))
}

/**
 * QUANTAS LINHAS EXISTEM, e não quantas couberam.
 *
 * O rodapé imprimia "200 de 200" porque contava o que tinha na memória do
 * navegador — o mesmo número dos dois lados da frase, sempre, qualquer que
 * fosse o tamanho da operação. Uma tela que não sabe dizer que está mostrando
 * uma fatia é uma tela em que "não achei" e "não existe" viram a mesma coisa.
 */
export async function contarHistorico(
  tx: Tx,
  filtro: FiltroHistorico = {},
  agora = new Date(),
): Promise<number> {
  const [linha] = await tx
    .select({ total: count() })
    .from(notifications)
    .where(and(...condicoes(filtro, agora)))

  return linha?.total ?? 0
}

/**
 * Quanto tempo levou.
 *
 * Da tentativa até a confirmação mais avançada que existir. Medir a partir de
 * `created_at` misturaria o atraso do jitter — que pode ser 20 horas — com a
 * latência do provedor, e a coluna deixaria de significar qualquer coisa.
 */
function latencia(
  attemptedAt: Date | null,
  sentAt: Date | null,
  deliveredAt: Date | null,
): number | null {
  if (!attemptedAt) return null
  const fim = deliveredAt ?? sentAt
  if (!fim) return null

  const ms = fim.getTime() - attemptedAt.getTime()
  return ms >= 0 ? ms : null
}

export type DetalheNotificacao = {
  id: string
  createdAt: Date
  channel: Channel
  status: NotificationStatus
  contactName: string | null
  contactId: string | null
  messageKey: string | null
  /**
   * O nome que a pessoa deu à mensagem.
   *
   * Vem JUNTO com a chave, e não no lugar dela: a tela de operação mostra o
   * nome ("Lembrete de PIX"), o CSV e a API continuam exportando a chave
   * (`pix_lembrete_1`), que é contrato com quem integra. Antes só havia a
   * chave, e procurar "Lembrete de PIX" no histórico não achava nada — a
   * linha se chamava outra coisa.
   */
  messageName: string | null
  messageId: string | null
  renderedSubject: string | null
  /** Exatamente o que saiu (§6.5). */
  renderedBody: string | null
  provider: string | null
  providerMessageId: string | null
  providerInstance: string | null
  attempts: number
  errorCode: string | null
  errorMessage: string | null
  scheduledFor: Date | null
  attemptedAt: Date | null
  sentAt: Date | null
  deliveredAt: Date | null
  readAt: Date | null
  cancelKey: string | null
  latenciaMs: number | null
}

export async function detalharNotificacao(
  tx: Tx,
  id: string,
  criadoEm: Date,
): Promise<DetalheNotificacao | null> {
  const [linha] = await tx
    .select({
      n: notifications,
      contactName: contacts.name,
      messageKey: messages.key,
      messageName: messages.name,
    })
    .from(notifications)
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .leftJoin(messages, eq(messages.id, notifications.messageId))
    // A coluna de partição entra no where para o Postgres podar as demais.
    .where(and(eq(notifications.id, id), eq(notifications.createdAt, criadoEm)))
    .limit(1)

  if (!linha) return null

  const n = linha.n
  return {
    id: n.id,
    createdAt: n.createdAt,
    channel: n.channel,
    status: n.status,
    contactName: linha.contactName,
    contactId: n.contactId,
    messageKey: linha.messageKey,
    messageName: linha.messageName,
    messageId: n.messageId,
    renderedSubject: n.renderedSubject,
    renderedBody: n.renderedBody,
    provider: n.provider,
    providerMessageId: n.providerMessageId,
    providerInstance: n.providerInstance,
    attempts: n.attempts,
    errorCode: n.errorCode,
    errorMessage: n.errorMessage,
    scheduledFor: n.scheduledFor,
    attemptedAt: n.attemptedAt,
    sentAt: n.sentAt,
    deliveredAt: n.deliveredAt,
    readAt: n.readAt,
    cancelKey: n.cancelKey,
    latenciaMs: latencia(n.attemptedAt, n.sentAt, n.deliveredAt),
  }
}

/**
 * Só o que mudou desde o último instante conhecido — a fonte do SSE (§10.1).
 *
 * `desde` é exclusivo para não reenviar a última linha a cada tique.
 */
export async function novidadesDesde(
  tx: Tx,
  desde: Date,
  filtro: Omit<FiltroHistorico, 'antesDe'> = {},
  agora = new Date(),
): Promise<LinhaHistorico[]> {
  const base = condicoes({ ...filtro, horas: 24 }, agora).filter(Boolean)

  const linhas = await tx
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      channel: notifications.channel,
      status: notifications.status,
      contactId: notifications.contactId,
      contactName: contacts.name,
      messageKey: messages.key,
      messageName: messages.name,
      scheduledFor: notifications.scheduledFor,
      attemptedAt: notifications.attemptedAt,
      sentAt: notifications.sentAt,
      deliveredAt: notifications.deliveredAt,
      errorCode: notifications.errorCode,
    })
    .from(notifications)
    .leftJoin(contacts, eq(contacts.id, notifications.contactId))
    .leftJoin(messages, eq(messages.id, notifications.messageId))
    .where(
      and(
        ...base,
        /*
         * Criada OU atualizada depois do corte. A segunda metade é o que faz a
         * linha "enviando → entregue" chegar ao vivo: sem ela, só apareceriam
         * envios novos, e o status de quem já está na tela ficaria congelado.
         */
        or(
          gte(notifications.createdAt, desde),
          gte(notifications.attemptedAt, desde),
          gte(notifications.sentAt, desde),
          gte(notifications.deliveredAt, desde),
        ),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(200)

  return linhas.map((linha) => ({
    id: linha.id,
    createdAt: linha.createdAt,
    channel: linha.channel,
    status: linha.status,
    contactId: linha.contactId,
    contactName: linha.contactName,
    messageKey: linha.messageKey,
    messageName: linha.messageName,
    scheduledFor: linha.scheduledFor,
    sentAt: linha.sentAt,
    deliveredAt: linha.deliveredAt,
    errorCode: linha.errorCode,
    latenciaMs: latencia(linha.attemptedAt, linha.sentAt, linha.deliveredAt),
  }))
}
