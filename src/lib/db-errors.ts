import { isConfigError } from '@/env'

/**
 * Traduz falhas de infraestrutura em algo acionável.
 *
 * Uma mensagem genérica manda quem configurou procurar em quatro lugares
 * diferentes; um erro cru do driver vaza host, usuário e porta para a tela.
 * Aqui fica o meio-termo: código estável, explicação em português, nenhum
 * detalhe de conexão (§11.7, §14.1).
 *
 * Compartilhado entre `/api/health` e a tela de entrada para que os dois
 * digam exatamente a mesma coisa sobre o mesmo problema.
 */

export type DbFailure = {
  /** Código estável, seguro de exibir e de comparar em teste. */
  reason:
    | 'configuracao_ausente'
    | 'credencial_recusada'
    | 'host_nao_resolve'
    | 'sem_resposta'
    | 'migrations_pendentes'
    | 'erro_desconhecido'
  /** O que fazer a respeito. */
  hint: string
}

/** Erro do Postgres quando a tabela não existe: o schema não foi migrado. */
const UNDEFINED_TABLE = '42P01'
/** Senha incorreta e papel inexistente/sem permissão. */
const INVALID_PASSWORD = '28P01'
const INVALID_AUTHORIZATION = '28000'

export function classifyDbError(error: unknown): DbFailure {
  if (isConfigError(error)) {
    return {
      reason: 'configuracao_ausente',
      hint: 'Faltam variáveis de ambiente. Defina-as e faça um novo deploy.',
    }
  }

  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)

  if (code === UNDEFINED_TABLE) {
    return {
      reason: 'migrations_pendentes',
      hint: 'O banco está vazio. Rode: npm run db:migrate && npm run db:seed',
    }
  }

  if (code === INVALID_PASSWORD || code === INVALID_AUTHORIZATION) {
    return {
      reason: 'credencial_recusada',
      hint: 'Usuário ou senha do banco incorretos. Na URL, # vira %23 e $ vira %24.',
    }
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      reason: 'host_nao_resolve',
      hint: 'O endereço do banco não existe. Confira o host do pooler no painel.',
    }
  }

  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || /timeout|timed out/i.test(message)) {
    return {
      reason: 'sem_resposta',
      hint: 'O banco não respondeu. Em serverless a conexão direta do Supabase não serve (é IPv6): use o pooler na porta 6543.',
    }
  }

  return {
    reason: 'erro_desconhecido',
    hint: 'Abra /api/health para ver o estado de cada dependência.',
  }
}
