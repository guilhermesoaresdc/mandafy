import type { Metadata } from 'next'
import Link from 'next/link'
import { desc } from 'drizzle-orm'
import { withTenant } from '@/db'
import { apiKeys } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { ESCOPO_LABELS, type Escopo } from '@/lib/api/keys'
import { EVENTO_LABELS, listarWebhooks, type EventoSaida } from '@/lib/api/webhooks'
import { alternarWebhookAction, revogarChaveAction } from './actions'
import { NovaChave, NovoWebhook } from './formularios'

export const metadata: Metadata = { title: 'API · Mandafy' }
export const dynamic = 'force-dynamic'

function quando(data: Date | null): string {
  if (!data) return 'nunca'
  return data.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

export default async function ApiPage() {
  const user = await requireAdmin()

  const { chaves, webhooks } = await withTenant(tenantOf(user), async (tx) => ({
    chaves: await tx.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)),
    webhooks: await listarWebhooks(tx),
  }))

  return (
    <SessionFrame
      title="API"
      description="Para o seu sistema falar com o Mandafy, e o Mandafy avisar o seu sistema."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/configuracoes">Voltar</Link>
        </Button>
      }
    >
      <div className="flex max-w-3xl flex-col gap-6">
        {/* ── Chaves (§12.1) ── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-medium text-ink">Chaves</h2>
              <p className="text-2xs text-ink-2">
                Mande em <code className="font-mono">Authorization: Bearer mandafy_live_…</code>
              </p>
            </div>
            <NovaChave />
          </div>

          {chaves.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-2xs text-pending">Nenhuma chave ainda.</p>
              </CardBody>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {chaves.map((chave) => (
                <Card key={chave.id}>
                  <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-40 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-xs font-medium text-ink">{chave.name}</p>
                        {chave.revokedAt ? <Badge tone="fail">revogada</Badge> : null}
                      </div>
                      <p className="truncate font-mono text-2xs text-pending">{chave.keyPrefix}</p>
                      <p className="mt-0.5 text-2xs text-ink-2">
                        {chave.scopes
                          .map((e) => ESCOPO_LABELS[e as Escopo] ?? e)
                          .join(' · ')}
                      </p>
                    </div>

                    <span className="text-2xs text-pending">
                      último uso: {quando(chave.lastUsedAt)}
                    </span>

                    {chave.revokedAt ? null : (
                      <form action={revogarChaveAction}>
                        <input type="hidden" name="id" value={chave.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Revogar
                        </Button>
                      </form>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* ── Webhooks de saída (§12.3) ── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-medium text-ink">Webhooks de saída</h2>
              <p className="text-2xs text-ink-2">
                Avisamos o seu sistema quando algo acontece aqui.
              </p>
            </div>
            <NovoWebhook />
          </div>

          {webhooks.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-2xs text-pending">Nenhum webhook ainda.</p>
              </CardBody>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {webhooks.map((webhook) => (
                <Card key={webhook.id}>
                  <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-40 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-mono text-2xs text-ink">{webhook.url}</p>
                        {webhook.active ? (
                          <Badge tone="ok">ativo</Badge>
                        ) : (
                          <Badge tone="fail">
                            {webhook.failureCount >= 5 ? 'desativado por falhas' : 'pausado'}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-2xs text-ink-2">
                        {webhook.events.map((e) => EVENTO_LABELS[e as EventoSaida] ?? e).join(' · ')}
                      </p>
                      {webhook.lastError ? (
                        <p className="mt-0.5 truncate text-2xs text-fail">{webhook.lastError}</p>
                      ) : null}
                    </div>

                    <span className="text-2xs text-pending">
                      {webhook.lastSentAt ? quando(webhook.lastSentAt) : 'nunca entregou'}
                    </span>

                    <form action={alternarWebhookAction} className="flex gap-1">
                      <input type="hidden" name="id" value={webhook.id} />
                      <input
                        type="hidden"
                        name="acao"
                        value={webhook.active ? 'desligar' : webhook.failureCount >= 5 ? 'reativar' : 'ligar'}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {webhook.active ? 'Pausar' : webhook.failureCount >= 5 ? 'Reativar' : 'Ligar'}
                      </Button>
                    </form>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Como validar a assinatura</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
              <p className="text-2xs text-ink-2">
                Cada entrega leva o header <code className="font-mono">X-Mandafy-Signature</code> no
                formato <code className="font-mono">t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>. O HMAC é
                SHA-256 sobre <code className="font-mono">timestamp + &quot;.&quot; + corpo</code>,
                com o segredo do webhook.
              </p>
              <p className="text-2xs text-pending">
                Rejeite entregas com mais de 5 minutos: o timestamp entra na assinatura justamente
                para que uma entrega capturada não possa ser reenviada depois.
              </p>
              <p className="text-2xs text-pending">
                Após 5 falhas seguidas o webhook é desativado sozinho. Entrega bem-sucedida zera o
                contador.
              </p>
            </CardBody>
          </Card>
        </section>
      </div>
    </SessionFrame>
  )
}
