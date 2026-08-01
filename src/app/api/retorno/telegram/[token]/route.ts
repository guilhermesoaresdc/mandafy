import { and, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { withTenant, type Tx } from '@/db'
import { contacts, suppressions } from '@/db/schema'
import { canalPorToken, tokenPlausivel } from '@/lib/channels/retorno-lookup'
import {
  lerRetornoTelegram,
  payloadValido,
  type RetornoTelegram,
} from '@/lib/channels/telegram-webhook'
import { notificar } from '@/lib/api/webhooks'
import { descadastrar } from '@/lib/lgpd'
import { createLogger } from '@/lib/logger'

/**
 * Retorno do bot do Telegram (§8.5, §14.1).
 *
 * Diferente dos outros três, esta rota não existe para relatório: o Telegram
 * não reporta entrega nem leitura para bots. Ela existe para CAPTURAR o
 * `chat_id`, que é a única coisa que falta para o canal funcionar — e que só
 * passa a existir quando a pessoa fala com o bot.
 *
 * Sem esta rota o canal mais barato dos quatro fica permanentemente vazio: o
 * link de captura leva a pessoa até o bot, ela manda `/start`, e nada acontece.
 *
 * AUTENTICAÇÃO em duas camadas:
 *   - o token na URL identifica a organização;
 *   - o header `X-Telegram-Bot-Api-Secret-Token`, que o próprio Telegram envia
 *     em toda chamada quando registrado no `setWebhook`, é conferido por cima.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('retorno-telegram')

const TAMANHO_MAXIMO = 256 * 1024

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
    if (!canal || canal.canal !== 'telegram') {
      return NextResponse.json({ ok: false }, { status: 401 })
    }

    const segredo = canal.credenciais.webhookSecret
    if (segredo && request.headers.get('x-telegram-bot-api-secret-token') !== segredo) {
      log.warn('segredo recusado no retorno do Telegram', { orgId: canal.orgId })
      return NextResponse.json({ ok: false }, { status: 401 })
    }

    const retorno = lerRetornoTelegram(corpo)
    if (retorno.tipo === 'ignorado') return NextResponse.json({ ok: true, ignorado: true })

    await withTenant({ orgId: canal.orgId, userId: canal.id, isAdmin: true }, (tx) =>
      aplicar(tx, canal.orgId, retorno),
    )

    return NextResponse.json({ ok: true })
  } catch (erro) {
    log.error('falha no retorno do Telegram', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    /*
     * 200 mesmo em erro nosso, ao contrário dos outros canais. O Telegram
     * reentrega o MESMO update em sequência até receber 200 e trava a fila do
     * bot inteiro enquanto isso — um erro nosso num update pararia a captura de
     * todo mundo. O que se perde aqui é um `/start`, recuperável: a pessoa
     * manda de novo.
     */
    return NextResponse.json({ ok: true })
  }
}

async function aplicar(tx: Tx, orgId: string, retorno: RetornoTelegram): Promise<void> {
  if (retorno.tipo === 'ignorado') return
  const agora = new Date()

  if (retorno.tipo === 'inicio') {
    await vincular(tx, orgId, retorno.chatId, payloadValido(retorno.payload), agora)
    return
  }

  const [contato] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.telegramChatId, retorno.chatId)))
    .limit(1)

  if (!contato) return

  if (retorno.tipo === 'saida') {
    await descadastrar(tx, orgId, contato.id, {
      canal: 'telegram',
      motivo: 'pediu /parar no Telegram',
      quem: null,
    })
    await notificar(
      tx,
      orgId,
      'contact.opted_out',
      { contact_id: contato.id, canal: 'telegram' },
      agora,
    )
  }

  // Mensagem comum: nada a fazer por ora. O canal existe para sair daqui, não
  // para chegar — atendimento humano está fora de escopo (§17).
}

/**
 * Liga o chat ao contato que veio no `/start`.
 *
 * O payload é o `external_id` do contato, posto ali por `linkDeCaptura`. Sem
 * ele — quem achou o bot pela busca — não há como saber de quem se trata, e a
 * conversa fica sem vínculo. Criar um contato novo nesse caso seria inventar um
 * titular a partir de um `chat_id`, sem nome, sem consentimento e sem origem
 * (§14.1): dado pessoal guardado sem base legal.
 */
async function vincular(
  tx: Tx,
  orgId: string,
  chatId: number,
  payload: string | null,
  agora: Date,
): Promise<void> {
  if (!payload) {
    log.info('start sem payload — chat não vinculado')
    return
  }

  const [contato] = await tx
    .select({ id: contacts.id, chatAtual: contacts.telegramChatId })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.externalId, payload)))
    .limit(1)

  if (!contato) return

  /*
   * O vínculo pode já existir, e mesmo assim há trabalho a fazer. Quem mandou
   * `/parar` e depois `/start` de novo continua com o mesmo `chat_id` — sair
   * cedo aqui deixaria a supressão de pé, e o `/start` seria um botão que não
   * faz nada. Só o UPDATE do chat é que se pode pular.
   */
  if (contato.chatAtual !== chatId) {
    /*
     * O mesmo chat não pode ficar em dois contatos: a coluna não é única, e um
     * link de captura compartilhado (encaminhado num grupo, por exemplo)
     * levaria várias pessoas ao mesmo payload. Limpar o vínculo anterior deixa
     * o último `/start` valer, que é o comportamento que a pessoa espera — e
     * impede que uma mensagem destinada a um contato caia no chat de outro.
     */
    await tx
      .update(contacts)
      .set({ telegramChatId: null, updatedAt: agora })
      .where(and(eq(contacts.orgId, orgId), eq(contacts.telegramChatId, chatId)))
  }

  await tx
    .update(contacts)
    .set({
      telegramChatId: chatId,
      /*
       * O `/start` é consentimento explícito para o canal: a pessoa procurou o
       * bot e apertou iniciar. Religa o opt-in, porque um `/parar` seguido de
       * um `/start` novo é alguém voltando atrás.
       */
      optinTelegram: true,
      updatedAt: agora,
    })
    .where(eq(contacts.id, contato.id))

  /*
   * Religar o opt-in não basta: a guarda 2 (§5.3) consulta `suppressions`, e o
   * `/parar` anterior deixou uma linha lá. Sem remover, o canal continuaria
   * bloqueado e o `/start` seria um botão que não faz nada.
   *
   * Só a supressão por opt-out sai. Um bloqueio de outra natureza não foi
   * pedido da pessoa e não é dela para desfazer.
   */
  await tx
    .delete(suppressions)
    .where(
      and(
        eq(suppressions.orgId, orgId),
        eq(suppressions.contactId, contato.id),
        eq(suppressions.channel, 'telegram'),
        eq(suppressions.reason, 'optout'),
      ),
    )

  log.info('chat do Telegram vinculado ao contato', { contactId: contato.id })
}
