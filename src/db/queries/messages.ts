import { and, asc, desc, eq } from 'drizzle-orm'
import type { Tx } from '@/db'
import { messages, messageVariants } from '@/db/schema'
import { CHANNELS, type Channel, type MessageCategory } from '@/db/schema/enums'
import type { Message, MessageVariant } from '@/db/schema/messages'

/**
 * Consultas das mensagens (§3.4, §6.1).
 *
 * Ficam fora dos componentes para poderem ser executadas em teste — uma query
 * que passa no `tsc` ainda pode ser recusada pelo Postgres.
 */

export type MensagemResumo = {
  id: string
  key: string
  name: string
  category: MessageCategory
  active: boolean
  updatedAt: Date
  /** Canais ligados, na ordem canônica — alimenta a fileira de pads da lista. */
  canaisAtivos: Channel[]
  /** Quantas variantes o autor customizou; o resto segue o corpo principal. */
  customizadas: number
}

export type MensagemCompleta = { mensagem: Message; variantes: MessageVariant[] }

export async function listarMensagens(tx: Tx): Promise<MensagemResumo[]> {
  const linhas = await tx
    .select({
      id: messages.id,
      key: messages.key,
      name: messages.name,
      category: messages.category,
      active: messages.active,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .orderBy(desc(messages.updatedAt))

  if (linhas.length === 0) return []

  const variantes = await tx
    .select({
      messageId: messageVariants.messageId,
      channel: messageVariants.channel,
      enabled: messageVariants.enabled,
      synced: messageVariants.synced,
    })
    .from(messageVariants)

  const porMensagem = new Map<string, { ativos: Set<Channel>; customizadas: number }>()
  for (const variante of variantes) {
    const atual = porMensagem.get(variante.messageId) ?? { ativos: new Set<Channel>(), customizadas: 0 }
    if (variante.enabled) atual.ativos.add(variante.channel)
    if (!variante.synced) atual.customizadas += 1
    porMensagem.set(variante.messageId, atual)
  }

  return linhas.map((linha) => {
    const agregado = porMensagem.get(linha.id)
    return {
      ...linha,
      // Ordem canônica, não a que o banco devolveu: a fileira de pads tem de
      // ficar no mesmo lugar em todas as linhas da lista.
      canaisAtivos: CHANNELS.filter((c) => agregado?.ativos.has(c)),
      customizadas: agregado?.customizadas ?? 0,
    }
  })
}

export async function buscarMensagem(tx: Tx, id: string): Promise<MensagemCompleta | null> {
  const [mensagem] = await tx.select().from(messages).where(eq(messages.id, id)).limit(1)
  if (!mensagem) return null

  const variantes = await tx
    .select()
    .from(messageVariants)
    .where(eq(messageVariants.messageId, id))
    .orderBy(asc(messageVariants.channel))

  return { mensagem, variantes }
}

/** Uma variante por canal, na ordem canônica, preenchendo o que faltar. */
export function variantesPorCanal(variantes: MessageVariant[]): Record<Channel, MessageVariant | null> {
  const mapa = new Map(variantes.map((v) => [v.channel, v]))
  return Object.fromEntries(CHANNELS.map((c) => [c, mapa.get(c) ?? null])) as Record<
    Channel,
    MessageVariant | null
  >
}

export async function chaveEmUso(tx: Tx, orgId: string, key: string, exceto?: string): Promise<boolean> {
  const linhas = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.key, key)))
    .limit(2)

  return linhas.some((linha) => linha.id !== exceto)
}
