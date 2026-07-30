import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { montarPipeline } from '@/db/queries/leads'
import { SessionFrame } from '@/components/shell/app-shell'
import { EmptyState } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { Kanban, type Coluna } from './kanban'

export const metadata: Metadata = { title: 'Pipeline · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function PipelinePage() {
  const user = await requireUser()

  // Consultor vê o pipeline FILTRADO (§9.4) — o RLS de `leads` já faz o
  // recorte por dono, então a mesma consulta serve aos dois perfis.
  const colunas = await withTenant(tenantOf(user), (tx) => montarPipeline(tx))

  const paraKanban: Coluna[] = colunas.map((c) => ({
    stageId: c.stageId,
    name: c.name,
    color: c.color,
    isWon: c.isWon,
    isLost: c.isLost,
    total: c.total,
    somaCents: c.somaCents,
    cartoes: c.cartoes.map((cartao) => ({
      id: cartao.id,
      title: cartao.title,
      valueCents: cartao.valueCents,
      ownerName: cartao.ownerName,
      contactName: cartao.contactName,
      diasNaEtapa: cartao.diasNaEtapa,
    })),
  }))

  const vazio = paraKanban.every((c) => c.total === 0)

  return (
    <SessionFrame
      title="Pipeline"
      description={
        user.isAdmin
          ? 'Arraste para mover de etapa. O cartão move na hora; o servidor confirma depois.'
          : 'Os seus leads, por etapa.'
      }
    >
      {paraKanban.length === 0 ? (
        <EmptyState
          title="Nenhum funil configurado"
          description="Rode `npm run db:seed` para criar o funil padrão: Novo → Contatado → Negociando → Ganho / Perdido."
        />
      ) : vazio ? (
        <div className="flex flex-col gap-4">
          <EmptyState
            title="Nenhum lead no funil ainda"
            description="Os leads nascem sozinhos: PIX gerado e não pago em 24h, compra acima de R$ 200, ou contato que sumiu há 30 dias mas já comprou."
          />
          <Kanban colunas={paraKanban} />
        </div>
      ) : (
        <Kanban colunas={paraKanban} />
      )}
    </SessionFrame>
  )
}
