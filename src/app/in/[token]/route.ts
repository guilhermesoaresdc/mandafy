import { sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db'
import { dedupeHash, verifySignature } from '@/lib/ingest/signature'
import { createLogger } from '@/lib/logger'
import { getQueue, QUEUE_NAMES } from '@/lib/queue'

/**
 * Webhook de entrada das plataformas de sorteio (§4.3).
 *
 * Alvo: ACK em menos de 50 ms (p95, §13.1). Por isso aqui só acontece o
 * mínimo — validar token, conferir assinatura, gravar o payload cru e
 * enfileirar. Normalizar, criar contato e disparar fluxos roda no worker.
 * Se a plataforma tiver timeout curto, é isso que salva a integração.
 *
 * Sem autenticação de sessão: o token na URL é a credencial (§12.2).
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('ingest')

/** Corpo maior que isso é recusado antes de qualquer processamento. */
const TAMANHO_MAXIMO = 512 * 1024

export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }) {
  const inicio = Date.now()
  const { token } = await context.params

  // Formato do token antes de tocar no banco: recusa varredura sem custo.
  if (!token || token.length < 16 || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return NextResponse.json({ ok: false, error: 'token_invalido' }, { status: 401 })
  }

  const rawBody = await request.text()
  if (rawBody.length > TAMANHO_MAXIMO) {
    return NextResponse.json({ ok: false, error: 'payload_grande_demais' }, { status: 413 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ ok: false, error: 'json_invalido' }, { status: 400 })
  }

  try {
    /*
     * A busca passa por função SECURITY DEFINER (drizzle/0016).
     *
     * A plataforma que chama não tem sessão nem contexto de tenant, e a
     * política de RLS de `sources` compara `org_id` com um valor nulo — o
     * SELECT direto devolvia ZERO linhas e esta rota respondia 401 para toda
     * integração legítima. O sintoma enganava: o painel mostrava o conector
     * configurado, e nada jamais chegava.
     */
    const encontradas = await db.execute<{
      id: string
      org_id: string
      hmac_secret: string | null
      active: boolean
    }>(sql`SELECT id, org_id, hmac_secret, active FROM mandafy_source_por_token(${token})`)

    const bruta = encontradas[0]
    const source = bruta
      ? { id: bruta.id, orgId: bruta.org_id, hmacSecret: bruta.hmac_secret, active: bruta.active }
      : null

    // Mesma resposta para token inexistente e conector desligado: quem
    // sonda não descobre se o token existe.
    if (!source || !source.active) {
      return NextResponse.json({ ok: false, error: 'token_invalido' }, { status: 401 })
    }

    const assinatura = verifySignature(
      rawBody,
      request.headers.get('x-mandafy-signature') ??
        request.headers.get('x-signature') ??
        request.headers.get('x-hub-signature-256'),
      source.hmacSecret,
    )

    // Assinatura configurada e inválida é rejeitada — e vira alerta (§10.4).
    if (assinatura.present && !assinatura.valid) {
      log.warn('assinatura inválida', { sourceId: source.id, motivo: assinatura.reason })
      return NextResponse.json({ ok: false, error: 'assinatura_invalida' }, { status: 401 })
    }

    const hash = dedupeHash(source.id, rawBody)

    /*
     * Deduplicação e gravação numa chamada só (drizzle/0016).
     *
     * Plataformas fazem retry com frequência (§4.3): se o mesmo corpo já
     * chegou nas últimas 24h, responde 200 e ignora — repetir seria mandar a
     * mesma mensagem duas vezes para o mesmo cliente.
     *
     * Junto e não em dois passos porque o retry costuma vir em rajada: com
     * SELECT e INSERT separados, duas chamadas simultâneas passavam as duas
     * pela checagem. Além disso `events_raw` herda a visibilidade de `sources`
     * no RLS, e este caminho não tem contexto de tenant — a função é a porta.
     */
    const gravadas = await db.execute<{
      id: string
      received_at: string
      duplicado: boolean
    }>(sql`
      SELECT id, received_at, duplicado FROM mandafy_gravar_evento_cru(
        ${token},
        ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify(cabecalhosSeguros(request))}::jsonb,
        ${hash},
        ${assinatura.present ? assinatura.valid : null}
      )`)

    const linha = gravadas[0]
    if (!linha) throw new Error('não foi possível gravar o evento')

    if (linha.duplicado) {
      return NextResponse.json(
        { ok: true, duplicado: true, ms: Date.now() - inicio },
        { status: 200 },
      )
    }

    const gravado = { id: Number(linha.id), receivedAt: new Date(linha.received_at) }

    /*
     * O enfileiramento não pode derrubar o ACK. Redis fora do ar significa
     * processamento atrasado — o evento já está gravado e o worker o retoma
     * pela varredura de pendentes. Devolver erro aqui faria a plataforma
     * reenviar um evento que já temos.
     */
    try {
      await getQueue(QUEUE_NAMES.normalize).add(
        'normalize',
        { rawId: gravado.id, receivedAt: gravado.receivedAt.toISOString(), sourceId: source.id },
        { jobId: `raw:${gravado.id}` },
      )
    } catch (error) {
      log.warn('evento gravado mas não enfileirado', {
        rawId: gravado.id,
        reason: error instanceof Error ? error.message : 'desconhecido',
      })
    }

    return NextResponse.json({ ok: true, id: String(gravado.id), ms: Date.now() - inicio })
  } catch (error) {
    log.error('falha na ingestão', {
      reason: error instanceof Error ? error.message : String(error),
    })
    // 500 faz a plataforma tentar de novo, que é o comportamento desejado
    // quando o problema é nosso.
    return NextResponse.json({ ok: false, error: 'erro_interno' }, { status: 500 })
  }
}

/** Cabeçalhos preservados para depuração, sem nada que autentique. */
function cabecalhosSeguros(request: NextRequest): Record<string, string> {
  const interessantes = ['content-type', 'user-agent', 'x-forwarded-for', 'x-request-id']
  const out: Record<string, string> = {}
  for (const nome of interessantes) {
    const valor = request.headers.get(nome)
    if (valor) out[nome] = valor.slice(0, 200)
  }
  return out
}

/** GET serve para a pessoa conferir no navegador que o endereço está certo. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    mensagem: 'Endereço de recebimento do Mandafy. Configure a plataforma para enviar POST aqui.',
  })
}
