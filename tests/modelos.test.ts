import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '@/db/schema'
import type { Tx } from '@/db'
import { buscarMensagem } from '@/db/queries/messages'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { compilar, variaveisDoCorpo } from '@/lib/messages/compile'
import { CONTATO_EXEMPLO, VARIAVEIS_DISPONIVEIS } from '@/lib/messages/exemplo'
import { contarSms, foraDoGsm7, paraGsm7, removerEmoji } from '@/lib/messages/gsm'
import { linhasDoModelo, acharModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS, type ModeloMensagem } from '@/lib/messages/modelos'
import { resumoDosModelos } from '@/lib/messages/galeria'

/**
 * Modelos de mensagem (§5.2, §6.1, §11.7).
 *
 * O QUE ESTA SUÍTE EXISTE PARA IMPEDIR
 *
 * Duas telas criam mensagem a partir do catálogo: o seed, na primeira subida, e
 * "Nova mensagem". Enquanto cada uma montava as próprias linhas, elas
 * divergiram em três pontos VISÍVEIS — a tela ligava o SMS que o seed desliga,
 * não gravava o assunto do e-mail, e nascia com tudo sincronizado, de modo que
 * a primeira edição do corpo apagava o texto escrito para aquele canal.
 *
 * Nada disso quebra o `tsc`, o lint ou o build: são valores certos em colunas
 * certas. Só um teste que grava e lê de volta os pega.
 *
 * A parte pura roda sempre. A que grava precisa dos mesmos endereços de
 * tests/rls.test.ts — e roda como `mandafy_app`, com RLS aplicado, porque é
 * exatamente lá que este projeto já viu insert virar zero linha em silêncio.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_ADMIN
const APP_URL = process.env.TEST_DATABASE_URL
const habilitado = Boolean(ADMIN_URL && APP_URL)

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
const ORG = uid('e01')
const ADMIN = uid('e02')

/**
 * O único modelo com variantes escritas à mão — e o único que liga o SMS.
 *
 * Não é coincidência: quem escreve texto próprio para um canal é justamente
 * quem tem motivo para ligá-lo. Nos demais, o SMS é decisão do PASSO do fluxo
 * (a "última chance" da cadência de PIX), não da mensagem.
 */
const COM_VARIANTES = 'bilhete_premiado'

