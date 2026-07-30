import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { sources } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { serverEnv } from '@/env'
import { ultimoPayload } from '../actions'
import { PassoEndereco } from './passo-endereco'
import { CombinarCampos } from './combinar-campos'

export const metadata: Metadata = { title: 'Conectar plataforma · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Conectar plataforma, em três passos (§4.2).
 *
 * A numeração aparece porque aqui a ordem realmente importa — não como enfeite
 * (§11.5, nível 2).
 */
export default async function PlataformaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin()

  const [plataforma] = await withTenant(tenantOf(user), async (tx) =>
    tx
      .select({
        id: sources.id,
        name: sources.name,
        active: sources.active,
        ingestToken: sources.ingestToken,
        mapping: sources.mapping,
      })
      .from(sources)
      .where(eq(sources.id, id))
      .limit(1),
  )

  if (!plataforma) notFound()

  const ultimo = await ultimoPayload(plataforma.id)

  let base = 'https://mandafy.vercel.app'
  try {
    base = serverEnv().APP_URL
  } catch {
    // Ambiente incompleto não pode derrubar a tela; a URL é ilustrativa.
  }
  const enderecoWebhook = `${base}/in/${plataforma.ingestToken}`

  return (
    <SessionFrame
      title={plataforma.name}
      description="Três passos: apontar o endereço, receber um evento, combinar os campos."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/configuracoes/plataformas">Voltar</Link>
        </Button>
      }
    >
      <div className="flex max-w-3xl flex-col gap-4 pb-8">
        <PassoEndereco endereco={enderecoWebhook} />

        <Card>
          <CardHeader>
            <CardTitle>
              <span className="mr-2 font-mono text-2xs text-pending">2</span>
              Receber um evento
            </CardTitle>
            {ultimo ? <Badge tone="ok">recebido</Badge> : <Badge tone="pending">aguardando</Badge>}
          </CardHeader>
          <CardBody>
            {ultimo ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-ink-2">
                  Último evento em{' '}
                  <span className="font-mono">
                    {ultimo.recebidoEm.toLocaleString('pt-BR', { timeZone: user.timezone })}
                  </span>
                  .
                </p>
                {ultimo.erro ? (
                  <p className="text-2xs text-warn">
                    Chegou, mas não foi aproveitado: {ultimo.erro}. Ajuste o passo 3.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-ink-2">
                Dispare um evento de teste na plataforma — criar um pedido já serve. Assim que ele
                chegar, os campos dele aparecem no passo 3 para você combinar.
              </p>
            )}
          </CardBody>
        </Card>

        <CombinarCampos
          sourceId={plataforma.id}
          mapping={plataforma.mapping}
          payload={ultimo?.payload ?? null}
        />
      </div>
    </SessionFrame>
  )
}
