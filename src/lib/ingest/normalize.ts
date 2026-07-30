import 'server-only'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, withTenant, type Tx } from '@/db'
import { contacts, events, eventsRaw, sources } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import { processarEvento } from '@/lib/flows/run'
import { applyMapping, type NormalizedContact } from './mapping'

/**
 * Transforma `events_raw` em `events` canônicos e mantém o contato (§4.3).
 *
 * Roda no worker, nunca na requisição do webhook: o ACK precisa ficar abaixo
 * de 50 ms (§13.1) e isto aqui faz upsert de contato e escrita em duas tabelas
 * particionadas.
 */

const log = createLogger('normalize')

export type NormalizeOutcome =
  | { status: 'processado'; eventId: number; type: string; contactId: string | null }
  | { status: 'ignorado'; motivo: string }
  | { status: 'erro'; motivo: string }

/**
 * Cria ou atualiza o contato a partir do que veio no evento.
 *
 * A chave de identidade é, em ordem: id externo, telefone, e-mail. Essa ordem
 * importa — a plataforma pode trocar o telefone de um cadastro, e o id externo
 * é o único identificador estável.
 *
 * Campos vazios nunca sobrescrevem valores existentes: um evento que não traz
 * e-mail não pode apagar o e-mail que já tínhamos.
 */
async function upsertContact(
  tx: Tx,
  orgId: string,
  dados: NormalizedContact,
  ocorridoEm: Date,
): Promise<string | null> {
  const temIdentidade = dados.externalId || dados.phoneE164 || dados.email
  if (!temIdentidade) return null

  const condicoes = []
  if (dados.externalId) condicoes.push(eq(contacts.externalId, dados.externalId))
  if (dados.phoneE164) condicoes.push(eq(contacts.phoneE164, dados.phoneE164))
  if (dados.email) condicoes.push(eq(contacts.email, dados.email))

  const [existente] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), sql`(${sql.join(condicoes, sql` OR `)})`))
    .limit(1)

  if (existente) {
    // COALESCE do lado do banco: só preenche o que está nulo, exceto quando o
    // evento traz valor novo para o campo.
    await tx
      .update(contacts)
      .set({
        name: dados.name ?? undefined,
        phoneE164: dados.phoneE164 ?? undefined,
        email: dados.email ?? undefined,
        cpf: dados.cpf ?? undefined,
        externalId: dados.externalId ?? undefined,
        telegramChatId: dados.telegramChatId ?? undefined,
        lastEventAt: ocorridoEm,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, existente.id))
    return existente.id
  }

  const [criado] = await tx
    .insert(contacts)
    .values({
      orgId,
      externalId: dados.externalId ?? null,
      name: dados.name ?? null,
      phoneE164: dados.phoneE164 ?? null,
      email: dados.email ?? null,
      cpf: dados.cpf ?? null,
      telegramChatId: dados.telegramChatId ?? null,
      firstSeenAt: ocorridoEm,
      lastEventAt: ocorridoEm,
    })
    .returning({ id: contacts.id })

  return criado?.id ?? null
}