describe('§6.1 — o catálogo de modelos', () => {
  it('todo modelo tem chave, nome e corpo', () => {
    for (const modelo of MENSAGENS) {
      expect(modelo.key, 'chave em formato de identificador').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(modelo.name.length).toBeGreaterThan(1)
      expect(modelo.body.trim().length).toBeGreaterThan(0)
    }
  })

  /*
   * O catálogo é de uma BANCA, não de uma rifa. O vocabulário errado não
   * quebra nada — só ensina: quem escreve mensagem nova copia o que vê nos
   * modelos, e "campanha" e "seus números" não existem em jogo do bicho.
   */
  it('nenhum modelo usa vocabulário de rifa', () => {
    const proibidas = /\b(campanha|rifa|bilhete|números da sorte|sorteio de prêmio)\b/i
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const texto = [modelo.body, modelo.subject ?? '', modelo.name].join(' ')
      expect(proibidas.test(texto), `vocabulário de rifa em ${modelo.key}`).toBe(false)
    }
  })

  /*
   * Toda variável usada precisa existir no contato de exemplo — senão a prévia
   * do editor mostra o nome da variável cru, e em envio real §6.3 é explícita:
   * a notificação falha com `variavel_ausente` em vez de sair pela metade.
   */
  it('todo modelo compila com os dados de exemplo, sem variável ausente', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const r = compilar(modelo.body, {
        canal: 'whatsapp',
        dados: CONTATO_EXEMPLO,
        previa: false,
        semente: 7,
      })
      expect(r.ok, `${modelo.key}: ${r.ok ? '' : `${r.motivo} ${(r.variaveis ?? []).join(',')}`}`).toBe(true)
    }
  })

  /*
   * A REGRA QUE GOVERNA O CATÁLOGO INTEIRO: nenhuma variável é obrigatória.
   *
   * §6.3 manda a notificação falhar com `variavel_ausente` quando uma variável
   * vem vazia, e está certo — o cliente não pode receber `Oi {{nome}}!`
   * literal. A consequência é que cada `{{…}}` sem padrão declarado é um ponto
   * de falha SILENCIOSA: a mensagem não sai, e nada na tela diz o porquê.
   *
   * E o catálogo é o ponto de partida de quem ACABOU de conectar a plataforma.
   * A que originou este projeto manda nome, telefone, e-mail, valor e o
   * identificador da transação — não manda sorteio, palpite, modalidade,
   * horário de fechamento nem link de pagamento. Escrito para o payload ideal,
   * o catálogo compilava na prévia (que usa `CONTATO_EXEMPLO`, onde tudo
   * existe) e falhava em produção, justamente nas mensagens que mais importam:
   * a cadência de PIX inteira, a confirmação da aposta e o aviso de prêmio.
   *
   * Por isso o caso abaixo compila com dados VAZIOS, e não com o exemplo. É a
   * única versão do teste que pega o modelo escrito amanhã.
   */
  it('todo modelo compila SEM NENHUM DADO — nenhuma variável é obrigatória', () => {
    const canais: Channel[] = [...CHANNELS]

    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      /*
       * Corpo, assunto e TODAS as variantes escritas à mão — inclusive o
       * assunto e o preheader do e-mail. Uma variável sem padrão no ASSUNTO é a
       * pior de todas: não é uma frase que sai errada, é o e-mail inteiro que
       * não sai.
       */
      const textos: [string, string][] = [
        ['corpo', modelo.body],
        ...(modelo.subject ? ([['assunto', modelo.subject]] as [string, string][]) : []),
        ...canais.flatMap((canal): [string, string][] => {
          const v = modelo.variantes?.[canal]
          if (!v) return []
          return [
            ...(v.body ? ([[`${canal}.corpo`, v.body]] as [string, string][]) : []),
            ...(v.subject ? ([[`${canal}.assunto`, v.subject]] as [string, string][]) : []),
            ...(v.preheader ? ([[`${canal}.preheader`, v.preheader]] as [string, string][]) : []),
          ]
        }),
      ]

      for (const [onde, fonte] of textos) {
        /*
         * Semente a semente: o spintax sorteia UMA alternativa por compilação,
         * e uma variável que só aparece num dos ramos passaria despercebida na
         * semente sorteada — para reaparecer no envio em que aquele ramo saísse.
         */
        for (let semente = 0; semente < 12; semente++) {
          const r = compilar(fonte, { canal: 'whatsapp', dados: {}, previa: false, semente })
          expect(
            r.ok,
            `${modelo.key} (${onde}, semente ${semente}) exige ${r.ok ? '' : (r.variaveis ?? []).join(', ')}`,
          ).toBe(true)
        }
      }
    }
  })

  /*
   * O padrão salva a mensagem; ele não pode virar o texto que sempre sai.
   *
   * `{{primeiro_nome|"tudo bem"}}` é o exemplo real: `primeiro_nome` é um
   * FILTRO, não um campo, e nada em produção o grava — o que chega do webhook é
   * `nome`. As quatro variantes de SMS da cadência de PIX estavam escritas
   * assim, então TODAS caíam no padrão: o cliente lia "Oi tudo bem!" com o nome
   * dele salvo na base ao lado. Nada falhava, nada aparecia no histórico.
   *
   * A regra que impede a volta disso: toda variável citada pelo catálogo tem de
   * existir no contato de exemplo. Se a prévia sabe preencher, é porque o campo
   * é real.
   */
  it('nenhum modelo cita variável que não existe de verdade', () => {
    const reais = new Set(VARIAVEIS_DISPONIVEIS)

    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const fontes = [
        modelo.body,
        modelo.subject ?? '',
        ...CHANNELS.flatMap((canal) => {
          const v = modelo.variantes?.[canal]
          return [v?.body ?? '', v?.subject ?? '', v?.preheader ?? '']
        }),
      ]

      for (const nome of fontes.flatMap(variaveisDoCorpo)) {
        expect(reais.has(nome), `${modelo.key} cita "${nome}", que ninguém preenche`).toBe(true)
      }
    }
  })

  /*
   * O outro lado da mesma regra: o padrão precisa produzir uma FRASE, não um
   * buraco. `Prêmio: ** **` compila, passa no caso acima e chega ao cliente.
   */
  it('sem dado nenhum, o texto sai sem buraco e sem marcador solto', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const r = compilar(modelo.body, { canal: 'whatsapp', dados: {}, previa: false, semente: 3 })
      expect(r.ok).toBe(true)
      if (!r.ok) continue

      expect(r.corpo, `espaço duplo em ${modelo.key}`).not.toMatch(/ {2}/)
      expect(r.corpo, `pontuação órfã em ${modelo.key}`).not.toMatch(/[:,]\s*[.\n]|\s+[.,!?]/)
      // `*` do WhatsApp sempre em par, e nunca em volta de nada.
      expect(r.corpo, `negrito vazio em ${modelo.key}`).not.toMatch(/\*\s*\*/)
    }
  })

  /*
   * Quem tem variante de SMS é quem de fato manda SMS — e SMS se cobra por
   * segmento. Um acento fora do GSM-7 derruba o limite de 160 para 70 e
   * TRIPLICA a conta de uma mensagem que vai para a base inteira. Já
   * aconteceu: a "última chance" saía em 3 segmentos, R$ 0,18 em vez de
   * R$ 0,06, e nada na tela dizia isso.
   */
  it('SMS escrito à mão cabe em um segmento GSM-7 (§8.4)', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const variante = modelo.variantes?.sms
      if (!variante?.body) continue

      const r = compilar(variante.body, {
        canal: 'sms',
        dados: CONTATO_EXEMPLO,
        previa: false,
        semente: 7,
        sms: { removerAcentuacao: Boolean(variante.stripAccents) },
      })

      expect(r.ok, `${modelo.key} não compilou`).toBe(true)
      if (!r.ok || !r.sms) continue

      expect(r.sms.codificacao, `${modelo.key} saiu em UCS-2`).toBe('GSM-7')
      expect(r.sms.segmentos, `${modelo.key} usou mais de um segmento`).toBe(1)
    }
  })

  it('não há chave repetida', () => {
    const chaves = MENSAGENS.map((m) => m.key)
    expect(new Set(chaves).size).toBe(chaves.length)
  })

  it('o SMS nasce desligado em todo modelo, menos onde foi pedido (§8.4)', () => {
    for (const modelo of MENSAGENS) {
      const sms = linhasDoModelo(modelo).variantes.find((v) => v.channel === 'sms')
      // O canal mais caro do sistema não se liga por omissão. Quem o liga é o
      // PASSO do fluxo que precisa dele — na cadência de PIX, só a "última
      // chance", onde o valor recuperado paga os centavos.
      expect(sms?.enabled, `SMS em ${modelo.key}`).toBe(modelo.key === COM_VARIANTES)
    }
  })

  it('o assunto do modelo vira o assunto do e-mail', () => {
    // O catálogo é `as const`: cada entrada tem o tipo exato do que escreveram
    // nela, e `subject` não existe nas que não declaram um. Ler pelo tipo comum
    // é o que permite perguntar.
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      if (!modelo.subject) continue
      const email = linhasDoModelo(modelo).variantes.find((v) => v.channel === 'email')
      expect(email?.subject, `assunto em ${modelo.key}`).toBeTruthy()
    }
  })

  it('variante escrita à mão nasce DESSINCRONIZADA; as outras, sincronizadas', () => {
    const modelo = acharModelo(MENSAGENS, COM_VARIANTES)
    expect(modelo).not.toBeNull()

    const { variantes } = linhasDoModelo(modelo!)

    for (const variante of variantes) {
      const escrita = Boolean(modelo!.variantes?.[variante.channel])

      /*
       * `synced` fica indefinido quando não há variante escrita — e é o certo:
       * a coluna tem `default true`. O que NÃO pode acontecer é o contrário,
       * um texto feito para o canal nascer sincronizado: a primeira edição do
       * corpo principal o apagaria.
       */
      expect(variante.synced ?? true, `synced de ${variante.channel}`).toBe(!escrita)
    }
  })

  it('o Telegram sai com parse_mode HTML e os outros não', () => {
    for (const modelo of MENSAGENS) {
      for (const variante of linhasDoModelo(modelo).variantes) {
        expect(variante.parseMode).toBe(variante.channel === 'telegram' ? 'HTML' : undefined)
      }
    }
  })

  it('a chave pode ser desviada pelo chamador, sem mexer no resto', () => {
    const modelo = acharModelo(MENSAGENS, 'boas_vindas')!
    const linhas = linhasDoModelo(modelo, 'boas_vindas_2')

    // A tela precisa disto: criar "Boas-vindas" duas vezes é uso legítimo.
    expect(linhas.mensagem.key).toBe('boas_vindas_2')
    expect(linhas.mensagem.body).toBe(modelo.body)
  })

  it('modelo inexistente devolve nada, em vez de estourar', () => {
    expect(acharModelo(MENSAGENS, 'nao_existe')).toBeNull()
    expect(acharModelo(MENSAGENS, '')).toBeNull()
    expect(acharModelo(MENSAGENS, undefined)).toBeNull()
  })
})

