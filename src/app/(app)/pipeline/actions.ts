'use server'

import { revalidatePath } from 'next/cache'
import { withTenant } from '@/db'
import { semearFunilPadrao } from '@/db/seed-org'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { createLogger } from '@/lib/logger'
import { assertCan } from '@/lib/rbac'

/** Funil de vendas (§9.2). */

const log = createLogger('pipeline-ui')

export type EstadoSemeadura = { ok?: string; erro?: string }

/**
 * Cria o funil padrão para a organização de quem clicou.
 *
 * Mesmo motivo do botão de fluxos: a tela vazia mandava rodar um comando, e sem
 * funil o CRM inteiro fica inerte — a consulta do kanban devolve lista vazia e
 * nenhum lead tem para onde ir.
 *
 * `integracoes.gerenciar` e não uma permissão nova: é a mesma que o botão
 * "Criar o que faltar" já usa, e a matriz de §9.4 é fechada — inventar uma
 * permissão significa mexer nela, o que é decisão de spec e não de tela.
 */
export async function criarFunilPadraoAction(): Promise<EstadoSemeadura> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    const criou = await withTenant(tenantOf(user), (tx) => semearFunilPadrao(tx, user.orgId))

    revalidatePath('/pipeline')
    revalidatePath('/leads')

    return {
      ok: criou
        ? 'Funil criado: Novo → Contatado → Negociando → Ganho / Perdido.'
        : 'Nada a fazer: esta organização já tem um funil.',
    }
  } catch (erro) {
    log.error('falha ao criar o funil padrão', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível criar o funil. Tente de novo.' }
  }
}
