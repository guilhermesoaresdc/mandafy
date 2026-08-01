import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@/db'
import { classifyDbError } from '@/lib/db-errors'
import { getRedis } from '@/lib/redis'

/**
 * Healthcheck do container, do balanceador — e do operador.
 *
 * Além de dizer se está de pé, classifica a falha em um código curto. Sem
 * isso, "não foi possível entrar" manda quem configurou procurar em quatro
 * lugares diferentes. Os códigos são genéricos de propósito: nada de string
 * de conexão, host, usuário ou versão de serviço externo na resposta.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const started = Date.now()

type Check = {
  ok: boolean
  /** Código estável, seguro de exibir. */
  reason?: string
  /** O que fazer a respeito. */
  hint?: string
  /** Qual objeto falhou. Sempre sem credenciais. */
  detail?: string
}

function falha(error: unknown): Check {
  return { ok: false, ...classifyDbError(error) }
}

export async function GET() {
  let database: Check = { ok: false }
  let schema: Check = { ok: false, reason: 'nao_verificado' }

  try {
    await db.execute(sql`SELECT 1`)
    database = { ok: true }

    /*
     * Conectar não basta. Esta verificação precisa LER uma tabela de verdade,
     * e não apenas conferir que ela existe: `to_regclass` responde sem exigir
     * privilégio nenhum, então o healthcheck ficava verde enquanto o papel da
     * aplicação não tinha permissão de SELECT — e o login falhava.
     *
     * O `count` sobre `users` exerce o caminho real: privilégio na tabela,
     * política de RLS e o tipo citext do e-mail.
     */
    const rows = await db.execute<{ total: number }>(sql`SELECT count(*)::int AS total FROM users`)
    const total = rows[0]?.total ?? 0

    schema =
      total > 0
        ? { ok: true }
        : {
            ok: false,
            reason: 'migrations_pendentes',
            hint: 'O banco responde e a tabela existe, mas não há nenhum usuário. Rode o seed: npm run db:seed',
          }
  } catch (error) {
    database = falha(error)
    schema = { ok: false, reason: 'nao_verificado' }
  }

  /*
   * Leitura não basta. O login lê `users`, mas TAMBÉM insere em `sessions` e
   * `audit_log` e atualiza `users` — e permissão de escrita é concedida por
   * comando separado. Um healthcheck que só lê fica verde enquanto o login
   * falha, o que já aconteceu duas vezes aqui.
   *
   * `has_table_privilege` responde sem escrever nada: nenhuma linha de teste
   * suja o banco, e nenhuma transação é aberta à toa.
   */
  let escrita: Check = { ok: false, reason: 'nao_verificado' }
  if (schema.ok) {
    try {
      const faltando = await db.execute<{ tabela: string; privilegio: string }>(sql`
        SELECT t.tablename AS tabela, p.privilegio
        FROM pg_tables t
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilegio)
        WHERE t.schemaname = 'public'
          AND NOT has_table_privilege(current_user, 'public.' || quote_ident(t.tablename), p.privilegio)
        ORDER BY 1, 2
        LIMIT 20
      `)

      escrita =
        faltando.length === 0
          ? { ok: true }
          : {
              ok: false,
              reason: 'sem_privilegio',
              hint: 'Rode no SQL Editor: grant select, insert, update, delete on all tables in schema public to mandafy_app;',
              detail: faltando.map((f) => `${f.tabela}:${f.privilegio}`).join(', '),
            }
    } catch (error) {
      escrita = falha(error)
    }
  }

  /*
   * O caminho de autenticação, verificado tabela por tabela.
   *
   * `validateSessionToken` junta sessions → users → organizations SEM contexto
   * de tenant — é justamente ela que descobre a organização. Se qualquer uma
   * das três estiver invisível nesse momento, a junção volta vazia, toda
   * sessão válida é lida como inválida, e o sintoma é um login que "funciona"
   * e devolve para a tela de entrada.
   *
   * Contar cada tabela separadamente é o que distingue "não há sessões" de
   * "a política esconde a organização" — os dois produzem junção vazia.
   */
  let autenticacao: Check = { ok: false, reason: 'nao_verificado' }
  if (schema.ok) {
    try {
      const [contagem] = await db.execute<{ orgs: number; usuarios: number; juncao: number }>(sql`
        SELECT
          (SELECT count(*)::int FROM organizations) AS orgs,
          (SELECT count(*)::int FROM users)         AS usuarios,
          (SELECT count(*)::int
             FROM users u
             INNER JOIN organizations o ON o.id = u.org_id) AS juncao
      `)

      const orgs = contagem?.orgs ?? 0
      const usuarios = contagem?.usuarios ?? 0
      const juncao = contagem?.juncao ?? 0

      if (usuarios > 0 && orgs === 0) {
        autenticacao = {
          ok: false,
          reason: 'organizacao_invisivel',
          hint:
            'A política de organizations esconde a linha quando não há contexto de tenant, ' +
            'e o login precisa lê-la antes de saber a organização. Rode a migration 0011: ' +
            'DROP POLICY IF EXISTS organizations_tenant ON organizations; ' +
            'CREATE POLICY organizations_tenant ON organizations FOR ALL ' +
            'USING (mandafy_current_org() IS NULL OR id = mandafy_current_org()) ' +
            'WITH CHECK (mandafy_current_org() IS NULL OR id = mandafy_current_org());',
          detail: `organizations=${orgs} users=${usuarios}`,
        }
      } else if (usuarios > 0 && juncao === 0) {
        autenticacao = {
          ok: false,
          reason: 'juncao_vazia',
          hint: 'Há usuários e organizações, mas a junção entre elas volta vazia. Confira org_id em users.',
          detail: `organizations=${orgs} users=${usuarios} juncao=${juncao}`,
        }
      } else {
        autenticacao = { ok: true, detail: `organizations=${orgs} users=${usuarios}` }
      }
    } catch (error) {
      autenticacao = falha(error)
    }
  }

  /*
   * A estrutura do banco está em dia?
   *
   * Este é o único check que se abre SEM sessão e diz o que quebrou uma tela
   * autenticada — e foi a falta dele que custou caro: uma migration que não
   * aplicou vira `column "x" does not exist`, o Next responde
   * "Application error" com um digest opaco, e quem opera não tem por onde
   * começar. O painel que diagnosticaria isso é justamente o que não abre.
   *
   * Os nomes das migrations pendentes saem na resposta. Não são segredo:
   * estão no repositório, e sem eles a informação não serve para agir.
   */
  let estrutura: Check = { ok: false, reason: 'nao_verificado' }
  if (database.ok) {
    try {
      const { migrationsPendentes } = await import('@/db/migrate')
      const m = await migrationsPendentes()

      estrutura =
        m.pendentes.length === 0
          ? { ok: true, detail: `${m.aplicadas}/${m.total} aplicadas` }
          : {
              ok: false,
              reason: 'migrations_pendentes',
              hint:
                'O app aplica as pendentes ao subir. Se elas persistem, force um novo deploy ' +
                'ou abra Configurações → Sistema e use "Aplicar agora".',
              detail: m.pendentes.join(', '),
            }
    } catch (error) {
      estrutura = falha(error)
    }
  }

  let redis: Check = { ok: false }
  try {
    await getRedis().ping()
    redis = { ok: true }
  } catch (error) {
    redis = falha(error)
  }

  // Redis fora do ar não impede login (o limite de tentativas degrada
  // graciosamente), então ele não derruba o status geral.
  const ok = database.ok && schema.ok && escrita.ok && autenticacao.ok && estrutura.ok

  return NextResponse.json(
    {
      ok,
      service: 'mandafy',
      checks: { database, schema, estrutura, escrita, autenticacao, redis },
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
    },
    { status: ok ? 200 : 503 },
  )
}
