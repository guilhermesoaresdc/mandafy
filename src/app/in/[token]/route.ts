import { and, eq, gt, sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db'
import { eventsRaw, sources } from '@/db/schema'
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
    const [source] = await db
      .select({
        id: sources.id,
        orgId: sources.orgId,
        hmacSecret: sources.hmacSecret,
        active: sources.active,
      })
      .from(sources)
      .where(eq(sources.ingestToken, token))
      .limit(1)

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
     * Deduplicação: plataformas fazem retry com frequência (§4.3). Se o mesmo
     * corpo já chegou nas últimas 24h, responde 200 e ignora — repetir seria
     * mandar a mesma mensagem duas vezes para o mesmo cliente.
     */
    const [duplicado] = await db
      .select({ id: eventsRaw.id })
      .from(eventsRaw)
      .where(
        and(
          eq(eventsRaw.dedupeHash, hash),
          gt(eventsRaw.receivedAt, sql`now() - interval '24 hours'`),
        ),
      )
      .limit(1)

    if (duplicado) {
      return NextResponse.json(
        { ok: true, duplicado: true, ms: Date.now() - inicio },
        { status: 200 },
      )
    }

    const [gravado] = await db
      .insert(eventsRaw)
      .values({
        sourceId: source.id,
        payload,
        // Cabeçalhos úteis para depurar a integração, sem os que carregam
        // credencial: authorization e cookie ficam de fora (§14.1).
        headers: cabecalhosSeguros(request),
        dedupeHash: hash,
        signatureOk: assinatura.present ? assinatura.valid : null,
      })
      .returning({ id: eventsRaw.id, receivedAt: eventsRaw.receivedAt })

    if (!gravado) throw new Error('não foi possível gravar o evento')

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