/**
 * O custo do SMS (§6.4, §8.4).
 *
 * Este bloco é o único guarda entre a caixa de texto e a fatura do provedor.
 * `tsc`, `eslint` e `next build` passam com um modelo de três segmentos, e a
 * tela não mostra o custo depois do envio — um travessão colado do Word triplica
 * a conta em silêncio, e ninguém descobre.
 *
 * Foi assim que quase todo modelo ficou saindo em 2 ou 3 segmentos.
 */
describe('§6.4 — todo modelo cabe em um segmento de SMS', () => {
  /**
   * O caso ruim, e não o bonito.
   *
   * O contato de exemplo tem nome curto e valor de dois dígitos. A realidade
   * tem "WELLINGTON APARECIDO", R$ 1.234,56 e um nome de sorteio que alguém
   * digitou à mão. Medir só pelo exemplo é medir o que não acontece.
   */
  const PESSIMISTA = {
    ...CONTATO_EXEMPLO,
    nome: 'WELLINGTON APARECIDO GONÇALVES',
    valor_cents: 123456,
    retorno_cents: 9876543,
    saldo_cents: 123456,
    external_id: 'ap_9f2c1b44-8e0a-4d77-b1c2-5e6a7f8d9012',
    // Com travessão de propósito: nome de sorteio é texto livre digitado por
    // quem opera a banca, e era ele — não o acento — que mantinha sete modelos
    // em UCS-2 mesmo com "remover acentuação" ligado.
    sorteio: 'Federal — Extração Especial de Natal',
    palpite: 'Elefante (grupo 11) na milhar 7842',
    modalidade: 'Milhar invertida',
  }

  function medir(modelo: ModeloMensagem, dados: typeof CONTATO_EXEMPLO) {
    const variante = modelo.variantes?.sms
    const compilada = compilar(variante?.body ?? modelo.body, {
      canal: 'sms',
      dados,
      semente: 1,
      sms: { removerAcentuacao: variante?.stripAccents ?? false },
    })
    expect(compilada.ok, `${modelo.key} não compila para SMS`).toBe(true)
    return compilada.ok ? compilada.sms! : null!
  }

  it('todo modelo tem versão de SMS escrita à mão', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      // Espelhar o corpo do WhatsApp no SMS é o que custava 2 a 3 segmentos:
      // o texto que cabe numa conversa não cabe em 160 caracteres.
      expect(modelo.variantes?.sms?.body, `SMS de ${modelo.key}`).toBeTruthy()
      expect(modelo.variantes?.sms?.stripAccents, `stripAccents de ${modelo.key}`).toBe(true)
    }
  })

  it('cabe em UM segmento também com nome longo, valor alto e sorteio comprido', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const sms = medir(modelo, PESSIMISTA)
      expect(sms.codificacao, `codificação de ${modelo.key}`).toBe('GSM-7')
      expect(
        sms.segmentos,
        `${modelo.key} passou de 160: ${sms.unidades} caracteres`,
      ).toBe(1)
    }
  })

  /*
   * O outro extremo, e o que passou a acontecer todo dia: NENHUM dado, com
   * todos os padrões disparando de uma vez.
   *
   * O padrão é texto que nós escrevemos, então ele conta para o segmento igual
   * ao resto — e "confira na sua conta" é mais longo do que "R$ 9,00". Um
   * padrão generoso demais dobra a conta do canal mais caro do sistema, na
   * mensagem que vai para quem a plataforma mandou menos campos.
   */
  it('cabe em UM segmento também sem dado nenhum, com os padrões no lugar', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const sms = medir(modelo, {})
      expect(sms.codificacao, `codificação de ${modelo.key} sem dados`).toBe('GSM-7')
      expect(
        sms.segmentos,
        `${modelo.key} passou de 160 só com os padrões: ${sms.unidades} caracteres`,
      ).toBe(1)
    }
  })

  it('o texto que NÓS escrevemos já nasce dentro do GSM-7', () => {
    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      // Sem os `{{…}}`: o valor de uma variável vem da plataforma da
      // organização — "Moto 0km — Edição de Julho" é nome de campanha digitado
      // por gente, e é justamente por ele que `stripAccents` precisa continuar
      // ligado. O que este caso cobra é a parte sob nosso controle.
      const escrito = (modelo.variantes?.sms?.body ?? '').replace(/\{\{[^}]*\}\}/g, '')

      /*
       * Escrever já sem acento não é redundância com a caixa marcada: é o que
       * faz desmarcá-la não estragar o texto. Uma economia que depende de um
       * clique permanecer marcado não é uma economia — é uma armadilha.
       */
      expect(
        foraDoGsm7(escrito),
        `SMS de ${modelo.key} tem caractere fora do GSM-7`,
      ).toEqual([])
    }
  })
})

