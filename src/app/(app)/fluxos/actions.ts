'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { buscarFluxo } from '@/db/queries/flows'
import { flows, flowSteps } from '@/db/schema'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { montarChave, variaveisDaChave } from '@/lib/flows/cancel-key'
import { lerAtraso } from '@/lib/flows/schedule'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'

/** Fluxos (§5). */

const log = createLogger('fluxos-ui')

export type FluxoState = { erro?: string; ok?: boolean; aviso?: string }

export async function alternarFluxoAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(flows)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(flows.id, id), eq(flows.orgId, user.orgId)))
  })

  revalidatePath('/fluxos')
  revalidatePath(`/fluxos/${id}`)
}

const configSchema = z.object({
  id: z.uuid(),
  nome: z.string().trim().min(2, 'Dê um nome ao fluxo.').max(80),
  cancelKeyTemplate: z.string().trim().max(200),
  janelaLigada: z.coerce.boolean(),
  maxPorDia: z.coerce.number().int().min(1).max(50),
})

export async function salvarFluxoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = configSchema.safeParse({
    id: formData.get('id'),
    nome: formData.get('nome'),
    cancelKeyTemplate: formData.get('cancelKeyTemplate') ?? '',
    janelaLigada: formData.get('janelaLigada') === 'on',
    maxPorDia: formData.get('maxPorDia') ?? 4,
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const dados = parsed.data

  try {
    return await withTenant(tenantOf(user), async (tx) => {
      const completo = await buscarFluxo(tx, dados.id)
      if (!completo) return { erro: 'Fluxo não encontrado.' }

      const modelo = dados.cancelKeyTemplate.trim() || null

      /*
       * Um fluxo que cancela SEM chave é o pior estado possível: ele agenda os
       * envios e nada consegue pará-los. Melhor recusar a configuração do que
       * deixar a pessoa descobrir pelo cliente que já pagou.
       */
      if (completo.fluxo.cancelOn.length > 0 && !modelo) {
        return {
          erro: 'Este fluxo cancela envios, então precisa de uma chave. Sem ela, nada segura os agendamentos.',
        }
      }

      let aviso: string | undefined
      if (modelo) {
        if (variaveisDaChave(modelo).length === 0) {
          return {
            erro: 'A chave precisa de pelo menos uma variável, como {{external_id}}. Uma chave fixa cancelaria os envios de todo mundo de uma vez.',
          }
        }

        // Testa contra o contato de exemplo: pega nome de variável errado antes
        // de o fluxo rodar em produção.
        const teste = montarChave(modelo, CONTATO_EXEMPLO)
        if (!teste.ok) {
          aviso = `A chave usa ${teste.faltando.join(', ')}, que não existe no exemplo. Confira se a plataforma manda esse campo.`
        }
      }

      await tx
        .update(flows)
        .set({
          name: dados.nome,
          cancelKeyTemplate: modelo,
          quietHoursEnabled: dados.janelaLigada,
          maxPerContactPerDay: dados.maxPorDia,
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, dados.id), eq(flows.orgId, user.orgId)))

      revalidatePath(`/fluxos/${dados.id}`)
      revalidatePath('/fluxos')
      return aviso ? { ok: true, aviso } : { ok: true }
    })
  } catch (erro) {
    log.error('falha ao salvar fluxo', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível salvar. Tente de novo.' }
  }
}

const passoSchema = z.object({
  stepId: z.uuid(),
  flowId: z.uuid(),
  atraso: z.string().trim().max(20),
})

export async function salvarPassoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = passoSchema.safeParse({
    stepId: formData.get('stepId'),
    flowId: formData.get('flowId'),
    atraso: formData.get('atraso') ?? '0',
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const segundos = lerAtraso(parsed.data.atraso)
  if (segundos === null) {
    return { erro: 'Não entendi o tempo. Use algo como 5min, 2h ou 3 dias.' }
  }

  await withTenant(tenantOf(user), async (tx) => {
    // O `where` passa pelo fluxo para o RLS valer: `flow_steps` não tem org_id.
    const [fluxo] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, parsed.data.flowId), eq(flows.orgId, user.orgId)))
      .limit(1)

    if (!fluxo) return

    await tx
      .update(flowSteps)
      .set({ delaySeconds: segundos, updatedAt: new Date() })
      .where(and(eq(flowSteps.id, parsed.data.stepId), eq(flowSteps.flowId, fluxo.id)))
  })

  revalidatePath(`/fluxos/${parsed.data.flowId}`)
  return { ok: true }
}