/** Processa um registro de `events_raw`. Idempotente por `rawId`. */
export async function normalizeRawEvent(rawId: number): Promise<NormalizeOutcome> {
  const [raw] = await db
    .select({
      id: eventsRaw.id,
      sourceId: eventsRaw.sourceId,
      payload: eventsRaw.payload,
      receivedAt: eventsRaw.receivedAt,
      processedAt: eventsRaw.processedAt,
    })
    .from(eventsRaw)
    .where(eq(eventsRaw.id, rawId))
    .limit(1)

  if (!raw) return { status: 'erro', motivo: 'evento_cru_nao_encontrado' }
  if (raw.processedAt) return { status: 'ignorado', motivo: 'ja_processado' }
  if (!raw.sourceId) return { status: 'erro', motivo: 'sem_conector' }

  const [source] = await db
    .select({ id: sources.id, orgId: sources.orgId, mapping: sources.mapping })
    .from(sources)
    .where(eq(sources.id, raw.sourceId))
    .limit(1)

  if (!source) return { status: 'erro', motivo: 'conector_removido' }

  const resultado = applyMapping(raw.payload, source.mapping)

  if (!resultado.ok) {
    // Evento que não interessa não é falha: a plataforma manda tudo, e o mapa
    // define o que o sistema entende. Fica registrado para a tela de conexão
    // mostrar o que está chegando e não sendo aproveitado.
    await db
      .update(eventsRaw)
      .set({ processedAt: new Date(), error: `${resultado.failure.reason}: ${resultado.failure.detail}` })
      .where(eq(eventsRaw.id, rawId))

    return { status: 'ignorado', motivo: resultado.failure.reason }
  }

  const normalizado = resultado.event
  const ocorridoEm = raw.receivedAt

  try {
    const eventId = await withTenant(
      // O worker age em nome do sistema, não de um usuário: isAdmin garante
      // que nenhuma política por dono bloqueie a ingestão.
      { orgId: source.orgId, userId: source.orgId, isAdmin: true },
      async (tx) => {
        const contactId = await upsertContact(tx, source.orgId, normalizado.contact, ocorridoEm)

        const [gravado] = await tx
          .insert(events)
          .values({
            orgId: source.orgId,
            sourceId: source.id,
            type: normalizado.type,
            externalId: normalizado.externalId ?? null,
            contactId,
            occurredAt: ocorridoEm,
            data: normalizado.data,
            rawId: raw.id,
          })
          // O índice único (source, type, external_id, occurred_at) protege
          // contra o mesmo evento entrar duas vezes por caminhos diferentes.
          .onConflictDoNothing()
          .returning({ id: events.id, contactId: events.contactId })

        return gravado ?? null
      },
    )

    await db.update(eventsRaw).set({ processedAt: new Date() }).where(eq(eventsRaw.id, rawId))

    if (!eventId) return { status: 'ignorado', motivo: 'evento_duplicado' }

    // Sem dado pessoal: só identificadores (§14.1).
    log.info('evento normalizado', { rawId, eventId: eventId.id, type: normalizado.type })

    /*
     * O evento normalizado entra no motor de cadência (§5): cancela o que este
     * evento cancela e dispara os fluxos que ele aciona.
     *
     * Transação SEPARADA da gravação de propósito. O evento já está no banco e
     * `events_raw` já está marcado como processado; se um fluxo tiver defeito,
     * o que se perde é o disparo, não o registro do que aconteceu. Juntar as
     * duas faria um fluxo quebrado apagar o histórico da ingestão.
     */
    const cadencia = await withTenant(
      { orgId: source.orgId, userId: source.orgId, isAdmin: true },
      (tx) =>
        processarEvento(tx, {
          orgId: source.orgId,
          tipo: normalizado.type,
          contactId: eventId.contactId,
          eventId: eventId.id,
          // As variáveis das mensagens e a chave de cancelamento saem daqui.
          dados: { ...normalizado.data, external_id: normalizado.externalId ?? null, contact_id: eventId.contactId },
        }),
    ).catch((erro: unknown) => {
      log.error('falha no motor de cadência', {
        eventId: eventId.id,
        reason: erro instanceof Error ? erro.message : 'desconhecido',
      })
      return null
    })

    if (cadencia) {
      log.info('cadência processada', {
        eventId: eventId.id,
        cancelados: cadencia.cancelados,
        disparados: cadencia.fluxos.filter((f) => f.disparado).length,
      })
    }

    return {
      status: 'processado',
      eventId: eventId.id,
      type: normalizado.type,
      contactId: eventId.contactId,
    }
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error)
    await db.update(eventsRaw).set({ error: motivo.slice(0, 500) }).where(eq(eventsRaw.id, rawId))
    log.error('falha ao normalizar', { rawId, reason: motivo })
    return { status: 'erro', motivo }
  }
}

/**
 * Recupera eventos que ficaram para trás.
 *
 * O endpoint grava e enfileira em passos separados de propósito: se o Redis
 * estiver fora, o evento já está salvo e o ACK sai mesmo assim. Esta varredura
 * é o que garante que ele acabe processado.
 */
export async function reprocessPending(limite = 100): Promise<number> {
  const pendentes = await db
    .select({ id: eventsRaw.id })
    .from(eventsRaw)
    .where(and(isNull(eventsRaw.processedAt), isNull(eventsRaw.error)))
    .limit(limite)

  let processados = 0
  for (const pendente of pendentes) {
    const resultado = await normalizeRawEvent(pendente.id)
    if (resultado.status === 'processado') processados += 1
  }

  return processados
}
