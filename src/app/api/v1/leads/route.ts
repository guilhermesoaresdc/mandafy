import { comChave, ok, paginacao } from '@/lib/api/responder'
import { listarLeads } from '@/db/queries/leads'

/** GET /v1/leads (§12.2). */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  return comChave(request, 'leads:read', async (tx) => {
    const url = new URL(request.url)
    const { limite, offset } = paginacao(url)
    const busca = url.searchParams.get('search')?.trim()

    const linhas = await listarLeads(tx, {
      ...(busca ? { busca } : {}),
      limite,
      offset,
    })

    return ok({
      data: linhas.map((l) => ({
        id: l.id,
        title: l.title,
        value_cents: l.valueCents,
        status: l.status,
        stage: l.stageName,
        owner: l.ownerName,
        contact: { id: l.contactId, name: l.contactName, phone: l.contactPhone, email: l.contactEmail },
        source: l.source,
        created_at: l.createdAt,
      })),
      limit: limite,
      offset,
    })
  })
}
