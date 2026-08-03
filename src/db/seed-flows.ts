/**
 * Mensagens e fluxos-modelo (§5.2, §6).
 *
 * Vêm prontos porque a primeira hora com o sistema define se ele vai ser usado.
 * "Nenhum fluxo ainda. Comece pelo modelo de recuperação de PIX — leva 2
 * minutos" (§11.7) só funciona se o modelo existir de verdade.
 *
 * Todo texto é editável depois. O que NÃO é palpite é a estrutura: os atrasos,
 * as chaves de cancelamento e quais canais cada passo usa vêm da spec.
 */

import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'
import type { Channel, MessageCategory } from './schema/enums'

type Db = PostgresJsDatabase<typeof schema>

type ModeloMensagem = {
  key: string
  name: string
  category: MessageCategory
  description?: string
  ignoreQuietHours?: boolean
  body: string
  subject?: string
  /** Sobrescreve o padrão de canais ligados (`CANAIS_PADRAO`). */
  canais?: Partial<Record<Channel, boolean>>
  /**
   * Variante escrita à mão para um canal (§6.1).
   *
   * O normal é a variante nascer sincronizada com o corpo, e é o certo para a
   * maioria: um texto, quatro canais. Mas há mensagens em que a diferença entre
   * os canais é do CONTEÚDO, não da formatação — o SMS que precisa caber em um
   * segmento, o e-mail que ganha assunto e preheader, o Telegram que leva
   * botão. Nesses casos sincronizar é perder a mensagem.
   *
   * Quem tem variante aqui nasce com `synced: false`: editar o corpo principal
   * depois NÃO pode sobrescrever um texto que foi escrito de propósito.
   */
  variantes?: Partial<
    Record<
      Channel,
      {
        body?: string
        subject?: string
        preheader?: string
        textBody?: string
        buttons?: { text: string; url?: string }[]
        stripAccents?: boolean
      }
    >
  >
}

/**
 * As mensagens dos fluxos.
 *
 * Escritas com spintax (§6.5) desde o primeiro dia: texto idêntico em massa é
 * o sinal mais fácil de spam, e o custo de aprender isso depois é um número
 * banido. Todas usam `{{nome|primeiro_nome|"tudo bem"}}` — cadastro de sorteio
 * chega em CAIXA ALTA e sem nome com frequência.
 */
const MENSAGENS: ModeloMensagem[] = [
  {
    key: 'boas_vindas',
    name: 'Boas-vindas',
    category: 'relacionamento',
    subject: 'Bem-vindo!',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Que bom ter você aqui|Seja bem-vindo|Bem-vindo}.

Agora é só escolher sua campanha e garantir seus números. Boa sorte! 🍀`,
  },
  {
    key: 'pix_lembrete_1',
    name: 'Lembrete de PIX — 5 minutos',
    category: 'recuperacao',
    subject: 'Seu PIX ainda está aberto',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Vi que|Notei que|Percebi que} seu PIX de *{{valor_cents|moeda}}* ainda não foi pago.

São {{quantidade|"seus"}} números esperando por você na campanha *{{campanha|"do sorteio"}}*. 🎟️

Finaliza aqui: {{link_pagamento}}`,
  },
  {
    key: 'pix_lembrete_2',
    name: 'Lembrete de PIX — 25 minutos',
    category: 'recuperacao',
    subject: 'Seus números ainda estão reservados',
    body: `{Ei|Oi de novo|Passando aqui} {{nome|primeiro_nome|"tudo bem"}}, seus números {ainda estão reservados|continuam guardados|seguem separados}.

{Falta pouco|É rapidinho|Leva menos de um minuto}: {{valor_cents|moeda}} pelo PIX e eles são seus.

{{link_pagamento}}`,
  },
  {
    key: 'pix_ultima_chance',
    name: 'Lembrete de PIX — última chance',
    category: 'recuperacao',
    subject: 'Última chance de garantir seus números',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, {esta é a última chamada|essa é a reta final|é agora ou nunca}.

Seus números da campanha *{{campanha|"do sorteio"}}* {saem da reserva em breve|voltam para o site em breve}.

Garante aqui: {{link_pagamento}}`,
  },
  {
    key: 'pix_expirou_oferta',
    name: 'PIX expirou — nova chance',
    category: 'recuperacao',
    subject: 'Seus números voltaram para o site',
    body: `{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}, seus números {voltaram para o site|foram liberados}.

Mas {ainda dá tempo|a campanha continua aberta}: {{campanha|"o sorteio"}} segue rolando.

{{link_pagamento}}`,
  },
  {
    key: 'pagamento_confirmado',
    name: 'Pagamento confirmado',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Pagamento confirmado',
    body: `Pagamento confirmado, {{nome|primeiro_nome|"tudo bem"}}! ✅

*{{quantidade|"Seus"}} números* garantidos na campanha *{{campanha|"do sorteio"}}*.

Valor: {{valor_cents|moeda}}
Pedido: {{external_id}}

Boa sorte! 🍀`,
  },
  {
    key: 'bilhete_premiado',
    name: 'Você foi premiado',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Você foi premiado!',
    body: `🏆 *{{nome|primeiro_nome|"Parabéns"}}, você foi premiado!*

Prêmio: *{{premio|"seu prêmio"}}*
Campanha: {{campanha|"do sorteio"}}

Nossa equipe entra em contato para combinar a entrega.`,
  },
  {
    key: 'saque_processando',
    name: 'Saque em processamento',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque em processamento',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, seu saque de *{{valor_cents|moeda}}* está sendo processado.

Assim que cair na conta a gente avisa.`,
  },
  {
    key: 'saque_concluido',
    name: 'Saque concluído',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque concluído',
    body: `💸 Saque de *{{valor_cents|moeda}}* concluído, {{nome|primeiro_nome|"tudo bem"}}.

Já deve estar na sua conta.`,
  },
  {
    key: 'reativacao_7d',
    name: 'Reativação — 7 dias',
    category: 'relacionamento',
    subject: 'Sentimos sua falta',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Faz uns dias que|Já faz um tempo que} você não aparece.

