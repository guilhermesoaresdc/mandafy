import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import type { Tx } from '@/db'
import { contacts, leadActivities, leads, pipelines, pipelineStages, users } from '@/db/schema'
import type { LeadStatus } from '@/db/schema/enums'

/**
 * Leads e pipeline (§9).
 *
 * O recorte por consultor é o ponto crítico: §9.4 diz que consultor só enxerga
 * os próprios leads, "garantido no banco (RLS), não só na UI". O RLS já faz
 * isso — estas consultas NÃO repetem o filtro por dono, justamente para que o
 * teste de RLS continue sendo o que prova a regra. Repetir aqui esconderia uma
 * política quebrada atrás de um `WHERE` da aplicação.
 */

export type FiltroLeads = {
  busca?: string
  stageId?: string | null
  status?: LeadStatus
  /** Filtro salvo "Sem contato há N dias" (§9.1). */
  paradoHaDias?: number
  ownerId?: string | null
  /** `true` = sem responsável, para a fila de distribuição. */
  semDono?: boolean
  limite?: number
  offset?: number
}

export type LeadResumo = {
  id: string
  title: string
  valueCents: number
  status: LeadStatus
  stageId: string
  stageName: string
  stageColor: string | null
  ownerId: string | null
  ownerName: string | null
  contactId: string
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  source: string
  nextActionAt: Date | null
  stageChangedAt: Date
  lastEventAt: Date | null
  createdAt: Date
}

function condicoes(filtro: FiltroLeads, agora: Date): SQL[] {
  const lista: SQL[] = []

  if (filtro.busca && filtro.busca.trim() !== '') {
    const termo = `%${filtro.busca.trim()}%`
    // O índice trigram cobre `title` e `contacts.name` — alvo <100ms em 50 mil
    // leads (§9.1, §13.1).
    lista.push(
      or(
        sql`${leads.title} ILIKE ${termo}`,
        sql`${contacts.name} ILIKE ${termo}`,
        sql`${contacts.phoneE164} ILIKE ${termo}`,
        sql`${contacts.email} ILIKE ${termo}`,
      ) as SQL,
    )
  }

  if (filtro.stageId) lista.push(eq(leads.stageId, filtro.stageId))
  if (filtro.status) lista.push(eq(leads.status, filtro.status))
  if (filtro.ownerId) lista.push(eq(leads.ownerId, filtro.ownerId))
  if (filtro.semDono) lista.push(isNull(leads.ownerId))

  if (filtro.paradoHaDias !== undefined) {
    const corte = new Date(agora.getTime() - filtro.paradoHaDias * 86400_000)
    lista.push(and(eq(leads.status, 'aberto'), lte(leads.stageChangedAt, corte)) as SQL)
  }

  return lista
}

