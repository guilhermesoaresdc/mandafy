/**
 * O catálogo de mensagens-modelo (§5.2, §6).
 *
 * Vive aqui, e não dentro do seed, porque tem DOIS consumidores: o seed, que o
 * grava na primeira subida, e a tela de nova mensagem, que o oferece como ponto
 * de partida. Enquanto ele morava no seed, a tela criava mensagem em branco e
 * as treze prontas ficavam invisíveis para quem estava começando — exatamente
 * quando mais ajudariam.
 *
 * PURO DE PROPÓSITO
 *
 * Só tipos e dados. O único import é `import type` de `@/db/schema/enums`, que
 * por sua vez não importa nada — são arrays `as const`. É isso que permite a um
 * componente de cliente exibir a galeria sem arrastar o driver do Postgres para
 * o navegador. Importar de `@/db/schema` (o barril) quebraria: ele reexporta as
 * tabelas do `pg-core`.
 *
 * Todo texto é editável depois de criado. O que NÃO é palpite é a estrutura:
 * os canais ligados, as chaves e a categoria vêm da spec.
 */

import type { Channel, MessageCategory } from '@/db/schema/enums'

export type ModeloMensagem = {
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
        /*
         * `readonly` porque o catálogo abaixo é declarado `as const` — sem isto,
         * nenhum modelo com botão passaria na verificação. Quem grava no banco
         * copia o array (ver `linhasDoModelo`): a fronteira entre "dado do
         * catálogo", que é imutável, e "linha de tabela", que não é, fica ali.
         */
        buttons?: readonly { text: string; url?: string }[]
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
 *
 * `as const satisfies` em vez de `: ModeloMensagem[]`: o `satisfies` verifica
 * cada entrada contra o tipo, e o `as const` preserva as chaves como literais.
 * É o que dá origem a `ChaveModelo` — e é por causa dele que um passo de fluxo
 * citando mensagem que não existe vira erro de compilação, e não um passo que
 * some do fluxo em silêncio.
 */
export const MENSAGENS = [
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
] as const satisfies readonly ModeloMensagem[]

/**
 * As chaves do catálogo, como união de literais.
 *
 * Quem cita um modelo pelo nome — o passo de um fluxo-modelo, a tela de nova
 * mensagem — usa este tipo. Errar a chave passa a ser erro de compilação.
 */
export type ChaveModelo = (typeof MENSAGENS)[number]['key']

/**
 * Canais ligados por padrão numa mensagem.
 *
 * SMS fica desligado em TODAS elas (§8.4). Quem o liga é o passo do fluxo que
 * precisa dele — na cadência de PIX, só a "última chance", onde o valor
 * recuperado paga os centavos. Deixá-lo ligado na mensagem faria o canal mais
 * caro do sistema sair em todo lugar por omissão.
 */
export const CANAIS_PADRAO: Record<Channel, boolean> = {
  whatsapp: true,
  email: true,
  telegram: true,
  sms: false,
}

