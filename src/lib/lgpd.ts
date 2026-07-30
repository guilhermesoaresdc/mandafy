import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@/db'
import {
  auditLog,
  contacts,
  events,
  leadActivities,
  leads,
  messages,
  notifications,
  suppressions,
} from '@/db/schema'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { createLogger } from '@/lib/logger'

/**
 * Direitos do titular (§14.1).
 *
 * "Endpoint e botão no painel para exportar todos os dados de um contato
 * (JSON) e para apagar/anonimizar. Anonimização preserva os agregados
 * estatísticos mas remove nome, telefone, e-mail e CPF."
 *
 * Anonimizar e não apagar é decisão de arquitetura, não preguiça: apagar a
 * linha do contato levaria junto o histórico de envios e os agregados, e o
 * sistema perderia a capacidade de provar o que fez — que é justamente o que a
 * fiscalização pede. Anonimizar atende o titular e preserva a auditoria.
 */

const log = createLogger('lgpd')

export type ExportacaoContato = {
  gerado_em: string
  contato: Record<string, unknown>
  eventos: Record<string, unknown>[]
  notificacoes: Record<string, unknown>[]
  leads: Record<string, unknown>[]
  supressoes: Record<string, unknown>[]
}

/** Tudo que o sistema sabe sobre um contato, em JSON (§14.1). */
export async function exportarContato(
  tx: Tx,
  contactId: string,
): Promise<ExportacaoContato | null> {
  const [contato] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1)
  if (!contato) return null

  const eventosDele = await tx
    .select({
      tipo: events.type,
      quando: events.occurredAt,
      externalId: events.externalId,
      dados: events.data,
    })
    .from(events)
    .where(eq(events.contactId, contactId))
    .orderBy(desc(events.occurredAt))
    .limit(500)

  const enviosDele = await tx
    .select({
      canal: notifications.channel,
      status: notifications.status,
      quando: notifications.createdAt,
      mensagem: messages.key,
      // O corpo exato: o titular tem direito de saber o que recebeu.
      corpo: notifications.renderedBody,
      enviadoEm: notifications.sentAt,
      entregueEm: notifications.deliveredAt,
    })
    .from(notifications)
    .leftJoin(messages, eq(messages.id, notifications.messageId))
    .where(eq(notifications.contactId, contactId))
    .orderBy(desc(notifications.createdAt))
    .limit(500)

  const leadsDele = await tx
    .select({
      titulo: leads.title,
      status: leads.status,
      valorCents: leads.valueCents,
      origem: leads.source,
      criadoEm: leads.createdAt,
    })
    .from(leads)
    .where(eq(leads.contactId, contactId))

  const bloqueios = await tx
    .select({ canal: suppressions.channel, motivo: suppressions.reason, quando: suppressions.createdAt })
    .from(suppressions)
    .where(eq(suppressions.contactId, contactId))

  return {
    gerado_em: new Date().toISOString(),
    contato: {
      id: contato.id,
      nome: contato.name,
      telefone: contato.phoneE164,
      email: contato.email,
      cpf: contato.cpf,
      tags: contato.tags,
      consentimento: {
        whatsapp: contato.optinWhatsapp,
        email: contato.optinEmail,
        sms: contato.optinSms,
        telegram: contato.optinTelegram,
        registrado_em: contato.optinAt,
        origem: contato.optinSource,
        descadastrado_em: contato.optedOutAt,
      },
      primeiro_contato: contato.firstSeenAt,
      ultimo_evento: contato.lastEventAt,
      total_pedidos: contato.totalOrders,
      total_pago_cents: contato.totalPaidCents,
    },
    eventos: eventosDele,
    notificacoes: enviosDele,
    leads: leadsDele,
    supressoes: bloqueios,
  }
}

export type ResultadoAnonimizacao = {
  anonimizado: boolean
  notificacoesLimpas: number
  atividadesLimpas: number
}

/**
 * Anonimiza um contato (§14.1).
 *
 * Remove nome, telefone, e-mail e CPF; preserva os agregados. Também limpa o
 * `rendered_body` das notificações — é lá que o nome e o valor da pessoa
 * aparecem por extenso, e deixar o corpo intacto tornaria a anonimização
 * teatro.
 */
