import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { listarPlataformas } from '@/db/queries/sources'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, EmptyState } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { NovaPlataforma } from './nova-plataforma'

export const metadata: Metadata = { title: 'Plataformas · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function PlataformasPage() {
  const user = await requireAdmin()

  const lista = await withTenant(tenantOf(user), listarPlataformas)

  return (
    <SessionFrame
      title="Plataformas"
      description="De onde os eventos chegam. Cada plataforma de sorteio conectada vira uma origem aqui."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/configuracoes">Voltar</Link>
        </Button>
      }
    >
      <div className="flex max-w-3xl flex-col gap-4">
        <NovaPlataforma />

        {lista.length === 0 ? (
          <EmptyState
            title="Nenhuma plataforma conectada"
            description="Conecte a primeira e o Mandafy passa a receber os eventos dela — novo usuário, PIX gerado, pagamento confirmado. Leva 2 minutos."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {lista.map((item) => (
              <Card key={item.id}>
                <CardBody className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-xs font-medium text-ink">{item.name}</p>
                      {item.active ? (
                        <Badge tone="ok">conectada</Badge>
                      ) : (
                        <Badge tone="pending">pausada</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 font-mono text-2xs text-pending">
                      {item.recebidos === 0
                        ? 'nenhum evento recebido ainda'
                        : `${item.recebidos} evento(s) recebido(s)`}
                    </p>
                  </div>

                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/configuracoes/plataformas/${item.id}`}>Configurar</Link>
                  </Button>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>
    </SessionFrame>
  )
}
