import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, leadActivities, leads, pipelines, pipelineStages } from '@/db/schema'
import { cargaPorConsultor, consultoresAtivos } from '@/db/queries/leads'
import { createLogger } from '@/lib/logger'
import { proximoResponsavel, regrasAplicaveis, type ContextoRegra } from './distribuicao'

/**
 * Criação automática de lead a partir de evento (§9.3).
 *
 * Mora fora do motor de fluxos de propósito: um lead é sobre a pessoa, um
 * fluxo é sobre a mensagem. Misturá-los faria pausar uma cadência parar de
 * gerar leads — que não é o que ninguém espera ao clicar em "pausar fluxo".
 */

const log = createLogger('crm')

export type EventoParaLead = {
  orgId: string
  tipo: string
  contactId: string | null
  /** O contato entrou na base agora, por este evento (§9.3). */
  contatoNovo?: boolean
  dados: Record<string, unknown>
}

export type ResultadoLead =
  | { criado: true; leadId: string; regra: string; ownerId: string | null }
  | { criado: false; motivo: string }

function valorDos(dados: Record<string, unknown>): number | null {
  const bruto = dados.valor_cents
  if (typeof bruto === 'number' && Number.isFinite(bruto)) return bruto
  if (typeof bruto === 'string') {
    const n = Number(bruto)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export async function criarLeadDoEvento(
  tx: Tx,
  evento: EventoParaLead,
  agora = new Date(),
): Promise<ResultadoLead[]> {
  if (!evento.contactId) return [{ criado: false, motivo: 'evento sem contato' }]

  const [contato] = await tx
    .select({
      id: contacts.id,
      name: contacts.name,
      totalOrders: contacts.totalOrders,
      totalPaidCents: contacts.totalPaidCents,
    })
    .from(contacts)
    .where(eq(contacts.id, evento.contactId))
    .limit(1)

  if (!contato) return [{ criado: false, motivo: 'contato não encontrado' }]

  const ctx: ContextoRegra = {
    evento: evento.tipo,
    valorCents: valorDos(evento.dados),
    jaComprou: contato.totalOrders > 0 || contato.totalPaidCents > 0,
    contatoNovo: evento.contatoNovo ?? false,
  }

  const regras = regrasAplicaveis(ctx)
  if (regras.length === 0) return []

  const [pipeline] = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.isDefault, true))
    .limit(1)

  if (!pipeline) return [{ criado: false, motivo: 'sem pipeline padrão' }]

  const etapas = await tx
    .select({ id: pipelineStages.id, name: pipelineStages.name })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))

  const resultados: ResultadoLead[] = []

  for (const regra of regras) {
    /*
     * Regra com atraso (o PIX não pago em 24h) não cria nada agora: o lead só
     * faz sentido se o pagamento NÃO tiver chegado. Criar já e apagar depois
     * encheria o funil de lead fantasma e mexeria na carga do rodízio à toa.
     * Quem materializa isso é a varredura de `varrerLeadsAtrasados`.
     */
    if (regra.atrasoSegundos) {
      resultados.push({ criado: false, motivo: `${regra.chave}: aguardando ${regra.atrasoSegundos}s` })
      continue
    }

    const etapa = etapas.find((e) => e.name === regra.etapa) ?? etapas[0]
    if (!etapa) {
      resultados.push({ criado: false, motivo: 'pipeline sem etapas' })
      continue
    }

    // Um contato não pode virar dois leads abertos pelo mesmo motivo.
    const [existente] = await tx
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.contactId, contato.id),
          eq(leads.status, 'aberto'),
          eq(leads.source, `evento:${regra.chave}`),
        ),
      )
      .limit(1)

    if (existente) {
      resultados.push({ criado: false, motivo: `${regra.chave}: já existe lead aberto` })
      continue
    }

    const consultores = await consultoresAtivos(tx, evento.orgId)
    const carga = await cargaPorConsultor(tx)
    const dono = proximoResponsavel(consultores, carga)

    const [criado] = await tx
      .insert(leads)
      .values({
        orgId: evento.orgId,
        contactId: contato.id,
        ownerId: dono?.id ?? null,
        pipelineId: pipeline.id,
        stageId: etapa.id,
        title: contato.name ?? 'Lead sem nome',
        valueCents: ctx.valorCents ?? 0,
        source: `evento:${regra.chave}`,
        stageChangedAt: agora,
      })
      .returning({ id: leads.id })

    if (!criado) {
      resultados.push({ criado: false, motivo: 'insert sem retorno' })
      continue
    }

    await tx.insert(leadActivities).values({
      leadId: criado.id,
      type: 'mudanca_etapa',
      content: `Criado automaticamente: ${regra.rotulo}. ${regra.explicacao}`,
    })

    // Sem nome nem telefone no log (§14.1).
    log.info('lead criado por regra', { leadId: criado.id, regra: regra.chave, temDono: Boolean(dono) })

    resultados.push({ criado: true, leadId: criado.id, regra: regra.chave, ownerId: dono?.id ?? null })
  }

  return resultados
}