export async function listarLeads(
  tx: Tx,
  filtro: FiltroLeads = {},
  agora = new Date(),
): Promise<LeadResumo[]> {
  const onde = condicoes(filtro, agora)

  const linhas = await tx
    .select({
      id: leads.id,
      title: leads.title,
      valueCents: leads.valueCents,
      status: leads.status,
      stageId: leads.stageId,
      stageName: pipelineStages.name,
      stageColor: pipelineStages.color,
      ownerId: leads.ownerId,
      ownerName: users.name,
      contactId: leads.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phoneE164,
      contactEmail: contacts.email,
      source: leads.source,
      nextActionAt: leads.nextActionAt,
      stageChangedAt: leads.stageChangedAt,
      lastEventAt: contacts.lastEventAt,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(onde.length > 0 ? and(...onde) : undefined)
    .orderBy(desc(leads.updatedAt))
    .limit(Math.min(filtro.limite ?? 200, 1000))
    .offset(filtro.offset ?? 0)

  return linhas
}

export async function contarLeads(
  tx: Tx,
  filtro: FiltroLeads = {},
  agora = new Date(),
): Promise<number> {
  const onde = condicoes(filtro, agora)

  const [linha] = await tx
    .select({ total: count() })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .where(onde.length > 0 ? and(...onde) : undefined)

  return linha?.total ?? 0
}

export type ColunaPipeline = {
  stageId: string
  name: string
  color: string | null
  position: number
  isWon: boolean
  isLost: boolean
  /** Contagem e soma da coluna (§9.2). */
  total: number
  somaCents: number
  cartoes: CartaoLead[]
}

export type CartaoLead = {
  id: string
  title: string
  valueCents: number
  ownerId: string | null
  ownerName: string | null
  contactName: string | null
  /** Dias parado na etapa — o número que denuncia lead esquecido. */
  diasNaEtapa: number
  /** Canais tocados recentemente, para os ícones do cartão. */
  canais: string[]
}

/**
 * O kanban (§9.2).
 *
 * Uma consulta traz as etapas, outra os cartões. Os totais da coluna vêm de
 * TODOS os leads da etapa, não só dos cartões carregados — senão a soma da
 * coluna mudaria conforme a rolagem, o que seria pior que não mostrar.
 */
/** Quanto tempo um lead fechado continua aparecendo na coluna dele. */
const DIAS_DE_FECHADO_NO_FUNIL = 30

/**
 * Quem aparece no funil.
 *
 * As duas consultas filtravam `status = 'aberto'` — e as colunas "Ganho" e
 * "Perdido" existem justamente para mostrar quem NÃO está aberto. O resultado
 * era um funil onde as duas últimas colunas ficavam em "Vazio." para sempre, e
 * o número que o dono abre o funil para ver — quanto fechou — não existia em
 * lugar nenhum da tela.
 *
 * Aberto sempre entra; fechado entra por um mês. Sem o corte, um ano de vendas
 * ganhas se acumularia numa coluna que ninguém rola até o fim, e a soma no
 * cabeçalho dela deixaria de responder "como foi este mês".
 */
function noFunil(agora = new Date()) {
  const corte = new Date(agora.getTime() - DIAS_DE_FECHADO_NO_FUNIL * 86_400_000)
  return or(eq(leads.status, 'aberto'), gte(leads.stageChangedAt, corte))
}

export async function montarPipeline(
  tx: Tx,
  opcoes: { porColuna?: number; agora?: Date } = {},
): Promise<ColunaPipeline[]> {
  const agora = opcoes.agora ?? new Date()
  const porColuna = opcoes.porColuna ?? 50

  const [pipeline] = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.isDefault, true))
    .limit(1)

  if (!pipeline) return []

  const etapas = await tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .orderBy(asc(pipelineStages.position))

  if (etapas.length === 0) return []

  const totais = await tx
    .select({
      stageId: leads.stageId,
      total: count(),
      soma: sql<number>`COALESCE(SUM(${leads.valueCents}), 0)::bigint`,
    })
    .from(leads)
    .where(noFunil())
    .groupBy(leads.stageId)

  const porEtapa = new Map(totais.map((t) => [t.stageId, t]))

  const cartoes = await tx
    .select({
      id: leads.id,
      stageId: leads.stageId,
      title: leads.title,
      valueCents: leads.valueCents,
      ownerId: leads.ownerId,
      ownerName: users.name,
      contactName: contacts.name,
      stageChangedAt: leads.stageChangedAt,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(noFunil())
    .orderBy(asc(leads.stageChangedAt))
    .limit(porColuna * etapas.length)

  return etapas.map((etapa) => {
    const agregado = porEtapa.get(etapa.id)
    return {
      stageId: etapa.id,
      name: etapa.name,
      color: etapa.color,
      position: etapa.position,
      isWon: etapa.isWon,
      isLost: etapa.isLost,
      total: agregado?.total ?? 0,
      somaCents: Number(agregado?.soma ?? 0),
      cartoes: cartoes
        .filter((c) => c.stageId === etapa.id)
        .slice(0, porColuna)
        .map((c) => ({
          id: c.id,
          title: c.title,
          valueCents: c.valueCents,
          ownerId: c.ownerId,
          ownerName: c.ownerName,
          contactName: c.contactName,
          diasNaEtapa: Math.floor((agora.getTime() - c.stageChangedAt.getTime()) / 86400_000),
          canais: [],
        })),
    }
  })
}

export type AtividadeLead = {
  id: string
  type: string
  content: string | null
  userName: string | null
  createdAt: Date
}

export type DetalheLead = {
  lead: typeof leads.$inferSelect
  contactName: string | null
  contactPhone: string | null
  contactEmail: string | null
  stageName: string
  ownerName: string | null
  atividades: AtividadeLead[]
}

export async function detalharLead(tx: Tx, id: string): Promise<DetalheLead | null> {
  const [linha] = await tx
    .select({
      lead: leads,
      contactName: contacts.name,
      contactPhone: contacts.phoneE164,
      contactEmail: contacts.email,
      stageName: pipelineStages.name,
      ownerName: users.name,
    })
    .from(leads)
    .innerJoin(contacts, eq(contacts.id, leads.contactId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, leads.stageId))
    .leftJoin(users, eq(users.id, leads.ownerId))
    .where(eq(leads.id, id))
    .limit(1)

  if (!linha) return null

  const atividades = await tx
    .select({
      id: leadActivities.id,
      type: leadActivities.type,
      content: leadActivities.content,
      userName: users.name,
      createdAt: leadActivities.createdAt,
    })
    .from(leadActivities)
    .leftJoin(users, eq(users.id, leadActivities.userId))
    .where(eq(leadActivities.leadId, id))
    .orderBy(desc(leadActivities.createdAt))
    .limit(50)

  return { ...linha, atividades }
}

/** Etapas da organização, para os seletores. */
export async function etapasDoPipeline(tx: Tx): Promise<(typeof pipelineStages.$inferSelect)[]> {
  const [pipeline] = await tx
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(eq(pipelines.isDefault, true))
    .limit(1)

  if (!pipeline) return []

  return tx
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .orderBy(asc(pipelineStages.position))
}

/** Consultores ativos, para atribuição e rodízio (§9.3). */
export async function consultoresAtivos(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.active, true), inArray(users.role, ['consultor', 'admin'])))
    .orderBy(asc(users.name))
}

