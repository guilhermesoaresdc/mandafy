import { desc, or, sql } from 'drizzle-orm'
import { contacts } from '@/db/schema'
import { comChave, ok, paginacao } from '@/lib/api/responder'

/**
 * GET /v1/contacts (§12.2).
 *
 * Devolve o telefone e o e-mail — é o ponto: quem chama a API é o dono do dado.
 * O que NÃO sai daqui é o CPF, que só interessa à plataforma que o coletou e
 * cujo vazamento é o mais caro (§14.1).
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  return comChave(request, 'contacts:read', async (tx) => {
    const url = new URL(request.url)
    const { limite, offset } = paginacao(url)
    const busca = url.searchParams.get('search')?.trim()

    const onde = busca
      ? or(
          sql`${contacts.name} ILIKE ${`%${busca}%`}`,
          sql`${contacts.phoneE164} ILIKE ${`%${busca}%`}`,
          sql`${contacts.email} ILIKE ${`%${busca}%`}`,
        )
      : undefined

    const linhas = await tx
      .select({
        id: contacts.id,
        external_id: contacts.externalId,
        name: contacts.name,
        phone: contacts.phoneE164,
        email: contacts.email,
        tags: contacts.tags,
        opted_out_at: contacts.optedOutAt,
        optin_at: contacts.optinAt,
        total_orders: contacts.totalOrders,
        total_paid_cents: contacts.totalPaidCents,
        last_event_at: contacts.lastEventAt,
        created_at: contacts.createdAt,
      })
      .from(contacts)
      .where(onde)
      .orderBy(desc(contacts.createdAt))
      .limit(limite)
      .offset(offset)

    return ok({ data: linhas, limit: limite, offset })
  })
}
