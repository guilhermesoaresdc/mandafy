import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { detalharLead, etapasDoPipeline } from '@/db/queries/leads'
import { events, messages, notifications } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, ChannelIcon } from '@/components/ui'
import { NOTIFICATION_STATUS_LABELS, type Channel, type NotificationStatus } from '@/db/schema/enums'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { formatBRL } from '@/lib/utils'
import { PainelLead } from './painel-lead'

export const metadata: Metadata = { title: 'Lead · Mandafy' }
export const dynamic = 'force-dynamic'

/** Um item da linha do tempo unificada (§9.1). */
type ItemLinha =
  | { tipo: 'atividade'; quando: Date; texto: string; quem: string | null; especie: string }
  | { tipo: 'evento'; quando: Date; texto: string }
  | { tipo: 'envio'; quando: Date; canal: Channel; status: NotificationStatus; texto: string }

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireUser()

  const dados = await withTenant(tenantOf(user), async (tx) => {
    const lead = await detalharLead(tx, id)
    if (!lead) return null

    // Eventos da plataforma e notificações do MESMO contato — é o que torna a
    // linha do tempo "unificada" em vez de três listas separadas.
    const eventosDoContato = await tx
      .select({ type: events.type, occurredAt: events.occurredAt, data: events.data })
      .from(events)
      .where(eq(events.contactId, lead.lead.contactId))
      .orderBy(desc(events.occurredAt))
      .limit(30)

    const envios = await tx
      .select({
        channel: notifications.channel,
        status: notifications.status,
        createdAt: notifications.createdAt,
        messageKey: messages.key,
      })
      .from(notifications)
      .leftJoin(messages, eq(messages.id, notifications.messageId))
      .where(and(eq(notifications.contactId, lead.lead.contactId)))
      .orderBy(desc(notifications.createdAt))
      .limit(30)

    const etapas = await etapasDoPipeline(tx)

    return { lead, eventosDoContato, envios, etapas }
  })

  if (!dados) notFound()

  const { lead, eventosDoContato, envios, etapas } = dados

  const linha: ItemLinha[] = [
    ...lead.atividades.map((a) => ({
      tipo: 'atividade' as const,
      quando: a.createdAt,
      texto: a.content ?? a.type,
      quem: a.userName,
      especie: a.type,
    })),
    ...eventosDoContato.map((e) => ({
      tipo: 'evento' as const,
      quando: e.occurredAt,
      texto: e.type,
    })),
    ...envios.map((n) => ({
      tipo: 'envio' as const,
      quando: n.createdAt,
      canal: n.channel,
      status: n.status,
      texto: n.messageKey ?? 'mensagem',
    })),
  ].sort((a, b) => b.quando.getTime() - a.quando.getTime())

  return (
    <SessionFrame
      title={lead.lead.title}
      description={`${lead.stageName} · ${lead.ownerName ?? 'sem responsável'}`}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href="/leads">Voltar</Link>
        </Button>
      }
    >
      <div className="grid max-w-4xl gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Contato</CardTitle>
              {lead.lead.valueCents > 0 ? (
                <span className="font-mono text-2xs text-ink">
                  {formatBRL(lead.lead.valueCents)}
                </span>
              ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-1">
              <p className="text-xs text-ink">{lead.contactName ?? '—'}</p>
              {lead.contactPhone ? (
                <p className="font-mono text-2xs text-ink-2">{lead.contactPhone}</p>
              ) : null}
              {lead.contactEmail ? (
                <p className="font-mono text-2xs text-ink-2">{lead.contactEmail}</p>
              ) : null}
              <p className="mt-1 font-mono text-2xs text-pending">origem: {lead.lead.source}</p>
            </CardBody>
          </Card>

          <PainelLead
            leadId={lead.lead.id}
            stageId={lead.lead.stageId}
            status={lead.lead.status}
            etapas={etapas.map((e) => ({ id: e.id, name: e.name }))}
          />
        </div>

        {/* ── Linha do tempo unificada (§9.1) ── */}
        <Card>
          <CardHeader>
            <CardTitle>Linha do tempo</CardTitle>
            <span className="text-2xs text-pending">plataforma, envios e notas juntos</span>
          </CardHeader>
          <CardBody className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {linha.length === 0 ? (
              <p className="text-2xs text-pending">Nada registrado ainda.</p>
            ) : (
              linha.map((item, i) => (
                <div key={i} className="flex items-start gap-2 border-b border-line/40 pb-2 last:border-0">
                  <span className="w-20 shrink-0 font-mono text-2xs text-pending tabular-nums">
                    {item.quando.toLocaleString('pt-BR', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'America/Sao_Paulo',
                    })}
                  </span>

                  <div className="min-w-0 flex-1">
                    {item.tipo === 'envio' ? (
                      <div className="flex items-center gap-1.5">
                        <ChannelIcon channel={item.canal} className="size-3" aria-hidden="true" />
                        <span className="truncate font-mono text-2xs text-ink-2">{item.texto}</span>
                        <Badge
                          tone={
                            ['sent', 'delivered', 'read'].includes(item.status)
                              ? 'ok'
                              : ['failed', 'dead'].includes(item.status)
                                ? 'fail'
                                : 'pending'
                          }
                        >
                          {NOTIFICATION_STATUS_LABELS[item.status]}
                        </Badge>
                      </div>
                    ) : item.tipo === 'evento' ? (
                      <p className="font-mono text-2xs text-ink-2">{item.texto}</p>
                    ) : (
                      <p className="text-2xs text-ink">
                        {item.texto}
                        {item.quem ? <span className="text-pending"> — {item.quem}</span> : null}
                      </p>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
