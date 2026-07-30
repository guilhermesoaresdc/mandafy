import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { withTenant } from '@/db'
import { apiKeys } from '@/db/schema'
import { PREFIXO_LIVE, PREFIXO_TEST, type Escopo } from './escopos'

/**
 * Chaves da API pública (§12.1).
 *
 * Prefixo visível (`mandafy_live_` / `mandafy_test_`), guardadas como SHA-256,
 * escopos por recurso, revogáveis, com registro de último uso.
 *
 * Nota de nomenclatura: a spec diz `pulso_live_`; o produto é Mandafy.
 *
 * SHA-256 e não scrypt, ao contrário da senha de usuário. A diferença é o
 * espaço de busca: uma senha humana tem entropia baixa e precisa de hash lento
 * para resistir a força bruta. Estas chaves têm 32 bytes aleatórios — não há o
 * que adivinhar — e o hash lento só serviria para tornar cada chamada de API
 * mais cara.
 */

// Escopos e prefixos moram em ./escopos, que não toca no banco: assim um
// componente de cliente importa os rótulos sem arrastar o driver do Postgres
// para dentro do navegador.
export {
  ESCOPOS,
  ESCOPO_LABELS,
  PREFIXO_LIVE,
  PREFIXO_TEST,
  type Escopo,
} from './escopos'

export function gerarChave(ambiente: 'live' | 'test' = 'live'): string {
  const prefixo = ambiente === 'test' ? PREFIXO_TEST : PREFIXO_LIVE
  return `${prefixo}${randomBytes(24).toString('base64url')}`
}

export function hashChave(chave: string): string {
  return createHash('sha256').update(chave).digest('hex')
}

/** `mandafy_live_a1b2…` — o que a pessoa vê na lista para reconhecer a chave. */
export function prefixoVisivel(chave: string): string {
  const corpo = chave.startsWith(PREFIXO_TEST)
    ? chave.slice(PREFIXO_TEST.length)
    : chave.slice(PREFIXO_LIVE.length)

  const marca = chave.startsWith(PREFIXO_TEST) ? PREFIXO_TEST : PREFIXO_LIVE
  return `${marca}${corpo.slice(0, 4)}…`
}

export type ChaveValida = {
  orgId: string
  keyId: string
  escopos: string[]
  ambiente: 'live' | 'test'
}

export type FalhaAutenticacao = 'ausente' | 'formato' | 'desconhecida' | 'revogada'

export type ResultadoAutenticacao =
  | { ok: true; chave: ChaveValida }
  | { ok: false; motivo: FalhaAutenticacao }

/** Extrai a chave do header `Authorization: Bearer …`. */
export function chaveDoHeader(header: string | null): string | null {
  if (!header) return null

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const chave = match?.[1]?.trim()
  if (!chave) return null

  return chave.startsWith(PREFIXO_LIVE) || chave.startsWith(PREFIXO_TEST) ? chave : null
}

type LinhaChave = {
  id: string
  org_id: string
  scopes: string[]
  revoked_at: Date | null
}

/**
 * Autentica uma requisição da API pública.
 *
 * Roda FORA de `withTenant`, e não tem como ser diferente: a organização é
 * justamente o que se descobre aqui. Com o RLS ligado, um `SELECT` comum sobre
 * `api_keys` não encontraria linha nenhuma — a política exige `app.org_id`, que
 * ainda não existe. Por isso a busca passa por `mandafy_lookup_api_key`, uma
 * função SECURITY DEFINER que recebe o HASH e devolve no máximo uma linha
 * (drizzle/0014).
 *
 * Não é um buraco no isolamento: sem a chave em claro não se obtém o hash, e
 * sem o hash a função não devolve nada. Não dá para enumerar.
 */
export type ExecutorSql = {
  execute: (query: SQL) => Promise<unknown>
}

export async function autenticar(
  db: ExecutorSql,
  header: string | null,
): Promise<ResultadoAutenticacao> {
  const chave = chaveDoHeader(header)
  if (!header) return { ok: false, motivo: 'ausente' }
  if (!chave) return { ok: false, motivo: 'formato' }

  const hash = hashChave(chave)

  const bruto = await db.execute(
    sql`SELECT id, org_id, scopes, revoked_at FROM mandafy_lookup_api_key(${hash})`,
  )

  // O retorno do driver é um array-like; normalizar aqui evita que a forma dele
  // vaze para o resto do módulo.
  const linha = (Array.isArray(bruto) ? bruto[0] : undefined) as LinhaChave | undefined

  if (!linha) return { ok: false, motivo: 'desconhecida' }
  if (linha.revoked_at) return { ok: false, motivo: 'revogada' }

  return {
    ok: true,
    chave: {
      orgId: linha.org_id,
      keyId: linha.id,
      escopos: linha.scopes,
      ambiente: chave.startsWith(PREFIXO_TEST) ? 'test' : 'live',
    },
  }
}

export function temEscopo(chave: ChaveValida, escopo: Escopo): boolean {
  return chave.escopos.includes(escopo)
}

/**
 * Registra o uso.
 *
 * Só grava se passou mais de um minuto desde o último registro: uma escrita por
 * chamada transformaria `api_keys` numa tabela de alta escrita, e o dado que
 * interessa ("esta chave ainda é usada?") não precisa de precisão de segundo.
 */
export async function registrarUso(orgId: string, keyId: string): Promise<void> {
  const umMinutoAtras = new Date(Date.now() - 60_000)

  await withTenant({ orgId, userId: orgId, isAdmin: true }, async (tx) => {
    await tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, umMinutoAtras)),
        ),
      )
  }).catch(() => {
    // Registrar uso nunca pode derrubar a chamada que o usuário fez.
  })
}