describe('§6.4 — o que estoura o GSM-7 além do acento', () => {
  it('travessão, reticências e aspas curvas viram equivalentes do alfabeto', () => {
    // Nenhum deles tem decomposição canônica, então `removerAcentos` os ignora.
    // Um travessão sozinho derruba o limite de 160 para 70.
    expect(paraGsm7('Moto 0km — Edição de Julho')).toBe('Moto 0km - Edicao de Julho')
    expect(paraGsm7('espere…')).toBe('espere...')
    expect(paraGsm7('a “campanha” do ‘mês’')).toBe('a "campanha" do \'mes\'')
    expect(paraGsm7('1º lugar, 2ª via')).toBe('1o lugar, 2a via')

    expect(contarSms(paraGsm7('Moto 0km — Edição de Julho')).codificacao).toBe('GSM-7')
  })

  it('o que não tem equivalente é descartado, em vez de dobrar a conta', () => {
    // Vem do valor de uma variável, que a plataforma da organização preenche.
    // Não há troca razoável — e cair para 70 caracteres por causa dele é pior.
    expect(paraGsm7('preço 中 final')).toBe('preco final')
    expect(contarSms(paraGsm7('preço 中 final')).codificacao).toBe('GSM-7')
  })

  it('o relógio ⏰ é removido junto com os outros emoji', () => {
    // U+23F0 fica no bloco de símbolos técnicos, que o regex de emoji não
    // cobria. Ele abria a mensagem de campanha encerrando e sozinho jogava a
    // mensagem inteira para UCS-2.
    expect(removerEmoji('⏰ Ultimas horas')).not.toContain('⏰')
    expect(contarSms(removerEmoji('⏰ Ultimas horas')).codificacao).toBe('GSM-7')
  })
})

