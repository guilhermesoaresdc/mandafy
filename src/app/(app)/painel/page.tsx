import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Card, CardBody, CardHeader, CardTitle, EmptyState, Stat } from '@/components/ui'
import { requireUser } from '@/lib/auth/current'
import { formatBRL, formatNumber, formatPercent } from '@/lib/utils'

export const metadata: Metadata = { title: 'Painel · Mandafy' }

/**
 * Os cinco números do topo (§10.3). Nada de gráfico decorativo.
 *
 * TODO Fase 6: virão de `notification_daily_stats`, atualizada por trigger —
 * nunca de COUNT(*) em tabela grande (§13.2).
 */
const METRICAS = {
  enviadasHoje: 0,
  taxaEntrega: 0,
  naFila: 0,
  falhas24h: 0,
  recuperadoCents: 0,
}

export default async function PainelPage() {
  const user = await requireUser()

  return (
    <SessionFrame title="Painel" description={`Operação de ${user.orgName}`}>
      <div className="flex flex-col gap-4">
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 md:grid-cols-5">
            <Stat label="Enviadas hoje" value={formatNumber(METRICAS.enviadasHoje)} />
            <Stat
              label="Taxa entrega"
              value={formatPercent(METRICAS.taxaEntrega)}
              tone={METRICAS.taxaEntrega >= 0.9 ? 'ok' : 'neutral'}
            />
            <Stat label="Na fila" value={formatNumber(METRICAS.naFila)} />
            <Stat
              label="Falhas 24h"
              value={formatNumber(METRICAS.falhas24h)}
              tone={METRICAS.falhas24h > 0 ? 'fail' : 'neutral'}
            />
            <Stat label="Recuperado" value={formatBRL(METRICAS.recuperadoCents)} tone="ok" />
          </CardBody>
        </Card>

        {/* A barra de pulso (§11.6) é o elemento assinatura do produto:
            os próximos 60 minutos, cada envio um traço deslizando para a
            linha "agora". TODO Fase 6: canvas 2D alimentado por SSE. */}
        <Card>
          <CardHeader>
            <CardTitle>Próximos 60 minutos</CardTitle>
          </CardHeader>
          <CardBody>
            <EmptyState
              title="A operação ainda não está respirando"
              description="Quando os fluxos começarem a agendar envios, cada um aparece aqui como um traço deslizando até a linha do agora."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Próximos envios agendados</CardTitle>
          </CardHeader>
          <CardBody>
            <EmptyState
              title="Nenhum envio na fila"
              description="Conecte uma plataforma para que os eventos comecem a chegar e os fluxos entrem em ação."
            />
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
