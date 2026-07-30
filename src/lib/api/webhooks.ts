import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { outboundWebhooks } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import type { EventoSaida } from './escopos'

/**
 * Webhooks de saída (§12.3).
 *
 * Notifica o sistema do cliente sobre o que acontece dentro do Mandafy.
 * Assinatura HMAC-SHA256 em `X-Mandafy-Signature` sobre `timestamp.body`, com
 * tolerância de 5 minutos contra replay.
 *
 * O timestamp entra na mensagem assinada, e não só num header separado, por um
 * motivo concreto: assinar apenas o corpo deixaria a assinatura válida para
 * sempre, e quem capturasse uma entrega poderia reenviá-la meses depois.
 */

const log = createLogger('webhooks')

// Ver a nota em ./escopos: os rótulos ficam fora daqui para o cliente poder
// importá-los sem trazer junto o acesso ao banco.
export { EVENTOS_SAIDA, EVENTO_LABELS, type EventoSaida } from './escopos'

/** Backoff de §12.3: 1min, 5min, 30min, 2h, 12h. */
export const BACKOFF_SEGUNDOS = [60, 300, 1800, 7200, 43_200] as const

/** Após 5 falhas seguidas o webhook é desativado e o admin é alertado. */
export const FALHAS_PARA_DESATIVAR = 5

/** Tolerância contra replay (§12.3). */
export const TOLERANCIA_SEGUNDOS = 300

