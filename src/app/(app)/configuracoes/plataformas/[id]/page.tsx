import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { sources } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { eventosPorTipo, resumoNoAr } from '@/db/queries/no-ar'
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

  const { plataforma, recebidos, noAr } = await withTenant(tenantOf(user), async (tx) => {
    const [linha] = await tx
      .select({
        id: sources.id,
        name: sources.name,
        active: sources.active,
        ingestToken: sources.ingestToken,
        mapping: sources.mapping,
      })
      .from(sources)
      .where(eq(sources.id, id))
      .limit(1)

    return {
      plataforma: linha,
      /*
       * As duas leituras precisam sair do MESMO withTenant do fluxo, senão o
       * cruzamento "quem escuta este evento" compara organizações diferentes —
       * e um aviso mentiroso é pior que aviso nenhum.
       */
      recebidos: linha ? await eventosPorTipo(tx, linha.id) : [],
      noAr: linha ? await resumoNoAr(tx) : null,
    }
  })

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

        {/*
          O que a plataforma manda DE VERDADE.
          
          Antes disto a tela mostrava um único payload — o último — e a lista de
          plataformas, um total bruto sem quebra por tipo. Quem estava
          conectando tinha de adivinhar quais eventos a própria plataforma
          dispara, e não tinha como saber se algum deles chegava sem ninguém
          escutando do outro lado.
        */}
        {recebidos.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>O que esta plataforma manda</CardTitle>
              <span className="text-2xs text-pending">últimos 7 dias</span>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {recebidos.map((evento) => {
                const ouvintes = (noAr?.fluxos ?? []).filter(
                  (f) => f.active && f.triggerEvent === evento.type,
                )

                return (
                  <div key={evento.type} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-44 font-mono text-2xs text-ink">{evento.type}</span>
                    <span className="text-2xs text-pending">
                      {evento.total}× · último em{' '}
                      {evento.ultimo.toLocaleString('pt-BR', { timeZone: user.timezone })}
                    </span>
                    {ouvintes.length > 0 ? (
                      <Badge tone="ok">{ouvintes.map((f) => f.name).join(', ')}</Badge>
                    ) : (
                      <Badge tone="pending">nenhum fluxo escuta</Badge>
                    )}
                  </div>
                )
              })}
            </CardBody>
          </Card>
        ) : null}

        <CombinarCampos
          sourceId={plataforma.id}
          mapping={plataforma.mapping}
          payload={ultimo?.payload ?? null}
        />
      </div>
    </SessionFrame>
  )
}