describe('§11.7 — a galeria de "nova mensagem"', () => {
  const resumos = resumoDosModelos()

  it('mostra um cartão por modelo, na mesma ordem', () => {
    expect(resumos.map((r) => r.key)).toEqual(MENSAGENS.map((m) => m.key))
  })

  it('a amostra é texto pronto, não o corpo cru', () => {
    for (const resumo of resumos) {
      expect(resumo.amostra.length).toBeGreaterThan(10)

      // Spintax resolvido e sem marcador de formatação: o cartão é vitrine.
      expect(resumo.amostra, `spintax em ${resumo.key}`).not.toMatch(/[{}|*_~]/)

      // Uma linha só — o cartão corta em duas, e quebra de linha no meio
      // desperdiçaria metade do espaço.
      expect(resumo.amostra).not.toContain('\n')
    }
  })

  it('a amostra é estável entre chamadas, apesar do spintax', () => {
    // Semente fixa a partir da chave. Sem isso a galeria mudaria de texto a
    // cada carregamento da página, o que parece defeito.
    expect(resumoDosModelos().map((r) => r.amostra)).toEqual(resumos.map((r) => r.amostra))
  })

  it('cada cartão anuncia canais, e nenhum anuncia SMS por omissão', () => {
    for (const resumo of resumos) {
      expect(resumo.canais.length).toBeGreaterThan(0)
      expect(resumo.canais.includes('sms')).toBe(resumo.key === COM_VARIANTES)
    }
  })
})