export function gerarSegredo(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`
}

/** `t=<unix>,v1=<hex>` — o mesmo formato que a ingestão já entende (§4.3). */
export function assinar(corpo: string, segredo: string, agora = new Date()): string {
  const timestamp = Math.floor(agora.getTime() / 1000)
  const assinatura = createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex')

  return `t=${timestamp},v1=${assinatura}`
}

export type VerificacaoAssinatura =
  | { ok: true }
  | { ok: false; motivo: 'formato' | 'expirada' | 'invalida' }

/**
 * Confere uma assinatura.
 *
 * Exposta para que o cliente possa copiar a lógica — e para que exista teste
 * do lado de quem recebe, não só de quem manda.
 */
export function verificar(
  corpo: string,
  cabecalho: string,
  segredo: string,
  agora = new Date(),
): VerificacaoAssinatura {
  const partes = new Map(
    cabecalho.split(',').map((p) => {
      const [chave, ...resto] = p.trim().split('=')
      return [chave ?? '', resto.join('=')]
    }),
  )

  const timestamp = Number(partes.get('t'))
  const recebida = partes.get('v1')
  if (!Number.isFinite(timestamp) || !recebida) return { ok: false, motivo: 'formato' }

  const idade = Math.abs(Math.floor(agora.getTime() / 1000) - timestamp)
  if (idade > TOLERANCIA_SEGUNDOS) return { ok: false, motivo: 'expirada' }

  const esperada = createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex')

  const a = Buffer.from(recebida, 'utf8')
  const b = Buffer.from(esperada, 'utf8')
  if (a.length !== b.length) return { ok: false, motivo: 'invalida' }

  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, motivo: 'invalida' }
}

export type EntregaWebhook = {
  url: string
  segredo: string
  evento: EventoSaida
  dados: Record<string, unknown>
}

export type ResultadoEntrega =
  | { ok: true; status: number }
  | { ok: false; status: number | null; erro: string }

/** Entrega um webhook. Timeout curto: um cliente lento não pode travar a fila. */
export async function entregar(
  entrega: EntregaWebhook,
  agora = new Date(),
): Promise<ResultadoEntrega> {
  const corpo = JSON.stringify({
    event: entrega.evento,
    created_at: agora.toISOString(),
    data: entrega.dados,
  })

  try {
    const resposta = await fetch(entrega.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mandafy-signature': assinar(corpo, entrega.segredo, agora),
        'user-agent': 'Mandafy/1.0',
      },
      body: corpo,
      signal: AbortSignal.timeout(10_000),
    })

    return resposta.ok
      ? { ok: true, status: resposta.status }
      : { ok: false, status: resposta.status, erro: `HTTP ${resposta.status}` }
  } catch (e) {
    return {
      ok: false,
      status: null,
      erro: e instanceof Error ? e.message : 'falha de rede',
    }
  }
}

/**
 * Dispara um evento para todos os webhooks inscritos nele.
 *
 * As falhas NÃO derrubam quem chamou: um webhook do cliente fora do ar não
 * pode impedir uma mensagem de sair. O retry vive na fila; aqui só se registra
 * o estado.
 */
export async function notificar(
  tx: Tx,
  orgId: string,
  evento: EventoSaida,
  dados: Record<string, unknown>,
  agora = new Date(),
): Promise<number> {
  const inscritos = await tx
    .select()
    .from(outboundWebhooks)
    .where(and(eq(outboundWebhooks.orgId, orgId), eq(outboundWebhooks.active, true)))

  const alvos = inscritos.filter((w) => w.events.includes(evento))
  if (alvos.length === 0) return 0

  let entregues = 0

  for (const alvo of alvos) {
    const resultado = await entregar(
      { url: alvo.url, segredo: alvo.secret, evento, dados },
      agora,
    )

    if (resultado.ok) {
      await tx
        .update(outboundWebhooks)
        .set({
          lastStatus: resultado.status,
          lastError: null,
          lastSentAt: agora,
          // Zera o contador: cinco falhas SEGUIDAS desativam, não cinco falhas
          // ao longo da vida.
          failureCount: 0,
          updatedAt: agora,
        })
        .where(eq(outboundWebhooks.id, alvo.id))

      entregues += 1
      continue
    }

    const falhas = alvo.failureCount + 1
    const desativar = falhas >= FALHAS_PARA_DESATIVAR

    await tx
      .update(outboundWebhooks)
      .set({
        lastStatus: resultado.status,
        lastError: resultado.erro.slice(0, 500),
        failureCount: falhas,
        active: !desativar,
        updatedAt: agora,
      })
      .where(eq(outboundWebhooks.id, alvo.id))

    // Sem URL completa no log: ela pode conter token do cliente.
    log.warn('webhook falhou', { webhookId: alvo.id, falhas, desativado: desativar })
  }

  return entregues
}

/** Quando tentar de novo, dado quantas vezes já falhou (§12.3). */
export function proximaTentativaEm(falhas: number): number | null {
  const espera = BACKOFF_SEGUNDOS[Math.min(falhas, BACKOFF_SEGUNDOS.length - 1)]
  return falhas >= FALHAS_PARA_DESATIVAR ? null : (espera ?? null)
}

/** Reativa um webhook desativado por falhas, zerando o contador. */
export async function reativar(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx
    .update(outboundWebhooks)
    .set({ active: true, failureCount: 0, lastError: null, updatedAt: new Date() })
    .where(and(eq(outboundWebhooks.id, id), eq(outboundWebhooks.orgId, orgId)))
}

/** Webhooks da organização, sem o segredo. */
export async function listarWebhooks(tx: Tx): Promise<
  {
    id: string
    url: string
    events: string[]
    active: boolean
    lastStatus: number | null
    lastError: string | null
    lastSentAt: Date | null
    failureCount: number
  }[]
> {
  return tx
    .select({
      id: outboundWebhooks.id,
      url: outboundWebhooks.url,
      events: outboundWebhooks.events,
      active: outboundWebhooks.active,
      lastStatus: outboundWebhooks.lastStatus,
      lastError: outboundWebhooks.lastError,
      lastSentAt: outboundWebhooks.lastSentAt,
      failureCount: outboundWebhooks.failureCount,
    })
    .from(outboundWebhooks)
    .orderBy(sql`${outboundWebhooks.createdAt} DESC`)
}
