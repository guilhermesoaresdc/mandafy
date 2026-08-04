'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { withTenant } from '@/db'
import { buscarMensagem, chaveEmUso } from '@/db/queries/messages'
import { messages, messageVariants } from '@/db/schema'
import { CHANNELS, MESSAGE_CATEGORIES, type Channel } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { createLogger } from '@/lib/logger'
import { assertCan } from '@/lib/rbac'
import { acharModelo, linhasDoModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS } from '@/lib/messages/modelos'
import { editarVariante, propagar, ressincronizar } from '@/lib/messages/sync'

/**
 * Mensagens (§3.4, §6.1).
 *
 * Toda escrita passa por `withTenant`: fora dele a query roda sem `app.org_id`
 * e o RLS recusa a linha.
 */

const log = createLogger('mensagens')

export type MensagemState = { error?: string; ok?: boolean }

/** Chave estável usada pela API pública: `pix_lembrete_1`. */
const CHAVE = /^[a-z][a-z0-9_]*$/

function chaveSugerida(nome: string): string {
  return (
    nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'mensagem'
  )
}

const criarSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome à mensagem.').max(80),
  categoria: z.enum(MESSAGE_CATEGORIES),
  /**
   * A chave de um modelo do catálogo, ou nada para começar em branco.
   *
   * Sem validar contra a lista aqui: `acharModelo` devolve nulo para o que não
   * existe, e o desfecho de uma chave inventada é "criou em branco" — não vale
   * uma mensagem de erro na tela.
   */
  modelo: z.string().trim().optional(),
})

