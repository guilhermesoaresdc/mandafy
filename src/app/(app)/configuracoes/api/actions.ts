'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { apiKeys, outboundWebhooks } from '@/db/schema'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { ESCOPOS, gerarChave, hashChave, prefixoVisivel } from '@/lib/api/keys'
import { EVENTOS_SAIDA, gerarSegredo, reativar } from '@/lib/api/webhooks'

/** Chaves de API e webhooks de saída (§12). */

const log = createLogger('api-config')

export type ApiState = {
  erro?: string
  ok?: string
  /** A chave em claro. Aparece UMA vez e nunca mais — não guardamos o valor. */
  chaveNova?: string
  segredoNovo?: string
}

const chaveSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome à chave.').max(80),
  ambiente: z.enum(['live', 'test']),
  escopos: z.array(z.enum(ESCOPOS)).min(1, 'Escolha ao menos um escopo.'),
})

export async function criarChaveAction(_prev: ApiState, formData: FormData): Promise<ApiState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = chaveSchema.safeParse({
    nome: formData.get('nome'),
    ambiente: formData.get('ambiente') ?? 'live',
    escopos: formData.getAll('escopos'),
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const chave = gerarChave(parsed.data.ambiente)

  try {
    await withTenant(tenantOf(user), async (tx) => {
      await tx.insert(apiKeys).values({
        orgId: user.orgId,
        name: parsed.data.nome,
        // Só o hash vai para o banco: nem nós conseguimos ler a chave depois.
        keyHash: hashChave(chave),
        keyPrefix: prefixoVisivel(chave),
        scopes: parsed.data.escopos,
        createdBy: user.id,
      })
    })
  } catch (erro) {
    log.error('falha ao criar chave', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível criar a chave.' }
  }

  revalidatePath('/configuracoes/api')
  return { chaveNova: chave, ok: 'Chave criada. Copie agora — ela não aparece de novo.' }
}

export async function revogarChaveAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    // Revoga em vez de apagar: a linha continua provando que a chave existiu e
    // quando foi usada pela última vez, que é o que uma auditoria pede.
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, user.orgId)))
  })

  revalidatePath('/configuracoes/api')
}

const webhookSchema = z.object({
  url: z.url('O endereço precisa ser uma URL https.'),
  eventos: z.array(z.enum(EVENTOS_SAIDA)).min(1, 'Escolha ao menos um evento.'),
})

export async function criarWebhookAction(_prev: ApiState, formData: FormData): Promise<ApiState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = webhookSchema.safeParse({
    url: formData.get('url'),
    eventos: formData.getAll('eventos'),
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  if (!parsed.data.url.startsWith('https://')) {
    return { erro: 'Use https. Em http, qualquer um no caminho lê o conteúdo.' }
  }

  const segredo = gerarSegredo()

  await withTenant(tenantOf(user), async (tx) => {
    await tx.insert(outboundWebhooks).values({
      orgId: user.orgId,
      url: parsed.data.url,
      events: parsed.data.eventos,
      secret: segredo,
    })
  })

  revalidatePath('/configuracoes/api')
  return { segredoNovo: segredo, ok: 'Webhook criado. Guarde o segredo — ele valida a assinatura.' }
}

export async function alternarWebhookAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  const acao = String(formData.get('acao') ?? '')
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    if (acao === 'reativar') {
      await reativar(tx, user.orgId, id)
      return
    }

    if (acao === 'remover') {
      await tx
        .delete(outboundWebhooks)
        .where(and(eq(outboundWebhooks.id, id), eq(outboundWebhooks.orgId, user.orgId)))
      return
    }

    await tx
      .update(outboundWebhooks)
      .set({ active: acao === 'ligar', updatedAt: new Date() })
      .where(and(eq(outboundWebhooks.id, id), eq(outboundWebhooks.orgId, user.orgId)))
  })

  revalidatePath('/configuracoes/api')
}
