/**
 * Popula o banco com o mínimo para o sistema abrir: organização, administrador,
 * perfis de ritmo de envio (§7.2) e o pipeline padrão (§9.2).
 *
 * Idempotente: rodar duas vezes não duplica nada.
 * Conecta com DATABASE_URL_ADMIN (dono das tabelas) porque escreve antes de
 * existir qualquer contexto de tenant.
 *
 * Uso: npm run db:seed
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import * as schema from './schema'
import { generatePassword, hashPassword } from '@/lib/auth/password'

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

export async function seed(): Promise<void> {
  const sql = postgres(adminUrl(), { max: 1, onnotice: () => {} })
  const db = drizzle(sql, { schema })

  try {
    // ── Organização ──────────────────────────────────────────────────────────
    let [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, ORG_SLUG))
      .limit(1)

    if (!org) {
      ;[org] = await db
        .insert(schema.organizations)
        .values({
          name: 'Mandafy',
          slug: ORG_SLUG,
          timezone: process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo',
        })
        .returning()
      console.log('✓ Organização criada.')
    } else {
      console.log('· Organização já existe.')
    }

    if (!org) throw new Error('Não foi possível criar a organização.')

    // ── Administrador ────────────────────────────────────────────────────────
    const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@mandafy.local'
    const [existingAdmin] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, adminEmail))
      .limit(1)

    if (!existingAdmin) {
      // Nunca uma senha fixa em código. Sem SEED_ADMIN_PASSWORD, geramos uma e
      // imprimimos — é a única vez que ela aparece.
      const provided = process.env.SEED_ADMIN_PASSWORD
      const password = provided && provided.length > 0 ? provided : generatePassword()

      await db.insert(schema.users).values({
        orgId: org.id,
        name: 'Administrador',
        email: adminEmail,
        passwordHash: await hashPassword(password),
        role: 'admin',
      })

      console.log('✓ Administrador criado.')
      console.log(`    e-mail: ${adminEmail}`)
      if (!provided) {
        console.log(`    senha:  ${password}`)
        console.log('    ⚠ Guarde agora: esta senha não será exibida de novo.')
      }
    } else {
      console.log('· Administrador já existe.')
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
    console.log(
      createdProfiles > 0
        ? `✓ ${createdProfiles} perfil(is) de ritmo criado(s).`
        : '· Perfis de ritmo já existem.',
    )

    // ── Pipeline padrão (§9.2) ───────────────────────────────────────────────
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
      console.log('✓ Pipeline padrão criado com 5 etapas.')
    } else {
      console.log('· Pipeline já existe.')
    }

    // TODO Fase 3: mensagens-modelo (boas-vindas, pix_lembrete_1…4, etc).
    // TODO Fase 5: os 9 fluxos-modelo de §5.2, incluindo a Recuperação de PIX.

    console.log('\nSeed concluído.')
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().catch((error: unknown) => {
    console.error('\nFalha no seed:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
