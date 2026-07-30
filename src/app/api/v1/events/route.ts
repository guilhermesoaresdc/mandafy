import { z } from 'zod'
import { eventsRaw, sources } from '@/db/schema'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { comChave, erro, lerCorpo, ok } from '@/lib/api/responder'
import { dedupeHash } from '@/lib/ingest/signature'
import { mappingSchema } from '@/lib/ingest/mapping'
import { getQueue, QUEUE_NAMES } from '@/lib/queue'
import { eq } from 'drizzle-orm'

/**
 * POST /v1/events (§12.2) — ingestão autenticada, formato canônico.
 *
 * Diferente de `/in/{token}`: ali o corpo é o da plataforma e passa pelo
 * mapeamento; aqui já vem canônico. O caminho depois é o mesmo — grava cru,
 * enfileira normalização — para que o histórico e o replay funcionem igual
 * pelos dois lados.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const schema = z.object({
  type: z.enum(CANONICAL_EVENTS),
  external_id: z.string().trim().max(200).optional(),
  occurred_at: z.iso.datetime().optional(),
  contact: z.object({
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().max(200).optional(),
    name: z.string().trim().max(200).optional(),
    external_id: z.string().trim().max(200).optional(),
  }),
  data: z.record(z.string(), z.unknown()).default({}),
})

export async function POST(request: Request): Promise<Response> {
  return comChave(request, 'events:write', async (tx, ctx) => {
    const bruto = await lerCorpo(request)
    if (!bruto) return erro('corpo_invalido', 'O corpo precisa ser um objeto JSON.')

    const parsed = schema.safeParse(bruto)
    if (!parsed.success) {
      return erro('corpo_invalido', 'Corpo inválido.', parsed.error.issues.slice(0, 5))
    }

    /*
     * O evento entra por uma origem chamada "API", criada na primeira chamada.
     * Ter uma origem real — em vez de `source_id` nulo — faz o evento aparecer
     * na tela de plataformas com o resto, e o replay funcionar igual.
     */
    const [origem] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.platform, 'custom'))
      .limit(1)

    const sourceId =
      origem?.id ??
      (
        await tx
          .insert(sources)
          .values({
            orgId: ctx.chave.orgId,
            name: 'API',
            platform: 'custom',
            ingestToken: `api-${ctx.chave.orgId}`,
            /*
             * O corpo já chega canônico, então o mapa é a identidade: o tipo
             * vem de `$.type` e os campos têm os nomes finais. É o que permite
             * o evento da API percorrer exatamente o mesmo caminho de
             * normalização que o da plataforma.
             */
            mapping: mappingSchema.parse({
              event_path: '$.type',
              event_map: Object.fromEntries(CANONICAL_EVENTS.map((e) => [e, e])),
              contact: {
                external_id: '$.contact.external_id',
                name: '$.contact.name',
                phone: '$.contact.phone',
                email: '$.contact.email',
              },
              fields: { external_id: '$.external_id' },
            }),
          })
          .returning({ id: sources.id })
      )[0]?.id

    if (!sourceId) return erro('erro_interno', 'Não foi possível registrar a origem.')

    const corpoCanonico = {
      type: parsed.data.type,
      external_id: parsed.data.external_id,
      contact: parsed.data.contact,
      data: parsed.data.data,
    }

    const [gravado] = await tx
      .insert(eventsRaw)
      .values({
        sourceId,
        payload: corpoCanonico,
        headers: { via: 'api' },
        dedupeHash: ctx.idempotencyKey ?? dedupeHash(sourceId, JSON.stringify(corpoCanonico)),
        signatureOk: true,
        ...(parsed.data.occurred_at ? { receivedAt: new Date(parsed.data.occurred_at) } : {}),
      })
      .returning({ id: eventsRaw.id })

    if (!gravado) return erro('erro_interno', 'Não foi possível gravar o evento.')

    // Grava primeiro, enfileira depois: Redis fora do ar não pode perder o
    // evento, e a varredura da manutenção o retoma.
    try {
      await getQueue(QUEUE_NAMES.normalize).add('normalize', { rawId: gravado.id })
    } catch {
      // Fica pendente; a manutenção reenfileira.
    }

    return ok({ event_id: gravado.id, accepted: true }, 202)
  })
}
