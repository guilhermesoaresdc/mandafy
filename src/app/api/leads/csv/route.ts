import { withTenant } from '@/db'
import { listarLeads } from '@/db/queries/leads'
import { getCurrentUser, tenantOf } from '@/lib/auth/current'

/**
 * Exportar leads em CSV (§9.1).
 *
 * O RLS recorta por consultor: quem não é administrador exporta só os próprios
 * leads, sem que esta rota precise saber disso.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Escapa um campo.
 *
 * `=`, `+`, `-` e `@` no início ganham um `\t`: Excel e Sheets tratam isso como
 * FÓRMULA. Aqui o risco é maior que no histórico — o nome do lead vem do
 * cadastro de um terceiro.
 */
function campo(valor: unknown): string {
  if (valor === null || valor === undefined) return ''

  const texto = valor instanceof Date ? valor.toISOString() : String(valor)
  const perigoso = /^[=+\-@]/.test(texto)
  return `"${(perigoso ? `\t${texto}` : texto).replace(/"/g, '""')}"`
}

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return new Response('não autenticado', { status: 401 })

  const busca = new URL(request.url).searchParams.get('busca') ?? undefined

  const linhas = await withTenant(tenantOf(user), (tx) =>
    listarLeads(tx, { ...(busca ? { busca } : {}), limite: 1000 }),
  )

  const cabecalho = [
    'lead',
    'contato',
    'telefone',
    'email',
    'etapa',
    'status',
    'responsavel',
    'valor_cents',
    'origem',
    'criado_em',
    'ultimo_evento',
  ]

  const corpo = [
    '﻿' + cabecalho.join(','),
    ...linhas.map((l) =>
      [
        campo(l.title),
        campo(l.contactName),
        campo(l.contactPhone),
        campo(l.contactEmail),
        campo(l.stageName),
        campo(l.status),
        campo(l.ownerName),
        campo(l.valueCents),
        campo(l.source),
        campo(l.createdAt),
        campo(l.lastEventAt),
      ].join(','),
    ),
  ].join('\n')

  const carimbo = new Date().toISOString().slice(0, 10)

  return new Response(corpo, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="mandafy-leads-${carimbo}.csv"`,
      'cache-control': 'no-store',
    },
  })
}
