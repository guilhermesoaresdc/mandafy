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
    | 'rede_inalcancavel'
    | 'tenant_desconhecido'
    | 'tls_recusado'
    | 'migrations_pendentes'
    | 'erro_desconhecido'
  /** O que fazer a respeito. */
  hint: string
  /** Código bruto do driver. Curto e sem segredo — ajuda a fechar o diagnóstico. */
  code?: string
  /** Mensagem do driver com credenciais removidas. Só para `erro_desconhecido`. */
  detail?: string
}

/**
 * Remove credenciais de uma mensagem de erro.
 *
 * Drivers costumam ecoar a string de conexão inteira — com usuário e senha —
 * dentro da mensagem. Exibir isso numa página pública seria vazamento (§14.1).
 */
export function redactCredentials(message: string): string {
  return message
    // //usuario:senha@host  →  //***@host
    .replace(/\/\/[^/@\s]*@/g, '//***@')
    // password=... em connection strings no formato de chave-valor
    .replace(/password=[^\s&]*/gi, 'password=***')
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
      code,
    }
  }

  // A rede não tem rota para o destino — é a assinatura de tentar IPv6 de um
  // ambiente que só fala IPv4, exatamente o caso da Vercel com a conexão
  // direta do Supabase.
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EAFNOSUPPORT') {
    return {
      reason: 'rede_inalcancavel',
      hint: 'Sem rota até o banco. A conexão direta do Supabase é IPv6 e a Vercel não fala IPv6: troque DATABASE_URL pelo pooler (host pooler.supabase.com, porta 6543).',
      code,
    }
  }

  // Resposta do Supavisor quando o projeto não bate com o endpoint. Quase
  // sempre: prefixo errado do pooler (aws-0 vs aws-1) ou usuário sem o
  // sufixo `.<ref-do-projeto>`.
  if (/tenant or user not found/i.test(message)) {
    return {
      reason: 'tenant_desconhecido',
      hint: 'O pooler não reconheceu o projeto. Confira duas coisas: o usuário precisa terminar em .<ref-do-projeto>, e o prefixo do host pode ser aws-0 em vez de aws-1.',
      code,
    }
  }

  if (/self.signed|certificate|SSL|TLS/i.test(message)) {
    return {
      reason: 'tls_recusado',
      hint: 'Falha de TLS ao conectar. Confirme que a URL usa o host do pooler e não um proxy intermediário.',
      code,
    }
  }

  return {
    reason: 'erro_desconhecido',
    hint: 'Erro não catalogado — o campo `detail` traz a mensagem do driver, sem credenciais.',
    code,
    detail: redactCredentials(message).slice(0, 300),
  }
}
