'use server'

import { and, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant } from '@/db'
import { buscarFluxo } from '@/db/queries/flows'
import { seedFlows } from '@/db/seed-flows'
import { semearRitmos } from '@/db/seed-org'
import { flows, flowSteps, messages, messageVariants } from '@/db/schema'
import { CHANNELS } from '@/db/schema/enums'
import { chaveEmUso } from '@/db/queries/messages'
import { propagar } from '@/lib/messages/sync'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { createLogger } from '@/lib/logger'
import { montarChave, variaveisDaChave } from '@/lib/flows/cancel-key'
import { formatarHorario, lerAtraso, lerHorario } from '@/lib/flows/schedule'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'

/** Fluxos (§5). */

const log = createLogger('fluxos-ui')

export type FluxoState = { erro?: string; ok?: boolean; aviso?: string }

/** O botão do estado vazio devolve texto, não booleano: ele mostra o que criou. */
export type EstadoSemeadura = { ok?: string; erro?: string }

/**
 * Traz os nove fluxos-modelo para a organização de quem clicou (§5.2).
 *
 * Existe porque a tela vazia mandava rodar `npm run db:seed`. Quem opera este
 * sistema não abre terminal — e a instrução era, além de inútil, redundante: o
 * mesmo trabalho já era feito por um botão escondido em Configurações →
 * Sistema. Aqui ele está onde a falta é sentida.
 *
 * A ORDEM NÃO É ARBITRÁRIA. Os ritmos vêm primeiro porque `seedFlows` liga
 * cada fluxo ao seu ritmo procurando por NOME: sem "Seguro", "Instantâneo",
 * "Conservador" e "Disparo em massa" gravados antes, os nove fluxos nascem sem
 * ritmo nenhum, em silêncio, e a coluna some da tela.
 */
export async function criarFluxosModeloAction(): Promise<EstadoSemeadura> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  try {
    const feito = await withTenant(tenantOf(user), async (tx) => {
      const ritmos = await semearRitmos(tx, user.orgId)
      /*
       * `user.orgId`, nunca um id vindo de formulário: `seedFlows` recebe a
       * organização por parâmetro e não a lê do contexto. Um id divergente faria
       * as buscas de existência voltarem vazias sob o RLS, o código concluiria
       * "não existe" e só o INSERT estouraria.
       */
      const modelos = await seedFlows(tx, user.orgId)
      return { ritmos, ...modelos }
    })

    revalidatePath('/fluxos')
    revalidatePath('/mensagens')

    if (feito.fluxos === 0 && feito.mensagens === 0 && feito.ritmos === 0) {
      return { ok: 'Nada a fazer: os modelos já estavam aqui.' }
    }

    const partes = [
      feito.fluxos > 0 && `${feito.fluxos} fluxo${feito.fluxos === 1 ? '' : 's'}`,
      feito.mensagens > 0 && `${feito.mensagens} mensagem${feito.mensagens === 1 ? '' : 's'}`,
      feito.ritmos > 0 && `${feito.ritmos} ritmo${feito.ritmos === 1 ? '' : 's'} de envio`,
    ].filter((p): p is string => typeof p === 'string')

    return {
      ok: `Pronto: ${partes.join(', ')}. Todos chegam pausados — leia o texto e ligue o que quiser no ar.`,
    }
  } catch (erro) {
    log.error('falha ao trazer os fluxos-modelo', {
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { erro: 'Não foi possível trazer os modelos. Tente de novo.' }
  }
}

export async function alternarFluxoAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(flows)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(flows.id, id), eq(flows.orgId, user.orgId)))
  })

  revalidatePath('/fluxos')
  revalidatePath(`/fluxos/${id}`)
}

const configSchema = z.object({
  id: z.uuid(),
  nome: z.string().trim().min(2, 'Dê um nome ao fluxo.').max(80),
  cancelKeyTemplate: z.string().trim().max(200),
  janelaLigada: z.coerce.boolean(),
  maxPorDia: z.coerce.number().int().min(1).max(50),
})

