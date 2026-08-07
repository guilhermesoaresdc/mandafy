import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db, withTenant, type Tx } from '@/db'
import { contacts, events } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import { processarEvento } from '@/lib/flows/run'
import { criarLeadDoEvento } from '@/lib/crm/criar-lead'
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
  /*
   * A leitura passa por função SECURITY DEFINER (drizzle/0023).
   *
   * Quem normaliza roda FORA de qualquer sessão — é o worker, ou a varredura do
   * batimento. Sem `app.org_id`, a política de `sources` compara org_id com
   * nulo e `events_raw` herda dela: o SELECT direto devolvia ZERO LINHAS, o
   * código concluía `evento_cru_nao_encontrado`, e o evento ficava pendente
   * para sempre. A tela dizia "recebido", o fluxo nunca disparava, e não havia
   * erro em lugar nenhum. É a mesma parede de 0015 e 0016, um passo adiante.
   */
  const [bruto] = await db.execute<{
    id: string
    source_id: string | null
    org_id: string
    mapping: unknown
    payload: unknown
    received_at: string
    processed_at: string | null
  }>(sql`SELECT * FROM mandafy_evento_cru(${rawId})`)

  /*
   * OS DOIS ERROS ABAIXO PRECISAM MARCAR A LINHA, e não marcavam.
   *
   * Eles são os únicos caminhos de saída daqui que não passavam por
   * `marcarProcessado` — e o efeito era o pior possível: o evento continuava
   * com `processed_at` e `error` nulos, que é exatamente o que a varredura de
   * pendentes procura. Ela o pegava de novo no minuto seguinte, e no seguinte,
   * para sempre.
   *
   * Na tela, ele ficava "na fila" indefinidamente. Não "não aproveitado", que
   * mandaria olhar o mapeamento; "na fila", que diz "aguarde". O batimento
   * respondia 200 com `normalizados: 0`, o painel dizia que o evento nunca
   * chegou, e não havia erro em lugar nenhum para procurar.
   *
   * Um evento que o sistema não consegue ler não é um evento pendente: é um
   * evento com defeito, e precisa dizer isso.
   */
  if (!bruto) {
    await marcarProcessado(rawId, 'evento_cru_nao_encontrado: a linha sumiu ou a origem foi removida')
    return { status: 'erro', motivo: 'evento_cru_nao_encontrado' }
  }

  if (bruto.processed_at) return { status: 'ignorado', motivo: 'ja_processado' }

  if (!bruto.source_id) {
    await marcarProcessado(rawId, 'sem_conector: o evento chegou sem origem vinculada')
    return { status: 'erro', motivo: 'sem_conector' }
  }

  const raw = {
    id: Number(bruto.id),
    payload: comoObjeto(bruto.payload),
    receivedAt: new Date(bruto.received_at),
  }
  const source = {
    id: bruto.source_id,
    orgId: bruto.org_id,
    mapping: comoObjeto(bruto.mapping),
  }

  const resultado = applyMapping(raw.payload, source.mapping)

  if (!resultado.ok) {
    // Evento que não interessa não é falha: a plataforma manda tudo, e o mapa
    // define o que o sistema entende. Fica registrado para a tela de conexão
    // mostrar o que está chegando e não sendo aproveitado.
    await marcarProcessado(rawId, `${resultado.failure.reason}: ${resultado.failure.detail}`)

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

    await marcarProcessado(rawId, null)

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

    /*
     * Criação automática de lead (§9.3), também em transação separada. Um lead
     * é sobre a pessoa; a cadência é sobre a mensagem. Falha de um não pode
     * levar o outro — e nenhum dos dois pode desfazer o registro do evento.
     */
    const leads = await withTenant(
      { orgId: source.orgId, userId: source.orgId, isAdmin: true },
      (tx) =>
        criarLeadDoEvento(tx, {
          orgId: source.orgId,
          tipo: normalizado.type,
          contactId: eventId.contactId,
          dados: normalizado.data,
        }),
    ).catch((erro: unknown) => {
      log.error('falha ao criar lead', {
        eventId: eventId.id,
        reason: erro instanceof Error ? erro.message : 'desconhecido',
      })
      return []
    })

    const criados = leads.filter((r) => r.criado).length
    if (criados > 0) log.info('leads criados', { eventId: eventId.id, criados })

    return {
      status: 'processado',
      eventId: eventId.id,
      type: normalizado.type,
      contactId: eventId.contactId,
    }
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error)
    await marcarProcessado(rawId, motivo.slice(0, 500))
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
export type VarreduraPendentes = {
  /** Quantos viraram evento canônico nesta passagem. */
  processados: number
  /** Quantos estavam pendentes quando a varredura começou. */
  vistos: number
  /**
   * Quantos de cada desfecho — e é isto que responde "por que zero?".
   *
   * `normalizados: 0` é ambíguo do jeito mais caro possível: significa "não
   * havia nada a fazer" e também "havia, e nada deu certo". Enquanto a
   * varredura devolvia só um número, as duas situações eram a mesma linha na
   * resposta do batimento — e a segunda ficou meses invisível.
   */
  motivos: Record<string, number>
}

