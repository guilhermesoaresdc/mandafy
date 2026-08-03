import 'server-only'

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { serverEnv } from '@/env'

/**
 * Links de uso único para definir senha (§9.4, §14.1).
 *
 * Convite de equipe e "esqueci minha senha" são o mesmo mecanismo. O que muda
 * é o prazo e o texto do e-mail — a validação, o consumo e a invalidação são
 * idênticos, e é isso que impede um dos dois de envelhecer sem manutenção.
 *
 * TODO O CAMINHO RODA SEM SESSÃO
 *
 * Quem abre o link é justamente quem ainda não consegue entrar. Por isso as
 * consultas passam por funções SECURITY DEFINER (drizzle/0020) em vez de
 * `withTenant`: sem contexto de organização, uma política de tenant devolveria
 * zero linhas e o link nunca funcionaria — o mesmo defeito silencioso que
 * derrubou a ingestão e o descadastro antes.
 */

/**
 * Prazos.
 *
 * O convite dura uma semana porque quem recebe pode estar de férias, e um
 * convite vencido gera trabalho para o administrador. A recuperação dura uma
 * hora porque quem a pediu está com a caixa de e-mail aberta agora — e o link
 * dá acesso total à conta.
 */
export const VALIDADE = {
  convite: 7 * 24 * 60 * 60 * 1000,
  recuperacao: 60 * 60 * 1000,
} as const

export type Proposito = keyof typeof VALIDADE

export function gerarToken(): string {
  // 32 bytes: mesma força do token de sessão. base64url viaja em URL sem
  // escape, que é onde este token vive.
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** O endereço que vai no e-mail. */
export function linkDeSenha(token: string): string {
  const base = serverEnv().APP_URL.replace(/\/+$/, '')
  return `${base}/definir-senha/${token}`
}

/**
 * Cria um link para a pessoa definir a senha.
 *
 * Os links anteriores da mesma pessoa são invalidados: pedir recuperação três
 * vezes não pode deixar três chaves válidas circulando por e-mail, e quem
 * recebeu um convite antigo encaminhado não deve conseguir usá-lo depois que
 * um novo foi emitido.
 */
export async function emitirToken(userId: string, proposito: Proposito): Promise<string> {
  const token = gerarToken()
  const expira = new Date(Date.now() + VALIDADE[proposito])

  await db.execute(sql`
    UPDATE auth_tokens SET used_at = now()
    WHERE user_id = ${userId}::uuid AND used_at IS NULL
  `)

  await db.execute(sql`
    INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at)
    VALUES (${userId}::uuid, ${hashToken(token)}, ${proposito}, ${expira.toISOString()}::timestamptz)
  `)

  return token
}

export type DonoDoToken = {
  userId: string
  orgId: string
  nome: string
  email: string
  proposito: Proposito
}

export type LeituraToken =
  | { ok: true; dono: DonoDoToken }
  | { ok: false; motivo: 'invalido' | 'expirado' | 'usado' | 'inativo' }

/**
 * Quem é o dono deste link, e ele ainda vale?
 *
 * `invalido` cobre token inexistente E token malformado, de propósito: os dois
 * dizem a mesma coisa a quem está tentando adivinhar.
 */
export async function lerToken(token: string): Promise<LeituraToken> {
  // Formato antes do banco: recusa varredura sem custo de consulta.
  if (!token || token.length < 40 || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, motivo: 'invalido' }
  }

  const linhas = await db.execute<{
    user_id: string
    org_id: string
    nome: string
    email: string
    purpose: Proposito
    expires_at: string
    used_at: string | null
    active: boolean
  }>(sql`
    SELECT user_id, org_id, nome, email, purpose, expires_at, used_at, active
    FROM mandafy_usuario_por_token(${hashToken(token)})
  `)

  const linha = linhas[0]
  if (!linha) return { ok: false, motivo: 'invalido' }
  if (linha.used_at) return { ok: false, motivo: 'usado' }
  if (new Date(linha.expires_at).getTime() <= Date.now()) return { ok: false, motivo: 'expirado' }

  /*
   * Conta desligada não define senha, seja convite ou recuperação.
   *
   * `active` e "convite pendente" são estados independentes: quem é convidado
   * nasce ativo e mesmo assim não entra, porque o hash de senha está vazio.
   * Misturar os dois faria um link antigo devolver acesso a quem o
   * administrador desligou.
   */
  if (!linha.active) return { ok: false, motivo: 'inativo' }

  return {
    ok: true,
    dono: {
      userId: linha.user_id,
      orgId: linha.org_id,
      nome: linha.nome,
      email: linha.email,
      proposito: linha.purpose,
    },
  }
}

/**
 * Consome o link e grava a senha.
 *
 * Tudo numa função do banco (drizzle/0020) porque as quatro escritas precisam
 * ser atômicas: marcar o token, gravar a senha, derrubar as sessões abertas e
 * invalidar os outros links. Se a troca aconteceu porque alguém entrou na
 * conta, deixar as sessões vivas tornaria a troca inútil.
 *
 * Devolve `null` quando o link já não valia — dois cliques simultâneos no mesmo
 * link resultam em um sucesso e um `null`, nunca em duas trocas.
 */
export async function consumirToken(token: string, passwordHash: string): Promise<string | null> {
  const linhas = await db.execute<{ mandafy_definir_senha: string | null }>(sql`
    SELECT mandafy_definir_senha(${hashToken(token)}, ${passwordHash})
  `)

  return linhas[0]?.mandafy_definir_senha ?? null
}

/**
 * Encontra a conta pelo e-mail, para o "esqueci minha senha".
 *
 * Quem chama NÃO pode contar ao visitante se achou ou não: a tela responde a
 * mesma coisa sempre. Devolver a lista de e-mails cadastrados é o presente que
 * uma tela de recuperação costuma dar sem perceber.
 */
export async function contaPorEmail(
  email: string,
): Promise<{ userId: string; orgId: string; nome: string; ativo: boolean } | null> {
  const linhas = await db.execute<{
    user_id: string
    org_id: string
    nome: string
    active: boolean
  }>(sql`SELECT user_id, org_id, nome, active FROM mandafy_usuario_por_email(${email})`)

  const linha = linhas[0]
  if (!linha) return null

  return { userId: linha.user_id, orgId: linha.org_id, nome: linha.nome, ativo: linha.active }
}

/**
 * Comparação de tokens em tempo constante.
 *
 * Exportada para quem precise comparar um token fora do caminho do banco. A
 * comparação por `===` vaza o tamanho do prefixo correto pelo tempo gasto.
 */
export function tokensIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