export async function salvarFluxoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = configSchema.safeParse({
    id: formData.get('id'),
    nome: formData.get('nome'),
    cancelKeyTemplate: formData.get('cancelKeyTemplate') ?? '',
    janelaLigada: formData.get('janelaLigada') === 'on',
    maxPorDia: formData.get('maxPorDia') ?? 4,
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const dados = parsed.data

  try {
    return await withTenant(tenantOf(user), async (tx) => {
      const completo = await buscarFluxo(tx, dados.id)
      if (!completo) return { erro: 'Fluxo não encontrado.' }

      const modelo = dados.cancelKeyTemplate.trim() || null

      /*
       * Um fluxo que cancela SEM chave é o pior estado possível: ele agenda os
       * envios e nada consegue pará-los. Melhor recusar a configuração do que
       * deixar a pessoa descobrir pelo cliente que já pagou.
       */
      if (completo.fluxo.cancelOn.length > 0 && !modelo) {
        return {
          erro: 'Este fluxo cancela envios, então precisa de uma chave. Sem ela, nada segura os agendamentos.',
        }
      }

      let aviso: string | undefined
      if (modelo) {
        if (variaveisDaChave(modelo).length === 0) {
          return {
            erro: 'A chave precisa de pelo menos uma variável, como {{external_id}}. Uma chave fixa cancelaria os envios de todo mundo de uma vez.',
          }
        }

        // Testa contra o contato de exemplo: pega nome de variável errado antes
        // de o fluxo rodar em produção.
        const teste = montarChave(modelo, CONTATO_EXEMPLO)
        if (!teste.ok) {
          aviso = `A chave usa ${teste.faltando.join(', ')}, que não existe no exemplo. Confira se a plataforma manda esse campo.`
        }
      }

      await tx
        .update(flows)
        .set({
          name: dados.nome,
          cancelKeyTemplate: modelo,
          quietHoursEnabled: dados.janelaLigada,
          maxPerContactPerDay: dados.maxPorDia,
          updatedAt: new Date(),
        })
        .where(and(eq(flows.id, dados.id), eq(flows.orgId, user.orgId)))

      revalidatePath(`/fluxos/${dados.id}`)
      revalidatePath('/fluxos')
      return aviso ? { ok: true, aviso } : { ok: true }
    })
  } catch (erro) {
    log.error('falha ao salvar fluxo', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
    return { erro: 'Não foi possível salvar. Tente de novo.' }
  }
}

const passoSchema = z.object({
  stepId: z.uuid(),
  flowId: z.uuid(),
  atraso: z.string().trim().max(20),
  /** Vazio = sem hora marcada; o passo sai no instante da cascata. */
  hora: z.string().trim().max(5),
  /** Ausente = não mexer na mensagem — o formulário sempre manda, mas a API é usada por gente. */
  messageId: z.uuid().optional(),
})

export async function salvarPassoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = passoSchema.safeParse({
    stepId: formData.get('stepId'),
    flowId: formData.get('flowId'),
    atraso: formData.get('atraso') ?? '0',
    hora: formData.get('hora') ?? '',
    ...(formData.get('messageId') ? { messageId: formData.get('messageId') } : {}),
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const segundos = lerAtraso(parsed.data.atraso)
  if (segundos === null) {
    return { erro: 'Não entendi o tempo. Use algo como 5min, 2h ou 3 dias.' }
  }

  const minutos = parsed.data.hora === '' ? null : lerHorario(parsed.data.hora)
  if (parsed.data.hora !== '' && minutos === null) {
    return { erro: 'Não entendi o horário. Use algo como 10:00 ou 18:30.' }
  }

  const problema = await withTenant(tenantOf(user), async (tx) => {
    // O `where` passa pelo fluxo para o RLS valer: `flow_steps` não tem org_id.
    const [fluxo] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, parsed.data.flowId), eq(flows.orgId, user.orgId)))
      .limit(1)

    if (!fluxo) return null

    /*
     * A mensagem tem de ser DESTA organização.
     *
     * O id vem de um `<select>`, e um `<select>` é uma sugestão: qualquer um
     * consegue mandar outro valor. `flow_steps.message_id` é uma FK sem
     * `org_id` junto, então o banco aceitaria alegremente um passo apontando
     * para a mensagem de outra banca — e o RLS não pegaria, porque a escrita é
     * em `flow_steps`, cuja política olha o FLUXO, não a mensagem.
     */
    if (parsed.data.messageId) {
      const [mensagem] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, parsed.data.messageId), eq(messages.orgId, user.orgId)))
        .limit(1)

      if (!mensagem) return 'Essa mensagem não existe aqui.'
    }

    await tx
      .update(flowSteps)
      .set({
        delaySeconds: segundos,
        sendAtLocal: minutos === null ? null : formatarHorario(minutos),
        ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(flowSteps.id, parsed.data.stepId), eq(flowSteps.flowId, fluxo.id)))

    return null
  })

  if (problema) return { erro: problema }

  revalidatePath(`/fluxos/${parsed.data.flowId}`)
  return { ok: true }
}

// ── Montar a cadência pela própria tela do fluxo ─────────────────────────────

