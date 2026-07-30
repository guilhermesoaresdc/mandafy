import { and, eq, sql } from 'drizzle-orm'
import { withTenant } from '@/db'
import { contacts, notifications, waInstances } from '@/db/schema'
import { enviarPeloCanal } from '@/lib/channels'
import type { DestinoEnvio, ResultadoEnvio } from '@/lib/channels'
import { createLogger } from '@/lib/logger'
import { carregarInstancias, resolverCanal } from './config'
import { linkDescadastro } from './enqueue'

/**
 * O envio propriamente dito (§8.1).
 *
 * Roda no worker, uma notificação por job. Move a máquina de estados:
 *
 *   queued/scheduled → sending → sent          (ou failed → retry → dead)
 *
 * Duas coisas importam mais que o resto aqui:
 *
 * 1. `cancelled` é verificado DEPOIS de pegar o job e ANTES de bater no
 *    provedor. Uma mensagem cancelada enquanto o job dormia na fila não pode
 *    sair — é exatamente o cenário do PIX pago de §5.1.
 * 2. Falha permanente não vira retry. Insistir num número que não tem WhatsApp
 *    ou num e-mail inválido só queima reputação e, no SMS, dinheiro.
 */

const log = createLogger('entrega')

export type DadosJobEnvio = { notificationId: string; createdAt: string; orgId: string }

export type DesfechoEnvio =
  | { desfecho: 'enviado'; providerMessageId: string | null }
  | { desfecho: 'cancelado' }
  | { desfecho: 'ja_processado'; status: string }
  | { desfecho: 'falhou'; codigo: string; reenviavel: boolean; esperarSegundos?: number }

export async function processarEnvio(dados: DadosJobEnvio): Promise<DesfechoEnvio> {
  const criadoEm = new Date(dados.createdAt)

  // Contexto de tenant do sistema: o worker não tem usuário logado, mas o RLS
  // exige `app.org_id` — sem ele a query não enxerga a própria linha.
  const ctx = { orgId: dados.orgId, userId: dados.orgId, isAdmin: true }

  const preparado = await withTenant(ctx, async (tx) => {
    const [linha] = await tx
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.id, dados.notificationId), eq(notifications.createdAt, criadoEm)),
      )
      .limit(1)

    if (!linha) return { tipo: 'sumiu' as const }

    // O cancelamento pode ter chegado enquanto o job dormia (§5.1).
    if (linha.status === 'cancelled') return { tipo: 'cancelado' as const }
    if (!['queued', 'scheduled'].includes(linha.status)) {
      return { tipo: 'ja_processado' as const, status: linha.status }
    }

    const [contato] = await tx
      .select({
        phoneE164: contacts.phoneE164,
        email: contacts.email,
        telegramChatId: contacts.telegramChatId,
      })
      .from(contacts)
      .where(eq(contacts.id, linha.contactId ?? ''))
      .limit(1)

    if (!contato) return { tipo: 'sem_contato' as const }

    const instancias =
      linha.channel === 'whatsapp' ? await carregarInstancias(tx, dados.orgId) : []
    const instancia = instancias.find((i) => i.id === linha.providerInstance) ?? null

    const canal = await resolverCanal(tx, dados.orgId, linha.channel, instancia)

    // Marca `sending` antes de sair para a rede: se o processo morrer no meio,
    // o estado mostra que a tentativa começou, em vez de sugerir que a fila
    // nunca a pegou.
    await tx
      .update(notifications)
      .set({
        status: 'sending',
        attemptedAt: new Date(),
        attempts: sql`${notifications.attempts} + 1`,
      })
      .where(and(eq(notifications.id, linha.id), eq(notifications.createdAt, criadoEm)))

    return { tipo: 'pronto' as const, linha, contato, canal }
  })

  if (preparado.tipo === 'cancelado') return { desfecho: 'cancelado' }
  if (preparado.tipo === 'ja_processado') {
    return { desfecho: 'ja_processado', status: preparado.status }
  }
  if (preparado.tipo === 'sumiu') {
    return { desfecho: 'falhou', codigo: 'notificacao_inexistente', reenviavel: false }
  }
  if (preparado.tipo === 'sem_contato') {
    await marcarFalha(ctx, dados, criadoEm, 'sem_destino', 'contato não encontrado', false)
    return { desfecho: 'falhou', codigo: 'sem_destino', reenviavel: false }
  }

  const { linha, contato, canal } = preparado

  if (!canal.alvo) {
    await marcarFalha(ctx, dados, criadoEm, 'sem_credencial', canal.falta ?? 'canal sem configuração', false)
    return { desfecho: 'falhou', codigo: 'sem_credencial', reenviavel: false }
  }

  const para =
    linha.channel === 'email'
      ? contato.email
      : linha.channel === 'telegram'
        ? contato.telegramChatId?.toString()
        : contato.phoneE164

  if (!para) {
    await marcarFalha(ctx, dados, criadoEm, 'sem_destino', 'contato sem endereço para o canal', false)
    return { desfecho: 'falhou', codigo: 'sem_destino', reenviavel: false }
  }

  const destino: DestinoEnvio = {
    para,
    corpo: linha.renderedBody ?? '',
    ...(linha.renderedSubject ? { assunto: linha.renderedSubject } : {}),
    ...(linha.channel === 'email'
      ? {
          html: linha.renderedBody ?? '',
          textoPuro: linha.renderedBody ?? '',
          linkDescadastro: linkDescadastro(linha.contactId ?? ''),
        }
      : {}),
  }

  const resultado = await enviarPeloCanal(destino, canal.alvo)

  await registrarResultado(ctx, dados, criadoEm, linha.providerInstance, resultado)

  if (resultado.ok) {
    return { desfecho: 'enviado', providerMessageId: resultado.providerMessageId }
  }

  return {
    desfecho: 'falhou',
    codigo: resultado.codigo,
    reenviavel: resultado.reenviavel,
    ...(resultado.esperarSegundos !== undefined
      ? { esperarSegundos: resultado.esperarSegundos }
      : {}),
  }
}

