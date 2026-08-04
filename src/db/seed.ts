/**
 * Popula o banco com o mínimo para o sistema abrir: organização, administrador,
 * perfis de ritmo de envio (§7.2) e o pipeline padrão (§9.2).
 *
 * Idempotente: rodar duas vezes não duplica nada, e o conjunto roda sob
 * `pg_advisory_lock` — dois cliques no botão da tela de sistema chegariam
 * juntos, e vários dos passos são "procura, e se não achar insere", que em
 * paralelo insere duas vezes.
 *
 * Conecta com DATABASE_URL_ADMIN (dono das tabelas) porque escreve antes de
 * existir qualquer contexto de tenant.
 *
 * NADA É IMPRESSO AQUI. A senha gerada volta no retorno, para quem chamou
 * decidir como mostrar: no terminal ela pode ir para a tela, mas no servidor
 * um `console.log` de senha e e-mail vira linha de log permanente (§14.1). O
 * ponto de entrada de linha de comando é `seed-cli.ts`.
 *
 * Uso: npm run db:seed  — ou pelo painel, em Configurações → Sistema.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema'
import { usesTransactionPooler } from './index'
import { generatePassword, hashPassword } from '@/lib/auth/password'
import { seedFlows } from './seed-flows'
import { semearFunilPadrao, semearRitmos } from './seed-org'

const ORG_SLUG = 'mandafy'

function adminUrl(): string {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL_ADMIN (ou DATABASE_URL) não definida.')
  }
  return url
}

/** Trava do seed. Número estável, vizinho do usado pelas migrations. */
const TRAVA = 8_270_121

export type ResultadoSeed = {
  orgCriada: boolean
  adminCriado: boolean
  adminEmail: string
  /** Só quando o administrador foi criado AGORA e sem senha no ambiente. */
  senhaGerada?: string
  perfis: number
  pipelineCriado: boolean
  mensagens: number
  fluxos: number
}

export async function seed(): Promise<ResultadoSeed> {
  const url = adminUrl()
  const sql = postgres(url, {
    max: 1,
    prepare: !usesTransactionPooler(url),
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })

  try {
    await sql`SELECT pg_advisory_lock(${TRAVA})`
    try {
    // ── Organização ──────────────────────────────────────────────────────────
    let [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, ORG_SLUG))
      .limit(1)

    let orgCriada = false

    if (!org) {
      ;[org] = await db
        .insert(schema.organizations)
        .values({
          name: 'Mandafy',
          slug: ORG_SLUG,
          timezone: process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo',
        })
        .returning()
      orgCriada = true
    }

    if (!org) throw new Error('Não foi possível criar a organização.')

    // ── Administrador ────────────────────────────────────────────────────────
    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@mandafy.local'
    const [existingAdmin] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, adminEmail))
      .limit(1)

    let adminCriado = false
    let senhaGerada: string | undefined

    if (!existingAdmin) {
      // Nunca uma senha fixa em código. Sem SEED_ADMIN_PASSWORD, geramos uma e
      // devolvemos — é a única vez que ela existe em claro.
      const provided = process.env.SEED_ADMIN_PASSWORD
      const password = provided && provided.length > 0 ? provided : generatePassword()

      await db.insert(schema.users).values({
        orgId: org.id,
        name: 'Administrador',
        email: adminEmail,
        passwordHash: await hashPassword(password),
        role: 'admin',
      })

      adminCriado = true
      if (!provided) senhaGerada = password
    }

    /*
     * Daqui para baixo é o mesmo que o botão da tela faz (src/db/seed-org.ts).
     *
     * As funções são compartilhadas de propósito: enquanto eram duas cópias, o
     * botão do painel semeava por um caminho e o comando por outro, e o do
     * painel semeava a organização errada. `db` aqui é o dono do banco e não um
     * `Tx` do withTenant — o tipo aceita os dois, e nesta subida não há sessão
     * de onde tirar contexto de tenant.
     */
    const createdProfiles = await semearRitmos(db, org.id)
    const pipelineCriado = await semearFunilPadrao(db, org.id)

    // ── Mensagens e fluxos-modelo (§5.2, §6) ─────────────────────────────────
    const modelos = await seedFlows(db, org.id)

    return {
      orgCriada,
      adminCriado,
      adminEmail,
      ...(senhaGerada ? { senhaGerada } : {}),
      perfis: createdProfiles,
      pipelineCriado,
      mensagens: modelos.mensagens,
      fluxos: modelos.fluxos,
    }
    } finally {
      await sql`SELECT pg_advisory_unlock(${TRAVA})`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