export async function reprocessPending(limite = 100): Promise<VarreduraPendentes> {
  /*
   * Também por função (drizzle/0023), e pelo mesmo motivo do resto: sem
   * contexto de tenant esta consulta devolvia zero linhas e a varredura
   * concluía que não havia nada pendente. Ela rodava desde sempre, sem nunca
   * ter processado um evento — a falha mais silenciosa possível, porque o
   * número zero é indistinguível de "estava tudo em dia".
   */
  const pendentes = await db.execute<{ id: string }>(
    sql`SELECT id FROM mandafy_eventos_crus_pendentes(${limite})`,
  )

  let processados = 0
  const motivos: Record<string, number> = {}

  for (const pendente of pendentes) {
    const resultado = await normalizeRawEvent(Number(pendente.id))

    if (resultado.status === 'processado') {
      processados += 1
      continue
    }

    // O motivo, e não só a contagem: `mapeamento_invalido` manda ajustar o
    // passo 3 da tela de conexão, `sem_conector` manda olhar a origem, e
    // `evento_cru_nao_encontrado` é defeito nosso. Três correções diferentes.
    const chave = resultado.motivo ?? resultado.status
    motivos[chave] = (motivos[chave] ?? 0) + 1
  }

  if (pendentes.length > 0 && processados === 0) {
    log.warn('varredura achou pendentes e não normalizou nenhum', {
      vistos: pendentes.length,
      motivos,
    })
  }

  return { processados, vistos: pendentes.length, motivos }
}

/**
 * `jsonb` vindo de função volta como TEXTO, não como objeto.
 *
 * Lendo a coluna direto, o driver conhece o tipo e entrega o objeto pronto.
 * Lendo o retorno de uma função, ele recebe o valor sem o OID da coluna e
 * devolve a string crua. O sintoma foi `mapeamento_invalido` em todo evento —
 * "esperava objeto, recebi string" —, que na tela vira "chegou, mas não foi
 * aproveitado" e manda a pessoa mexer no passo 3, onde não há nada errado.
 *
 * Aceita os dois formatos porque o mesmo módulo serve aos dois caminhos, e
 * porque um `JSON.parse` que estoura aqui derrubaria a normalização inteira.
 */
function comoObjeto(valor: unknown): unknown {
  if (typeof valor !== 'string') return valor
  try {
    return JSON.parse(valor)
  } catch {
    return valor
  }
}

/**
 * Marca o evento cru como processado — e é o UPDATE mais crítico do caminho.
 *
 * Sem ele o evento continua pendente, a varredura o pega de novo na passagem
 * seguinte, e o fluxo dispara outra vez: mensagem repetida para o mesmo
 * cliente, sem nada na tela sugerindo o porquê. Por isso ele passa pela função
 * SECURITY DEFINER como todo o resto — um UPDATE recusado pelo RLS não
 * levanta erro, atualiza zero linhas e devolve sucesso.
 */
async function marcarProcessado(rawId: number, erro: string | null): Promise<void> {
  await db.execute(sql`SELECT mandafy_marcar_evento_cru(${rawId}, ${erro})`)
}
