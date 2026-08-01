import { and, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { withTenant, type Tx } from '@/db'
import { contacts } from '@/db/schema'
import { canalPorToken, tokenPlausivel } from '@/lib/channels/retorno-lookup'
import {
  lerDlrComtele,
  lerDlrSmsDev,
  lerRespostaSmsDev,
  type RetornoSms,
} from '@/lib/channels/sms-webhook'
import { notificar } from '@/lib/api/webhooks'
import { marcarEntrega } from '@/lib/delivery/retorno'
import { descadastrar, ehPedidoDeSaida } from '@/lib/lgpd'
import { createLogger } from '@/lib/logger'
import { toE164 } from '@/lib/phone'

/**
 * Retorno do provedor de SMS — a DLR (§8.1, §8.4, §14.1).
 *
 * Aceita GET e POST porque os dois provedores discordam: o SMSDev chama por GET
 * com os campos na query string, a Comtele por POST com JSON. Exigir um formato
 * só obrigaria a manter dois endereços diferentes no painel.
 *
 * Vale registrar o que esta rota NÃO resolve: o "SAIR" por SMS só chega se o
 * número contratado for de duas vias. Sem isso o único caminho de descadastro
 * do canal é o link — e é por isso que a variante de SMS precisa levá-lo.
 *
 * AUTENTICAÇÃO é o token na URL, e só. Nenhum dos dois provedores assina a
 * chamada da DLR; não há o que conferir além do segredo do endereço.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('retorno-sms')

const TAMANHO_MAXIMO = 64 * 1024

export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!tokenPlausivel(token)) return NextResponse.json({ ok: false }, { status: 401 })

  const params = request.nextUrl.searchParams

  return processar(token, (provider) => {
    // Resposta e DLR chegam no mesmo endereço; a presença do texto decide.
    const resposta = lerRespostaSmsDev(params)
    if (resposta.tipo === 'recebida') return resposta
    return provider === 'comtele' ? { tipo: 'ignorado', motivo: 'comtele não usa GET' } : lerDlrSmsDev(params)
  })
}

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!tokenPlausivel(token)) return NextResponse.json({ ok: false }, { status: 401 })

  const bruto = await request.text()
  if (bruto.length > TAMANHO_MAXIMO) return NextResponse.json({ ok: false }, { status: 413 })

  /*
   * A Comtele manda JSON, mas alguns painéis do SMSDev mandam a mesma DLR do
   * GET como formulário. Ler as duas formas evita um 400 silencioso que
   * ninguém descobriria — a DLR não tem tela de erro do outro lado.
   */
  let json: unknown = null
  let form: URLSearchParams | null = null

  const tipo = request.headers.get('content-type') ?? ''
  if (tipo.includes('json')) {
    try {
      json = JSON.parse(bruto)
    } catch {
      return NextResponse.json({ ok: false }, { status: 400 })
    }
  } else {
    form = new URLSearchParams(bruto)
  }

  return processar(token, () => {
    if (form) {
      const resposta = lerRespostaSmsDev(form)
      return resposta.tipo === 'recebida' ? resposta : lerDlrSmsDev(form)
    }
    // O corpo JSON é sempre da Comtele: o SMSDev não usa esse formato.
    return lerDlrComtele(json)
  })
}

async function processar(
  token: string,
  ler: (provider: string) => RetornoSms,
): Promise<NextResponse> {
  try {
    const canal = await canalPorToken(token)
    if (!canal || canal.canal !== 'sms') return NextResponse.json({ ok: false }, { status: 401 })

    const retorno = ler(canal.provider)
    if (retorno.tipo === 'ignorado') return NextResponse.json({ ok: true, ignorado: true })

    await withTenant({ orgId: canal.orgId, userId: canal.id, isAdmin: true }, (tx) =>
      aplicar(tx, canal.orgId, retorno),
    )

    return NextResponse.json({ ok: true })
  } catch (erro) {
    log.error('falha no retorno de SMS', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}

async function aplicar(tx: Tx, orgId: string, retorno: RetornoSms): Promise<void> {
  if (retorno.tipo === 'ignorado') return
  const agora = new Date()

  if (retorno.tipo === 'status') {
    await marcarEntrega(
      tx,
      orgId,
      'sms',
      retorno.providerMessageId,
      retorno.estado,
      agora,
      retorno.estado === 'failed'
        ? { codigo: 'dlr_falhou', mensagem: `a operadora não entregou: ${retorno.detalhe}` }
        : undefined,
    )
    return
  }

  // Resta `recebida`. Só o pedido de saída importa — o resto é conversa que o
  // SMS não sustenta e que não vale guardar (§14.1).
  if (!ehPedidoDeSaida(retorno.texto)) return

  const e164 = toE164(retorno.telefone)
  if (!e164) return

  const [contato] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.phoneE164, e164)))
    .limit(1)

  if (!contato) return

  /*
   * Descadastra do SMS, não de tudo. Quem responde "SAIR" a um SMS está
   * reagindo ao canal caro e invasivo; presumir que também não quer o e-mail
   * seria decidir por ela. O descadastro geral tem o link, que diz o que faz.
   */
  await descadastrar(tx, orgId, contato.id, {
    canal: 'sms',
    motivo: 'respondeu pedindo para sair no SMS',
    quem: null,
  })

  await notificar(tx, orgId, 'contact.opted_out', { contact_id: contato.id, canal: 'sms' }, agora)
}
