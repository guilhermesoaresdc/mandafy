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
    | 'search_path_incompleto'
    | 'sem_privilegio'
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
/** Operador ou função inexistente — tipicamente search_path sem `extensions`. */
const UNDEFINED_FUNCTION = '42883'
/** Sem privilégio na tabela. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** Senha incorreta e papel inexistente/sem permissão. */
const INVALID_PASSWORD = '28P01'
const INVALID_AUTHORIZATION = '28000'

/**
 * Percorre a cadeia de `cause`.
 *
 * O Drizzle embrulha o erro do driver num DrizzleQueryError cuja mensagem é
 * só "Failed query: SELECT 1" — a causa real (senha recusada, host sem rota,
 * tenant desconhecido) fica em `.cause`. Classificar só a camada de fora
 * devolve "erro desconhecido" para todo problema de banco.
 */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  // O limite evita laço infinito se alguém montar um ciclo de causas.
  for (let depth = 0; current != null && depth < 10; depth += 1) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

/** Mensagem do erro mais interno que tenha alguma — é a informativa. */
function deepestMessage(chain: unknown[]): string {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const item = chain[i]
    const message = item instanceof Error ? item.message : typeof item === 'string' ? item : ''
    if (message) return message
  }
  return String(chain[0] ?? '')
}

export function classifyDbError(error: unknown): DbFailure {
  const chain = causeChain(error)

  // Do mais interno para o mais externo: a causa raiz é a que interessa.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const resultado = classifyOne(chain[i])
    if (resultado.reason !== 'erro_desconhecido') return resultado
  }

  const raiz = chain[chain.length - 1]
  const code = (raiz as { code?: string } | null)?.code
  return {
    reason: 'erro_desconhecido',
    hint: 'Erro não catalogado. Abra /api/health para ver a mensagem do driver.',
    ...(code ? { code } : {}),
    detail: redactCredentials(deepestMessage(chain)).slice(0, 300),
  }
}

function classifyOne(error: unknown): DbFailure {
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

  // 42883 = operador ou função inexistente. Num banco recém-configurado quase
  // sempre significa que o tipo citext está num schema fora do search_path do
  // papel da aplicação — o Supabase instala extensões em `extensions`, e sem
  // isso a comparação `email = $1` não acha o operador.
  if (code === UNDEFINED_FUNCTION) {
    return {
      reason: 'search_path_incompleto',
      hint: 'O papel da aplicação não enxerga as extensões. Rode no SQL Editor: alter role mandafy_app set search_path = public, extensions;',
      code,
    }
  }

  // 42501 = sem privilégio na tabela.
  if (code === INSUFFICIENT_PRIVILEGE) {
    return {
      reason: 'sem_privilegio',
      hint: 'O papel da aplicação não tem permissão nas tabelas. Rode no SQL Editor: grant select, insert, update, delete on all tables in schema public to mandafy_app; grant usage, select on all sequences in schema public to mandafy_app;',
      code,
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

  // Resposta do Supavisor quando não encontra o tenant. O texto varia entre
  // "Tenant or user not found" e "(ENOTFOUND) tenant/user <nome> not found",
  // por isso o padrão é frouxo no meio.
  if (/tenant.{0,20}user[\s\S]{0,120}not found/i.test(message)) {
    return {
      reason: 'tenant_desconhecido',
      hint: 'O pooler não reconheceu o projeto. Três causas, nesta ordem: (1) o prefixo do host pode ser aws-0 em vez de aws-1; (2) o usuário precisa terminar em .<ref-do-projeto>; (3) papéis criados à mão podem não estar habilitados no pooler — teste com o usuário postgres no mesmo host para descobrir qual é.',
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

  // Sem detail aqui: quem monta a resposta final é classifyDbError, que tem
  // a cadeia inteira e sabe qual mensagem é a informativa.
  return {
    reason: 'erro_desconhecido',
    hint: 'Erro não catalogado.',
  }
}