describe.skipIf(!habilitado)('§6.1 — o modelo gravado no banco', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  /** Mesma mecânica de withTenant(), sem depender das variáveis de ambiente. */
  async function comoUsuario<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${ADMIN}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return fn(tx as Tx)
    })
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Modelos', 'modelos-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'modelos-admin@teste.local', 'x', 'admin')`
  })

  afterAll(async () => {
    if (!habilitado) return
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
  })

  /** O caminho que o seed e a tela compartilham, do modelo à linha. */
  async function gravar(chaveDoModelo: string, chave?: string): Promise<string> {
    const modelo = acharModelo(MENSAGENS, chaveDoModelo)!
    const linhas = linhasDoModelo(modelo, chave)

    return comoUsuario(async (tx) => {
      const [criada] = await tx
        .insert(schema.messages)
        .values({ orgId: ORG, ...linhas.mensagem })
        .returning({ id: schema.messages.id })

      // Zero linha aqui significa RLS recusando em silêncio — o modo de falha
      // mais caro deste projeto, e o motivo de este teste rodar como app.
      expect(criada, 'insert recusado pelo RLS').toBeTruthy()

      await tx
        .insert(schema.messageVariants)
        .values(linhas.variantes.map((v) => ({ messageId: criada!.id, ...v })))

      return criada!.id
    })
  }

  it('a mensagem chega ao banco com corpo, e a tela a lê de volta', async () => {
    const id = await gravar('boas_vindas')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    expect(lida).not.toBeNull()
    expect(lida!.mensagem.key).toBe('boas_vindas')
    expect(lida!.mensagem.body.trim().length).toBeGreaterThan(0)
    expect(lida!.variantes).toHaveLength(CHANNELS.length)
  })

  it('os canais do modelo valem na tela: SMS desligado, os outros ligados', async () => {
    const id = await gravar('boas_vindas')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const ligados = lida!.variantes.filter((v) => v.enabled).map((v) => v.channel)
    expect(ligados.sort()).toEqual(['email', 'telegram', 'whatsapp'])
  })

  it('o e-mail chega com assunto — sem ele a prévia mostra o nome da mensagem', async () => {
    const id = await gravar('pix_lembrete_1')
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const email = lida!.variantes.find((v) => v.channel === 'email')
    expect(email?.subject?.trim()).toBeTruthy()
  })

  it('a variante escrita à mão chega dessincronizada e com o próprio texto', async () => {
    const id = await gravar(COM_VARIANTES)
    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))

    const sms = lida!.variantes.find((v) => v.channel === 'sms')
    expect(sms?.enabled).toBe(true)
    expect(sms?.synced).toBe(false)
    expect(sms?.body?.trim()).toBeTruthy()

    // O Telegram deste modelo leva botão, que é o que ele tem e os outros não.
    const telegram = lida!.variantes.find((v) => v.channel === 'telegram')
    expect(telegram?.parseMode).toBe('HTML')

    // Canal sem variante escrita continua espelhando o corpo principal.
    const whatsapp = lida!.variantes.find((v) => v.channel === 'whatsapp')
    expect(whatsapp?.synced).toBe(true)
    expect(whatsapp?.body).toBeNull()
  })

  it('o mesmo modelo cabe duas vezes, com chave desviada', async () => {
    await gravar('boas_vindas')
    const id = await gravar('boas_vindas', 'boas_vindas_2')

    const lida = await comoUsuario((tx) => buscarMensagem(tx, id))
    expect(lida!.mensagem.key).toBe('boas_vindas_2')
    expect(lida!.mensagem.name).toBe('Boas-vindas')
  })
})

/**
 * A ação de "Nova mensagem", com o banco de verdade por baixo.
 *
 * Os arredores dela são do Next — sessão em cookie, `revalidatePath`,
 * `redirect` — e nenhum existe sob o Vitest. Substituí-los é o preço de
 * exercitar o que interessa: o desvio de chave quando o modelo já existe, e o
 * fato de a ação gravar pela MESMA função do seed.
 */
describe.skipIf(!habilitado)('§11.7 — criar mensagem a partir de um modelo', () => {
  let admin: postgres.Sql
  let app: postgres.Sql
  let db: PostgresJsDatabase<typeof schema>

  const USUARIO = {
    id: ADMIN,
    orgId: ORG,
    name: 'Admin',
    email: 'modelos-admin@teste.local',
    role: 'admin' as const,
    isAdmin: true,
    orgName: 'Modelos',
    orgSlug: 'modelos-org',
    timezone: 'America/Sao_Paulo',
  }

  beforeAll(async () => {
    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} })
    app = postgres(APP_URL!, { max: 2, onnotice: () => {} })
    db = drizzle(app, { schema })

    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'Modelos', 'modelos-org')`
    await admin`INSERT INTO users (id, org_id, name, email, password_hash, role) VALUES
      (${ADMIN}, ${ORG}, 'Admin', 'modelos-admin@teste.local', 'x', 'admin')`

    vi.doMock('@/db', () => ({
      withTenant: <T,>(_ctx: unknown, fn: (tx: Tx) => Promise<T>): Promise<T> =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            select
              set_config('app.org_id',   ${ORG}, true),
              set_config('app.user_id',  ${ADMIN}, true),
              set_config('app.is_admin', 'true', true)
          `)
          return fn(tx as Tx)
        }),
    }))

    vi.doMock('@/lib/auth/current', () => ({
      requireAdmin: async () => USUARIO,
      tenantOf: () => ({ orgId: ORG, userId: ADMIN, isAdmin: true }),
    }))

    vi.doMock('next/cache', () => ({ revalidatePath: () => {} }))

    // `redirect` sinaliza por exceção também em produção. Aqui ela carrega o
    // destino, que é como o teste descobre o id da mensagem criada.
    vi.doMock('next/navigation', () => ({
      redirect: (destino: string) => {
        throw Object.assign(new Error('redirect'), { destino })
      },
    }))
  })

  afterAll(async () => {
    if (!habilitado) return
    vi.doUnmock('@/db')
    vi.doUnmock('@/lib/auth/current')
    vi.doUnmock('next/cache')
    vi.doUnmock('next/navigation')
    await admin`DELETE FROM organizations WHERE id = ${ORG}`
    await admin.end({ timeout: 0 })
    await app.end({ timeout: 0 })
  })

  beforeEach(async () => {
    await admin`DELETE FROM messages WHERE org_id = ${ORG}`
  })

  /** Roda a ação e devolve o id extraído do destino do redirect. */
  async function criar(campos: Record<string, string>): Promise<string> {
    const { criarMensagemAction } = await import('@/app/(app)/mensagens/actions')

    const form = new FormData()
    for (const [nome, valor] of Object.entries(campos)) form.append(nome, valor)

    try {
      const estado = await criarMensagemAction({}, form)
      throw new Error(`a ação não redirecionou: ${JSON.stringify(estado)}`)
    } catch (erro) {
      const destino = (erro as { destino?: string }).destino
      if (!destino) throw erro
      return destino.replace('/mensagens/', '')
    }
  }

  async function ler(id: string) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.org_id',   ${ORG}, true),
          set_config('app.user_id',  ${ADMIN}, true),
          set_config('app.is_admin', 'true', true)
      `)
      return buscarMensagem(tx as Tx, id)
    })
  }

  it('sem modelo, a mensagem nasce em branco — como antes', async () => {
    const id = await criar({ nome: 'Do zero', categoria: 'relacionamento' })
    const lida = await ler(id)

    expect(lida!.mensagem.key).toBe('do_zero')
    expect(lida!.mensagem.body).toBe('')
    expect(lida!.variantes).toHaveLength(CHANNELS.length)
  })

  it('com modelo, nasce idêntica à do catálogo', async () => {
    const modelo = acharModelo(MENSAGENS, COM_VARIANTES)!

    const id = await criar({
      nome: modelo.name,
      categoria: modelo.category,
      modelo: modelo.key,
    })
    const lida = await ler(id)

    // Chave do MODELO, não derivada do nome: é ela que a API pública usa
    // (§3.4) e que a documentação cita pelo nome.
    expect(lida!.mensagem.key).toBe(modelo.key)
    expect(lida!.mensagem.body).toBe(modelo.body)

    const sms = lida!.variantes.find((v) => v.channel === 'sms')
    expect(sms?.enabled, 'só este modelo liga o SMS').toBe(true)
    expect(sms?.synced, 'texto feito para o canal não pode nascer sincronizado').toBe(false)

    const email = lida!.variantes.find((v) => v.channel === 'email')
    expect(email?.subject?.trim(), 'assunto do e-mail').toBeTruthy()
  })

  it('o SMS continua desligado quando o modelo não o pede (§8.4)', async () => {
    const id = await criar({ nome: 'Boas-vindas', categoria: 'relacionamento', modelo: 'boas_vindas' })
    const lida = await ler(id)

    // A regressão que motivou tudo isto: a tela ligava os quatro canais, e a
    // mensagem saía pelo mais caro do sistema sem ninguém ter pedido.
    expect(lida!.variantes.find((v) => v.channel === 'sms')?.enabled).toBe(false)
  })

  it('o nome digitado vence o do modelo; a chave do modelo, não', async () => {
    const id = await criar({
      nome: 'Meu lembrete de PIX',
      categoria: 'recuperacao',
      modelo: 'pix_lembrete_1',
    })
    const lida = await ler(id)

    expect(lida!.mensagem.name).toBe('Meu lembrete de PIX')
    expect(lida!.mensagem.key).toBe('pix_lembrete_1')
    expect(lida!.mensagem.category).toBe('recuperacao')
  })

  it('o mesmo modelo duas vezes vira _2, sem conflito de chave', async () => {
    const primeiro = await criar({
      nome: 'Boas-vindas',
      categoria: 'relacionamento',
      modelo: 'boas_vindas',
    })
    const segundo = await criar({
      nome: 'Boas-vindas de novo',
      categoria: 'relacionamento',
      modelo: 'boas_vindas',
    })

    expect((await ler(primeiro))!.mensagem.key).toBe('boas_vindas')
    expect((await ler(segundo))!.mensagem.key).toBe('boas_vindas_2')
  })

  it('chave de modelo inventada cria em branco, sem erro na tela', async () => {
    // Vem de campo escondido: quem mexe no HTML consegue mandar qualquer
    // coisa, e o desfecho razoável é "criou vazia", não uma tela de erro.
    const id = await criar({ nome: 'Inventada', categoria: 'relacionamento', modelo: 'nao_existe' })
    const lida = await ler(id)

    expect(lida!.mensagem.key).toBe('inventada')
    expect(lida!.mensagem.body).toBe('')
  })
})
