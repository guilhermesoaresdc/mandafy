'use server'

import { and, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { eventsRaw, sources } from '@/db/schema'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { mappingSchema, MAPEAMENTO_SUGERIDO } from '@/lib/ingest/mapping'
import { generateIngestToken } from '@/lib/ingest/signature'
import { createLogger } from '@/lib/logger'

/**
 * Conectar plataforma (§4.2).
 *
 * Nomeia pelo que a pessoa controla, não pela implementação: "plataforma", não
 * "webhook"; "combinar campos", não "payload mapping" (§11.7).
 */

const log = createLogger('plataformas')

export type PlataformaState = { error?: string; ok?: boolean }

const criarSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome à plataforma.').max(80),
  plataforma: z.enum(['generico', 'rifei', 'custom']).default('generico'),
})

export async function criarPlataformaAction(
  _prev: PlataformaState,
  formData: FormData,
): Promise<PlataformaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = criarSchema.safeParse({
    nome: formData.get('nome'),
    plataforma: formData.get('plataforma') ?? 'generico',
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Não foi possível criar.' }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      await tx.insert(sources).values({
        orgId: user.orgId,
        name: parsed.data.nome,
        platform: parsed.data.plataforma,
        ingestToken: generateIngestToken(),
        // Começa com o mapa sugerido: a pessoa ajusta, não monta do zero.
        mapping: mappingSchema.parse(MAPEAMENTO_SUGERIDO),
      })
    })
  } catch (error) {
    log.error('falha ao criar plataforma', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível criar a plataforma. Tente de novo.' }
  }

  revalidatePath('/configuracoes/plataformas')
  return { ok: true }
}

const mapeamentoSchema = z.object({
  sourceId: z.uuid(),
  mapping: z.string().max(20_000),
})

export async function salvarMapeamentoAction(
  _prev: PlataformaState,
  formData: FormData,
): Promise<PlataformaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = mapeamentoSchema.safeParse({
    sourceId: formData.get('sourceId'),
    mapping: formData.get('mapping'),
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  let mapping: unknown
  try {
    mapping = JSON.parse(parsed.data.mapping)
  } catch {
    return { error: 'O mapeamento não é um JSON válido.' }
  }

  const validado = mappingSchema.safeParse(mapping)
  if (!validado.success) {
    const issue = validado.error.issues[0]
    return { error: `Mapeamento inválido em ${issue?.path.join('.') || 'raiz'}: ${issue?.message}` }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      await tx
        .update(sources)
        .set({ mapping: validado.data, updatedAt: new Date() })
        .where(and(eq(sources.id, parsed.data.sourceId), eq(sources.orgId, user.orgId)))
    })
  } catch (error) {
    log.error('falha ao salvar mapeamento', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath(`/configuracoes/plataformas/${parsed.data.sourceId}`)
  return { ok: true }
}

export async function alternarPlataformaAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('sourceId') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(sources)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(sources.id, id), eq(sources.orgId, user.orgId)))
  })

  revalidatePath('/configuracoes/plataformas')
}

/**
 * Último payload recebido por este conector.
 *
 * É o passo 2 de §4.2 — "clicar em Aguardando evento… e o sistema captura o
 * primeiro que chegar". Mostrar o payload de verdade é o que permite arrastar
 * campos reais em vez de digitar JSONPath de cabeça.
 */
export async function ultimoPayload(
  sourceId: string,
): Promise<{ payload: unknown; recebidoEm: Date; erro: string | null } | null> {
  const user = await requireAdmin()

  return withTenant(tenantOf(user), async (tx) => {
    const [linha] = await tx
      .select({
        payload: eventsRaw.payload,
        receivedAt: eventsRaw.receivedAt,
        error: eventsRaw.error,
      })
      .from(eventsRaw)
      .where(eq(eventsRaw.sourceId, sourceId))
      .orderBy(desc(eventsRaw.receivedAt))
      .limit(1)

    if (!linha) return null
    return { payload: linha.payload, recebidoEm: linha.receivedAt, erro: linha.error }
  })
}
