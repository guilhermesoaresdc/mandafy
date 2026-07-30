'use server'

import { and, eq, inArray } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { cargaPorConsultor, consultoresAtivos, detalharLead } from '@/db/queries/leads'
import { leadActivities, leads, pipelineStages } from '@/db/schema'
import { LEAD_STATUSES } from '@/db/schema/enums'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { assertCan, can } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { distribuir } from '@/lib/crm/distribuicao'

/**
 * Ações do CRM (§9).
 *
 * O RLS já impede um consultor de tocar em lead alheio: o `UPDATE` não encontra
 * a linha e não afeta nada. As checagens de permissão aqui existem para dar uma
 * MENSAGEM em vez de um silêncio — "reatribuir é do administrador" é mais útil
 * que um botão que não faz nada.
 */

const log = createLogger('leads')

export type LeadState = { erro?: string; ok?: string }

const moverSchema = z.object({ leadId: z.uuid(), stageId: z.uuid() })

/**
 * Mover de etapa — o arrastar e soltar do kanban (§9.2).
 *
 * A interface move o cartão na hora e chama isto depois (atualização
 * otimista, §13.2). Se falhar, o cartão volta.
 */
export async function moverLeadAction(
  _prev: LeadState,
  formData: FormData,
): Promise<LeadState> {
  const user = await requireUser()

  const parsed = moverSchema.safeParse({
    leadId: formData.get('leadId'),
    stageId: formData.get('stageId'),
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  try {
    return await withTenant(tenantOf(user), async (tx) => {
      const [etapa] = await tx
        .select({ id: pipelineStages.id, name: pipelineStages.name, isWon: pipelineStages.isWon, isLost: pipelineStages.isLost })
        .from(pipelineStages)
        .where(eq(pipelineStages.id, parsed.data.stageId))
        .limit(1)

      if (!etapa) return { erro: 'Etapa não encontrada.' }

      const agora = new Date()
      const atualizadas = await tx
        .update(leads)
        .set({
          stageId: etapa.id,
          // Ganho e perdido fecham o lead: um card em "Ganho" que continua
          // contando como aberto estragaria toda soma do funil.
          status: etapa.isWon ? 'ganho' : etapa.isLost ? 'perdido' : 'aberto',
          stageChangedAt: agora,
          updatedAt: agora,
        })
        .where(and(eq(leads.id, parsed.data.leadId), eq(leads.orgId, user.orgId)))
        .returning({ id: leads.id })

      // Zero linhas com RLS ligado significa "não é seu" — a política filtrou.
      if (atualizadas.length === 0) return { erro: 'Este lead não é seu.' }

      await tx.insert(leadActivities).values({
        leadId: parsed.data.leadId,
        userId: user.id,
        type: 'mudanca_etapa',
        content: `Movido para ${etapa.name}`,
      })

      revalidatePath('/pipeline')
      revalidatePath('/leads')
      return { ok: `Movido para ${etapa.name}.` }
    })
  } catch (erro) {
    log.error('falha ao mover lead', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível mover. O cartão volta para a etapa anterior.' }
  }
}

const notaSchema = z.object({ leadId: z.uuid(), nota: z.string().trim().min(1).max(2000) })

export async function anotarAction(_prev: LeadState, formData: FormData): Promise<LeadState> {
  const user = await requireUser()

  const parsed = notaSchema.safeParse({
    leadId: formData.get('leadId'),
    nota: formData.get('nota'),
  })
  if (!parsed.success) return { erro: 'Escreva alguma coisa antes de salvar.' }

  await withTenant(tenantOf(user), async (tx) => {
    // Confirma o acesso pelo lead: `lead_activities` não tem org_id, e o RLS
    // dela passa pelo lead.
    const lead = await detalharLead(tx, parsed.data.leadId)
    if (!lead) return

    await tx.insert(leadActivities).values({
      leadId: parsed.data.leadId,
      userId: user.id,
      type: 'nota',
      content: parsed.data.nota,
    })
  })

  revalidatePath(`/leads/${parsed.data.leadId}`)
  return { ok: 'Nota salva.' }
}

const atribuirSchema = z.object({
  leadIds: z.string().min(1),
  ownerId: z.string(),
})

/** Reatribuir responsável — só administrador (§9.4). */
export async function atribuirAction(_prev: LeadState, formData: FormData): Promise<LeadState> {
  const user = await requireUser()

  if (!can(user, 'leads.reatribuir')) {
    return { erro: 'Só o administrador reatribui responsável.' }
  }
  assertCan(user, 'leads.reatribuir')

  const parsed = atribuirSchema.safeParse({
    leadIds: formData.get('leadIds'),
    ownerId: formData.get('ownerId') ?? '',
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const ids = parsed.data.leadIds.split(',').filter((id) => z.uuid().safeParse(id).success)
  if (ids.length === 0) return { erro: 'Selecione ao menos um lead.' }

  try {
    return await withTenant(tenantOf(user), async (tx) => {
      const agora = new Date()

      // "auto" = rodízio; qualquer outro valor é atribuição direta.
      if (parsed.data.ownerId === 'auto') {
        const consultores = await consultoresAtivos(tx, user.orgId)
        if (consultores.length === 0) return { erro: 'Nenhum consultor ativo para distribuir.' }

        const carga = await cargaPorConsultor(tx)
        const destinos = distribuir(ids.length, consultores, carga)

        for (const [i, id] of ids.entries()) {
          const destino = destinos[i]
          if (!destino) break

          await tx
            .update(leads)
            .set({ ownerId: destino.id, updatedAt: agora })
            .where(and(eq(leads.id, id), eq(leads.orgId, user.orgId)))

          await tx.insert(leadActivities).values({
            leadId: id,
            userId: user.id,
            type: 'mudanca_etapa',
            content: `Distribuído para ${destino.name}`,
          })
        }

        revalidatePath('/leads')
        return { ok: `${ids.length} lead(s) distribuído(s).` }
      }

      const novoDono = parsed.data.ownerId === '' ? null : parsed.data.ownerId
      await tx
        .update(leads)
        .set({ ownerId: novoDono, updatedAt: agora })
        .where(and(inArray(leads.id, ids), eq(leads.orgId, user.orgId)))

      revalidatePath('/leads')
      return { ok: `${ids.length} lead(s) atualizado(s).` }
    })
  } catch (erro) {
    log.error('falha ao atribuir', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível atribuir. Tente de novo.' }
  }
}

const statusSchema = z.object({
  leadId: z.uuid(),
  status: z.enum(LEAD_STATUSES),
  motivo: z.string().trim().max(200).optional(),
})

export async function mudarStatusAction(
  _prev: LeadState,
  formData: FormData,
): Promise<LeadState> {
  const user = await requireUser()

  const parsed = statusSchema.safeParse({
    leadId: formData.get('leadId'),
    status: formData.get('status'),
    motivo: formData.get('motivo') ?? undefined,
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(leads)
      .set({
        status: parsed.data.status,
        lostReason: parsed.data.status === 'perdido' ? (parsed.data.motivo ?? null) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, parsed.data.leadId), eq(leads.orgId, user.orgId)))
  })

  revalidatePath('/leads')
  revalidatePath('/pipeline')
  return { ok: 'Atualizado.' }
}
