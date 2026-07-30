'use server'

import { or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { contacts } from '@/db/schema'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { anonimizarContato, descadastrar } from '@/lib/lgpd'

/** Direitos do titular (§14.1). */

const log = createLogger('privacidade')

export type TitularState = {
  erro?: string
  ok?: string
  achados?: { id: string; nome: string | null; telefone: string | null; email: string | null; saiu: boolean }[]
}

export async function buscarTitularAction(
  _prev: TitularState,
  formData: FormData,
): Promise<TitularState> {
  const user = await requireAdmin()
  assertCan(user, 'contatos.exportar')

  const termo = String(formData.get('termo') ?? '').trim()
  if (termo.length < 3) return { erro: 'Digite ao menos 3 caracteres.' }

  const achados = await withTenant(tenantOf(user), (tx) =>
    tx
      .select({
        id: contacts.id,
        nome: contacts.name,
        telefone: contacts.phoneE164,
        email: contacts.email,
        optedOutAt: contacts.optedOutAt,
      })
      .from(contacts)
      .where(
        or(
          sql`${contacts.name} ILIKE ${`%${termo}%`}`,
          sql`${contacts.phoneE164} ILIKE ${`%${termo}%`}`,
          sql`${contacts.email} ILIKE ${`%${termo}%`}`,
        ),
      )
      .limit(10),
  )

  if (achados.length === 0) return { erro: 'Ninguém encontrado com esse dado.' }

  return {
    achados: achados.map((a) => ({
      id: a.id,
      nome: a.nome,
      telefone: a.telefone,
      email: a.email,
      saiu: Boolean(a.optedOutAt),
    })),
  }
}

const acaoSchema = z.object({
  contactId: z.uuid(),
  acao: z.enum(['anonimizar', 'descadastrar']),
})

export async function atenderPedidoAction(
  _prev: TitularState,
  formData: FormData,
): Promise<TitularState> {
  const user = await requireAdmin()
  assertCan(user, 'contatos.anonimizar')

  const parsed = acaoSchema.safeParse({
    contactId: formData.get('contactId'),
    acao: formData.get('acao'),
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  try {
    const resultado = await withTenant(tenantOf(user), async (tx) => {
      if (parsed.data.acao === 'descadastrar') {
        const feito = await descadastrar(
          tx,
          user.orgId,
          parsed.data.contactId,
          { motivo: 'pedido do titular pelo painel', quem: user.id },
        )
        return feito ? { ok: 'Descadastrado agora. Não recebe mais nada.' } : { erro: 'Contato não encontrado.' }
      }

      const r = await anonimizarContato(tx, user.orgId, parsed.data.contactId, user.id)
      return r.anonimizado
        ? {
            ok: `Anonimizado. ${r.notificacoesLimpas} mensagem(ns) e ${r.atividadesLimpas} nota(s) tiveram o texto removido.`,
          }
        : { erro: 'Contato não encontrado.' }
    })

    revalidatePath('/configuracoes/privacidade')
    return resultado
  } catch (erro) {
    // Nada de dado pessoal no log (§14.1) — só o id.
    log.error('falha ao atender pedido do titular', {
      contactId: parsed.data.contactId,
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível concluir. Tente de novo.' }
  }
}
