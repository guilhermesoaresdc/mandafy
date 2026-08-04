/**
 * Os fluxos-modelo (§5.2, §6) e a gravação do catálogo de mensagens.
 *
 * Vêm prontos porque a primeira hora com o sistema define se ele vai ser usado.
 * "Nenhum fluxo ainda. Comece pelo modelo de recuperação de PIX — leva 2
 * minutos" (§11.7) só funciona se o modelo existir de verdade.
 *
 * Todo texto é editável depois. O que NÃO é palpite é a estrutura: os atrasos,
 * as chaves de cancelamento e quais canais cada passo usa vêm da spec.
 *
 * O TEXTO DAS MENSAGENS NÃO MORA MAIS AQUI
 *
 * Ele foi para `@/lib/messages/modelos`, que não importa nada do banco e por
 * isso pode ser lido também pela tela de nova mensagem. Enquanto morava neste
 * arquivo, as mensagens prontas só existiam para quem rodou o seed: quem criava
 * uma mensagem pela interface começava do zero, com as prontas
 * invisíveis. Aqui ficou o que é de fato do seed — quais fluxos existem e como
 * o catálogo vira linha no banco.
 */

import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { linhasDoModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS, type ChaveModelo } from '@/lib/messages/modelos'
import * as schema from './schema'
import type { Channel } from './schema/enums'

type Db = PostgresJsDatabase<typeof schema>

type ModeloPasso = {
  /** Segundos desde o passo ANTERIOR (§3.5). */
  delay: number
  /**
   * A chave de uma mensagem do catálogo — o tipo, não `string`.
   *
   * Citar uma que não existe passava a compilar sem reclamar e o passo sumia do
   * fluxo em silêncio na hora do seed: um fluxo de quatro passos nascia com
   * três, e nada dizia qual faltou. Agora é erro de compilação.
   */
  message: ChaveModelo
  /** Sem isso, valem os canais ligados na própria mensagem. */
  channels?: Channel[]
}

type ModeloFluxo = {
  name: string
  trigger: string
  cancelOn?: string[]
  cancelKey?: string
  entryConditions?: Record<string, unknown>
  jitter?: string
  steps: ModeloPasso[]
}

/** Os 9 fluxos da tabela de §5.2. */
const FLUXOS: ModeloFluxo[] = [
  {
    name: 'Boas-vindas',
    trigger: 'user.created',
    jitter: 'Seguro',
    steps: [
      { delay: 0, message: 'boas_vindas' },
      // "+2 dias (se não comprou)" — a condição olha o contador do contato.
      { delay: 2 * 86400, message: 'reativacao_7d' },
    ],
  },
  {
    name: 'Recuperação de PIX',
    trigger: 'order.created',
    cancelOn: ['order.paid', 'order.cancelled'],
    cancelKey: 'order:{{external_id}}',
    jitter: 'Seguro',
    steps: [
      // +5min → +25min → +2h → +20h, contados do gatilho.
      { delay: 5 * 60, message: 'pix_lembrete_1', channels: ['whatsapp', 'email', 'telegram'] },
      { delay: 20 * 60, message: 'pix_lembrete_2', channels: ['whatsapp', 'email', 'telegram'] },
      // O único passo com SMS: é o mais caro, e só se paga na última chance.
      { delay: 95 * 60, message: 'pix_ultima_chance', channels: ['whatsapp', 'email', 'sms', 'telegram'] },
      { delay: 18 * 3600, message: 'pix_expirou_oferta', channels: ['whatsapp', 'email', 'telegram'] },
    ],
  },
  {
    name: 'Pagamento confirmado',
    trigger: 'order.paid',
    jitter: 'Instantâneo',
    steps: [{ delay: 0, message: 'pagamento_confirmado' }],
  },
  {
    name: 'Você foi premiado',
    trigger: 'ticket.awarded',
    jitter: 'Instantâneo',
    steps: [{ delay: 0, message: 'bilhete_premiado' }],
  },
  {
    name: 'Saque em processamento',
    trigger: 'withdrawal.pending',
    jitter: 'Instantâneo',
    steps: [{ delay: 0, message: 'saque_processando' }],
  },
  {
    name: 'Saque concluído',
    trigger: 'withdrawal.completed',
    jitter: 'Instantâneo',
    steps: [{ delay: 0, message: 'saque_concluido' }],
  },
  {
    name: 'Reativação 7 dias',
    trigger: 'contact.inactive_7d',
    jitter: 'Conservador',
    steps: [{ delay: 0, message: 'reativacao_7d' }],
  },
  {
    name: 'Campanha encerrando',
    trigger: 'campaign.ending_24h',
    // Vai para a base inteira da campanha: o ritmo mais lento de todos.
    jitter: 'Disparo em massa',
    steps: [{ delay: 0, message: 'campanha_encerrando' }],
  },
  {
    name: 'Pós-compra / upsell',
    trigger: 'order.paid',
    jitter: 'Conservador',
    steps: [{ delay: 3 * 86400, message: 'pos_compra_upsell' }],
  },
]

