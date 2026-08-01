import { and, eq, gte, sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db, withTenant } from '@/db'
import { contacts, notifications, waInstances } from '@/db/schema'
import {
  lerRetorno,
  statusDoAck,
  telefoneDoJid,
  type RetornoEvolution,
} from '@/lib/channels/evolution-webhook'
import { notificar } from '@/lib/api/webhooks'
import { descadastrar, ehPedidoDeSaida } from '@/lib/lgpd'
import { createLogger } from '@/lib/logger'
import { toE164 } from '@/lib/phone'

/**
 * Retorno da Evolution (§8.1, §8.2, §14.1).
 *
 * É o que faz três coisas funcionarem:
 *   1. a tela do QR perceber sozinha que o aparelho conectou;
 *   2. o histórico sair de "enviado" e chegar a "entregue" e "lido" — sem isto
 *      todo envio de WhatsApp para no primeiro degrau para sempre;
 *   3. quem responde "SAIR" ser descadastrado de verdade, na hora.
 *
 * AUTENTICAÇÃO — o token na URL, e só ele. A Evolution NÃO assina as chamadas
 * que faz (conferido em `webhook.controller.ts`: o corpo leva um campo
 * `apikey`, mas nenhum HMAC). Autenticar por um campo do corpo seria acreditar
 * em quem está falando. Cada instância tem seu token, então vazar o endereço de
 * um chip não expõe os outros.
 *
 * A resposta é 200 mesmo quando não há nada a fazer: a Evolution reenfileira o
 * que falha, e um 4xx por evento que simplesmente não nos interessa viraria
 * retentativa infinita.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('evolution')

const TAMANHO_MAXIMO = 512 * 1024

/** Retenção da camada quente (§10.2): fora disso o UPDATE não acha mesmo. */
const JANELA_HORAS = 72

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params

  // Formato antes do banco: recusa varredura sem custo de query.
  if (!token || token.length < 16 || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  const bruto = await request.text()
  if (bruto.length > TAMANHO_MAXIMO) return NextResponse.json({ ok: false }, { status: 413 })

  let corpo: unknown
  try {
    corpo = JSON.parse(bruto)
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const envelope = lerRetorno(corpo)
  if (!envelope) return NextResponse.json({ ok: true, ignorado: true })

  try {
    /*
     * A busca passa por função SECURITY DEFINER (drizzle/0016): quem chama vem
     * de fora, sem sessão e sem contexto de tenant, e com a política de RLS
     * valendo o SELECT direto devolveria zero linhas em silêncio.
     */
    const encontrada = await db.execute<{
      id: string
      org_id: string
      instance_name: string
    }>(sql`SELECT id, org_id, instance_name FROM mandafy_instancia_por_token(${token})`)

    const instancia = encontrada[0]
    if (!instancia) return NextResponse.json({ ok: false }, { status: 401 })

    /*
     * Contexto de tenant com o admin do sistema: não há usuário humano nesta
     * requisição. `isAdmin` é necessário porque o descadastro toca `contacts`,
     * e a política de leads exige dono — este caminho não mexe em leads.
     */
    await withTenant(
      { orgId: instancia.org_id, userId: instancia.id, isAdmin: true },
      (tx) => aplicar(tx, instancia.org_id, instancia.id, instancia.instance_name, envelope.retorno),
    )

    return NextResponse.json({ ok: true })
  } catch (erro) {
    log.error('falha no retorno da Evolution', {
      evento: envelope.evento,
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    // 500 faz a Evolution tentar de novo — o comportamento certo quando a
    // falha é nossa.
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

type Transacao = Parameters<Parameters<typeof withTenant>[1]>[0]

async function aplicar(
  tx: Transacao,
  orgId: string,
  instanciaId: string,
  instanceName: string,
  retorno: RetornoEvolution,
): Promise<void> {
  const agora = new Date()

  if (retorno.tipo === 'conexao') {
    const [antes] = await tx
      .select({ status: waInstances.status })
      .from(waInstances)
      .where(eq(waInstances.id, instanciaId))
      .limit(1)

    await tx
      .update(waInstances)
      .set({
        status: retorno.estado,
        ...(retorno.estado === 'conectado' ? { lastConnectedAt: agora } : {}),
        // O número só é gravado quando a Evolution informa; nunca sobrescreve
        // com nulo o que a pessoa digitou à mão.
        ...(retorno.telefone ? { phoneE164: toE164(retorno.telefone) } : {}),
        updatedAt: agora,
      })
      .where(eq(waInstances.id, instanciaId))

    // Só avisa na TRANSIÇÃO: a Evolution repete connection.update, e um alerta
    // por repetição vira ruído que ninguém lê (§10.4).
    if (retorno.estado === 'desconectado' && antes?.status === 'conectado') {
      await notificar(tx, orgId, 'instance.disconnected', { instancia: instanceName }, agora)
    }
    return
  }

  if (retorno.tipo === 'status') {
    const novo = statusDoAck(retorno.ack)
    if (!novo) return
    await marcarEntrega(tx, orgId, retorno.providerMessageId, novo, agora)
    return
  }

  if (retorno.tipo === 'recebida') {
    if (!ehPedidoDeSaida(retorno.texto)) return

    const telefone = telefoneDoJid(retorno.deJid)
    if (!telefone) return

    const e164 = toE164(telefone)
    if (!e164) return

    const [contato] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), eq(contacts.phoneE164, e164)))
      .limit(1)

    // Sem contato, não há o que descadastrar — quem escreveu nunca recebeu nada
    // nosso. Criar um só para marcá-lo como saído seria guardar dado pessoal de
    // quem não pediu (§14.1).
    if (!contato) return

    await descadastrar(tx, orgId, contato.id, {
      canal: 'whatsapp',
      motivo: 'respondeu pedindo para sair no WhatsApp',
      quem: null,
    })

    await notificar(tx, orgId, 'contact.opted_out', { contact_id: contato.id, canal: 'whatsapp' }, agora)
    return
  }

  // `saiu` confirma um id que o adaptador já gravou na resposta do envio. Nada
  // a fazer — fica registrado para não parecer que o evento foi esquecido.
}

/**
 * Grava entrega ou leitura na notificação certa.
 *
 * Duas coisas não óbvias:
 *
 * `created_at >= agora - 72h` existe porque `notifications` é particionada por
 * dia. Sem esse limite o UPDATE varre TODAS as partições a cada confirmação —
 * e chega uma ou mais por mensagem enviada. É o mesmo cuidado do índice em
 * drizzle/0016.
 *
 * A comparação de status impede regressão: o WhatsApp entrega DELIVERY_ACK e
 * READ, mas a ordem de chegada não é garantida. Sem o guarda, um DELIVERY_ACK
 * atrasado rebaixaria para "entregue" uma mensagem já marcada como "lida".
 */
async function marcarEntrega(
  tx: Transacao,
  orgId: string,
  providerMessageId: string,
  novo: 'delivered' | 'read' | 'failed',
  agora: Date,
): Promise<void> {
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

  if (!alvo) return

  const ORDEM: Record<string, number> = { sent: 1, delivered: 2, read: 3 }
  if (novo !== 'failed' && (ORDEM[alvo.status] ?? 0) >= (ORDEM[novo] ?? 0)) return

  await tx
    .update(notifications)
    .set({
      status: novo,
      ...(novo === 'delivered' ? { deliveredAt: agora } : {}),
      // Lido implica entregue: se o DELIVERY_ACK se perdeu, o horário da
      // leitura preenche os dois. Ficar com "lido" e entrega vazia faria o
      // relatório de entrega mentir para menos.
      ...(novo === 'read' ? { readAt: agora, deliveredAt: alvo.status === 'delivered' ? undefined : agora } : {}),
      ...(novo === 'failed'
        ? { errorCode: 'ack_erro', errorMessage: 'o WhatsApp devolveu erro na entrega' }
        : {}),
    })
    .where(and(eq(notifications.id, alvo.id), eq(notifications.createdAt, alvo.createdAt)))

  const evento =
    novo === 'delivered' ? 'message.delivered' : novo === 'read' ? 'message.read' : 'message.failed'

  await notificar(
    tx,
    orgId,
    evento,
    { notification_id: alvo.id, contact_id: alvo.contactId, canal: 'whatsapp' },
    agora,
  )
}