/**
 * O QUE FALTAVA AQUI
 *
 * A tela do fluxo deixava AJUSTAR um passo — tempo, hora, qual mensagem — e
 * nada além disso. Acrescentar um passo, tirar um passo ou mexer no texto que
 * vai sair eram três coisas sem caminho nenhum pela interface: a primeira e a
 * segunda só existiam no seed, e a terceira exigia sair do fluxo, achar a
 * mensagem em outra tela, editar e voltar — uma vez por passo, perdendo de
 * vista a cadência inteira, que é justamente o que se está tentando montar.
 *
 * As três ações abaixo fecham isso. Todas escrevem nas MESMAS tabelas de
 * sempre: um passo é `flow_steps`, um texto é `messages`. Não há cópia local
 * do texto no fluxo — editar aqui é editar a mensagem, e é por isso que a tela
 * avisa quando ela é usada em mais lugares.
 */

const novoPassoSchema = z.object({
  flowId: z.uuid(),
  /** Ausente = criar uma mensagem em branco para este passo. */
  messageId: z.uuid().optional(),
  atraso: z.string().trim().max(20).default('1h'),
})

export async function adicionarPassoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = novoPassoSchema.safeParse({
    flowId: formData.get('flowId'),
    ...(formData.get('messageId') ? { messageId: formData.get('messageId') } : {}),
    atraso: formData.get('atraso') ?? '1h',
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const segundos = lerAtraso(parsed.data.atraso)
  if (segundos === null) {
    return { erro: 'Não entendi o tempo. Use algo como 5min, 2h ou 3 dias.' }
  }

  const problema = await withTenant(tenantOf(user), async (tx) => {
    const [fluxo] = await tx
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .where(and(eq(flows.id, parsed.data.flowId), eq(flows.orgId, user.orgId)))
      .limit(1)

    if (!fluxo) return 'Esse fluxo não existe aqui.'

    let messageId = parsed.data.messageId

    if (messageId) {
      // Mesma conferência de `salvarPassoAction`: `flow_steps.message_id` é uma
      // FK sem org_id, e o RLS da escrita olha o FLUXO, não a mensagem.
      const [existente] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.orgId, user.orgId)))
        .limit(1)

      if (!existente) return 'Essa mensagem não existe aqui.'
    } else {
      /*
       * Sem mensagem escolhida, o passo nasce com uma em branco.
       *
       * A alternativa seria exigir que a pessoa criasse a mensagem antes, em
       * outra tela, e voltasse — que é exatamente o vaivém que esta tela existe
       * para acabar. A mensagem nasce ATIVA e vazia; a tela do fluxo já avisa
       * em vermelho que um passo com texto em branco não envia nada.
       */
      const base = `${chaveDoFluxo(fluxo.name)}_passo`
      let key = base
      for (let n = 2; await chaveEmUso(tx, user.orgId, key); n += 1) key = `${base}_${n}`

      const [criada] = await tx
        .insert(messages)
        .values({
          orgId: user.orgId,
          key,
          name: `${fluxo.name} — novo passo`,
          category: 'relacionamento',
          body: '',
        })
        .returning({ id: messages.id })

      if (!criada) return 'Não consegui criar a mensagem do passo.'

      await tx.insert(messageVariants).values(
        CHANNELS.map((channel) => ({
          messageId: criada.id,
          channel,
          parseMode: channel === 'telegram' ? ('HTML' as const) : null,
        })),
      )

      messageId = criada.id
    }

    /*
     * A posição é a última + 1. `position` é único por fluxo, então a conta
     * precisa sair do banco e não de uma contagem feita na tela — duas abas
     * abertas escolheriam o mesmo número e a segunda estouraria.
     */
    const [ultimo] = await tx
      .select({ position: flowSteps.position })
      .from(flowSteps)
      .where(eq(flowSteps.flowId, fluxo.id))
      .orderBy(desc(flowSteps.position))
      .limit(1)

    await tx.insert(flowSteps).values({
      flowId: fluxo.id,
      position: (ultimo?.position ?? 0) + 1,
      delaySeconds: segundos,
      messageId,
    })

    return null
  })

  if (problema) return { erro: problema }

  revalidatePath(`/fluxos/${parsed.data.flowId}`)
  revalidatePath('/mensagens')
  return { ok: true }
}

/**
 * Tira um passo da cadência.
 *
 * A MENSAGEM NÃO É APAGADA JUNTO, e é uma decisão.
 *
 * Ela pode estar em outro fluxo, e mesmo quando não está, o texto costuma ser
 * trabalho de alguém — apagá-lo por tabela ao remover um passo transformaria
 * "tirar este lembrete da cadência" em "perder o texto do lembrete". A mensagem
 * fica em Mensagens, e quem quiser some com ela lá, de propósito.
 *
 * O que JÁ ESTÁ NA FILA também não é cancelado: as notificações agendadas por
 * este passo continuam de pé. Cancelar é o que `cancel_on` faz quando o
 * pagamento chega (§5.1); um passo removido agora não deve apagar mensagem que
 * já foi prometida a quem está esperando.
 */
