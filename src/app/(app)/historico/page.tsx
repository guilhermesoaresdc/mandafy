import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, EmptyState } from '@/components/ui'
import { CHANNEL_LABELS, CHANNEL_SHORT, CHANNELS } from '@/db/schema/enums'
import { requireUser } from '@/lib/auth/current'

export const metadata: Metadata = { title: 'Histórico · Mandafy' }

export default async function HistoricoPage() {
  const user = await requireUser()

  return (
    <SessionFrame
      title="Histórico"
      description={
        user.isAdmin
          ? 'Os últimos 3 dias, ao vivo. Clique numa linha para ver exatamente o que saiu.'
          : 'Os últimos 3 dias dos seus leads.'
      }
    >
      {/* Layout de terminal de log (§10.1): denso, monoespaçado, rápido.
          Sem cards inflados. */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
          <span className="text-2xs font-medium text-ink-2">Todos</span>

          <div className="flex gap-1">
            {CHANNELS.map((channel) => (
              <span
                key={channel}
                title={CHANNEL_LABELS[channel]}
                className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-2xs text-pending"
              >
                {CHANNEL_SHORT[channel]}
              </span>
            ))}
          </div>

          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-2xs text-pending">
            Status
          </span>
          <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-2xs text-pending">
            Buscar…
          </span>

          <span className="ml-auto flex items-center gap-1.5 text-2xs text-pending">
            {/* TODO Fase 6: SSE em /api/stream, sem polling (§13.2). */}
            <span className="size-1.5 rounded-full bg-pending" aria-hidden="true" />
            ao vivo
          </span>
        </div>

        <div className="p-4">
          <EmptyState
            title="Nada saiu ainda"
            description="Cada envio aparece aqui no instante em que acontece — com o horário, o canal, o contato e o que exatamente foi entregue."
            className="border-0 bg-transparent"
          />
        </div>
      </div>

      <p className="mt-3 flex items-center gap-2 text-2xs text-pending">
        <Badge tone="neutral">3 dias quentes</Badge>
        <span>
          Depois disso, 30 dias em arquivo e 12 meses de agregados. A limpeza descarta partições
          inteiras, sem travar o banco.
        </span>
      </p>
    </SessionFrame>
  )
}
