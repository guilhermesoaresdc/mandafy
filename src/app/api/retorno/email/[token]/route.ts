import { and, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { withTenant, type Tx } from '@/db'
import { contacts, notifications } from '@/db/schema'
import { assinaturaValida, lerRetornoEmail, type RetornoEmail } from '@/lib/channels/resend-webhook'
import { canalPorToken, tokenPlausivel } from '@/lib/channels/retorno-lookup'
import { notificar } from '@/lib/api/webhooks'
import { marcarEntrega } from '@/lib/delivery/retorno'
import { bloquearCanal } from '@/lib/lgpd'
import { createLogger } from '@/lib/logger'

/**
 * Retorno do provedor de e-mail (§8.3, §14.1).
 *
 * É o que impede o domínio de envio de se queimar sozinho. Sem esta rota, um
 * endereço que deixou de existir continua recebendo tentativa a cada cadência,
 * e o provedor de caixa postal lê isso como o comportamento de quem compra
 * lista. A degradação não avisa: um dia a taxa de entrega começa a cair e não
 * há nada no painel explicando por quê.
 *
 * AUTENTICAÇÃO em duas camadas, e as duas valem:
 *   - o token na URL identifica a organização e sempre é exigido;
 *   - a assinatura Svix é conferida POR CIMA dele, quando o segredo de
 *     assinatura estiver configurado no canal.
 *
 * Com o segredo configurado, nem um token vazado permite forjar um bounce — e
 * um bounce forjado é um cliente bloqueado sem motivo, que é justamente o dano
 * que a supressão automática torna barato de causar.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('retorno-email')

const TAMANHO_MAXIMO = 512 * 1024

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!tokenPlausivel(token)) return NextResponse.json({ ok: false }, { status: 401 })

  const bruto = await request.text()
  if (bruto.length > TAMANHO_MAXIMO) return NextResponse.json({ ok: false }, { status: 413 })

  let corpo: unknown
  try {
    corpo = JSON.parse(bruto)
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  try {
    const canal = await canalPorToken(token)
    if (!canal || canal.canal !== 'email') {
      return NextResponse.json({ ok: false }, { status: 401 })
    }

    /*
     * O segredo de assinatura é opcional de propósito: quem acabou de conectar
     * a Resend ainda não copiou o `whsec_`, e exigir isso deixaria o bounce
     * sendo descartado durante a configuração — que é exatamente quando os
     * primeiros erros de endereço aparecem. Configurado, passa a ser exigido.
     */
    const segredo = canal.credenciais.webhookSecret
    if (segredo) {
      const ok = assinaturaValida(
        segredo,
        {
          id: request.headers.get('svix-id'),
          timestamp: request.headers.get('svix-timestamp'),
          signature: request.headers.get('svix-signature'),
        },
        bruto,
      )
      if (!ok) {
        log.warn('assinatura recusada no retorno de e-mail', { orgId: canal.orgId })
        return NextResponse.json({ ok: false }, { status: 401 })
      }
    }

    const retorno = lerRetornoEmail(corpo)
    if (!retorno || retorno.tipo === 'ignorado') return NextResponse.json({ ok: true, ignorado: true })

    await withTenant({ orgId: canal.orgId, userId: canal.id, isAdmin: true }, (tx) =>
      aplicar(tx, canal.orgId, retorno),
    )

    return NextResponse.json({ ok: true })
  } catch (erro) {
    log.error('falha no retorno de e-mail', {
      tipo: typeof corpo === 'object' && corpo !== null ? String((corpo as Record<string, unknown>).type) : '?',
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    // 500 faz a Resend tentar de novo — o comportamento certo quando a falha
    // é nossa. Um bounce perdido é um endereço morto que fica na lista.
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

async function aplicar(tx: Tx, orgId: string, retorno: RetornoEmail): Promise<void> {
  if (retorno.tipo === 'ignorado') return
  const agora = new Date()

  if (retorno.tipo === 'entregue') {
    await marcarEntrega(tx, orgId, 'email', retorno.providerMessageId, 'delivered', agora)
    return
  }

  if (retorno.tipo === 'engajou') {
    /*
     * Abertura NÃO vira `read`. O pixel de rastreio dispara sozinho no cache de
     * imagem do Gmail e no antivírus corporativo, então "aberto" no e-mail não
     * significa o mesmo que "lido" no WhatsApp. Igualar os dois inflaria a taxa
     * de leitura do painel com abertura de robô.
     *
     * Clique é sinal de gente de verdade, e esse sobe o status.
     */
    if (retorno.acao !== 'clicado') return
    await marcarEntrega(tx, orgId, 'email', retorno.providerMessageId, 'read', agora)
    return
  }

  // Resta `bloquear`.
  const contactId = await acharContato(tx, orgId, retorno.providerMessageId, retorno.email)

  if (retorno.providerMessageId) {
    await marcarEntrega(tx, orgId, 'email', retorno.providerMessageId, 'failed', agora, {
      codigo: retorno.razao,
      mensagem: retorno.detalhe,
    })
  }

  /*
   * Sem contato não há o que bloquear. Acontece quando o e-mail saiu por outro
   * sistema no mesmo domínio, ou quando o contato foi anonimizado depois do
   * envio — nos dois casos criar um registro só para marcá-lo como bloqueado
   * seria guardar dado pessoal sem base legal (§14.1).
   */
  if (!contactId) return

  const novo = await bloquearCanal(tx, orgId, contactId, 'email', retorno.razao, retorno.detalhe, agora)

  // Reclamação de spam retira consentimento; avisa quem integra. Bounce não é
  // pedido do titular e não dispara `contact.opted_out`.
  if (novo && retorno.razao === 'complaint') {
    await notificar(tx, orgId, 'contact.opted_out', { contact_id: contactId, canal: 'email' }, agora)
  }
}

/**
 * De quem era o e-mail que voltou.
 *
 * Duas rotas, nesta ordem. Pela notificação é exato: liga o bounce à mensagem
 * que o causou. Pelo endereço é o resgate para quando o `email_id` não veio ou
 * a notificação já saiu da janela quente de 72h — e é o caminho que importa,
 * porque bounce assíncrono chega horas depois do envio.
 */
async function acharContato(
  tx: Tx,
  orgId: string,
  providerMessageId: string | null,
  email: string | null,
): Promise<string | null> {
  if (providerMessageId) {
    const [linha] = await tx
      .select({ contactId: notifications.contactId })
      .from(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.providerMessageId, providerMessageId),
        ),
      )
      .limit(1)

    if (linha?.contactId) return linha.contactId
  }

  if (!email) return null

  // `contacts.email` é citext: a comparação já ignora maiúsculas.
  const [contato] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.email, email)))
    .limit(1)

  return contato?.id ?? null
}
