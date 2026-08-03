'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { withTenant } from '@/db'
import { auditLog, organizations } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { createLogger } from '@/lib/logger'
import { hashPassword } from './password'
import { MENSAGEM_DO_MOTIVO, MIN_PASSWORD_LENGTH } from './regras'
import { consumeAttempt } from './rate-limit'
import { enviarLinkDeSenha } from './convite-email'
import { consumirToken, contaPorEmail, emitirToken, lerToken, linkDeSenha } from './tokens'

/**
 * Definir senha por link e pedir recuperação (§9.4, §14.1).
 *
 * As duas rodam SEM sessão — quem está aqui é justamente quem não consegue
 * entrar. Toda a proteção vem do token: aleatório, de uso único, com prazo, e
 * buscado por resumo criptográfico.
 */

const log = createLogger('senha')

export type DefinirSenhaState = { erro?: string; ok?: boolean }

const definirSchema = z
  .object({
    senha: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`)
      .max(200, 'Senha longa demais.'),
    confirmacao: z.string(),
  })
  .refine((d) => d.senha === d.confirmacao, {
    message: 'As duas senhas não são iguais.',
    path: ['confirmacao'],
  })

async function ipDoCliente(): Promise<string | null> {
  const store = await headers()
  const primeiro = store.get('x-forwarded-for')?.split(',')[0]?.trim()
  return primeiro && primeiro.length > 0 ? primeiro : null
}

export async function definirSenhaAction(
  _prev: DefinirSenhaState,
  formData: FormData,
): Promise<DefinirSenhaState> {
  const token = String(formData.get('token') ?? '')

  const parsed = definirSchema.safeParse({
    senha: formData.get('senha'),
    confirmacao: formData.get('confirmacao'),
  })

  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const ip = await ipDoCliente()

  /*
   * Limite por IP, não por token: um token só serve uma vez, então limitar por
   * ele não protegeria de nada. Quem estivesse varrendo tokens usaria um
   * diferente a cada tentativa.
   */
  const limite = await consumeAttempt('definir-senha', ip ?? 'sem-ip')
  if (!limite.allowed) {
    return { erro: 'Muitas tentativas. Tente de novo em alguns minutos.' }
  }

  const leitura = await lerToken(token)
  if (!leitura.ok) {
    return { erro: MENSAGEM_DO_MOTIVO[leitura.motivo] }
  }

  try {
    const hash = await hashPassword(parsed.data.senha)
    const userId = await consumirToken(token, hash)

    // `null` = o link deixou de valer entre a leitura e o consumo. Dois cliques
    // simultâneos caem aqui, e é o desfecho certo: um venceu.
    if (!userId) return { erro: MENSAGEM_DO_MOTIVO.usado }

    await withTenant(
      { orgId: leitura.dono.orgId, userId, isAdmin: false },
      async (tx) => {
        // Sem e-mail nem senha no registro (§14.1) — só o id e o motivo.
        await tx.insert(auditLog).values({
          orgId: leitura.dono.orgId,
          userId,
          action:
            leitura.dono.proposito === 'convite' ? 'auth.convite_aceito' : 'auth.senha_redefinida',
          entity: 'user',
          entityId: userId,
          ip,
        })
      },
    ).catch(() => {
      // A auditoria não pode impedir alguém de recuperar o acesso. A senha já
      // foi trocada; perder a linha do registro é o mal menor.
      log.warn('senha trocada sem registro de auditoria', { userId })
    })

    return { ok: true }
  } catch (erro) {
    log.error('falha ao definir senha', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível salvar a senha. Tente de novo.' }
  }
}

// ── Esqueci minha senha ──────────────────────────────────────────────────────

export type RecuperarState = { enviado?: boolean; erro?: string }

const recuperarSchema = z.object({
  email: z.email('Informe um e-mail válido.'),
})

/**
 * Pede um link de recuperação.
 *
 * A resposta é SEMPRE a mesma, exista a conta ou não. Uma tela de recuperação
 * que diz "e-mail não encontrado" entrega de graça a lista de quem tem acesso
 * ao painel — e essa lista é o primeiro passo de qualquer ataque dirigido.
 *
 * Pelo mesmo motivo, falha no envio também não é contada a quem pediu: ela vai
 * para o log, onde o administrador a encontra.
 */
export async function recuperarAction(
  _prev: RecuperarState,
  formData: FormData,
): Promise<RecuperarState> {
  const parsed = recuperarSchema.safeParse({ email: formData.get('email') })
  if (!parsed.success) return { erro: parsed.error.issues[0]?.message ?? 'E-mail inválido.' }

  const email = parsed.data.email.trim().toLowerCase()
  const ip = await ipDoCliente()

  const limite = await consumeAttempt('recuperar', `${ip ?? 'sem-ip'}:${email}`)
  if (!limite.allowed) {
    // Aqui o limite PODE ser dito: ele não revela se a conta existe, e sem essa
    // mensagem a pessoa acha que o e-mail está a caminho e fica esperando.
    return { erro: 'Muitas tentativas. Tente de novo em alguns minutos.' }
  }

  try {
    const conta = await contaPorEmail(email)

    if (conta?.ativo) {
      const token = await emitirToken(conta.userId, 'recuperacao')

      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, conta.orgId))
        .limit(1)

      const envio = await enviarLinkDeSenha({
        orgId: conta.orgId,
        para: email,
        nome: conta.nome,
        link: linkDeSenha(token),
        proposito: 'recuperacao',
        organizacao: org?.name ?? 'Mandafy',
      })

      if (!envio.enviado) {
        log.error('recuperação pedida mas o e-mail não saiu', { motivo: envio.motivo })
      }
    }
  } catch (erro) {
    log.error('falha ao processar recuperação', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
  }

  // Sempre igual. Ver comentário acima.
  return { enviado: true }
}
