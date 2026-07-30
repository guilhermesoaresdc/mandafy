import type { Metadata } from 'next'
import { withTenant } from '@/db'
import {
  acoesVencidas,
  consultoresAtivos,
  contarLeads,
  filtroSalvo,
  FILTROS_SALVOS,
  listarLeads,
  novosLeads,
  type FiltroLeads,
  type FiltroSalvo,
} from '@/db/queries/leads'
import { SessionFrame } from '@/components/shell/app-shell'
import { Card, CardBody, Stat } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { formatNumber } from '@/lib/utils'
import Link from 'next/link'
import { TabelaLeads, type LinhaLead } from './tabela'

export const metadata: Metadata = { title: 'Leads · Mandafy' }
export const dynamic = 'force-dynamic'

function ehFiltroSalvo(valor: string | undefined): valor is FiltroSalvo {
  return FILTROS_SALVOS.some((f) => f.chave === valor)
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string }>
}) {
  const user = await requireUser()
  const { filtro: chave } = await searchParams

  // Consultor não vê os filtros de outra pessoa; o RLS já limita o resultado,
  // isto só define o recorte pedido.
  const filtro: FiltroLeads = ehFiltroSalvo(chave) ? filtroSalvo(chave, user.id) : { limite: 1000 }

  const { linhas, total, consultores, vencidas, novos } = await withTenant(
    tenantOf(user),
    async (tx) => ({
      linhas: await listarLeads(tx, { ...filtro, limite: 1000 }),
      total: await contarLeads(tx),
      consultores: user.isAdmin ? await consultoresAtivos(tx, user.orgId) : [],
      vencidas: await acoesVencidas(tx),
      novos: await novosLeads(tx),
    }),
  )

  const paraTabela: LinhaLead[] = linhas.map((l) => ({
    id: l.id,
    title: l.title,
    valueCents: l.valueCents,
    status: l.status,
    stageName: l.stageName,
    stageColor: l.stageColor,
    ownerId: l.ownerId,
    ownerName: l.ownerName,
    contactName: l.contactName,
    contactPhone: l.contactPhone,
    contactEmail: l.contactEmail,
    source: l.source,
    nextActionAt: l.nextActionAt?.toISOString() ?? null,
    lastEventAt: l.lastEventAt?.toISOString() ?? null,
  }))

  return (
    <SessionFrame
      title="Leads"
      description={
        user.isAdmin
          ? 'Todo mundo que passou por aqui. Os leads nascem sozinhos conforme os eventos chegam.'
          : 'Os seus leads.'
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <CardBody className="grid grid-cols-3 gap-6">
            <Stat label="Leads" value={formatNumber(total)} />
            <Stat label="Novos (7 dias)" value={formatNumber(novos)} />
            <Stat label="Ação vencida" value={formatNumber(vencidas)} />
          </CardBody>
        </Card>

        {/* Filtros salvos (§9.1) */}
        <div className="flex flex-wrap gap-1">
          <Link
            href="/leads"
            className={`rounded-lg border px-2.5 py-1 text-2xs ${
              chave ? 'border-line text-ink-2' : 'border-ink text-ink'
            }`}
          >
            Todos
          </Link>
          {FILTROS_SALVOS.map((f) => (
            <Link
              key={f.chave}
              href={`/leads?filtro=${f.chave}`}
              className={`rounded-lg border px-2.5 py-1 text-2xs ${
                chave === f.chave ? 'border-ink text-ink' : 'border-line text-ink-2'
              }`}
            >
              {f.rotulo}
            </Link>
          ))}
        </div>

        <TabelaLeads
          linhas={paraTabela}
          consultores={consultores}
          podeReatribuir={can(user, 'leads.reatribuir')}
        />
      </div>
    </SessionFrame>
  )
}
