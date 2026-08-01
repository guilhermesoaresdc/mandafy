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

const ORG_SLUG = 'mandafy'

/** Perfis de randomização já configurados (§7.2). */
const JITTER_PROFILES = [
  { name: 'Instantâneo', mode: 'instantaneo' as const, min: 0, max: 0, isDefault: false },
  { name: 'Seguro', mode: 'humano' as const, min: 8, max: 25, isDefault: true },
  { name: 'Conservador', mode: 'humano' as const, min: 30, max: 90, isDefault: false },
  { name: 'Disparo em massa', mode: 'faixa' as const, min: 45, max: 180, isDefault: false },
]

/** Etapas padrão do funil (§9.2). */
const STAGES = [
  { name: 'Novo', position: 0, color: '#8A94AD', probability: 10, isWon: false, isLost: false },
  { name: 'Contatado', position: 1, color: '#2D9CDB', probability: 30, isWon: false, isLost: false },
  { name: 'Negociando', position: 2, color: '#E8A13C', probability: 60, isWon: false, isLost: false },
  { name: 'Ganho', position: 3, color: '#17B26A', probability: 100, isWon: true, isLost: false },
  { name: 'Perdido', position: 4, color: '#E5484D', probability: 0, isWon: false, isLost: true },
]

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

    // ── Perfis de ritmo de envio (§7.2) ──────────────────────────────────────
    let createdProfiles = 0
    for (const profile of JITTER_PROFILES) {
      const inserted = await db
        .insert(schema.jitterProfiles)
        .values({
          orgId: org.id,
          name: profile.name,
          mode: profile.mode,
          minSeconds: profile.min,
          maxSeconds: profile.max,
          isDefault: profile.isDefault,
        })
        .onConflictDoNothing({
          target: [schema.jitterProfiles.orgId, schema.jitterProfiles.name],
        })
        .returning({ id: schema.jitterProfiles.id })
      createdProfiles += inserted.length
    }

    // ── Pipeline padrão (§9.2) ───────────────────────────────────────────────
    let pipelineCriado = false
    let [pipeline] = await db
      .select()
      .from(schema.pipelines)
      .where(eq(schema.pipelines.orgId, org.id))
      .limit(1)

    if (!pipeline) {
      ;[pipeline] = await db
        .insert(schema.pipelines)
        .values({ orgId: org.id, name: 'Funil de vendas', isDefault: true })
        .returning()

      if (!pipeline) throw new Error('Não foi possível criar o pipeline.')

      await db.insert(schema.pipelineStages).values(
        STAGES.map((s) => ({
          pipelineId: pipeline!.id,
          name: s.name,
          position: s.position,
          color: s.color,
          probability: s.probability,
          isWon: s.isWon,
          isLost: s.isLost,
        })),
      )
      pipelineCriado = true
    }

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
