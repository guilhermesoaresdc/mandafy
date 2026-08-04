/**
 * O catálogo de mensagens-modelo (§5.2, §6).
 *
 * Vive aqui, e não dentro do seed, porque tem DOIS consumidores: o seed, que o
 * grava na primeira subida, e a tela de nova mensagem, que o oferece como ponto
 * de partida. Enquanto ele morava no seed, a tela criava mensagem em branco e
 * as prontas ficavam invisíveis para quem estava começando — exatamente
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
    subject: 'Bem-vindo à banca',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Que bom ter você aqui|Seja bem-vindo|Bem-vindo}.

Sua conta está pronta. É só escolher o bicho, a modalidade e o valor — dá para apostar em grupo, dezena, centena ou milhar.

Boa sorte! 🍀`,
    /*
     * SMS escrito à mão, e não espelho do corpo principal.
     *
     * Um segmento GSM-7 são 160 caracteres; o 161º dobra a conta. Espelhando o
     * texto do WhatsApp, quase todo modelo saía em 2 ou 3 segmentos — o
     * canal mais caro do sistema custando o triplo, sem nada na tela acusando.
     *
     * As regras que mantêm isto em um segmento, e que valem para qualquer
     * variante de SMS escrita depois: sem emoji (força UCS-2 e derruba o limite
     * para 70), sem acento na FONTE — e não só confiando em `stripAccents`,
     * para que desmarcar a caixa não estrague o texto —, e sem spintax, porque
     * ramos de tamanhos diferentes fazem a contagem do editor deixar de valer
     * para o envio.
     *
     * Medido com dados ruins de propósito (nome de 30 letras, R$ 9.876,54,
     * nome de sorteio comprido e link de pagamento com uuid): todos continuam
     * em um segmento. `tests/modelos.test.ts` prende isso.
     */
    variantes: {
      sms: { body: `Ola {{nome|primeiro_nome|"tudo bem"}}! Sua conta esta pronta. Escolha o bicho, a modalidade e o valor. Boa sorte!`, stripAccents: true },
    },
  },

  /*
   * A CADÊNCIA DE RECUPERAÇÃO (§5.2).
   *
   * Numa banca, o prazo não é invenção de copy: cada sorteio FECHA numa hora
   * fixa, e depois dela a aposta não entra mais. É a urgência mais forte que
   * esta operação tem, e é verdadeira — por isso `{{fecha_em|hora}}` aparece
   * nos quatro lembretes, e não uma frase genérica de escassez.
   *
   * Também é o que muda o tom em relação a uma rifa: ali o cliente perde uma
   * campanha que dura semanas; aqui ele perde a extração das 18h e a próxima
   * é logo mais. Insistir demais num único sorteio queima o relacionamento
   * por um valor pequeno.
   */
  {
    key: 'pix_lembrete_1',
    name: 'Lembrete de PIX — 5 minutos',
    category: 'recuperacao',
    subject: 'Sua aposta ainda não foi confirmada',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Vi que|Notei que|Percebi que} o PIX de **{{valor_cents|moeda}}** da sua aposta ainda não caiu.

{{modalidade|"Sua aposta"}} em **{{palpite}}** no **{{sorteio}}**.
As apostas fecham às **{{fecha_em|hora}}**.

Finaliza aqui: {{link_pagamento}}`,
    variantes: {
      sms: { body: `Oi {{primeiro_nome|"tudo bem"}}! O PIX de {{valor_cents|moeda}} nao caiu. As apostas fecham as {{fecha_em|hora}}: {{link_pagamento}}`, stripAccents: true },
    },
  },
  {
    key: 'pix_lembrete_2',
    name: 'Lembrete de PIX — 25 minutos',
    category: 'recuperacao',
    subject: 'Sua aposta ainda está reservada',
    body: `{Ei|Oi de novo|Passando aqui} {{nome|primeiro_nome|"tudo bem"}}, seu palpite em **{{palpite}}** {ainda está reservado|continua guardado|segue separado}.

{Falta pouco|É rapidinho|Leva menos de um minuto}: {{valor_cents|moeda}} pelo PIX e a aposta entra no **{{sorteio}}**.