{Tem campanha nova rolando|Tem novidade por aqui|Chegou campanha nova}. Dá uma olhada. 👀`,
  },
  {
    key: 'campanha_encerrando',
    name: 'Campanha encerrando',
    category: 'relacionamento',
    subject: 'A campanha encerra amanhã',
    body: `⏰ {{nome|primeiro_nome|"Tudo bem"}}, a campanha *{{campanha|"do sorteio"}}* encerra em 24 horas.

{Ainda dá tempo|Corre que dá tempo|Última chance} de garantir seus números.`,
  },
  {
    key: 'pos_compra_upsell',
    name: 'Pós-compra — nova chance',
    category: 'relacionamento',
    subject: 'Quer aumentar suas chances?',
    body: `{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}! {Como foi|Tudo certo com} sua compra?

{Quer aumentar suas chances|Que tal mais alguns números}? {{campanha|"A campanha"}} ainda está aberta.`,
  },

  /**
   * Deu no seu bicho (§3.4, §6.1) — a mensagem-modelo dos quatro canais.
   *
   * É a mais lida da operação e a única em que o CONTEÚDO muda de canal para
   * canal, não só a formatação. Por isso as quatro variantes vêm escritas à
   * mão, e é o exemplo de referência de quando não sincronizar.
   *
   * Duas decisões de conteúdo que valem para qualquer banca:
   *
   * O resultado sai ANTES do valor, nos quatro. Quem recebe já sabe que
   * apostou; o que ele quer saber é se deu. Abrir com saudação e deixar a
   * milhar no terceiro parágrafo é escrever para si mesmo.
   *
   * `{{milhar}}` nunca leva filtro. É texto justamente para preservar zero à
   * esquerda — `0742` vira `742` no instante em que alguém o tratar como
   * número, e resultado errado em mensagem de prêmio é o erro mais caro que
   * esta caixa de texto permite cometer.
   */
  {
    key: 'bicho_resultado_premiado',
    name: 'Deu no seu bicho — resultado premiado',
    category: 'transacional',
    /*
     * NÃO vem ligada a fluxo. O gatilho natural é `ticket.awarded`, que já é
     * usado pelo fluxo "Você foi premiado" — dois fluxos no mesmo gatilho
     * mandariam duas mensagens para a mesma pessoa pelo mesmo prêmio.
     * Para usá-la, troque a mensagem daquele fluxo por esta.
     */
    description:
      'Modelo dos quatro canais, com variante escrita à mão em cada um. Para ' +
      'usar, troque a mensagem do fluxo "Você foi premiado" por esta — não ' +
      'crie um fluxo novo em ticket.awarded, ou a pessoa recebe duas vezes.',
    // Resultado de sorteio é transacional: quem apostou está esperando, e
    // segurar até as 8h da manhã seguinte esvazia a notícia (§7.4).
    ignoreQuietHours: true,
    // Resultado premiado justifica os centavos do SMS — é a exceção de §8.4.
    canais: { whatsapp: true, email: true, telegram: true, sms: true },

    body: `🐘 **Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!**