export async function criarMensagemAction(
  _prev: MensagemState,
  formData: FormData,
): Promise<MensagemState> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const parsed = criarSchema.safeParse({
    nome: formData.get('nome'),
    categoria: formData.get('categoria') ?? 'relacionamento',
    modelo: formData.get('modelo') ?? undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Não foi possível criar.' }
  }

  const modelo = acharModelo(MENSAGENS, parsed.data.modelo)

  let id: string
  try {
    id = await withTenant(tenantOf(user), async (tx) => {
      /*
       * Chave única por organização: se `boas_vindas` já existe, vira
       * `boas_vindas_2`. Pedir outra chave à pessoa seria burocracia por nada.
       *
       * Com modelo, a base é a chave DELE e não o nome digitado. A chave é o
       * que a API pública usa (§3.4) e o que a documentação cita pelo nome:
       * quem escolhe "Lembrete de PIX — 5 minutos" espera `pix_lembrete_1`,
       * mesmo tendo renomeado a mensagem antes de criar. O nome é rótulo; a
       * chave é contrato, e continua editável na tela da mensagem.
       */
      const base = modelo ? modelo.key : chaveSugerida(parsed.data.nome)
      let key = base
      for (let n = 2; await chaveEmUso(tx, user.orgId, key); n += 1) key = `${base}_${n}`

      /*
       * Do modelo saem corpo, variantes e canais pela MESMA função que o seed
       * usa (`linhasDoModelo`). O nome e a categoria vêm do formulário: são os
       * dois campos que a pessoa acabou de ver e pode ter mudado.
       */
      const linhas = modelo ? linhasDoModelo(modelo, key) : null

      const [criada] = await tx
        .insert(messages)
        .values({
          orgId: user.orgId,
          ...(linhas ? linhas.mensagem : {}),
          key,
          name: parsed.data.nome,
          category: parsed.data.categoria,
        })
        .returning({ id: messages.id })

      if (!criada) throw new Error('insert sem retorno')

      // As quatro variantes nascem juntas e sincronizadas (§6.1) — assim a
      // mensagem já pode sair por qualquer canal sem passo extra.
      await tx.insert(messageVariants).values(
        linhas
          ? linhas.variantes.map((variante) => ({ messageId: criada.id, ...variante }))
          : CHANNELS.map((channel) => ({
              messageId: criada.id,
              channel,
              parseMode: channel === 'telegram' ? ('HTML' as const) : null,
            })),
      )

      return criada.id
    })
  } catch (error) {
    log.error('falha ao criar mensagem', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível criar a mensagem. Tente de novo.' }
  }

  revalidatePath('/mensagens')
  // Fora do try: o redirect sinaliza por exceção e seria engolido pelo catch.
  redirect(`/mensagens/${id}`)
}

const corpoSchema = z.object({
  id: z.uuid(),
  nome: z.string().trim().min(2, 'Dê um nome à mensagem.').max(80),
  chave: z.string().trim().regex(CHAVE, 'A chave usa letras minúsculas, números e _.').max(60),
  categoria: z.enum(MESSAGE_CATEGORIES),
  corpo: z.string().max(20_000),
  ignorarSilencio: z.coerce.boolean(),
})

export async function salvarCorpoAction(
  _prev: MensagemState,
  formData: FormData,
): Promise<MensagemState> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const parsed = corpoSchema.safeParse({
    id: formData.get('id'),
    nome: formData.get('nome'),
    chave: formData.get('chave'),
    categoria: formData.get('categoria'),
    corpo: formData.get('corpo') ?? '',
    ignorarSilencio: formData.get('ignorarSilencio') === 'on',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const dados = parsed.data

  try {
    const conflito = await withTenant(tenantOf(user), async (tx) => {
      if (await chaveEmUso(tx, user.orgId, dados.chave, dados.id)) return true

      await tx
        .update(messages)
        .set({
          name: dados.nome,
          key: dados.chave,
          category: dados.categoria,
          body: dados.corpo,
          ignoreQuietHours: dados.ignorarSilencio,
          updatedAt: new Date(),
        })
        .where(and(eq(messages.id, dados.id), eq(messages.orgId, user.orgId)))

      // §6.1: o corpo principal propaga só para as variantes sincronizadas.
      const variantes = await tx
        .select({
          channel: messageVariants.channel,
          synced: messageVariants.synced,
          body: messageVariants.body,
        })
        .from(messageVariants)
        .where(eq(messageVariants.messageId, dados.id))

      for (const decisao of propagar(dados.corpo, variantes)) {
        if (!decisao.propagou) continue
        await tx
          .update(messageVariants)
          .set({ body: null, updatedAt: new Date() })
          .where(
            and(
              eq(messageVariants.messageId, dados.id),
              eq(messageVariants.channel, decisao.channel),
            ),
          )
      }

      return false
    })

    if (conflito) return { error: 'Já existe outra mensagem com essa chave.' }
  } catch (error) {
    log.error('falha ao salvar mensagem', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath(`/mensagens/${dados.id}`)
  revalidatePath('/mensagens')
  return { ok: true }
}

const varianteSchema = z.object({
  id: z.uuid(),
  canal: z.enum(CHANNELS),
  corpo: z.string().max(20_000),
  assunto: z.string().trim().max(200).optional(),
  preheader: z.string().trim().max(200).optional(),
  removerAcentos: z.coerce.boolean(),
  encurtarLinks: z.coerce.boolean(),
})

export async function salvarVarianteAction(
  _prev: MensagemState,
  formData: FormData,
): Promise<MensagemState> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const parsed = varianteSchema.safeParse({
    id: formData.get('id'),
    canal: formData.get('canal'),
    corpo: formData.get('corpo') ?? '',
    assunto: formData.get('assunto') ?? undefined,
    preheader: formData.get('preheader') ?? undefined,
    removerAcentos: formData.get('removerAcentos') === 'on',
    encurtarLinks: formData.get('encurtarLinks') === 'on',
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const dados = parsed.data

  try {
    await withTenant(tenantOf(user), async (tx) => {
      const completa = await buscarMensagem(tx, dados.id)
      if (!completa) throw new Error('mensagem inexistente')

      const atual = completa.variantes.find((v) => v.channel === dados.canal)
      if (!atual) throw new Error('variante inexistente')

      const decisao = editarVariante(completa.mensagem.body, atual, dados.corpo)

      await tx
        .update(messageVariants)
        .set({
          body: decisao.body,
          synced: decisao.synced,
          subject: dados.canal === 'email' ? (dados.assunto ?? null) : atual.subject,
          preheader: dados.canal === 'email' ? (dados.preheader ?? null) : atual.preheader,
          stripAccents: dados.canal === 'sms' ? dados.removerAcentos : atual.stripAccents,
          linkShorten: dados.canal === 'sms' ? dados.encurtarLinks : atual.linkShorten,
          updatedAt: new Date(),
        })
        .where(eq(messageVariants.id, atual.id))
    })
  } catch (error) {
    log.error('falha ao salvar variante', {
      canal: dados.canal,
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath(`/mensagens/${dados.id}`)
  return { ok: true }
}

/** Botão "ressincronizar" de §6.1 — sempre disponível na variante customizada. */
export async function ressincronizarAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const id = String(formData.get('id') ?? '')
  const canal = String(formData.get('canal') ?? '') as Channel
  if (!id || !CHANNELS.includes(canal)) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(messageVariants)
      .set({ ...ressincronizar(), updatedAt: new Date() })
      .where(and(eq(messageVariants.messageId, id), eq(messageVariants.channel, canal)))
  })

  revalidatePath(`/mensagens/${id}`)
}

/** Liga e desliga o canal — é o pad de §11.4 gravando no banco. */
export async function alternarCanalAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const id = String(formData.get('id') ?? '')
  const canal = String(formData.get('canal') ?? '') as Channel
  const ligar = formData.get('ligar') === '1'
  if (!id || !CHANNELS.includes(canal)) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(messageVariants)
      .set({ enabled: ligar, updatedAt: new Date() })
      .where(and(eq(messageVariants.messageId, id), eq(messageVariants.channel, canal)))
  })

  revalidatePath(`/mensagens/${id}`)
  revalidatePath('/mensagens')
}

export async function alternarMensagemAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'mensagens.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(messages)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(messages.id, id), eq(messages.orgId, user.orgId)))
  })

  revalidatePath('/mensagens')
  revalidatePath(`/mensagens/${id}`)
}