/** Quantos leads abertos cada consultor tem — a base do rodízio equilibrado. */
export async function cargaPorConsultor(tx: Tx): Promise<Map<string, number>> {
  const linhas = await tx
    .select({ ownerId: leads.ownerId, total: count() })
    .from(leads)
    .where(eq(leads.status, 'aberto'))
    .groupBy(leads.ownerId)

  const mapa = new Map<string, number>()
  for (const linha of linhas) {
    if (linha.ownerId) mapa.set(linha.ownerId, linha.total)
  }
  return mapa
}

/** Filtros salvos de §9.1. */
export const FILTROS_SALVOS = [
  { chave: 'meus_abertos', rotulo: 'Meus abertos' },
  { chave: 'parados_7d', rotulo: 'Sem contato há 7 dias' },
  { chave: 'sem_dono', rotulo: 'Sem responsável' },
  { chave: 'ganhos', rotulo: 'Ganhos' },
] as const

export type FiltroSalvo = (typeof FILTROS_SALVOS)[number]['chave']

export function filtroSalvo(chave: FiltroSalvo, userId: string): FiltroLeads {
  switch (chave) {
    case 'meus_abertos':
      return { ownerId: userId, status: 'aberto' }
    case 'parados_7d':
      return { paradoHaDias: 7 }
    case 'sem_dono':
      return { semDono: true, status: 'aberto' }
    case 'ganhos':
      return { status: 'ganho' }
  }
}

/*
 * `acoesVencidas` SAIU DAQUI, e a coluna `next_action_at` continua no banco.
 *
 * Ela contava leads cuja próxima ação venceu — e nada no sistema jamais gravou
 * essa data. Toda escrita de `leads` no `src/` mexe em etapa, dono, status,
 * valor ou nota; `next_action_at` só era LIDA. O Stat "Ação vencida" marcava
 * zero desde o primeiro dia e ia marcar zero para sempre, anunciando um
 * lembrete que o sistema não tem.
 *
 * Um número que não pode mudar é pior que um número ausente: ele ocupa espaço
 * na tela, convida a confiar, e ensina que os outros números ao lado talvez
 * também não signifiquem nada.
 *
 * A coluna e o índice ficam. No dia em que houver como marcar "falar com esta
 * pessoa na terça", a consulta volta em três linhas — e aí ela vai contar algo.
 */

/** Leads criados nos últimos N dias — o número do topo da tela. */
export async function novosLeads(tx: Tx, dias = 7, agora = new Date()): Promise<number> {
  const [linha] = await tx
    .select({ total: count() })
    .from(leads)
    .where(gte(leads.createdAt, new Date(agora.getTime() - dias * 86400_000)))

  return linha?.total ?? 0
}