{{link_pagamento}}`,
    variantes: {
      sms: { body: `{{primeiro_nome|"Tudo bem"}}, seu palpite segue reservado. Sao {{valor_cents|moeda}} pelo PIX: {{link_pagamento}}`, stripAccents: true },
    },
  },
  {
    key: 'pix_ultima_chance',
    name: 'Lembrete de PIX — última chance',
    category: 'recuperacao',
    subject: 'As apostas fecham em instantes',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, {esta é a última chamada|essa é a reta final|é agora ou nunca}.

O **{{sorteio}}** fecha às **{{fecha_em|hora}}** e seu palpite em **{{palpite}}** {ainda não entrou|fica de fora}.

Garante aqui: {{link_pagamento}}`,

    variantes: {
      /*
       * O ÚNICO SMS da cadência de recuperação (§8.4) — e por isso o único que
       * precisa caber num segmento.
       *
       * Com o corpo comum ele saía em 3 segmentos UCS-2: R$ 0,18 em vez de
       * R$ 0,06, três vezes o custo, numa mensagem que vai para todo mundo que
       * abandonou o PIX. Um acento basta para derrubar o limite de 160 para 70,
       * e o spintax pode escolher a alternativa mais longa sem avisar.
       *
       * O NOME DO SORTEIO SAIU DAQUI, e não por economia de palavras: ele é
       * texto livre digitado pela banca. Com "Federal — Extração Especial de
       * Natal" e um link de pagamento com uuid, esta mensagem passava de 160 e
       * voltava a custar dois segmentos. O que segura a urgência é a HORA do
       * fechamento, que tem tamanho fixo; quem recebe já sabe em que sorteio
       * apostou.
       */
      sms: {
        body: `{{primeiro_nome|"Ola"}}, as apostas fecham as {{fecha_em|hora}} e a sua nao entrou. Garante agora: {{link_pagamento}}`,
        stripAccents: true,
      },
    },
  },
  {
    key: 'pix_expirou_oferta',
    name: 'PIX expirou — próximo sorteio',
    category: 'recuperacao',
    /*
     * O único da cadência que NÃO insiste no mesmo sorteio: ele já fechou.
     * Repetir "corre que dá tempo" depois do fechamento é mentira, e o
     * cliente sabe a que horas a extração saiu.
     */
    subject: 'Esse sorteio fechou — o próximo já está aberto',
    body: `{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}, o **{{sorteio}}** {fechou|já saiu} e sua aposta não chegou a entrar.

{Mas o próximo já está aberto|A próxima extração já aceita aposta}: mesmo palpite, mesmo valor, um toque.

{{link_pagamento}}`,
    variantes: {
      sms: { body: `{{primeiro_nome|"Tudo bem"}}, o sorteio fechou e sua aposta nao entrou. A proxima ja aceita: {{link_pagamento}}`, stripAccents: true },
    },
  },

  {
    key: 'pagamento_confirmado',
    name: 'Aposta confirmada',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Aposta confirmada',
    body: `Aposta confirmada, {{nome|primeiro_nome|"tudo bem"}}! ✅

**{{modalidade}}** em **{{palpite}}**
Sorteio: **{{sorteio}}**
Valor: {{valor_cents|moeda}}
{Se der, você recebe|Pagando} **{{retorno_cents|moeda}}**

Comprovante: {{external_id}}

Boa sorte! 🍀`,
    variantes: {
      sms: { body: `Aposta confirmada, {{nome|primeiro_nome|"tudo bem"}}! {{valor_cents|moeda}} no {{sorteio}}, pagando {{retorno_cents|moeda}}. Comprovante {{external_id}}.`, stripAccents: true },
    },
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
    key: 'bilhete_premiado',
    name: 'Deu no seu bicho',
    category: 'transacional',
    // Resultado de sorteio é transacional: quem apostou está esperando, e
    // segurar até as 8h da manhã seguinte esvazia a notícia (§7.4).
    ignoreQuietHours: true,
    // Prêmio pago justifica os centavos do SMS — é a exceção de §8.4.
    canais: { whatsapp: true, email: true, telegram: true, sms: true },

    body: `🐘 **Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!**

Sorteio **{{sorteio}}** · 1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite em {{palpite}} bateu. Prêmio: **{{retorno_cents|moeda}}** já creditado na sua conta.

Conferir o resultado completo: {{link_resultado}}`,

    variantes: {
      /*
       * SMS: um segmento GSM-7 são 160 caracteres, e cada segmento a mais é
       * outra cobrança em cima de uma mensagem que já vai para todo mundo que
       * ganhou. Sem spintax (o sorteio de variante pode estourar o limite sem
       * avisar), sem emoji (força UCS-2 e derruba o limite para 70), sem
       * acento — e o link encurtado pelo próprio sistema.
       *
       * O grupo e o bicho entram entre parênteses, e não em frase: com um nome
       * de sorteio comprido esta mensagem passava de 160 e custava dois
       * segmentos. O resultado continua completo — sorteio, milhar, grupo,
       * bicho e valor —, que é o que quem ganhou quer conferir.
       */
      sms: {
        body: `Deu no seu bicho! {{sorteio}}, 1o premio {{milhar}} ({{grupo}} {{bicho}}). Premio de {{retorno_cents|moeda}}: {{link_resultado}}`,
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
        preheader: '1º prêmio {{milhar}} · {{bicho}} · {{retorno_cents|moeda}} creditados',
        body: `Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!

**Sorteio {{sorteio}}**
1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite em {{palpite}} bateu. O prêmio de **{{retorno_cents|moeda}}** já está creditado na sua conta.

[Conferir o resultado completo]({{link_resultado}})`,
      },

      /*
       * Telegram: o botão é o que este canal tem e os outros não. Ele substitui
       * o link no corpo — deixar os dois faz a pessoa ler a mesma coisa duas
       * vezes e reduz o clique em vez de aumentar.
       *
       * Escrito no MESMO Markdown reduzido dos outros, não em HTML cru: o
       * renderizador é que produz as tags (§6.2), e um `<b>` digitado aqui
       * chega ao cliente como `&lt;b&gt;` escapado, à vista.
       */
      telegram: {
        body: `🐘 **Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!**

Sorteio **{{sorteio}}**
1º prêmio: **{{milhar}}**
Grupo {{grupo}} — {{bicho}}

Seu palpite em {{palpite}} bateu.
Prêmio: **{{retorno_cents|moeda}}**, já creditado.`,
        buttons: [{ text: '🐘 Ver resultado completo', url: '{{link_resultado}}' }],
      },
    },
  },

  {
    key: 'saque_processando',
    name: 'Saque em processamento',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque em processamento',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, seu saque de **{{valor_cents|moeda}}** está sendo processado.

Assim que cair na conta a gente avisa.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, seu saque de {{valor_cents|moeda}} esta em processamento. A gente avisa assim que cair na conta.`, stripAccents: true },
    },
  },
  {
    key: 'saque_concluido',
    name: 'Saque concluído',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque concluído',
    body: `💸 Saque de **{{valor_cents|moeda}}** concluído, {{nome|primeiro_nome|"tudo bem"}}.

Já deve estar na sua conta.`,
    variantes: {
      sms: { body: `Saque de {{valor_cents|moeda}} concluido, {{nome|primeiro_nome|"tudo bem"}}. Ja deve estar na sua conta.`, stripAccents: true },
    },
  },

  {
    key: 'reativacao_7d',
    name: 'Reativação — 7 dias',
    category: 'relacionamento',
    subject: 'O bicho continua dando',
    /*
     * Sem prometer resultado e sem cutucar quem parou de jogar. O gancho é o
     * que a banca tem de concreto: as extrações do dia continuam saindo, e o
     * saldo dele está lá.
     */
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Faz uns dias que|Já faz um tempo que} você não aparece.

As extrações seguem saindo todo dia, e {seu saldo está aqui|sua conta continua ativa}: **{{saldo_cents|moeda}}**.

Dá uma olhada nos resultados de hoje. 👀`,
    variantes: {
      sms: { body: `Oi {{nome|primeiro_nome|"tudo bem"}}! As extracoes seguem saindo todo dia, e seu saldo esta aqui: {{saldo_cents|moeda}}.`, stripAccents: true },
    },
  },
  {
    key: 'campanha_encerrando',
    name: 'Sorteio fechando',
    category: 'relacionamento',
    subject: 'As apostas fecham hoje às {{fecha_em|hora}}',
    body: `⏰ {{nome|primeiro_nome|"Tudo bem"}}, o **{{sorteio}}** fecha às **{{fecha_em|hora}}**.

{Ainda dá tempo|Corre que dá tempo|Última chance} de colocar seu palpite.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, o {{sorteio}} fecha as {{fecha_em|hora}}. Ainda da tempo de colocar seu palpite.`, stripAccents: true },
    },
  },
  {
    key: 'pos_compra_upsell',
    name: 'Pós-aposta — próxima extração',
    category: 'relacionamento',
    subject: 'A próxima extração já está aberta',
    /*
     * Sai três dias depois da aposta paga (§5.2), então NÃO fala do resultado
     * — ele já saiu, e quem ganhou recebeu a mensagem de prêmio. O gancho é a
     * próxima extração, não a anterior.
     */
    body: `{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}! {Já viu que|Olha que} a próxima extração está aberta.

{Quer repetir o palpite|Que tal outro bicho}? Dá para apostar em grupo, dezena, centena ou milhar.`,
    variantes: {
      sms: { body: `Oi {{nome|primeiro_nome|"tudo bem"}}! A proxima extracao ja esta aberta. Mesmo palpite, mesmo valor, um toque.`, stripAccents: true },
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

