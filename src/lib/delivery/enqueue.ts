import { and, count, eq, gte, inArray } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, messages, messageVariants, notifications, suppressions } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { compilar } from '@/lib/messages/compile'
import { corpoEfetivo } from '@/lib/messages/sync'
import type { DadosVariaveis } from '@/lib/messages/variables'
import { getQueue, queueForChannel } from '@/lib/queue'
import { createLogger } from '@/lib/logger'
import { serverEnv } from '@/env'
import { decidirEnvio, type ContatoParaEnvio, type MotivoSkip } from './guards'
import { sortearAtraso, type PerfilJitter } from './jitter'
import { escolherInstancia } from './warmup'
import { carregarInstancias } from './config'
import type { JanelaSilencio } from './quiet-hours'

/**
 * Enfileiramento de um envio (§5.3, §7, §8.1).
 *
 * A ordem aqui é a espinha do sistema:
 *
 *   guardas → jitter → janela de silêncio → escolha da instância → linha em
 *   `notifications` → job na fila do canal
 *
 * A linha no banco é gravada ANTES do job. Se o Redis cair entre os dois, o
 * envio fica visível como `queued` e a varredura de manutenção o retoma; a
 * ordem inversa perderia o registro de que ele existiu.
 */

const log = createLogger('envio')

export type PedidoEnvio = {
  orgId: string
  contactId: string
  messageId: string
  canais?: readonly Channel[]
  dados: DadosVariaveis
  /** 'order:12345' — o que permite cancelar em lote quando o pagamento chega (§5.1). */
  cancelKey?: string | null
  dedupeKey?: string | null
  flowId?: string | null
  stepId?: string | null
  eventId?: number | null
  perfil?: PerfilJitter
  janela?: JanelaSilencio
  /** Teste manual do editor: não aplica teto diário nem dedupe. */
  teste?: boolean
}

export type ResultadoCanal =
  | { canal: Channel; situacao: 'enfileirado'; notificationId: string; quando: Date }
  | { canal: Channel; situacao: 'reagendado'; notificationId: string; quando: Date }
  | { canal: Channel; situacao: 'pulado'; motivo: MotivoSkip }
  | { canal: Channel; situacao: 'falhou'; motivo: string }

const PERFIL_PADRAO: PerfilJitter = { mode: 'humano', minSeconds: 8, maxSeconds: 25 }

/** Perfil sem atraso, para o botão "enviar teste" — ninguém espera 25s por ele. */
export const PERFIL_TESTE: PerfilJitter = { mode: 'instantaneo', minSeconds: 0, maxSeconds: 0 }

