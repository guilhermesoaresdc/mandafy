import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { listarFluxos } from '@/db/queries/flows'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, EmptyState } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { alternarFluxoAction } from './actions'

export const metadata: Metadata = { title: 'Fluxos · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function FluxosPage() {
  const user = await requireAdmin()

  const lista = await withTenant(tenantOf(user), listarFluxos)

  return (
    <SessionFrame
      title="Fluxos"
      description="O que dispara, quando sai, e o que faz parar."
    >
      {lista.length === 0 ? (
        /* Copy de vazio convida à ação (§11.7). */
        <EmptyState
          title="Nenhum fluxo ainda"
          description="Rode `npm run db:seed` para trazer os nove modelos, incluindo a recuperação de PIX — ela avisa quem gerou o pagamento e não pagou, e para sozinha no instante em que o pagamento entra."
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-2">
          {lista.map((fluxo) => (
            <Card key={fluxo.id}>
              <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-48 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-xs font-medium text-ink">{fluxo.name}</p>
                    {fluxo.active ? (
                      <Badge tone="ok">ativo</Badge>
                    ) : (
                      <Badge tone="pending">pausado</Badge>
                    )}
                    {fluxo.cancelOn.length > 0 ? (
                      <Badge tone="pending">para sozinho</Badge>
                    ) : null}
                    {fluxo.temMensagemPausada ? (
                      <Badge tone="fail">mensagem pausada</Badge>
                    ) : null}
                  </div>

                  <p className="mt-0.5 font-mono text-2xs text-pending">
                    {fluxo.triggerEvent} · {fluxo.passos} passo{fluxo.passos === 1 ? '' : 's'}
                    {fluxo.ritmo ? ` · ${fluxo.ritmo}` : ''}
                  </p>
                </div>

                <form action={alternarFluxoAction}>
                  <input type="hidden" name="id" value={fluxo.id} />
                  <input type="hidden" name="ativar" value={fluxo.active ? '0' : '1'} />
                  <Button type="submit" variant="ghost" size="sm">
                    {fluxo.active ? 'Pausar' : 'Ativar'}
                  </Button>
                </form>

                <Button asChild variant="secondary" size="sm">
                  <Link href={`/fluxos/${fluxo.id}`}>Abrir</Link>
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </SessionFrame>
  )
}