async function registrarResultado(
  ctx: { orgId: string; userId: string; isAdmin: boolean },
  dados: DadosJobEnvio,
  criadoEm: Date,
  instanciaId: string | null,
  resultado: ResultadoEnvio,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    if (resultado.ok) {
      await tx
        .update(notifications)
        .set({
          status: 'sent',
          sentAt: new Date(),
          provider: resultado.provider,
          providerMessageId: resultado.providerMessageId,
          errorCode: null,
          errorMessage: null,
        })
        .where(and(eq(notifications.id, dados.notificationId), eq(notifications.createdAt, criadoEm)))

      // Contadores do rodízio e do aquecimento (§7.3).
      if (instanciaId) {
        await tx
          .update(waInstances)
          .set({
            sentToday: sql`${waInstances.sentToday} + 1`,
            lastSentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(waInstances.id, instanciaId))
      }
      return
    }

    /*
     * Falha permanente vai direto para `dead`: a fila não deve tentar de novo
     * um número sem WhatsApp nem um e-mail inválido. `failed` fica reservado ao
     * que ainda tem chance na próxima tentativa (§8.1).
     */
    await tx
      .update(notifications)
      .set({
        status: resultado.reenviavel ? 'failed' : 'dead',
        provider: resultado.provider,
        errorCode: resultado.codigo,
        // Mensagem do provedor, não dado do contato (§14.1).
        errorMessage: resultado.mensagem.slice(0, 500),
      })
      .where(and(eq(notifications.id, dados.notificationId), eq(notifications.createdAt, criadoEm)))
  })
}

async function marcarFalha(
  ctx: { orgId: string; userId: string; isAdmin: boolean },
  dados: DadosJobEnvio,
  criadoEm: Date,
  codigo: string,
  mensagem: string,
  reenviavel: boolean,
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx
      .update(notifications)
      .set({ status: reenviavel ? 'failed' : 'dead', errorCode: codigo, errorMessage: mensagem })
      .where(and(eq(notifications.id, dados.notificationId), eq(notifications.createdAt, criadoEm)))
  })

  log.warn('envio não saiu', { notificationId: dados.notificationId, codigo })
}

/**
 * Marca `dead` quando a fila esgotou as tentativas.
 *
 * Chamado pelo evento `failed` do worker quando `attemptsMade` bateu o limite —
 * sem isso a notificação ficaria eternamente em `failed`, e o painel mostraria
 * como "vai tentar de novo" algo que ninguém mais vai tentar.
 */
export async function marcarEsgotado(dados: DadosJobEnvio, motivo: string): Promise<void> {
  const ctx = { orgId: dados.orgId, userId: dados.orgId, isAdmin: true }

  await withTenant(ctx, async (tx) => {
    await tx
      .update(notifications)
      .set({ status: 'dead', errorMessage: motivo.slice(0, 500) })
      .where(
        and(
          eq(notifications.id, dados.notificationId),
          eq(notifications.createdAt, new Date(dados.createdAt)),
          eq(notifications.status, 'failed'),
        ),
      )
  })
}
