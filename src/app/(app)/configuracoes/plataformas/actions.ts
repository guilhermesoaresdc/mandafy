'use server'

import { and, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { eventsRaw, sources } from '@/db/schema'
import { nomeDoEvento } from '@/lib/ingest/mapping'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { mappingSchema, MAPEAMENTO_SUGERIDO } from '@/lib/ingest/mapping'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { generateIngestToken } from '@/lib/ingest/signature'
import { createLogger } from '@/lib/logger'

/**
 * Conectar plataforma (§4.2).
 *
 * Nomeia pelo que a pessoa controla, não pela implementação: "plataforma", não
 * "webhook"; "combinar campos", não "payload mapping" (§11.7).
 */

const log = createLogger('plataformas')

export type PlataformaState = { error?: string; ok?: boolean }

const criarSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome à plataforma.').max(80),
  plataforma: z.enum(['generico', 'rifei', 'custom']).default('generico'),
})

export async function criarPlataformaAction(
  _prev: PlataformaState,
  formData: FormData,
): Promise<PlataformaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = criarSchema.safeParse({
    nome: formData.get('nome'),
    plataforma: formData.get('plataforma') ?? 'generico',
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Não foi possível criar.' }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      await tx.insert(sources).values({
        orgId: user.orgId,
        name: parsed.data.nome,
        platform: parsed.data.plataforma,
        ingestToken: generateIngestToken(),
        // Começa com o mapa sugerido: a pessoa ajusta, não monta do zero.
        mapping: mappingSchema.parse(MAPEAMENTO_SUGERIDO),
      })
    })
  } catch (error) {
    log.error('falha ao criar plataforma', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível criar a plataforma. Tente de novo.' }
  }

  revalidatePath('/configuracoes/plataformas')
  return { ok: true }
}

const mapeamentoSchema = z.object({
  sourceId: z.uuid(),
  mapping: z.string().max(20_000),
})

export async function salvarMapeamentoAction(
  _prev: PlataformaState,
  formData: FormData,
): Promise<PlataformaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = mapeamentoSchema.safeParse({
    sourceId: formData.get('sourceId'),
    mapping: formData.get('mapping'),
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  let mapping: unknown
  try {
    mapping = JSON.parse(parsed.data.mapping)
  } catch {
    return { error: 'O mapeamento não é um JSON válido.' }
  }

  const validado = mappingSchema.safeParse(mapping)
  if (!validado.success) {
    const issue = validado.error.issues[0]
    return { error: `Mapeamento inválido em ${issue?.path.join('.') || 'raiz'}: ${issue?.message}` }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      await tx
        .update(sources)
        .set({ mapping: validado.data, updatedAt: new Date() })
        .where(and(eq(sources.id, parsed.data.sourceId), eq(sources.orgId, user.orgId)))
    })
  } catch (error) {
    log.error('falha ao salvar mapeamento', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath(`/configuracoes/plataformas/${parsed.data.sourceId}`)
  return { ok: true }
}

export async function alternarPlataformaAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('sourceId') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(sources)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(sources.id, id), eq(sources.orgId, user.orgId)))
  })

  revalidatePath('/configuracoes/plataformas')
}

/**
 * Último payload recebido por este conector.
 *
 * É o passo 2 de §4.2 — "clicar em Aguardando evento… e o sistema captura o
 * primeiro que chegar". Mostrar o payload de verdade é o que permite arrastar
 * campos reais em vez de digitar JSONPath de cabeça.
 */
export type UltimoEvento = {
  payload: unknown
  recebidoEm: Date
  erro: string | null
  /**
   * O que a plataforma chamou o evento — o nome DELA, não o canônico.
   *
   * Sai de onde o mapeamento o procuraria: o caminho configurado, ou a chave
   * que a rota grava quando o nome veio na URL. É a informação que faltava na
   * tela: "recebido, 13:53:08" não diz se chegou o cadastro de conta ou o
   * pagamento, e é exatamente isso que quem está testando precisa conferir.
   */
  nome: string | null
  /** `null` enquanto ainda não foi processado. */
  processadoEm: Date | null
}

/** Uma linha do histórico de recebidos. Sem o payload — ele é grande. */
export type EventoRecebido = {
  id: string
  nome: string | null
  recebidoEm: Date
  processadoEm: Date | null
  erro: string | null
}

/**
 * TUDO que chegou por este webhook, do mais recente para o mais antigo.
 *
 * A tela mostrava só o último evento, e isso basta para o passo 2 — "chegou
 * alguma coisa?". Não basta para operar: quem liga a plataforma dispara vários
 * eventos seguidos para conferir, e cada novo apaga o anterior da vista. Se o
 * cadastro funcionou e o pagamento não, a tela mostra só o pagamento e a pessoa
 * conclui que nada funciona.
 *
 * É também onde o "não aproveitado" deixa de ser um susto e vira uma lista de
 * trabalho: quais nomes de evento a plataforma manda e quais deles o mapa ainda
 * não traduz.
 */