export async function enfileirarEnvio(
  tx: Tx,
  pedido: PedidoEnvio,
  agora = new Date(),
): Promise<ResultadoCanal[]> {
  const [mensagem] = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.id, pedido.messageId), eq(messages.orgId, pedido.orgId)))
    .limit(1)

  if (!mensagem) return []

  const [contato] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, pedido.contactId), eq(contacts.orgId, pedido.orgId)))
    .limit(1)

  if (!contato) return []

  const variantes = await tx
    .select()
    .from(messageVariants)
    .where(eq(messageVariants.messageId, pedido.messageId))

  const bloqueados = await tx
    .select({ channel: suppressions.channel })
    .from(suppressions)
    .where(and(eq(suppressions.orgId, pedido.orgId), eq(suppressions.contactId, pedido.contactId)))

  const recebidasHoje = pedido.teste ? 0 : await contarRecebidasHoje(tx, pedido, agora)

  const paraEnvio: ContatoParaEnvio = {
    optedOutAt: contato.optedOutAt,
    optinAt: contato.optinAt,
    phoneE164: contato.phoneE164,
    email: contato.email,
    telegramChatId: contato.telegramChatId,
    optinWhatsapp: contato.optinWhatsapp,
    optinEmail: contato.optinEmail,
    optinSms: contato.optinSms,
    optinTelegram: contato.optinTelegram,
  }

  /*
   * Sem canais pedidos, os alvos são os LIGADOS — canal desligado simplesmente
   * não faz parte do envio, e não vira linha `skipped`. A diferença importa:
   * registrar um pulo por canal desligado a cada envio encheria uma tabela
   * particionada de alta escrita com ruído, e a maioria das organizações usa
   * um ou dois canais dos quatro.
   *
   * A guarda `canal_desligado` continua valendo para quem PEDE um canal
   * específico — um passo de fluxo apontando para SMS, ou o botão de teste.
   * Aí o pulo é informação de verdade: você pediu e não saiu, eis o porquê.
   */
  const alvos = pedido.canais ?? variantes.filter((v) => v.enabled).map((v) => v.channel)
  const perfil = pedido.perfil ?? (pedido.teste ? PERFIL_TESTE : PERFIL_PADRAO)

  // Carregadas uma vez para todos os canais: o rodízio só interessa ao
  // WhatsApp, e uma consulta por canal seria desperdício.
  const instancias = alvos.includes('whatsapp')
    ? await carregarInstancias(tx, pedido.orgId)
    : []

  const resultados: ResultadoCanal[] = []

  for (const canal of alvos) {
    const variante = variantes.find((v) => v.channel === canal)

    const decisao = decidirEnvio(
      {
        canal,
        contato: paraEnvio,
        categoria: mensagem.category,
        canalLigado: variante?.enabled ?? false,
        mensagemAtiva: mensagem.active || Boolean(pedido.teste),
        suprimidos: bloqueados.map((b) => b.channel),
        recebidasHoje,
        duplicado: pedido.teste ? false : await jaExiste(tx, pedido.dedupeKey ?? null, agora),
        ignorarSilencio: mensagem.ignoreQuietHours || Boolean(pedido.teste),
        ...(pedido.janela ? { janela: pedido.janela } : {}),
      },
      agora,
      sortearAtraso(perfil),
    )

    if (decisao.acao === 'pular') {
      resultados.push({ canal, situacao: 'pulado', motivo: decisao.motivo })
      // O pulo também vira linha: o histórico precisa mostrar POR QUE não saiu.
      await registrarPulo(tx, pedido, canal, variante?.id ?? null, decisao.motivo, agora)
      continue
    }

    const corpo = corpoEfetivo(mensagem.body, variante ?? null)
    const compilado = compilar(corpo, {
      canal,
      dados: pedido.dados,
      preheader: variante?.preheader ?? null,
      ...(canal === 'sms'
        ? { sms: { removerAcentuacao: variante?.stripAccents ?? false } }
        : {}),
    })

    if (!compilado.ok) {
      resultados.push({ canal, situacao: 'falhou', motivo: compilado.motivo })
      await registrarFalhaDeCompilacao(tx, pedido, canal, variante?.id ?? null, compilado, agora)
      continue
    }

    // §5.3 regra 8: sem instância disponível, reagenda em vez de queimar o job.
    let instanciaId: string | null = null
    if (canal === 'whatsapp') {
      const escolha = escolherInstancia(instancias, agora)
      if (!escolha.escolhida) {
        resultados.push({ canal, situacao: 'falhou', motivo: 'sem_instancia_disponivel' })
        continue
      }
      instanciaId = escolha.escolhida.id
    }

    const [linha] = await tx
      .insert(notifications)
      .values({
        orgId: pedido.orgId,
        contactId: pedido.contactId,
        messageId: pedido.messageId,
        variantId: variante?.id ?? null,
        flowId: pedido.flowId ?? null,
        stepId: pedido.stepId ?? null,
        eventId: pedido.eventId ?? null,
        channel: canal,
        status: decisao.acao === 'reagendar' ? 'scheduled' : 'queued',
        scheduledFor: decisao.quando,
        providerInstance: instanciaId,
        renderedSubject: canal === 'email' ? (variante?.subject ?? mensagem.name) : null,
        // Exatamente o que foi enviado, para auditoria (§6.5).
        renderedBody: compilado.corpo,
        cancelKey: pedido.cancelKey ?? null,
        dedupeKey: pedido.dedupeKey ?? null,
      })
      .returning({ id: notifications.id, createdAt: notifications.createdAt })

    if (!linha) {
      resultados.push({ canal, situacao: 'falhou', motivo: 'insert_sem_retorno' })
      continue
    }

    const fila = queueForChannel(canal, instanciaId)
    if (!fila) {
      resultados.push({ canal, situacao: 'falhou', motivo: 'sem_instancia_disponivel' })
      continue
    }

    const atrasoMs = Math.max(0, decisao.quando.getTime() - agora.getTime())

    try {
      const job = await getQueue(fila).add(
        'enviar',
        { notificationId: linha.id, createdAt: linha.createdAt.toISOString(), orgId: pedido.orgId },
        { delay: atrasoMs, jobId: `n:${linha.id}` },
      )

      await tx
        .update(notifications)
        .set({ queueJobId: String(job.id) })
        .where(and(eq(notifications.id, linha.id), eq(notifications.createdAt, linha.createdAt)))
    } catch (erro) {
      /*
       * Redis fora do ar não perde o envio: a linha ficou como `queued` e a
       * varredura de manutenção reenfileira. Por isso o banco vem primeiro.
       */
      log.error('não foi possível enfileirar', {
        canal,
        reason: erro instanceof Error ? erro.message : 'desconhecido',
      })
    }

    resultados.push({
      canal,
      situacao: decisao.acao === 'reagendar' ? 'reagendado' : 'enfileirado',
      notificationId: linha.id,
      quando: decisao.quando,
    })
  }

  return resultados
}

/** Quantas notificações o contato já recebeu hoje, somando os canais (§5.3). */
async function contarRecebidasHoje(tx: Tx, pedido: PedidoEnvio, agora: Date): Promise<number> {
  const inicioDoDia = new Date(agora)
  inicioDoDia.setUTCHours(0, 0, 0, 0)

  const [linha] = await tx
    .select({ total: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, pedido.orgId),
        eq(notifications.contactId, pedido.contactId),
        gte(notifications.createdAt, inicioDoDia),
        inArray(notifications.status, ['queued', 'scheduled', 'sending', 'sent', 'delivered', 'read']),
      ),
    )

  return linha?.total ?? 0
}

