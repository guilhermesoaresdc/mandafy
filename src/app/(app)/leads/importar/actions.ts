'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { createLogger } from '@/lib/logger'
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

const log = createLogger('importar-leads-action')

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

  /*
   * TODA falha vira mensagem, nenhuma vira exceção.
   *
   * A tela chama isto de dentro de um `useTransition`. Ação que lança deixa a
   * transição sem desfecho, e o botão fica em "Importando…" para sempre — sem
   * erro, sem dado, sem nada que a pessoa possa fazer além de recarregar e
   * tentar de novo, provavelmente com o mesmo resultado. Um importador que
   * falha em silêncio é pior que um que recusa o arquivo.
   */
  try {
    const resultado = await withTenant(tenantOf(user), (tx) =>
      importarContatos(tx, user.orgId, validas, {
        criarLeads: parsed.data.criarLeads,
        origem: 'importacao',
      }),
    )

    revalidatePath('/leads')
    return { resultado }
  } catch (erro) {
    /*
     * O log leva o CÓDIGO do erro, nunca a mensagem inteira.
     *
     * O Postgres põe o valor que violou a restrição no detalhe: "Key
     * (org_id, email)=(…, alguem@exemplo.com) already exists". Isso é dado
     * pessoal, e §14.1 proíbe dado pessoal em log de aplicação — a saída de um
     * erro não é exceção à regra.
     */
    const codigo = codigoDoErro(erro)
    log.error('importação falhou', { codigo, linhas: validas.length })

    return { erro: explicar(codigo) }
  }
}

/**
 * O código do Postgres, que mora embrulhado.
 *
 * O Drizzle envolve a falha num `DrizzleQueryError` — cujo `message` traz a
 * query inteira, parâmetros e tudo — e guarda o erro real em `cause`. Sem
 * descer a corrente, todo problema vira "Error" e a mensagem para quem importa
 * fica igual para causas completamente diferentes.
 */
function codigoDoErro(erro: unknown): string {
  let atual: unknown = erro

  for (let i = 0; i < 5 && atual; i += 1) {
    if (typeof atual === 'object' && 'code' in atual) {
      const code = (atual as { code: unknown }).code
      if (typeof code === 'string' && code !== '') return code
    }
    atual = (atual as { cause?: unknown }).cause
  }

  return erro instanceof Error ? erro.name : 'desconhecido'
}

/**
 * Traduz o código para o que a pessoa pode FAZER (§11.7).
 *
 * "23505" não ajuda ninguém; "esse telefone já está em outro contato" diz onde
 * mexer. O código vai junto entre parênteses porque, quando a explicação não
 * servir, é o que permite pedir ajuda sem adivinhar.
 */
function explicar(codigo: string): string {
  const CONHECIDOS: Record<string, string> = {
    '23505': 'Um telefone ou e-mail da planilha já pertence a outro contato desta organização. Nada foi importado. Me mande este código e a planilha para eu ver qual é.',
    '23503': 'O funil de destino não existe mais. Recarregue a página e tente de novo.',
    '23514': 'Algum valor da planilha não é aceito nessa coluna. Confira o mapeamento das colunas acima.',
    '42501': 'Sua conta não tem permissão para gravar contatos nesta organização.',
    '57014': 'A importação passou do tempo limite. Divida a planilha em partes menores.',
  }

  return (
    CONHECIDOS[codigo] ??
    'Não consegui gravar a lista e nada foi importado. Tente de novo; se repetir, me diga este código.'
  ) + ` (${codigo})`
}
