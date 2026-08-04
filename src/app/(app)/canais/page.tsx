import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { estadoDosCanais, saudeDasInstancias } from '@/db/queries/channels'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, ChannelIcon, Separator } from '@/components/ui'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, type Channel } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { serverEnv } from '@/env'
import { resolverServidorEvolution } from '@/lib/delivery/config'
import { cn } from '@/lib/utils'
import {
  alternarNumeroAction,
  desconectarNumeroAction,
  removerNumeroAction,
} from './actions'
import { AcoesNumero } from './acoes-numero'
import { AlternarCanal } from './alternar'
import { ConectarNumero } from './conectar-numero'
import { EnderecoRetorno } from './endereco-retorno'
import { ConfigurarCanal } from './configurar'

export const metadata: Metadata = { title: 'Canais · Mandafy' }
export const dynamic = 'force-dynamic'

/** Copy pelo que a pessoa controla, não pela implementação (§11.7). */
const DESCRICOES: Record<Channel, string> = {
  whatsapp:
    'Conecte um número lendo o QR Code na Evolution. Use pelo menos dois, e nunca o número principal do negócio.',
  email: 'Verifique seu domínio de envio. Sem SPF, DKIM e DMARC no verde, a entrega degrada sozinha.',
  sms: 'O canal mais caro. Vem desligado por padrão e só entra nos passos finais de recuperação.',
  telegram: 'O mais barato e sem risco de bloqueio. Precisa que a pessoa inicie a conversa antes.',
}

const CORES_SEMAFORO = {
  verde: 'bg-ok',
  ambar: 'bg-pending',
  vermelho: 'bg-fail',
} as const

export default async function CanaisPage() {
  const user = await requireAdmin()

  // O endereço público do app monta a URL de retorno que se cola no provedor.
  const appUrl = serverEnv().APP_URL

  const { canais, instancias, servidorPronto } = await withTenant(tenantOf(user), async (tx) => ({
    canais: await estadoDosCanais(tx),
    instancias: await saudeDasInstancias(tx),
    // Sem endereço e chave global não há como criar instância pelo painel — o
    // botão precisa dizer isso antes do clique, não depois.
    servidorPronto: (await resolverServidorEvolution(tx, user.orgId)) !== null,
  }))

  return (
    <SessionFrame
      title="Canais"
      description="Por onde as mensagens saem. Cada canal é independente: trocar de provedor não mexe no resto."
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 md:grid-cols-2">
          {canais.map((canal) => (
            <Card key={canal.canal}>
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                    style={{
                      background: `color-mix(in oklab, var(${CHANNEL_COLOR_VAR[canal.canal]}) 12%, transparent)`,
                      color: `var(${CHANNEL_COLOR_VAR[canal.canal]})`,
                    }}
                  >
                    <ChannelIcon channel={canal.canal} className="size-4.5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-ink">{CHANNEL_LABELS[canal.canal]}</p>
                      {canal.configurado ? (
                        canal.ativo ? (
                          <Badge tone="ok">ligado</Badge>
                        ) : (
                          <Badge tone="pending">desligado</Badge>
                        )
                      ) : (
                        <Badge tone="pending">sem configuração</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-2xs text-ink-2">{DESCRICOES[canal.canal]}</p>
                    {canal.provider ? (
                      <p className="mt-1 font-mono text-2xs text-pending">via {canal.provider}</p>
                    ) : null}
                  </div>
                </div>

                {/* O endereço de avisos do provedor (§8.1). Sem ele o canal
                    envia, mas nunca fica sabendo o que aconteceu depois. */}
                {canal.configurado ? (
                  <EnderecoRetorno
                    canal={canal.canal}
                    token={canal.webhookToken}
                    appUrl={appUrl}
                  />
                ) : null}

                <div className="flex items-center gap-2">
                  <ConfigurarCanal
                    canal={canal.canal}
                    provider={canal.provider}
                    configurado={canal.configurado}
                    ativo={canal.ativo}
                  />

                  {canal.configurado ? (
                    <AlternarCanal canal={canal.canal} ativo={canal.ativo} />
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>

        <Separator />

        {/* ── Painel de saúde dos números (§7.3) ── */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xs font-medium text-ink">Números de WhatsApp</h2>
              <p className="text-2xs text-ink-2">
                Cada número tem seu próprio ritmo e teto. Mais de um em rodízio protege a operação
                quando um cai.
              </p>
            </div>
            <ConectarNumero servidorPronto={servidorPronto} />
          </div>

          {instancias.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-2xs text-pending">
                  Nenhum número conectado ainda. Sem ele o WhatsApp não envia — os outros três
                  canais funcionam normalmente.
                </p>
              </CardBody>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {instancias.map((instancia) => (
                <Card key={instancia.id}>
                  <CardBody className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span
                      aria-label={instancia.semaforo.texto}
                      title={instancia.semaforo.texto}
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        CORES_SEMAFORO[instancia.semaforo.cor],
                      )}
                    />

                    <div className="min-w-40 flex-1">
                      <p className="truncate text-xs font-medium text-ink">{instancia.name}</p>
                      <p className="truncate font-mono text-2xs text-pending">
                        {instancia.instanceName} · {instancia.semaforo.texto}
                      </p>
                    </div>

                    <div className="text-2xs text-ink-2">
                      <span className="text-pending">estágio </span>
                      {instancia.estagioLabel}
                    </div>

                    <div className="text-2xs text-ink-2">
                      <span className="text-pending">hoje </span>
                      <span className="font-mono">
                        {instancia.enviadasHoje}/{instancia.tetoDiario}
                      </span>
                    </div>

                    <div className="text-2xs text-ink-2">
                      <span className="text-pending">intervalo </span>
                      <span className="font-mono">{instancia.intervaloMinimo}s</span>
                    </div>

                    <div className="text-2xs text-ink-2">
                      <span className="text-pending">falha 24h </span>
                      <span className="font-mono">{(instancia.falha24h * 100).toFixed(1)}%</span>
                    </div>

                    <form action={alternarNumeroAction}>
                      <input type="hidden" name="id" value={instancia.id} />
                      <input type="hidden" name="ativar" value={instancia.ativa ? '0' : '1'} />
                      <Button type="submit" variant="ghost" size="sm">
                        {instancia.ativa ? 'Pausar' : 'Retomar'}
                      </Button>
                    </form>

                    {instancia.status === 'conectado' ? (
                      <form action={desconectarNumeroAction}>
                        <input type="hidden" name="id" value={instancia.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Desconectar
                        </Button>
                      </form>
                    ) : null}

                    <AcoesNumero
                      id={instancia.id}
                      nome={instancia.name}
                      gerenciada={instancia.gerenciada}
                      conectado={instancia.status === 'conectado'}
                      onRemover={removerNumeroAction}
                    />
                  </CardBody>
                </Card>
              ))}

              <p className="text-2xs text-pending">
                Número novo passa a receber envios quando o worker reinicia — cada número tem a
                própria fila, e ela é criada na subida do processo.
              </p>
            </div>
          )}
        </div>
      </div>
    </SessionFrame>
  )
}
