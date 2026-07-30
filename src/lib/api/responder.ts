import { db, withTenant } from '@/db'
import { createLogger } from '@/lib/logger'
import { autenticar, registrarUso, temEscopo, type ChaveValida, type Escopo } from './keys'
import type { Tx } from '@/db'

/**
 * A casca das rotas da API pública (§12).
 *
 * Autentica, confere escopo, abre o contexto de tenant e devolve erro no mesmo
 * formato em toda rota. Cada endpoint fica só com a sua regra.
 */

const log = createLogger('api')

export const CODIGOS = {
  sem_credencial: 401,
  credencial_invalida: 401,
  sem_permissao: 403,
  nao_encontrado: 404,
  corpo_invalido: 422,
  conflito: 409,
  erro_interno: 500,
} as const

export type CodigoErro = keyof typeof CODIGOS

export function erro(codigo: CodigoErro, mensagem: string, extra?: unknown): Response {
  return Response.json(
    { error: { code: codigo, message: mensagem, ...(extra ? { details: extra } : {}) } },
    { status: CODIGOS[codigo] },
  )
}

export function ok(dados: unknown, status = 200): Response {
  return Response.json(dados, { status })
}

export type ContextoApi = {
  chave: ChaveValida
  /** Header `Idempotency-Key`, quando o cliente mandar (§12.1). */
  idempotencyKey: string | null
}

/**
 * Executa `fn` com a organização da chave e o contexto de tenant abertos.
 *
 * A resposta de erro NÃO distingue chave desconhecida de chave revogada para
 * quem chama — as duas dizem "credencial inválida". Diferenciar contaria a um
 * atacante que a chave existiu, o que é informação de graça.
 */
export async function comChave(
  request: Request,
  escopo: Escopo,
  fn: (tx: Tx, ctx: ContextoApi) => Promise<Response>,
): Promise<Response> {
  const resultado = await autenticar(db, request.headers.get('authorization'))

  if (!resultado.ok) {
    if (resultado.motivo === 'ausente') {
      return erro('sem_credencial', 'Mande a chave em Authorization: Bearer mandafy_live_…')
    }
    return erro('credencial_invalida', 'Credencial inválida.')
  }

  const { chave } = resultado

  if (!temEscopo(chave, escopo)) {
    return erro('sem_permissao', `Esta chave não tem o escopo ${escopo}.`)
  }

  const ctx: ContextoApi = {
    chave,
    idempotencyKey: request.headers.get('idempotency-key'),
  }

  try {
    const resposta = await withTenant(
      { orgId: chave.orgId, userId: chave.orgId, isAdmin: true },
      (tx) => fn(tx, ctx),
    )

    void registrarUso(chave.orgId, chave.keyId)
    return resposta
  } catch (e) {
    // Nada de dado pessoal e nada de detalhe interno na resposta (§14.1).
    log.error('erro na API pública', {
      escopo,
      reason: e instanceof Error ? e.message : 'desconhecido',
    })
    return erro('erro_interno', 'Não foi possível processar. Tente de novo.')
  }
}

/** Lê o corpo como JSON sem estourar em corpo vazio ou malformado. */
export async function lerCorpo(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const texto = await request.text()
    if (texto.trim() === '') return {}

    const json: unknown = JSON.parse(texto)
    return typeof json === 'object' && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Paginação por `limit`/`offset`, com teto. */
export function paginacao(url: URL): { limite: number; offset: number } {
  const limite = Number(url.searchParams.get('limit') ?? 50)
  const offset = Number(url.searchParams.get('offset') ?? 0)

  return {
    limite: Number.isFinite(limite) ? Math.min(Math.max(Math.trunc(limite), 1), 200) : 50,
    offset: Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0,
  }
}
