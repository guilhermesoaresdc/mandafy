import { z } from 'zod'
import { CHANNELS } from '@/db/schema/enums'
import { comChave, erro, lerCorpo, ok } from '@/lib/api/responder'
import { descadastrar } from '@/lib/lgpd'
import { notificar } from '@/lib/api/webhooks'

/**
 * POST /v1/contacts/{id}/optout (§12.2, §14.1).
 *
 * O quarto caminho de opt-out da spec: endpoint de API para a plataforma do
 * cliente. Processamento IMEDIATO, não em 48h.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const schema = z.object({
  channel: z.enum(CHANNELS).optional(),
  reason: z.string().trim().max(200).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params

  return comChave(request, 'contacts:write', async (tx, ctx) => {
    if (!z.uuid().safeParse(id).success) return erro('nao_encontrado', 'Contato não encontrado.')

    const bruto = await lerCorpo(request)
    const parsed = schema.safeParse(bruto ?? {})
    if (!parsed.success) return erro('corpo_invalido', 'Corpo inválido.')

    const feito = await descadastrar(tx, ctx.chave.orgId, id, {
      ...(parsed.data.channel ? { canal: parsed.data.channel } : {}),
      ...(parsed.data.reason ? { motivo: parsed.data.reason } : {}),
    })

    if (!feito) return erro('nao_encontrado', 'Contato não encontrado.')

    await notificar(tx, ctx.chave.orgId, 'contact.opted_out', {
      contact_id: id,
      channel: parsed.data.channel ?? 'all',
    }).catch(() => 0)

    return ok({ contact_id: id, opted_out: true, channel: parsed.data.channel ?? 'all' })
  })
}
