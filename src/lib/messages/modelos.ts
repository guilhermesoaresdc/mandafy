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
 *
 * NENHUMA VARIÁVEL DO CATÁLOGO É OBRIGATÓRIA
 *
 * Essa é a regra que governa cada texto abaixo, e ela não é estilo: §6.3 manda
 * a notificação inteira falhar com `variavel_ausente` quando uma variável vem
 * vazia — nunca mandar `Oi {{nome}}!` literal para o cliente. Está certo, e faz
 * de cada `{{…}}` sem padrão um ponto único de falha silenciosa: a mensagem não
 * sai, o cliente não recebe, e nada na tela explica por quê.
 *
 * O catálogo é o PONTO DE PARTIDA de quem acabou de conectar a plataforma, e
 * plataforma nenhuma manda todos os campos que uma banca conhece. A que
 * originou este projeto manda nome, telefone, e-mail, valor e o identificador
 * da transação; sorteio, palpite, modalidade, horário de fechamento e link de
 * pagamento não existem no webhook dela. Um catálogo escrito para o payload
 * ideal é um catálogo que não envia.
 *
 * Então todo `{{…}}` daqui carrega um padrão — `{{valor_cents|moeda|"sua
 * aposta"}}` — e cada frase foi escrita para ler bem NAS DUAS pontas: com o
 * dado, e sem ele. Texto rico para quem manda dado rico; texto que sai para
 * todo mundo. `tests/modelos.test.ts` compila os doze modelos, os assuntos e
 * todas as variantes contra dados VAZIOS e exige `ok: true` — é lá que a regra
 * deixa de depender de quem escreve o próximo modelo.
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
     * Medido com dados ruins de propósito (nome de 30 letras, R$ 98.765,43 e um
     * nome de sorteio comprido com travessão): todos continuam em um segmento.
     * `tests/modelos.test.ts` prende isso.
     */
    variantes: {
      sms: { body: `Ola {{nome|primeiro_nome|"tudo bem"}}! Sua conta esta pronta. Escolha o bicho, a modalidade e o valor. Boa sorte!`, stripAccents: true },
    },
  },

  /*
   * A CADÊNCIA DE RECUPERAÇÃO (§5.2).
   *
   * O tom aqui é o que muda em relação a uma rifa: ali o cliente perde uma
   * campanha que dura semanas; aqui ele perde a extração das 18h e a próxima é
   * logo mais. Insistir demais num único sorteio queima o relacionamento por um
   * valor pequeno — por isso são quatro toques curtos, e o último já aponta
   * para a extração seguinte em vez de repetir "corre".
   *
   * OS QUATRO PEDEM SÓ NOME E VALOR, E ISSO NÃO É ECONOMIA DE COPY
   *
   * A versão anterior abria com o nome do sorteio, citava o palpite e fechava
   * com a hora do fechamento e o link de pagamento. Texto melhor — e que não
   * saía. A plataforma que originou este projeto manda, no webhook de PIX
   * gerado, o nome, o telefone e o valor. Só. Sem `sorteio`, sem `fecha_em`,
   * sem `link_pagamento`, e §6.3 é explícita: variável sem valor derruba a
   * notificação inteira com `variavel_ausente`. A cadência mais importante do
   * sistema estava escrita para um payload que ninguém manda.
   *
   * Quem TEM esses campos continua podendo usá-los: eles seguem oferecidos na
   * tela de combinar campos e no editor. O que mudou é o ponto de partida, que
   * agora funciona com o mínimo em vez de falhar em silêncio com ele.
   */
  {
    key: 'pix_lembrete_1',
    name: 'Lembrete de PIX — 5 minutos',
    category: 'recuperacao',
    subject: 'Sua aposta ainda não foi confirmada',
    body: `{Oi|Olá|E aí} {{nome|primeiro_nome|"tudo bem"}}! {Vi que|Notei que|Percebi que} o PIX de **{{valor_cents|moeda|"sua aposta"}}** ainda não caiu.

Enquanto ele não é pago, sua aposta não entra no sorteio.

{Dá tempo de finalizar|Ainda dá tempo|É rapidinho}: é só concluir o pagamento.`,
    variantes: {
      sms: { body: `Oi {{nome|primeiro_nome|"tudo bem"}}! O PIX de {{valor_cents|moeda|"sua aposta"}} nao caiu. Enquanto nao pagar, sua aposta nao entra no sorteio.`, stripAccents: true },
    },
  },
  {
    key: 'pix_lembrete_2',
    name: 'Lembrete de PIX — 25 minutos',
    category: 'recuperacao',
    subject: 'Sua aposta ainda está reservada',
    body: `{Ei|Oi de novo|Passando aqui} {{nome|primeiro_nome|"tudo bem"}}, sua aposta de **{{valor_cents|moeda|"hoje"}}** {ainda está reservada|continua guardada|segue separada}.

{Falta pouco|É rapidinho|Leva menos de um minuto}: assim que o PIX cair, ela entra no sorteio.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, sua aposta de {{valor_cents|moeda|"hoje"}} segue reservada. Assim que o PIX cair, ela entra.`, stripAccents: true },
    },
  },
  {
    key: 'pix_ultima_chance',
    name: 'Lembrete de PIX — última chance',
    category: 'recuperacao',
    subject: 'As apostas fecham em instantes',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, {esta é a última chamada|essa é a reta final|é agora ou nunca}.

O PIX de **{{valor_cents|moeda|"sua aposta"}}** {está prestes a expirar|vence em instantes} e a aposta {sai da reserva|fica de fora}.`,

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
       * Sobrou nome e valor, que é o que a plataforma manda e o que tem tamanho
       * previsível. O nome do sorteio é texto livre digitado pela banca: com
       * "Federal — Extração Especial de Natal" no meio, esta mensagem passava
       * de 160 e voltava a custar dois segmentos mesmo quando o campo existia.
       */
      sms: {
        body: `{{nome|primeiro_nome|"Ola"}}, o PIX de {{valor_cents|moeda|"sua aposta"}} esta prestes a expirar e sua aposta fica de fora.`,
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
    body: `{Oi|Olá} {{nome|primeiro_nome|"tudo bem"}}, o PIX de **{{valor_cents|moeda|"sua aposta"}}** {expirou|venceu} e a aposta não chegou a entrar.

{Mas dá para refazer num toque|Gerar outro leva um minuto}: mesmo palpite, mesmo valor, e a próxima extração já aceita.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, o PIX de {{valor_cents|moeda|"sua aposta"}} expirou e sua aposta nao entrou. Da para refazer num toque.`, stripAccents: true },
    },
  },

  {
    key: 'pagamento_confirmado',
    name: 'Aposta confirmada',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Aposta confirmada',
    /*
     * A confirmação trazia cinco campos numa tabelinha — modalidade, palpite,
     * sorteio, valor e retorno. Bonito, e falhava: o webhook de pagamento manda
     * o valor e o identificador da transação, não a ficha da aposta. Cinco
     * variáveis obrigatórias numa mensagem TRANSACIONAL significa que a
     * confirmação — a mensagem que a pessoa está esperando de olho no celular —
     * era a mais fácil de derrubar do catálogo inteiro.
     *
     * Ficou o que chega sempre. Quem tem a ficha completa acrescenta as linhas
     * no editor; as variáveis continuam todas disponíveis lá.
     */
    body: `Aposta confirmada, {{nome|primeiro_nome|"tudo bem"}}! ✅

Valor: **{{valor_cents|moeda|"confirmado"}}**
Comprovante: {{external_id|"disponível na sua conta"}}

{Agora é torcer|Boa sorte}! 🍀`,
    variantes: {
      sms: { body: `Aposta confirmada, {{nome|primeiro_nome|"tudo bem"}}! Valor {{valor_cents|moeda|"confirmado"}}. Comprovante {{external_id|"na sua conta"}}.`, stripAccents: true },
    },
  },

  /**
   * Deu no seu bicho (§3.4, §6.1) — a mensagem-modelo dos quatro canais.
   *
   * É a mais lida da operação e a única em que o CONTEÚDO muda de canal para
   * canal, não só a formatação. Por isso as quatro variantes vêm escritas à
   * mão, e é o exemplo de referência de quando não sincronizar.
   *
   * O resultado sai ANTES do valor, nos quatro. Quem recebe já sabe que
   * apostou; o que ele quer saber é se deu. Abrir com saudação e deixar o
   * resultado no terceiro parágrafo é escrever para si mesmo.
   *
   * O BLOCO DE RESULTADO SAIU DAQUI
   *
   * As quatro variantes traziam `1º prêmio {{milhar}} · grupo {{grupo}} ·
   * {{bicho}}` e um link para o resultado completo. É o texto certo para quem
   * tem esses campos — e não é o caso do webhook de bilhete premiado, que manda
   * quem ganhou e quanto. Como toda variável sem valor derruba a notificação
   * (§6.3), o efeito prático era o pior possível: a mensagem de PRÊMIO, a única
   * do catálogo que o cliente conta para os outros, era a que mais falhava.
   *
   * Se a sua plataforma manda o resultado, `milhar`, `grupo`, `bicho` e
   * `link_resultado` continuam disponíveis no editor — e `{{milhar}}` nunca
   * leva filtro, porque é texto para preservar o zero à esquerda: `0742` vira
   * `742` no instante em que alguém o tratar como número, e resultado errado em
   * mensagem de prêmio é o erro mais caro que esta caixa de texto comete.
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

{{palpite|"Seu palpite"}} bateu no {{sorteio|"sorteio de hoje"}}.

Prêmio: **{{retorno_cents|moeda|"conforme a tabela"}}** — já disponível na sua conta.`,

    variantes: {
      /*
       * SMS: um segmento GSM-7 são 160 caracteres, e cada segmento a mais é
       * outra cobrança em cima de uma mensagem que já vai para todo mundo que
       * ganhou. Sem spintax (o sorteio de variante pode estourar o limite sem
       * avisar), sem emoji (força UCS-2 e derruba o limite para 70), sem acento.
       *
       * O nome do sorteio fica de fora deste: ele é texto livre digitado pela
       * banca, e "Federal — Extração Especial de Natal" sozinho já empurrava a
       * mensagem para o segundo segmento. Quem ganhou confere o resultado no
       * app; o que o SMS precisa dizer é que deu e quanto.
       */
      sms: {
        body: `Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}! {{palpite|"Seu palpite"}} bateu. Premio: {{retorno_cents|moeda|"confira na sua conta"}}.`,
        stripAccents: true,
      },

      /*
       * E-mail: assunto sem emoji e sem CAIXA ALTA — os dois são gatilho de
       * filtro de spam, e queimar reputação numa mensagem que a pessoa QUER
       * receber é o pior lugar para fazê-lo. O preheader carrega o valor porque
       * é a segunda linha visível na caixa de entrada, e é o que decide a
       * abertura.
       */
      email: {
        subject: 'Deu no seu bicho — {{sorteio|"confira o resultado"}}',
        preheader: 'Seu palpite bateu — prêmio: {{retorno_cents|moeda|"confira na sua conta"}}',
        body: `Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!

{{palpite|"Seu palpite"}} bateu no {{sorteio|"sorteio de hoje"}}.

Prêmio: **{{retorno_cents|moeda|"conforme a tabela"}}** — já está na sua conta.`,
      },

      /*
       * Telegram: escrito no MESMO Markdown reduzido dos outros, não em HTML
       * cru. O renderizador é que produz as tags (§6.2), e um `<b>` digitado
       * aqui chega ao cliente como `&lt;b&gt;` escapado, à vista.
       *
       * Sem botão: o único link que caberia num é `{{link_resultado}}`, que
       * este webhook não manda. Botão apontando para lugar nenhum é pior do que
       * botão nenhum — quem mapeia esse campo acrescenta o botão no editor.
       */
      telegram: {
        body: `🐘 **Deu no seu bicho, {{nome|primeiro_nome|"parceiro"}}!**

{{palpite|"Seu palpite"}} bateu no {{sorteio|"sorteio de hoje"}}.

Prêmio: **{{retorno_cents|moeda|"conforme a tabela"}}**, já creditado.`,
      },
    },
  },

  {
    key: 'saque_processando',
    name: 'Saque em processamento',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque em processamento',
    body: `{{nome|primeiro_nome|"Tudo bem"}}, seu saque de **{{valor_cents|moeda|"hoje"}}** está sendo processado.

Assim que cair na conta a gente avisa.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, seu saque de {{valor_cents|moeda|"hoje"}} esta em processamento. A gente avisa assim que cair na conta.`, stripAccents: true },
    },
  },
  {
    key: 'saque_concluido',
    name: 'Saque concluído',
    category: 'transacional',
    ignoreQuietHours: true,
    subject: 'Saque concluído',
    body: `💸 Saque de **{{valor_cents|moeda|"hoje"}}** concluído, {{nome|primeiro_nome|"tudo bem"}}.

Já deve estar na sua conta.`,
    variantes: {
      sms: { body: `Saque de {{valor_cents|moeda|"hoje"}} concluido, {{nome|primeiro_nome|"tudo bem"}}. Ja deve estar na sua conta.`, stripAccents: true },
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

As extrações seguem saindo todo dia, e {sua conta continua ativa|sua conta está te esperando}.
Saldo: **{{saldo_cents|moeda|"confira ao entrar"}}**

Dá uma olhada nos resultados de hoje. 👀`,
    variantes: {
      sms: { body: `Oi {{nome|primeiro_nome|"tudo bem"}}! As extracoes seguem saindo todo dia. Saldo na sua conta: {{saldo_cents|moeda|"confira ao entrar"}}.`, stripAccents: true },
    },
  },
  {
    key: 'campanha_encerrando',
    name: 'Sorteio fechando',
    category: 'relacionamento',
    /*
     * O assunto perdeu a hora, e o corpo também.
     *
     * "As apostas fecham hoje às {{fecha_em|hora}}" é a linha de assunto mais
     * forte do catálogo — e uma variável no ASSUNTO é a pior de todas: se ela
     * vier vazia, não é uma frase que sai errada, é o e-mail inteiro que não
     * sai. `fecha_em` não vem de webhook nenhum: é um horário da grade da
     * banca, que ninguém manda por evento.
     *
     * Quem tem o horário — porque dispara este fluxo pela API pública, onde dá
     * para mandar o que quiser — põe `{{fecha_em|hora}}` de volta no editor,
     * onde a prévia mostra o resultado antes de a mensagem existir.
     */
    subject: 'O sorteio de hoje está fechando',
    body: `⏰ {{nome|primeiro_nome|"Tudo bem"}}, o **{{sorteio|"sorteio de hoje"}}** está fechando.

{Ainda dá tempo|Corre que dá tempo|Última chance} de colocar seu palpite.`,
    variantes: {
      sms: { body: `{{nome|primeiro_nome|"Tudo bem"}}, o {{sorteio|"sorteio de hoje"}} esta fechando. Ainda da tempo de colocar seu palpite.`, stripAccents: true },
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