export async function seedFlows(db: Db, orgId: string): Promise<{ mensagens: number; fluxos: number }> {
  let mensagensCriadas = 0

  const idPorChave = new Map<string, string>()

  for (const modelo of MENSAGENS) {
    const [existente] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.key, modelo.key)))
      .limit(1)

    if (existente) {
      idPorChave.set(modelo.key, existente.id)
      continue
    }

    /*
     * A tradução de modelo em linhas é a MESMA que a tela de nova mensagem usa.
     *
     * Enquanto eram duas cópias, elas divergiram em cinco pontos — três
     * visíveis: a tela ligava o SMS que o seed desliga, não gravava o assunto
     * do e-mail e nascia com tudo sincronizado. Uma mensagem criada pela
     * interface saía diferente da semeada com o mesmo nome. Aqui sobrou só o
     * que é do seed: a idempotência por chave.
     */
    const { mensagem, variantes } = linhasDoModelo(modelo)

    const [criada] = await db
      .insert(schema.messages)
      .values({ orgId, ...mensagem })
      .returning({ id: schema.messages.id })

    if (!criada) continue

    await db
      .insert(schema.messageVariants)
      .values(variantes.map((variante) => ({ messageId: criada.id, ...variante })))

    idPorChave.set(modelo.key, criada.id)
    mensagensCriadas += 1
  }

  const perfis = await db
    .select({ id: schema.jitterProfiles.id, name: schema.jitterProfiles.name })
    .from(schema.jitterProfiles)
    .where(eq(schema.jitterProfiles.orgId, orgId))

  const perfilPorNome = new Map(perfis.map((p) => [p.name, p.id]))

  let fluxosCriados = 0

  for (const modelo of FLUXOS) {
    const [existente] = await db
      .select({ id: schema.flows.id })
      .from(schema.flows)
      .where(and(eq(schema.flows.orgId, orgId), eq(schema.flows.name, modelo.name)))
      .limit(1)

    if (existente) continue

    const [criado] = await db
      .insert(schema.flows)
      .values({
        orgId,
        name: modelo.name,
        triggerEvent: modelo.trigger,
        cancelOn: modelo.cancelOn ?? [],
        cancelKeyTemplate: modelo.cancelKey ?? null,
        entryConditions: modelo.entryConditions ?? {},
        jitterProfileId: modelo.jitter ? (perfilPorNome.get(modelo.jitter) ?? null) : null,
        // Nasce PAUSADO. Um fluxo-modelo que começasse ativo mandaria mensagem
        // com texto de exemplo no primeiro evento que chegasse — e a pessoa
        // descobriria pelo cliente.
        active: false,
      })
      .returning({ id: schema.flows.id })

    if (!criado) continue

    for (const [i, passo] of modelo.steps.entries()) {
      const messageId = idPorChave.get(passo.message)

      // Alto, e não `continue`: o tipo de `passo.message` já impede a chave
      // errada, então chegar aqui sem id significa que a gravação da mensagem
      // falhou antes. Pular criaria um fluxo com um passo a menos e nenhum
      // aviso — o modo de falha mais caro que este arquivo pode ter.
      if (!messageId) {
        throw new Error(
          `seed: fluxo "${modelo.name}" cita a mensagem "${passo.message}", que não foi gravada`,
        )
      }

      await db.insert(schema.flowSteps).values({
        flowId: criado.id,
        position: i + 1,
        delaySeconds: passo.delay,
        messageId,
        channelsOverride: passo.channels ?? null,
      })
    }

    fluxosCriados += 1
  }

  return { mensagens: mensagensCriadas, fluxos: fluxosCriados }
}