/**
 * Materializa as regras com atraso (§9.3, "sem pagamento em 24h").
 *
 * Roda na manutenção. Procura pedidos criados há mais de 24h que continuam sem
 * pagamento e ainda não viraram lead.
 *
 * A checagem de "não pagou" é feita AGORA, não no momento do evento — é a
 * diferença entre um funil com leads reais e um cheio de gente que pagou dez
 * minutos depois.
 */
export async function varrerLeadsAtrasados(
  tx: Tx,
  orgId: string,
  limite = 100,
  agora = new Date(),
): Promise<number> {
  const [pipeline] = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.isDefault, true))
    .limit(1)

  if (!pipeline) return 0

  const [etapa] = await tx
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .orderBy(pipelineStages.position)
    .limit(1)

  if (!etapa) return 0

  const corte = new Date(agora.getTime() - 24 * 3600 * 1000).toISOString()

  /*
   * Um pedido "abandonado" é um `order.created` sem `order.paid` nem
   * `order.cancelled` de MESMO `external_id`. A comparação por external_id, e
   * não por contato, é o que separa dois pedidos da mesma pessoa.
   */
  const candidatos = await tx.execute<{ contact_id: string; external_id: string; valor: number | null }>(
    sql`
      SELECT DISTINCT ON (e.external_id)
        e.contact_id,
        e.external_id,
        (e.data ->> 'valor_cents')::bigint AS valor
      FROM events e
      WHERE e.type = 'order.created'
        AND e.occurred_at < ${corte}::timestamptz
        AND e.occurred_at > ${corte}::timestamptz - interval '7 days'
        AND e.contact_id IS NOT NULL
        AND e.external_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM events pago
          WHERE pago.external_id = e.external_id
            AND pago.type IN ('order.paid', 'order.cancelled')
            AND pago.occurred_at > ${corte}::timestamptz - interval '7 days'
        )
        AND NOT EXISTS (
          SELECT 1 FROM leads l
          WHERE l.contact_id = e.contact_id
            AND l.source = 'evento:pix_nao_pago_24h'
            AND l.status = 'aberto'
        )
      ORDER BY e.external_id, e.occurred_at DESC
      LIMIT ${limite}
    `,
  )

  if (candidatos.length === 0) return 0

  const consultores = await consultoresAtivos(tx, orgId)
  const carga = await cargaPorConsultor(tx)

  let criados = 0
  for (const candidato of candidatos) {
    const [contato] = await tx
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, candidato.contact_id))
      .limit(1)

    if (!contato) continue

    const dono = proximoResponsavel(consultores, carga)

    const [criado] = await tx
      .insert(leads)
      .values({
        orgId,
        contactId: candidato.contact_id,
        ownerId: dono?.id ?? null,
        pipelineId: pipeline.id,
        stageId: etapa.id,
        title: contato.name ?? 'Lead sem nome',
        valueCents: Number(candidato.valor ?? 0),
        source: 'evento:pix_nao_pago_24h',
        stageChangedAt: agora,
      })
      .returning({ id: leads.id })

    if (!criado) continue

    await tx.insert(leadActivities).values({
      leadId: criado.id,
      type: 'mudanca_etapa',
      content: `Criado automaticamente: gerou o PIX do pedido ${candidato.external_id} e não pagou em 24h.`,
    })

    // A carga sobe a cada atribuição: sem isso, todos os leads da varredura
    // cairiam no mesmo consultor.
    if (dono) carga.set(dono.id, (carga.get(dono.id) ?? 0) + 1)
    criados += 1
  }

  if (criados > 0) log.info('leads criados pela varredura', { criados })

  return criados
}
