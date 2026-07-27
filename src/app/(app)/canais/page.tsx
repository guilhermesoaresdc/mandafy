import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, ChannelIcon } from '@/components/ui'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, CHANNELS, type Channel } from '@/db/schema/enums'
import { requireAdmin } from '@/lib/auth/current'

export const metadata: Metadata = { title: 'Canais · Mandafy' }

/** Copy pelo que a pessoa controla, não pela implementação (§11.7). */
const DESCRICOES: Record<Channel, string> = {
  whatsapp:
    'Conecte um número lendo o QR Code. Use pelo menos dois, e nunca o número principal do negócio.',
  email: 'Verifique seu domínio de envio. Sem SPF, DKIM e DMARC no verde, o envio fica bloqueado.',
  sms: 'O canal mais caro. Vem desligado por padrão e só entra nos passos finais de recuperação.',
  telegram: 'O mais barato e sem risco de bloqueio. Precisa que a pessoa inicie a conversa antes.',
}

export default async function CanaisPage() {
  await requireAdmin()

  return (
    <SessionFrame
      title="Canais"
      description="Por onde as mensagens saem. Cada canal é independente: trocar de provedor não mexe no resto."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {CHANNELS.map((channel) => (
          <Card key={channel}>
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: `color-mix(in oklab, var(${CHANNEL_COLOR_VAR[channel]}) 12%, white)`,
                    color: `var(${CHANNEL_COLOR_VAR[channel]})`,
                  }}
                >
                  <ChannelIcon channel={channel} className="size-4.5" />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-medium text-ink">{CHANNEL_LABELS[channel]}</p>
                    <Badge tone="pending">não configurado</Badge>
                  </div>
                  <p className="mt-1 text-2xs text-ink-2">{DESCRICOES[channel]}</p>
                </div>
              </div>

              {/* TODO Fase 4: abre o passo a passo de conexão do canal. */}
              <Button variant="secondary" size="sm" disabled className="self-start">
                Configurar
              </Button>
            </CardBody>
          </Card>
        ))}
      </div>
    </SessionFrame>
  )
}
