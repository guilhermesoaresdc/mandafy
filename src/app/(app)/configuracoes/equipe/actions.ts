'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db, withTenant } from '@/db'
import { auditLog, organizations, users } from '@/db/schema'
import { USER_ROLES } from '@/db/schema/enums'
import { contarAdminsAtivos, membroDaOrg } from '@/db/queries/equipe'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { enviarLinkDeSenha } from '@/lib/auth/convite-email'
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password'
import { invalidateAllSessions } from '@/lib/auth/session'
import { emitirToken, linkDeSenha } from '@/lib/auth/tokens'
import { createLogger } from '@/lib/logger'
import { assertCan } from '@/lib/rbac'

/**
 * Quem entra no painel (§9.4).
 *
 * Só administrador cadastra, e não existe cadastro público. A pessoa recebe um
 * link e define a própria senha — o administrador nunca digita, nunca vê e
 * nunca guarda a senha de ninguém.
 */

const log = createLogger('equipe')

export type EquipeState = {
  ok?: string
  erro?: string
  /**
   * O link, quando o e-mail não sai.
   *
   * Devolver o link na tela é deliberado: sem isso, um canal de e-mail mal
   * configurado deixaria o administrador travado, sem nenhum caminho para dar
   * acesso a alguém. Ele aparece UMA vez, para quem já é administrador, e
   * quem o vê já podia criar o próprio convite de qualquer forma.
   */
  link?: string
}

const convidarSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome da pessoa.').max(120),
  email: z.email('Informe um e-mail válido.'),
  papel: z.enum(USER_ROLES),
})

export async function convidarAction(
  _prev: EquipeState,
  formData: FormData,
): Promise<EquipeState> {
  const admin = await requireAdmin()
  assertCan(admin, 'usuarios.gerenciar')

  const parsed = convidarSchema.safeParse({
    nome: formData.get('nome'),
    email: formData.get('email'),
    papel: formData.get('papel'),
  })
  if (!parsed.success) return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const email = parsed.data.email.trim().toLowerCase()

  try {
    const criado = await withTenant(tenantOf(admin), async (tx) => {
      const [existente] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

      if (existente) return { erro: 'Já existe alguém com esse e-mail.' } as const

      const [novo] = await tx
        .insert(users)
        .values({
          orgId: admin.orgId,
          name: parsed.data.nome,
          email,
          /*
           * Hash vazio: a marca de convite não aceito.
           *
           * A coluna é obrigatória e é bom que seja — permitir NULL aqui
           * convidaria alguém a esquecer de conferi-lo antes de comparar
           * senha. Vazio não casa com senha nenhuma (`verifyPassword` recusa
           * formato inválido), então a conta existe e não entra.
           */
          passwordHash: '',
          role: parsed.data.papel,
          active: true,
        })
        .returning({ id: users.id })

      if (!novo) return { erro: 'Não foi possível criar o acesso.' } as const

      await tx.insert(auditLog).values({
        orgId: admin.orgId,
        userId: admin.id,
        action: 'equipe.convidado',
        entity: 'user',
        entityId: novo.id,
        // Sem e-mail no registro (§14.1) — o id basta para rastrear.
        after: { papel: parsed.data.papel },
      })

      return { id: novo.id } as const
    })

    if ('erro' in criado) return { erro: criado.erro }

    return await mandarConvite(admin.orgId, criado.id, email, parsed.data.nome, 'convite')
  } catch (erro) {
    log.error('falha ao convidar', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível criar o acesso. Tente de novo.' }
  } finally {
    revalidatePath('/configuracoes/equipe')
  }
}

/** Emite o link e tenta enviar. Se o e-mail não sai, o link volta para a tela. */
async function mandarConvite(
  orgId: string,
  userId: string,
  email: string,
  nome: string,
  proposito: 'convite' | 'recuperacao',
): Promise<EquipeState> {
  const token = await emitirToken(userId, proposito)
  const link = linkDeSenha(token)

  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)

  const envio = await enviarLinkDeSenha({
    orgId,
    para: email,
    nome,
    link,
    proposito,
    organizacao: org?.name ?? 'Mandafy',
  })

  if (envio.enviado) {
    return { ok: `Convite enviado para ${email}. O link vale por 7 dias.` }
  }

  return {
    ok: `O acesso foi criado, mas o e-mail não saiu (${envio.motivo}). Passe este link para a pessoa — ele vale por 7 dias e só funciona uma vez.`,
    link,
  }
}

