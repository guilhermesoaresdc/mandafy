import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq } from 'drizzle-orm'
import { withTenant } from '@/db'
import { detalharLead, etapasDoPipeline } from '@/db/queries/leads'
import { events, messages, notifications } from '@/db/schema'
import { SessionFrame } from '@/components/shell/app-shell'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { can } from '@/lib/rbac'
import { formatBRL } from '@/lib/utils'
import { nomeDoCampo } from '@/lib/vocabulario'
import { ExcluirLead } from './excluir-lead'
import { LinhaDoTempo, type ItemLinha } from './linha-do-tempo'
import { PainelLead } from './painel-lead'

export const metadata: Metadata = { title: 'Lead · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireUser()

  const dados = await withTenant(tenantOf(user), async (tx) => {
    const lead = await detalharLead(tx, id)
    if (!lead) return null

    // Eventos da plataforma e notificações do MESMO contato — é o que torna a
    // linha do tempo "unificada" em vez de três listas separadas.
    const eventosDoContato = await tx
      .select({
        type: events.type,
        occurredAt: events.occurredAt,
        data: events.data,
        externalId: events.externalId,
      })
      .from(events)
      .where(eq(events.contactId, lead.lead.contactId))
      .orderBy(desc(events.occurredAt))
      .limit(30)

    const envios = await tx
      .select({
        id: notifications.id,
        channel: notifications.channel,
        status: notifications.status,
        createdAt: notifications.createdAt,
        messageName: messages.name,
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
      quando: a.createdAt.toISOString(),
      texto: a.content ?? a.type,
      quem: a.userName,
      especie: a.type,
    })),
    ...eventosDoContato.map((e) => ({
      tipo: 'evento' as const,
      quando: e.occurredAt.toISOString(),
      evento: e.type,
      dados: e.data,
      externalId: e.externalId,
    })),
    ...envios.map((n) => ({
      tipo: 'envio' as const,
      quando: n.createdAt.toISOString(),
      canal: n.channel,
      status: n.status,
      // O NOME da mensagem, não a chave: `pix_lembrete_1` embaixo do nome do
      // cliente é o dicionário do banco vazando para a ficha (§11.7).
      texto: n.messageName ?? n.messageKey ?? 'mensagem',
      notificationId: n.id,
      criadoEm: n.createdAt.toISOString(),
    })),
  ].sort((a, b) => b.quando.localeCompare(a.quando))

  return (
    <SessionFrame
      title={lead.lead.title}
      description={`${lead.stageName} · ${lead.ownerName ?? 'sem responsável'}`}
      actions={
        <div className="flex items-center gap-2">
          {/* Só quem manda no funil apaga cartão (§9.4). */}
          {can(user, 'leads.reatribuir') ? (
            <ExcluirLead leadId={lead.lead.id} titulo={lead.lead.title} />
          ) : null}
          <Button asChild variant="ghost" size="sm">
            <Link href="/leads">Voltar</Link>
          </Button>
        </div>
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
                <p className="font-mono text-2xs text-ink-2">
                  <span className="text-pending">{nomeDoCampo('telefone')}: </span>
                  {lead.contactPhone}
                </p>
              ) : null}
              {lead.contactEmail ? (
                <p className="font-mono text-2xs text-ink-2">
                  <span className="text-pending">{nomeDoCampo('email')}: </span>
                  {lead.contactEmail}
                </p>
              ) : null}
              <p className="mt-1 text-2xs text-pending">
                Entrou por: <span className="text-ink-2">{lead.lead.source}</span>
              </p>
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
            <span className="text-2xs text-pending">clique para ver tudo do item</span>
          </CardHeader>
          <CardBody className="max-h-[60vh] overflow-y-auto py-0">
            <LinhaDoTempo itens={linha} podeReenviar={can(user, 'mensagem.enviar_manual')} />
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
