import { z } from 'zod'
import { withTenant } from '@/db'
import { auditLog } from '@/db/schema'
import { getCurrentUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { exportarContato } from '@/lib/lgpd'

/**
 * Exportar os dados de um contato (§14.1).
 *
 * "Endpoint e botão no painel para exportar todos os dados de um contato
 * (JSON)". Autenticado por sessão, não por chave de API: exportar dado pessoal
 * é ação de pessoa, e a auditoria precisa saber QUEM pediu.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return new Response('não autenticado', { status: 401 })
  if (!can(user, 'contatos.exportar')) return new Response('sem permissão', { status: 403 })

  const { contactId } = await params
  if (!z.uuid().safeParse(contactId).success) {
    return new Response('contato não encontrado', { status: 404 })
  }

  const exportacao = await withTenant(tenantOf(user), async (tx) => {
    const dados = await exportarContato(tx, contactId)
    if (!dados) return null

    // Log de auditoria de todo acesso a dado pessoal (§14.1).
    await tx.insert(auditLog).values({
      orgId: user.orgId,
      userId: user.id,
      action: 'lgpd.exportar',
      entity: 'contacts',
      entityId: contactId,
    })

    return dados
  })

  if (!exportacao) return new Response('contato não encontrado', { status: 404 })

  return new Response(JSON.stringify(exportacao, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="contato-${contactId}.json"`,
      'cache-control': 'no-store',
    },
  })
}