export async function removerPassoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')

  const parsed = z
    .object({ stepId: z.uuid(), flowId: z.uuid() })
    .safeParse({ stepId: formData.get('stepId'), flowId: formData.get('flowId') })

  if (!parsed.success) return { erro: 'Dados inválidos.' }

  await withTenant(tenantOf(user), async (tx) => {
    const [fluxo] = await tx
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.id, parsed.data.flowId), eq(flows.orgId, user.orgId)))
      .limit(1)

    if (!fluxo) return

    await tx
      .delete(flowSteps)
      .where(and(eq(flowSteps.id, parsed.data.stepId), eq(flowSteps.flowId, fluxo.id)))

    /*
     * As posições são renumeradas para 1, 2, 3… porque `position` tem índice
     * único e é o que ordena a cadência. Deixar buracos funcionaria hoje e
     * quebraria no primeiro passo novo que tentasse ocupar a última posição +1
     * depois de duas remoções.
     */
    const restantes = await tx
      .select({ id: flowSteps.id })
      .from(flowSteps)
      .where(eq(flowSteps.flowId, fluxo.id))
      .orderBy(flowSteps.position)

    /*
     * Em duas passadas, e o desvio é obrigatório: `UPDATE ... SET position = 1`
     * numa tabela com índice único bate no passo que ainda tem a posição 1. O
     * negativo é território que nenhuma linha ocupa, então nenhuma colisão
     * acontece no meio do caminho.
     */
    for (const [i, passo] of restantes.entries()) {
      await tx
        .update(flowSteps)
        .set({ position: -(i + 1) })
        .where(eq(flowSteps.id, passo.id))
    }
    for (const [i, passo] of restantes.entries()) {
      await tx
        .update(flowSteps)
        .set({ position: i + 1, updatedAt: new Date() })
        .where(eq(flowSteps.id, passo.id))
    }
  })

  revalidatePath(`/fluxos/${parsed.data.flowId}`)
  return { ok: true }
}

/**
 * Salva o texto da mensagem SEM sair do fluxo.
 *
 * Escreve em `messages.body` — a mesma coluna que a tela de Mensagens edita — e
 * propaga para as variantes sincronizadas pela mesma função de §6.1. Não existe
 * "texto do passo": o que a tela do fluxo mostra é a mensagem, e é por isso que
 * editar aqui aparece em Mensagens e em todo fluxo que a use.
 */
export async function salvarTextoDoPassoAction(
  _prev: FluxoState,
  formData: FormData,
): Promise<FluxoState> {
  const user = await requireAdmin()
  assertCan(user, 'fluxos.gerenciar')
  // Editar o texto que sai para o cliente é mexer na mensagem, e a permissão
  // exigida é a de mensagens — não a de fluxos.
  assertCan(user, 'mensagens.gerenciar')

  const parsed = z
    .object({
      flowId: z.uuid(),
      messageId: z.uuid(),
      corpo: z.string().max(20_000),
    })
    .safeParse({
      flowId: formData.get('flowId'),
      messageId: formData.get('messageId'),
      corpo: formData.get('corpo') ?? '',
    })

  if (!parsed.success) return { erro: 'Dados inválidos.' }

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(messages)
      .set({ body: parsed.data.corpo, updatedAt: new Date() })
      .where(and(eq(messages.id, parsed.data.messageId), eq(messages.orgId, user.orgId)))

    const variantes = await tx
      .select({
        channel: messageVariants.channel,
        synced: messageVariants.synced,
        body: messageVariants.body,
      })
      .from(messageVariants)
      .where(eq(messageVariants.messageId, parsed.data.messageId))

    // §6.1: só as sincronizadas recebem. Uma versão customizada de SMS não pode
    // ser sobrescrita por uma edição feita na tela do fluxo.
    for (const decisao of propagar(parsed.data.corpo, variantes)) {
      if (!decisao.propagou) continue
      await tx
        .update(messageVariants)
        .set({ body: null, updatedAt: new Date() })
        .where(
          and(
            eq(messageVariants.messageId, parsed.data.messageId),
            eq(messageVariants.channel, decisao.channel),
          ),
        )
    }
  })

  revalidatePath(`/fluxos/${parsed.data.flowId}`)
  revalidatePath(`/mensagens/${parsed.data.messageId}`)
  revalidatePath('/mensagens')
  return { ok: true }
}

/** `Boas-vindas` → `boas_vindas`, para servir de base à chave da mensagem nova. */
function chaveDoFluxo(nome: string): string {
  return (
    nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fluxo'
  )
}
