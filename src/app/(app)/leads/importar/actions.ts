'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { importarContatos, type ResultadoImportacao } from '@/lib/leads/importar'
import type { LinhaValidada } from '@/lib/leads/conferir'

/**
 * Gravar a lista conferida (§9.1).
 *
 * A CONFERÊNCIA É DO NAVEGADOR; A CONFIANÇA, NÃO.
 *
 * A tela lê e confere o arquivo no navegador — é o que faz a prévia aparecer
 * na hora, sem subir nada. Mas o que chega aqui é entrada de rede como
 * qualquer outra: o Zod refaz a validação de forma e o RLS recorta a
 * organização. Aceitar as linhas só porque "a tela já conferiu" seria confiar
 * num validador que qualquer um reescreve pelo console.
 */

const linha = z.object({
  linha: z.number().int(),
  nome: z.string().max(200).nullable(),
  telefone: z.string().max(20).nullable(),
  email: z.string().max(320).nullable(),
  cpf: z.string().max(11).nullable(),
  externalId: z.string().max(120).nullable(),
  tags: z.array(z.string().max(60)).max(20),
  valorCents: z.number().int().min(0).max(1_000_000_00),
  titulo: z.string().max(200).nullable(),
})

/*
 * Cinco mil por vez.
 *
 * Não é limite do banco — é do tempo de execução da função. Uma planilha de
 * cinquenta mil linhas estouraria o limite no meio e deixaria a base pela
 * metade sem dizer onde parou. Recusar antes de começar é honesto; parar no
 * meio, não.
 */
const LIMITE = 5000

const entrada = z.object({
  linhas: z.array(linha).min(1).max(LIMITE),
  criarLeads: z.boolean(),
})

export type EstadoImportacao = {
  erro?: string
  resultado?: ResultadoImportacao
}

export async function importarAction(
  bruto: unknown,
): Promise<EstadoImportacao> {
  const user = await requireUser()
  assertCan(user, 'leads.editar_proprio')

  const parsed = entrada.safeParse(bruto)
  if (!parsed.success) {
    return {
      erro: `Não consegui ler as linhas enviadas. Se a planilha passa de ${LIMITE.toLocaleString('pt-BR')} linhas, divida em partes.`,
    }
  }

  const validas = parsed.data.linhas as LinhaValidada[]

  const resultado = await withTenant(tenantOf(user), (tx) =>
    importarContatos(tx, user.orgId, validas, {
      criarLeads: parsed.data.criarLeads,
      origem: 'importacao',
    }),
  )

  revalidatePath('/leads')
  return { resultado }
}