export async function eventosRecebidos(
  sourceId: string,
  limite = 50,
): Promise<EventoRecebido[]> {
  const user = await requireAdmin()

  return withTenant(tenantOf(user), async (tx) => {
    const linhas = await tx
      .select({
        id: eventsRaw.id,
        payload: eventsRaw.payload,
        receivedAt: eventsRaw.receivedAt,
        processedAt: eventsRaw.processedAt,
        error: eventsRaw.error,
      })
      .from(eventsRaw)
      .where(eq(eventsRaw.sourceId, sourceId))
      .orderBy(desc(eventsRaw.receivedAt))
      .limit(limite)

    return linhas.map((linha) => ({
      // `bigint` chega como string do driver; a tela só a usa como chave.
      id: String(linha.id),
      nome: nomeDoEvento(linha.payload),
      recebidoEm: linha.receivedAt,
      processadoEm: linha.processedAt,
      erro: linha.error,
    }))
  })
}

export async function ultimoPayload(sourceId: string): Promise<UltimoEvento | null> {
  const user = await requireAdmin()

  return withTenant(tenantOf(user), async (tx) => {
    const [linha] = await tx
      .select({
        payload: eventsRaw.payload,
        receivedAt: eventsRaw.receivedAt,
        processedAt: eventsRaw.processedAt,
        error: eventsRaw.error,
      })
      .from(eventsRaw)
      .where(eq(eventsRaw.sourceId, sourceId))
      .orderBy(desc(eventsRaw.receivedAt))
      .limit(1)

    if (!linha) return null

    return {
      payload: linha.payload,
      recebidoEm: linha.receivedAt,
      processadoEm: linha.processedAt,
      erro: linha.error,
      nome: nomeDoEvento(linha.payload),
    }
  })
}

/**
 * Grava a tradução de um ou mais nomes de evento, sem passar pelo passo 3.
 *
 * POR QUE UM CAMINHO PRÓPRIO
 *
 * A tradução já existia no passo 3, e mesmo assim o aviso do topo mandava a
 * pessoa "acrescentar cada um lá embaixo": rolar a página, achar a seção,
 * clicar no botão, lembrar de salvar. Quatro passos para dizer "sim, é isso" a
 * uma tradução que o sistema já sabia fazer — e cada passo é uma chance de
 * parar no meio e deixar o evento morrendo em silêncio.
 *
 * Aqui a confirmação é um clique, no lugar onde o problema aparece.
 *
 * MESCLA, NUNCA SUBSTITUI. O `event_map` salvo é a autoridade sobre esta
 * plataforma: um nome que já está lá não é tocado, porque pode ter sido
 * ajustado à mão justamente por o padrão estar errado para esta banca.
 */
const traducaoSchema = z.object({
  sourceId: z.uuid(),
  /** `nome-da-plataforma=evento.canonico`, um por linha. */
  pares: z.string().max(4_000),
})

export async function traduzirEventosAction(
  _prev: PlataformaState,
  formData: FormData,
): Promise<PlataformaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = traducaoSchema.safeParse({
    sourceId: formData.get('sourceId'),
    pares: formData.get('pares') ?? '',
  })
  if (!parsed.success) return { error: 'Dados inválidos.' }

  const novas: Record<string, string> = {}
  for (const linha of parsed.data.pares.split('\n')) {
    const [nome, canonico] = linha.split('=')
    if (!nome?.trim() || !canonico?.trim()) continue

    // Só evento canônico: o valor vem de um `<select>`, e um `<select>` é uma
    // sugestão. Um destino inventado passaria a gravar um mapa que a validação
    // do motor recusaria depois, longe daqui.
    if (!(CANONICAL_EVENTS as readonly string[]).includes(canonico.trim())) continue
    novas[nome.trim()] = canonico.trim()
  }

  if (Object.keys(novas).length === 0) return { error: 'Nada para traduzir.' }

  try {
    const problema = await withTenant(tenantOf(user), async (tx) => {
      const [linha] = await tx
        .select({ mapping: sources.mapping })
        .from(sources)
        .where(and(eq(sources.id, parsed.data.sourceId), eq(sources.orgId, user.orgId)))
        .limit(1)

      if (!linha) return 'Essa plataforma não existe aqui.'

      const atual = mappingSchema.safeParse(linha.mapping ?? {})
      if (!atual.success) return 'O mapeamento gravado está inválido — abra o passo 3 e salve.'

      const mapa = {
        ...atual.data,
        // As novas primeiro: o que já estava salvo vence, e vence de propósito.
        event_map: { ...novas, ...atual.data.event_map },
      }

      await tx
        .update(sources)
        .set({ mapping: mapa, updatedAt: new Date() })
        .where(and(eq(sources.id, parsed.data.sourceId), eq(sources.orgId, user.orgId)))

      return null
    })

    if (problema) return { error: problema }
  } catch (error) {
    log.error('falha ao traduzir eventos', {
      reason: error instanceof Error ? error.message : 'desconhecido',
    })
    return { error: 'Não foi possível salvar a tradução. Tente de novo.' }
  }

  log.info('eventos traduzidos', { quantos: Object.keys(novas).length })

  revalidatePath(`/configuracoes/plataformas/${parsed.data.sourceId}`)
  revalidatePath('/painel')
  return { ok: true }
}