async function jaExiste(tx: Tx, dedupeKey: string | null, agora: Date): Promise<boolean> {
  if (!dedupeKey) return false

  const desde = new Date(agora.getTime() - 24 * 3600 * 1000)
  const [linha] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.dedupeKey, dedupeKey), gte(notifications.createdAt, desde)))
    .limit(1)

  return Boolean(linha)
}

async function registrarPulo(
  tx: Tx,
  pedido: PedidoEnvio,
  canal: Channel,
  variantId: string | null,
  motivo: MotivoSkip,
  agora: Date,
): Promise<void> {
  await tx.insert(notifications).values({
    orgId: pedido.orgId,
    contactId: pedido.contactId,
    messageId: pedido.messageId,
    variantId,
    flowId: pedido.flowId ?? null,
    stepId: pedido.stepId ?? null,
    channel: canal,
    status: 'skipped',
    errorCode: motivo,
    scheduledFor: agora,
    cancelKey: pedido.cancelKey ?? null,
  })
}

async function registrarFalhaDeCompilacao(
  tx: Tx,
  pedido: PedidoEnvio,
  canal: Channel,
  variantId: string | null,
  falha: { motivo: string; detalhe: string },
  agora: Date,
): Promise<void> {
  await tx.insert(notifications).values({
    orgId: pedido.orgId,
    contactId: pedido.contactId,
    messageId: pedido.messageId,
    variantId,
    flowId: pedido.flowId ?? null,
    channel: canal,
    status: 'failed',
    errorCode: falha.motivo,
    // O detalhe cita nomes de variável, nunca o valor delas (§14.1).
    errorMessage: falha.detalhe,
    scheduledFor: agora,
  })
}

/**
 * Cancelamento por chave (§5.1) — a lógica mais crítica do sistema.
 *
 * Só alcança o que ainda não saiu. Uma mensagem já enviada não pode ser
 * "descancelada", e marcar como cancelada o que o cliente já leu faria o
 * histórico mentir.
 */
export async function cancelarPorChave(
  tx: Tx,
  orgId: string,
  cancelKey: string,
): Promise<{ cancelados: number; jobs: string[] }> {
  const alvos = await tx
    .select({ id: notifications.id, createdAt: notifications.createdAt, queueJobId: notifications.queueJobId, channel: notifications.channel, providerInstance: notifications.providerInstance })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.cancelKey, cancelKey),
        inArray(notifications.status, ['queued', 'scheduled']),
      ),
    )

  if (alvos.length === 0) return { cancelados: 0, jobs: [] }

  await tx
    .update(notifications)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.cancelKey, cancelKey),
        inArray(notifications.status, ['queued', 'scheduled']),
      ),
    )

  // Remove os jobs também: sem isto, o worker acordaria, leria `cancelled` e
  // descartaria — funciona, mas mantém a fila cheia de trabalho morto.
  const removidos: string[] = []
  for (const alvo of alvos) {
    if (!alvo.queueJobId) continue
    const fila = queueForChannel(alvo.channel, alvo.providerInstance)
    if (!fila) continue

    try {
      await getQueue(fila).remove(alvo.queueJobId)
      removidos.push(alvo.queueJobId)
    } catch {
      // Job já consumido ou fila indisponível: o status no banco é a verdade.
    }
  }

  return { cancelados: alvos.length, jobs: removidos }
}

/** Link de descadastro de um contato (§14.1). Usado no rodapé de todo e-mail. */
export function linkDescadastro(contactId: string): string {
  const base = serverEnv().APP_URL.replace(/\/+$/, '')
  return `${base}/sair/${contactId}`
}

/** Envios ainda não enfileirados — a rede de segurança de um Redis instável. */
export async function reenfileirarPendentes(tx: Tx, limite = 200): Promise<number> {
  const pendentes = await tx
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      orgId: notifications.orgId,
      channel: notifications.channel,
      providerInstance: notifications.providerInstance,
      scheduledFor: notifications.scheduledFor,
    })
    .from(notifications)
    .where(
      and(
        inArray(notifications.status, ['queued', 'scheduled']),
        sql`${notifications.queueJobId} IS NULL`,
      ),
    )
    .limit(limite)

  let total = 0
  for (const p of pendentes) {
    const fila = queueForChannel(p.channel, p.providerInstance)
    if (!fila) continue

    const atraso = Math.max(0, (p.scheduledFor?.getTime() ?? 0) - Date.now())

    try {
      const job = await getQueue(fila).add(
        'enviar',
        { notificationId: p.id, createdAt: p.createdAt.toISOString(), orgId: p.orgId },
        { delay: atraso, jobId: `n:${p.id}` },
      )
      await tx
        .update(notifications)
        .set({ queueJobId: String(job.id) })
        .where(and(eq(notifications.id, p.id), eq(notifications.createdAt, p.createdAt)))
      total += 1
    } catch {
      break
    }
  }

  return total
}