export async function anonimizarContato(
  tx: Tx,
  orgId: string,
  contactId: string,
  quem: string | null,
  agora = new Date(),
): Promise<ResultadoAnonimizacao> {
  const [contato] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .limit(1)

  if (!contato) return { anonimizado: false, notificacoesLimpas: 0, atividadesLimpas: 0 }

  await tx
    .update(contacts)
    .set({
      name: 'Contato anonimizado',
      /*
       * `null` e não string vazia: as chaves únicas de telefone e e-mail são
       * parciais (`WHERE ... IS NOT NULL`), então anonimizar dois contatos com
       * string vazia colidiria no índice e o segundo falharia.
       */
      phoneE164: null,
      email: null,
      cpf: null,
      externalId: null,
      tags: [],
      optedOutAt: agora,
      optoutReason: 'anonimizado a pedido do titular',
      optinWhatsapp: false,
      optinEmail: false,
      optinSms: false,
      optinTelegram: false,
      updatedAt: agora,
    })
    .where(eq(contacts.id, contactId))

  const limpas = await tx
    .update(notifications)
    .set({ renderedBody: '[anonimizado]', renderedSubject: null })
    .where(eq(notifications.contactId, contactId))
    .returning({ id: notifications.id })

  const leadsDele = await tx
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.contactId, contactId))

  let atividades: { id: string }[] = []
  if (leadsDele.length > 0) {
    await tx
      .update(leads)
      .set({ title: 'Lead anonimizado', updatedAt: agora })
      .where(eq(leads.contactId, contactId))

    // As notas do consultor citam a pessoa pelo nome com frequência.
    atividades = await tx
      .update(leadActivities)
      .set({ content: '[anonimizado]' })
      .where(
        and(
          inArray(leadActivities.leadId, leadsDele.map((l) => l.id)),
          eq(leadActivities.type, 'nota'),
        ),
      )
      .returning({ id: leadActivities.id })
  }

  // A auditoria registra o pedido, sem repetir o dado que acabou de sair.
  await tx.insert(auditLog).values({
    orgId,
    userId: quem,
    action: 'lgpd.anonimizar',
    entity: 'contacts',
    entityId: contactId,
  })

  log.info('contato anonimizado', {
    contactId,
    notificacoes: limpas.length,
    atividades: atividades.length,
  })

  return {
    anonimizado: true,
    notificacoesLimpas: limpas.length,
    atividadesLimpas: atividades.length,
  }
}

/**
 * Descadastro (§14.1).
 *
 * "Processamento imediato, não em 48h. É trivial tecnicamente e elimina o
 * risco." Sem canal, sai de tudo; com canal, só daquele.
 */
export async function descadastrar(
  tx: Tx,
  orgId: string,
  contactId: string,
  opcoes: { canal?: Channel; motivo?: string; quem?: string | null } = {},
  agora = new Date(),
): Promise<boolean> {
  const [contato] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .limit(1)

  if (!contato) return false

  const motivo = opcoes.motivo ?? 'pedido do titular'
  const canais = opcoes.canal ? [opcoes.canal] : [...CHANNELS]

  const desligados = Object.fromEntries(
    canais.map((c) => [
      c === 'whatsapp'
        ? 'optinWhatsapp'
        : c === 'email'
          ? 'optinEmail'
          : c === 'sms'
            ? 'optinSms'
            : 'optinTelegram',
      false,
    ]),
  )

  await tx
    .update(contacts)
    .set({
      ...desligados,
      // Só marca opt-out GLOBAL quando sai de todos os canais.
      ...(opcoes.canal ? {} : { optedOutAt: agora, optoutReason: motivo }),
      updatedAt: agora,
    })
    .where(eq(contacts.id, contactId))

  for (const canal of canais) {
    await tx
      .insert(suppressions)
      .values({ orgId, contactId, channel: canal, reason: 'optout', detail: motivo })
      .onConflictDoNothing()
  }

  await tx.insert(auditLog).values({
    orgId,
    userId: opcoes.quem ?? null,
    action: 'lgpd.descadastrar',
    entity: 'contacts',
    entityId: contactId,
    after: { canais, motivo },
  })

  log.info('contato descadastrado', { contactId, canais: canais.length })
  return true
}

/**
 * Palavras que disparam descadastro imediato (§14.1).
 *
 * Vale para WhatsApp e SMS. O Telegram usa `/parar`, tratado no adaptador dele.
 */
export const PALAVRAS_SAIDA = /^\s*(sair|parar|cancelar|descadastrar|stop|remover)\b/i

export function ehPedidoDeSaida(texto: string): boolean {
  return PALAVRAS_SAIDA.test(texto)
}

/** Retenção declarada (§14.1), para a tela de privacidade dizer em português. */
export const RETENCAO = {
  logQuenteDias: 3,
  arquivoDias: 30,
  agregadosMeses: 12,
  eventosCrusDias: 7,
} as const
