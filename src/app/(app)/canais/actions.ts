'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { channelConfigs, waInstances } from '@/db/schema'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { encryptSecret } from '@/lib/crypto'
import { createLogger } from '@/lib/logger'
import { toE164 } from '@/lib/phone'
import { CANAL_PROVEDORES } from '@/lib/channels'
import { limitesDoEstagio } from '@/lib/delivery/warmup'

/**
 * Configuração dos canais (§8, §14.1).
 *
 * As credenciais são cifradas com AES-256-GCM ANTES de tocar o banco, e nunca
 * voltam para a tela. Quem quiser trocar a chave digita a nova; não há "ver a
 * chave atual", de propósito.
 */

const log = createLogger('canais')

export type CanalState = { erro?: string; ok?: boolean }

const canalSchema = z.object({
  canal: z.enum(CHANNELS),
  provider: z.string().trim().min(1).max(40),
  // Vazio significa "não mexer": permite ligar/desligar sem redigitar a chave.
  apiKey: z.string().trim().max(500).optional(),
  remetente: z.string().trim().max(200).optional(),
  ativo: z.coerce.boolean(),
})

export async function salvarCanalAction(
  _prev: CanalState,
  formData: FormData,
): Promise<CanalState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = canalSchema.safeParse({
    canal: formData.get('canal'),
    provider: formData.get('provider'),
    apiKey: formData.get('apiKey') ?? undefined,
    remetente: formData.get('remetente') ?? undefined,
    ativo: formData.get('ativo') === 'on',
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const { canal, provider, apiKey, remetente, ativo } = parsed.data

  const permitidos = CANAL_PROVEDORES[canal]
  if (!permitidos.includes(provider)) {
    return { erro: `Provedor não suportado para ${canal}. Use: ${permitidos.join(', ')}.` }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      const [existente] = await tx
        .select({ id: channelConfigs.id, credentials: channelConfigs.credentialsEncrypted })
        .from(channelConfigs)
        .where(
          and(
            eq(channelConfigs.orgId, user.orgId),
            eq(channelConfigs.channel, canal),
            eq(channelConfigs.isDefault, true),
          ),
        )
        .limit(1)

      const novasCredenciais =
        apiKey || remetente
          ? encryptSecret(
              JSON.stringify({
                ...(apiKey ? { apiKey, botToken: apiKey } : {}),
                ...(remetente ? { remetente } : {}),
              }),
            )
          : null

      if (existente) {
        await tx
          .update(channelConfigs)
          .set({
            provider,
            active: ativo,
            // Campo em branco preserva a credencial atual.
            ...(novasCredenciais ? { credentialsEncrypted: novasCredenciais } : {}),
            updatedAt: new Date(),
          })
          .where(eq(channelConfigs.id, existente.id))
        return
      }

      await tx.insert(channelConfigs).values({
        orgId: user.orgId,
        channel: canal,
        provider,
        active: ativo,
        isDefault: true,
        credentialsEncrypted: novasCredenciais,
      })
    })
  } catch (erro) {
    // A mensagem de um erro de AES pode dizer coisas sobre a chave; só o canal
    // vai para o log.
    log.error('falha ao salvar canal', { canal })
    if (erro instanceof Error && erro.message.includes('ENCRYPTION_KEY')) {
      return { erro: 'ENCRYPTION_KEY não está configurada no ambiente.' }
    }
    return { erro: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath('/canais')
  return { ok: true }
}

const instanciaSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome ao número.').max(80),
  evolutionUrl: z.url('O endereço da Evolution precisa ser uma URL.'),
  instanceName: z.string().trim().min(1, 'Informe o nome da instância.').max(80),
  apikey: z.string().trim().min(1, 'Informe a apikey da instância.').max(500),
  telefone: z.string().trim().max(30).optional(),
})

export async function conectarNumeroAction(
  _prev: CanalState,
  formData: FormData,
): Promise<CanalState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = instanciaSchema.safeParse({
    nome: formData.get('nome'),
    evolutionUrl: formData.get('evolutionUrl'),
    instanceName: formData.get('instanceName'),
    apikey: formData.get('apikey'),
    telefone: formData.get('telefone') ?? undefined,
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const dados = parsed.data

  try {
    await withTenant(tenantOf(user), async (tx) => {
      // Todo número novo começa no estágio 0 da escada (§7.3): 20/dia, 60s de
      // intervalo. Não há atalho — pular o aquecimento é o caminho do ban.
      const limites = limitesDoEstagio(0)

      await tx.insert(waInstances).values({
        orgId: user.orgId,
        name: dados.nome,
        evolutionUrl: dados.evolutionUrl,
        instanceName: dados.instanceName,
        apikeyEncrypted: encryptSecret(JSON.stringify({ apikey: dados.apikey })),
        phoneE164: dados.telefone ? toE164(dados.telefone) : null,
        status: 'conectando',
        warmupStage: 0,
        warmupStartedAt: new Date(),
        ...limites,
      })
    })
  } catch (erro) {
    log.error('falha ao conectar número', {
      reason: erro instanceof Error && erro.message.includes('unique') ? 'nome_repetido' : 'desconhecido',
    })
    if (erro instanceof Error && erro.message.includes('wa_instances_org_name_uq')) {
      return { erro: 'Já existe um número com esse nome de instância.' }
    }
    return { erro: 'Não foi possível conectar o número. Confira os dados da Evolution.' }
  }

  revalidatePath('/canais')
  return { ok: true }
}

export async function alternarNumeroAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(waInstances)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(waInstances.id, id), eq(waInstances.orgId, user.orgId)))
  })

  revalidatePath('/canais')
}

export async function alternarCanalConfigAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const canal = String(formData.get('canal') ?? '') as Channel
  const ativar = formData.get('ativar') === '1'
  if (!CHANNELS.includes(canal)) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(channelConfigs)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(channelConfigs.orgId, user.orgId), eq(channelConfigs.channel, canal)))
  })

  revalidatePath('/canais')
}
