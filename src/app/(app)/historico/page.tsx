import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { listarHistorico } from '@/db/queries/historico'
import { SessionFrame } from '@/components/shell/app-shell'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { LogAoVivo, type LinhaLog } from './log'

export const metadata: Metadata = { title: 'Histórico · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function HistoricoPage() {
  const user = await requireUser()

  const linhas = await withTenant(tenantOf(user), (tx) =>
    listarHistorico(tx, {
      // Consultor só vê o que saiu para os leads dele (§9.4). O RLS protege o
      // banco; isto é o recorte da tela.
      ownerId: user.isAdmin ? null : user.id,
      limite: 200,
    }),
  )

  // Datas viram string na fronteira servidor→cliente: um `Date` atravessa a
  // serialização como string de qualquer forma, e ser explícito evita o tipo
  // mentir sobre o que chega do outro lado.
  const iniciais: LinhaLog[] = linhas.map((l) => ({
    id: l.id,
    createdAt: l.createdAt.toISOString(),
    channel: l.channel,
    status: l.status,
    contactId: l.contactId,
    contactName: l.contactName,
    messageKey: l.messageKey,
    scheduledFor: l.scheduledFor?.toISOString() ?? null,
    errorCode: l.errorCode,
    latenciaMs: l.latenciaMs,
  }))

  return (
    <SessionFrame
      title="Histórico"
      description={
        user.isAdmin
          ? 'Os últimos 3 dias, ao vivo. Clique numa linha para ver exatamente o que saiu.'
          : 'Os últimos 3 dias dos seus leads.'
      }
    >
      <LogAoVivo inicial={iniciais} podeReenviar={can(user, 'mensagem.enviar_manual')} />
    </SessionFrame>
  )
}