Sorteio **{{sorteio}}** · 1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite no {{modalidade|"grupo"}} bateu. Prêmio: **{{valor_cents|moeda}}** já creditado na sua conta.

Conferir o resultado completo: {{link_resultado}}`,

    variantes: {
      /*
       * SMS: um segmento GSM-7 são 160 caracteres, e cada segmento a mais é
       * outra cobrança em cima de uma mensagem que já vai para todo mundo que
       * ganhou. Sem spintax (o sorteio de variante pode estourar o limite sem
       * avisar), sem emoji (força UCS-2 e derruba o limite para 70), sem
       * acento — e o link encurtado pelo próprio sistema.
       */
      sms: {
        body: `Deu no seu bicho! {{sorteio}}, 1o premio {{milhar}} - grupo {{grupo}} {{bicho}}. Voce ganhou {{valor_cents|moeda}}. Confira: {{link_resultado}}`,
        stripAccents: true,
      },

      /*
       * E-mail: assunto sem emoji e sem CAIXA ALTA — os dois são gatilho de
       * filtro de spam, e queimar reputação numa mensagem que a pessoa QUER
       * receber é o pior lugar para fazê-lo. O preheader repete o resultado
       * porque é a segunda linha visível na caixa de entrada, e é o que decide
       * a abertura.
       */
      email: {
        subject: 'Deu no seu bicho — {{sorteio}}, grupo {{grupo}}',
        preheader: '1º prêmio {{milhar}} · {{bicho}} · {{valor_cents|moeda}} creditados',
        body: `Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!

**Sorteio {{sorteio}}**
1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite no {{modalidade|"grupo"}} bateu. O prêmio de **{{valor_cents|moeda}}** já está creditado na sua conta.

[Conferir o resultado completo]({{link_resultado}})`,
      },

      /*
       * Telegram: o botão é o que este canal tem e os outros não. Ele substitui
       * o link no corpo — deixar os dois faz a pessoa ler a mesma coisa duas
       * vezes e reduz o clique em vez de aumentar.
       */
      /*
       * Escrito no MESMO Markdown reduzido dos outros, não em HTML cru: o
       * renderizador é que produz as tags (§6.2), e um `<b>` digitado aqui
       * chega ao cliente como `&lt;b&gt;` escapado, à vista.
       */
      telegram: {
        body: `🐘 **Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!**

Sorteio **{{sorteio}}**
1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite no {{modalidade|"grupo"}} bateu.
Prêmio: **{{valor_cents|moeda}}**, já creditado.`,
        buttons: [{ text: '🐘 Ver resultado completo', url: '{{link_resultado}}' }],
      },
    },
  },
]

type ModeloPasso = {
  /** Segundos desde o passo ANTERIOR (§3.5). */
  delay: number
  message: string
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

/**
 * Canais ligados por padrão numa mensagem.
 *
 * SMS fica desligado em TODAS elas (§8.4). Quem o liga é o passo do fluxo que
 * precisa dele — na cadência de PIX, só a "última chance", onde o valor
 * recuperado paga os centavos. Deixá-lo ligado na mensagem faria o canal mais
 * caro do sistema sair em todo lugar por omissão.
 */
const CANAIS_PADRAO: Record<Channel, boolean> = {
  whatsapp: true,
  email: true,
  telegram: true,
  sms: false,
}

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

    const [criada] = await db
      .insert(schema.messages)
      .values({
        orgId,
        key: modelo.key,
        name: modelo.name,
        category: modelo.category,
        ...(modelo.description ? { description: modelo.description } : {}),
        body: modelo.body,
        ignoreQuietHours: modelo.ignoreQuietHours ?? false,
      })
      .returning({ id: schema.messages.id })

    if (!criada) continue

    await db.insert(schema.messageVariants).values(
      (Object.keys(CANAIS_PADRAO) as Channel[]).map((canal) => {
        const escrita = modelo.variantes?.[canal]

        return {
          messageId: criada.id,
          channel: canal,
          enabled: modelo.canais?.[canal] ?? CANAIS_PADRAO[canal],
          // Variante escrita à mão nasce dessincronizada: editar o corpo
          // principal depois não pode apagar um texto feito de propósito.
          ...(escrita ? { synced: false, ...escrita } : {}),
          ...(canal === 'email' && !escrita?.subject && modelo.subject
            ? { subject: modelo.subject }
            : {}),
          ...(canal === 'telegram' ? { parseMode: 'HTML' as const } : {}),
        }
      }),
    )

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
      if (!messageId) continue

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
