import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { saudeDasInstancias } from '@/db/queries/channels'
import { metricasDoPainel, proximosEnvios, saudeDosCanais } from '@/db/queries/painel'
import { SessionFrame } from '@/components/shell/app-shell'
import { BarraDePulso, type EnvioNaBarra } from '@/components/shell/barra-de-pulso'
import { Card, CardBody, CardHeader, CardTitle, ChannelIcon, Stat } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { avaliarAlertas } from '@/lib/alertas'
import { cn, formatBRL, formatNumber, formatPercent } from '@/lib/utils'

export const metadata: Metadata = { title: 'Painel · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function PainelPage() {
  const user = await requireUser()

  const { metricas, proximos, canais, instancias } = await withTenant(
    tenantOf(user),
    async (tx) => ({
      metricas: await metricasDoPainel(tx),
      proximos: await proximosEnvios(tx),
      canais: await saudeDosCanais(tx),
      instancias: user.isAdmin ? await saudeDasInstancias(tx) : [],
    }),
  )

  const alertas = avaliarAlertas({ canais, instancias, naFila: metricas.naFila })

  const naBarra: EnvioNaBarra[] = proximos.map((e) => ({
    id: e.id,
    channel: e.channel,
    scheduledFor: e.scheduledFor.toISOString(),
  }))

  return (
    <SessionFrame title="Painel" description={`Operação de ${user.orgName}`}>
      <div className="flex flex-col gap-4">
        {/* ── Os cinco números (§10.3). Nada de gráfico decorativo. ── */}
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label="Enviadas hoje" value={formatNumber(metricas.enviadasHoje)} />
            <Stat
              label="Taxa entrega"
              value={metricas.taxaEntrega === null ? '—' : formatPercent(metricas.taxaEntrega)}
            />
            <Stat label="Na fila" value={formatNumber(metricas.naFila)} />
            <Stat label="Falhas 24h" value={formatNumber(metricas.falhas24h)} />
            <Stat label="Recuperado" value={formatBRL(metricas.recuperadoCents)} />
          </CardBody>
        </Card>

        {/* ── Alertas (§10.4) ── */}
        {alertas.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Precisa de atenção</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
              {alertas.map((alerta, i) => (
                <div key={`${alerta.titulo}-${i}`} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1 size-1.5 shrink-0 rounded-full',
                      alerta.nivel === 'critico' ? 'bg-fail' : 'bg-pending',
                    )}
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-ink">{alerta.titulo}</p>
                    <p className="text-2xs text-ink-2">{alerta.acao}</p>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}

        {/* ── A barra de pulso (§11.6) ── */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-medium text-ink">Próxima hora</h2>
            <Link href="/historico" className="text-2xs text-ink-2 underline-offset-2 hover:underline">
              ver o histórico
            </Link>
          </div>
          <BarraDePulso envios={naBarra} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* ── Próximos envios (§10.3) ── */}
          <Card>
            <CardHeader>
              <CardTitle>Próximos envios</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1">
              {proximos.length === 0 ? (
                <p className="text-2xs text-pending">Nada agendado para a próxima hora.</p>
              ) : (
                proximos.slice(0, 8).map((envio) => (
                  <div key={envio.id} className="flex items-center gap-2 text-2xs">
                    <span className="font-mono text-ink tabular-nums">
                      {envio.scheduledFor.toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'America/Sao_Paulo',
                      })}
                    </span>
                    <ChannelIcon channel={envio.channel} className="size-3" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {envio.contactName ?? '—'}
                    </span>
                    <span className="truncate font-mono text-pending">{envio.messageKey ?? ''}</span>
                  </div>
                ))
              )}
              {proximos.length > 8 ? (
                <p className="mt-1 text-2xs text-pending">e mais {proximos.length - 8}…</p>
              ) : null}
            </CardBody>
          </Card>

          {/* ── Saúde por canal ── */}
          <Card>
            <CardHeader>
              <CardTitle>Canais nas últimas 24h</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {canais.map((canal) => (
                <div key={canal.canal} className="flex items-center gap-2 text-2xs">
                  <ChannelIcon channel={canal.canal} className="size-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {formatNumber(canal.enviadas24h)} enviadas
                  </span>
                  <span
                    className={cn(
                      'font-mono tabular-nums',
                      canal.taxaFalha !== null && canal.taxaFalha > 0.1 ? 'text-fail' : 'text-pending',
                    )}
                  >
                    {canal.taxaFalha === null ? '—' : `${(canal.taxaFalha * 100).toFixed(1)}% falha`}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
    </SessionFrame>
  )
}