export async function reenviarConviteAction(
  _prev: EquipeState,
  formData: FormData,
): Promise<EquipeState> {
  const admin = await requireAdmin()
  assertCan(admin, 'usuarios.gerenciar')

  const id = String(formData.get('id') ?? '')
  if (!id) return { erro: 'Sem identificador.' }

  try {
    const membro = await withTenant(tenantOf(admin), (tx) => membroDaOrg(tx, id))
    if (!membro) return { erro: 'Pessoa não encontrada.' }
    if (!membro.ativo) return { erro: 'Reative o acesso antes de mandar um link novo.' }

    revalidatePath('/configuracoes/equipe')
    return await mandarConvite(admin.orgId, membro.id, membro.email, membro.nome, 'convite')
  } catch (erro) {
    log.error('falha ao reenviar convite', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível gerar o link.' }
  }
}

export async function alternarAcessoAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin()
  assertCan(admin, 'usuarios.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(admin), async (tx) => {
    const membro = await membroDaOrg(tx, id)
    if (!membro) return

    /*
     * Duas travas que impedem a organização de ficar sem dono:
     *
     * 1. Ninguém desliga o próprio acesso — sairia da própria tela e não
     *    conseguiria voltar.
     * 2. O último administrador ativo não pode ser desligado, ou não sobra
     *    quem religue.
     */
    if (!ativar) {
      if (membro.id === admin.id) return
      if (membro.papel === 'admin' && (await contarAdminsAtivos(tx)) <= 1) return
    }

    await tx
      .update(users)
      .set({ active: ativar, updatedAt: new Date() })
      .where(eq(users.id, id))

    if (!ativar) {
      // Sessões abertas caem na hora: tirar o acesso e deixar a pessoa
      // navegando por mais trinta dias não é tirar o acesso.
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}::uuid`)
      // E os links pendentes morrem, para que um convite antigo não devolva o
      // acesso que acabou de ser retirado.
      await tx.execute(sql`
        UPDATE auth_tokens SET used_at = now()
        WHERE user_id = ${id}::uuid AND used_at IS NULL
      `)
    }

    await tx.insert(auditLog).values({
      orgId: admin.orgId,
      userId: admin.id,
      action: ativar ? 'equipe.reativado' : 'equipe.desativado',
      entity: 'user',
      entityId: id,
    })
  })

  revalidatePath('/configuracoes/equipe')
}

export async function trocarPapelAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin()
  assertCan(admin, 'usuarios.gerenciar')

  const id = String(formData.get('id') ?? '')
  const papel = String(formData.get('papel') ?? '')
  if (!id || !USER_ROLES.includes(papel as (typeof USER_ROLES)[number])) return

  await withTenant(tenantOf(admin), async (tx) => {
    const membro = await membroDaOrg(tx, id)
    if (!membro) return

    // Mesma proteção do desligamento: rebaixar o último administrador deixaria
    // a organização sem ninguém que possa promover alguém.
    if (membro.papel === 'admin' && papel !== 'admin' && (await contarAdminsAtivos(tx)) <= 1) return

    await tx
      .update(users)
      .set({ role: papel as (typeof USER_ROLES)[number], updatedAt: new Date() })
      .where(eq(users.id, id))

    await tx.insert(auditLog).values({
      orgId: admin.orgId,
      userId: admin.id,
      action: 'equipe.papel_alterado',
      entity: 'user',
      entityId: id,
      before: { papel: membro.papel },
      after: { papel },
    })
  })

  revalidatePath('/configuracoes/equipe')
}

// ── Trocar a própria senha ───────────────────────────────────────────────────

export type TrocarSenhaState = { ok?: boolean; erro?: string }

const trocarSchema = z
  .object({
    atual: z.string().min(1, 'Informe a senha atual.'),
    nova: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`)
      .max(200),
    confirmacao: z.string(),
  })
  .refine((d) => d.nova === d.confirmacao, {
    message: 'As duas senhas não são iguais.',
    path: ['confirmacao'],
  })
  .refine((d) => d.nova !== d.atual, {
    message: 'A senha nova precisa ser diferente da atual.',
    path: ['nova'],
  })

/**
 * Troca a senha de quem está logado.
 *
 * Exige a senha ATUAL, e isso não é burocracia: sem ela, um notebook
 * desbloqueado por dois minutos vira uma conta sequestrada — o invasor troca a
 * senha, derruba as sessões e o dono perde o acesso.
 */
export async function trocarSenhaAction(
  _prev: TrocarSenhaState,
  formData: FormData,
): Promise<TrocarSenhaState> {
  const user = await requireAdmin()

  const parsed = trocarSchema.safeParse({
    atual: formData.get('atual'),
    nova: formData.get('nova'),
    confirmacao: formData.get('confirmacao'),
  })
  if (!parsed.success) return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  try {
    const [linha] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1)

    const confere = await verifyPassword(parsed.data.atual, linha?.passwordHash ?? '')
    if (!confere) return { erro: 'A senha atual não confere.' }

    const hash = await hashPassword(parsed.data.nova)

    await withTenant(tenantOf(user), async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: hash, updatedAt: new Date() })
        .where(and(eq(users.id, user.id), eq(users.orgId, user.orgId)))

      await tx.insert(auditLog).values({
        orgId: user.orgId,
        userId: user.id,
        action: 'auth.senha_trocada',
        entity: 'user',
        entityId: user.id,
      })
    })

    /*
     * Derruba as OUTRAS sessões desta conta.
     *
     * Trocar a senha é o que se faz ao desconfiar de acesso indevido; deixar a
     * sessão do invasor viva tornaria a troca decorativa. A sessão atual cai
     * junto e a pessoa entra de novo — um incômodo pequeno perto de manter uma
     * sessão desconhecida aberta por trinta dias.
     */
    await invalidateAllSessions(user.id)

    return { ok: true }
  } catch (erro) {
    log.error('falha ao trocar senha', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível trocar a senha. Tente de novo.' }
  }
}
