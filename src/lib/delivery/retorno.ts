import { and, eq, gte } from 'drizzle-orm'
import type { Tx } from '@/db'
import { notifications } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { notificar } from '@/lib/api/webhooks'

/**
 * Gravar o que o provedor devolveu sobre uma mensagem já enviada (§8.1).
 *
 * Nasceu dentro da rota da Evolution e saiu de lá quando e-mail e SMS
 * passaram a precisar da mesma coisa. Os dois cuidados abaixo não são
 * detalhes de implementação — são o que separa isto de um UPDATE que derruba
 * o banco ou mente no relatório.
 */

/** Retenção da camada quente (§10.2): fora disso o UPDATE não acha mesmo. */
const JANELA_HORAS = 72

/** A escada de estados. Só se sobe. */
const ORDEM: Record<string, number> = { sent: 1, delivered: 2, read: 3 }

export type EstadoRetorno = 'delivered' | 'read' | 'failed'

/**
 * Sobe o status de uma notificação a partir do id que o provedor devolveu.
 *
 * `created_at >= agora - 72h` existe porque `notifications` é particionada por
 * dia. Sem esse limite o UPDATE varre TODAS as partições a cada confirmação —
 * e chega ao menos uma por mensagem enviada. É o mesmo cuidado do índice em
 * drizzle/0016.
 *
 * A comparação de status impede regressão: a ordem de chegada dos retornos não
 * é garantida em nenhum dos canais. Sem o guarda, uma confirmação de entrega
 * atrasada rebaixaria para "entregue" uma mensagem já marcada como "lida".
 *
 * Devolve o contato da notificação, ou null se não achou — quem chama costuma
 * precisar dele para o próximo passo (bloquear o endereço, por exemplo).
 */
export async function marcarEntrega(
  tx: Tx,
  orgId: string,
  canal: Channel,
  providerMessageId: string,
  novo: EstadoRetorno,
  agora = new Date(),
  erro?: { codigo: string; mensagem: string },
): Promise<{ notificationId: string; contactId: string | null } | null> {
  const desde = new Date(agora.getTime() - JANELA_HORAS * 60 * 60 * 1000)

  const [alvo] = await tx
    .select({
      id: notifications.id,
      createdAt: notifications.createdAt,
      status: notifications.status,
      contactId: notifications.contactId,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        eq(notifications.providerMessageId, providerMessageId),
        gte(notifications.createdAt, desde),
      ),
    )
    .limit(1)

  if (!alvo) return null

  const encontrado = { notificationId: alvo.id, contactId: alvo.contactId }

  if (novo !== 'failed' && (ORDEM[alvo.status] ?? 0) >= (ORDEM[novo] ?? 0)) return encontrado

  await tx
    .update(notifications)
    .set({
      status: novo,
      ...(novo === 'delivered' ? { deliveredAt: agora } : {}),
      // Lido implica entregue: se a confirmação de entrega se perdeu, o horário
      // da leitura preenche os dois. Ficar com "lido" e entrega vazia faria o
      // relatório de entrega mentir para menos.
      ...(novo === 'read'
        ? { readAt: agora, deliveredAt: alvo.status === 'delivered' ? undefined : agora }
        : {}),
      ...(novo === 'failed' && erro
        ? { errorCode: erro.codigo, errorMessage: erro.mensagem }
        : {}),
    })
    .where(and(eq(notifications.id, alvo.id), eq(notifications.createdAt, alvo.createdAt)))

  const evento =
    novo === 'delivered' ? 'message.delivered' : novo === 'read' ? 'message.read' : 'message.failed'

  await notificar(
    tx,
    orgId,
    evento,
    { notification_id: alvo.id, contact_id: alvo.contactId, canal },
    agora,
  )

  return encontrado
}
