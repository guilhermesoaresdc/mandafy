import { describe, expect, it } from 'vitest'
import type { ModeloMensagem } from './modelos'
import {
  contarSms,
  ehGsm7,
  foraDoGsm7,
  formatarCusto,
  LIMITE_GSM7_MULTIPLO,
  LIMITE_GSM7_UNICO,
  LIMITE_UCS2_UNICO,
  removerAcentos,
  removerEmoji,
  resumoContador,
  temEmoji,
} from './gsm'

describe('alfabeto GSM-7 (§6.4)', () => {
  it('aceita o básico latino', () => {
    expect(ehGsm7('Seu PIX de R$ 50,00 esta aberto')).toBe(true)
  })

  it('aceita os acentos que estão no alfabeto', () => {
    // é, è, ù, ì, ò, à, ä, ö, ñ, ü e Ç maiúsculo fazem parte do GSM-7.
    expect(ehGsm7('café à noite com Ç')).toBe(true)
  })

  it('recusa os acentos do português que NÃO estão', () => {
    // O caso que dobra a fatura de quem escreve em pt-BR sem saber.
    for (const c of ['á', 'â', 'ã', 'ê', 'í', 'ó', 'ô', 'õ', 'ú', 'ç']) {
      expect(ehGsm7(c), `${c} deveria estar fora do GSM-7`).toBe(false)
    }
  })

  it('recusa emoji', () => {
    expect(ehGsm7('bilhete 🎟️')).toBe(false)
  })

  it('aponta quais caracteres estouraram, sem repetir', () => {
    expect(foraDoGsm7('ação e coração')).toEqual(['ç', 'ã'])
  })

  it('conta a tabela de extensão como dois septetos', () => {
    // `[`, `]`, `{`, `}`, `\`, `^`, `~`, `|` e `€` custam ESC + caractere.
    expect(contarSms('[').unidades).toBe(2)
    expect(contarSms('a').unidades).toBe(1)
  })
})

describe('contagem de segmentos (§6.4)', () => {
  it('160 caracteres GSM-7 cabem em um segmento', () => {
    const contagem = contarSms('a'.repeat(LIMITE_GSM7_UNICO))
    expect(contagem.codificacao).toBe('GSM-7')
    expect(contagem.segmentos).toBe(1)
    expect(contagem.restante).toBe(0)
  })

  it('161 caracteres já custam dois segmentos', () => {
    const contagem = contarSms('a'.repeat(LIMITE_GSM7_UNICO + 1))
    expect(contagem.segmentos).toBe(2)
    // Em multipartes o cabeçalho come 7 septetos por segmento.
    expect(contagem.limite).toBe(LIMITE_GSM7_MULTIPLO * 2)
  })

  it('um único emoji derruba o limite de 160 para 70', () => {
    const texto = `${'a'.repeat(100)}🎟`
    const contagem = contarSms(texto)
    expect(contagem.codificacao).toBe('UCS-2')
    expect(contagem.segmentos).toBeGreaterThan(1)
    expect(contagem.forcaramUcs2).toContain('🎟')
  })

  it('70 caracteres UCS-2 ainda cabem em um segmento', () => {
    const contagem = contarSms(`ç${'a'.repeat(LIMITE_UCS2_UNICO - 1)}`)
    expect(contagem.codificacao).toBe('UCS-2')
    expect(contagem.segmentos).toBe(1)
  })

  it('mensagem vazia não custa segmento nenhum', () => {
    const contagem = contarSms('')
    expect(contagem.segmentos).toBe(0)
    expect(contagem.custoCentavos).toBe(0)
  })

  it('o custo acompanha o número de segmentos', () => {
    const um = contarSms('a'.repeat(10))
    const dois = contarSms('a'.repeat(200))
    expect(dois.custoCentavos).toBe(um.custoCentavos * 2)
  })

  it('monta a linha do editor que §6.4 pede', () => {
    const contagem = contarSms('a'.repeat(142))
    expect(resumoContador(contagem)).toBe('142/160 · 1 segmento · ~R$ 0,06')
  })

  it('formata o custo em reais', () => {
    expect(formatarCusto(6)).toBe('R$ 0,06')
    expect(formatarCusto(120)).toBe('R$ 1,20')
  })
})

describe('limpeza para SMS (§6.4)', () => {
  it('remove emoji e fecha o espaço que sobrou', () => {
    expect(removerEmoji('Oi 🎟️ tudo bem')).toBe('Oi tudo bem')
  })

  it('detecta emoji', () => {
    expect(temEmoji('sem nada')).toBe(false)
    expect(temEmoji('com 🎉')).toBe(true)
  })

  it('remove acentuação preservando a letra', () => {
    expect(removerAcentos('Promoção não terminou, é você!')).toBe('Promocao nao terminou, e voce!')
  })

  it('sem acento o texto volta a caber no GSM-7', () => {
    const comAcento = 'Sua inscrição na promoção está confirmada, não perca!'
    expect(contarSms(comAcento).codificacao).toBe('UCS-2')
    expect(contarSms(removerAcentos(comAcento)).codificacao).toBe('GSM-7')
  })

  it('remover acentuação corta o custo pela metade quando estoura', () => {
    const texto = 'Atenção: sua inscrição está aberta. '.repeat(3)
    const antes = contarSms(texto)
    const depois = contarSms(removerAcentos(texto))
    expect(antes.custoCentavos).toBeGreaterThan(depois.custoCentavos)
  })
})

/**
 * O teto de custo do SMS (§6.4, §8.4).
 *
 * POR QUE ISTO EXISTE
 *
 * O SMS é o único canal que se cobra por pedaço, e o 161º caractere dobra a
 * conta de uma mensagem que vai para a base inteira. O catálogo já era medido
 * por teste — mas teste não alcança quem escreve texto novo na tela, e não
 * alcança o que a VARIÁVEL faz no envio: um corpo de 140 caracteres com
 * `{{nome}}` e `{{sorteio}}` cabe folgado no editor e estoura quando
 * "WELLINGTON APARECIDO GONÇALVES" e "Federal — Extração Especial de Natal"
 * entram no lugar.
 *
 * Entre a caixa de texto e a fatura do provedor não havia nada.
 */
describe('§6.4 — o corte que segura o custo', () => {
  it('texto que já cabe passa intocado', async () => {
    const { cortarParaSegmentos } = await import('./gsm')

    // Cortar o que cabe seria pior que não cortar: mutila mensagem de graça.
    const curto = 'Oi Maria! Seu PIX de R$ 5,00 ainda nao caiu.'
    expect(cortarParaSegmentos(curto)).toEqual({ texto: curto, cortado: false })
  })

  it('texto longo volta para UM segmento', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    const longo = 'palavra '.repeat(60)
    expect(contarSms(longo).segmentos).toBeGreaterThan(1)

    const { texto, cortado } = cortarParaSegmentos(longo)
    expect(cortado).toBe(true)
    expect(contarSms(texto).segmentos).toBe(1)
  })

  it('corta na palavra, nunca no meio dela', async () => {
    const { cortarParaSegmentos } = await import('./gsm')

    const { texto } = cortarParaSegmentos(`${'palavra '.repeat(30)}FIMDAFRASE`)
    // "palav..." lido no celular parece defeito do sistema, não texto cortado.
    expect(texto).toMatch(/(^|\s)\S+\.\.\.$/)
    expect(texto).not.toMatch(/palav\.\.\.$/)
  })

  it('as reticências entram no orçamento, e não empurram para o segundo', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    // O erro fácil: cortar em 160 e concatenar "...", devolvendo 163 septetos —
    // exatamente o segundo segmento que o corte existia para evitar.
    for (const n of [40, 41, 42, 43, 44]) {
      const { texto } = cortarParaSegmentos('palavra '.repeat(n))
      expect(contarSms(texto).segmentos, `${n} palavras`).toBe(1)
    }
  })

  it('conta o custo REAL de cada caractere, não o índice da string', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    /*
     * No GSM-7 um `{` custa DOIS septetos. Cortar por `slice(0, 160)` deixaria
     * passar até 320 septetos de chaves — o dobro do orçamento, silenciosamente.
     */
    const chaves = '{'.repeat(200)
    const { texto } = cortarParaSegmentos(chaves)
    expect(contarSms(texto).segmentos).toBe(1)
  })

  it('acento derruba o limite para 70, e o corte acompanha', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    // Sem `stripAccents`, o texto é UCS-2 e cabe menos da metade. Um corte que
    // assumisse 160 devolveria três segmentos achando que devolvia um.
    const comAcento = 'atenção '.repeat(30)
    expect(contarSms(comAcento).codificacao).toBe('UCS-2')

    const { texto } = cortarParaSegmentos(comAcento)
    expect(contarSms(texto).segmentos).toBe(1)
  })

  it('sem espaço nenhum, o corte seco vale', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    // Uma URL comprida não tem onde quebrar. Devolver string vazia porque não
    // há espaço seria trocar um SMS caro por um SMS inútil.
    const url = `https://exemplo.com.br/${'a'.repeat(300)}`
    const { texto } = cortarParaSegmentos(url)

    expect(contarSms(texto).segmentos).toBe(1)
    expect(texto.length).toBeGreaterThan(20)
  })

  it('o teto é configurável, para o dia em que dois segmentos se pagarem', async () => {
    const { contarSms, cortarParaSegmentos } = await import('./gsm')

    const longo = 'palavra '.repeat(80)
    expect(contarSms(cortarParaSegmentos(longo, 2).texto).segmentos).toBe(2)
    expect(contarSms(cortarParaSegmentos(longo, 1).texto).segmentos).toBe(1)
  })

  it('texto vazio não quebra', async () => {
    const { cortarParaSegmentos } = await import('./gsm')
    expect(cortarParaSegmentos('')).toEqual({ texto: '', cortado: false })
  })
})

/**
 * O corte visto de onde ele importa: a compilação.
 *
 * Testar `cortarParaSegmentos` isolada prova a aritmética e não prova o que
 * paga a conta — que é o SMS compilado com variáveis de verdade, no caminho de
 * ENVIO, ter no máximo um segmento.
 */
describe('§6.4 — nenhum SMS compilado sai com mais de um segmento', () => {
  const GRANDE = {
    nome: 'WELLINGTON APARECIDO GONÇALVES DE OLIVEIRA JUNIOR',
    valor_cents: 1234567,
    retorno_cents: 98765432,
    saldo_cents: 1234567,
    sorteio: 'Federal — Extração Especial de Natal com Acumulado de Fim de Ano',
    palpite: 'Elefante (grupo 11) na milhar invertida 7842 com desdobramento',
    external_id: 'ap_9f2c1b44-8e0a-4d77-b1c2-5e6a7f8d9012-x7k2',
  }

  it('mesmo com todo dado no pior tamanho possível', async () => {
    const { compilar } = await import('./compile')
    const { MENSAGENS } = await import('./modelos')

    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const variante = modelo.variantes?.sms
      const r = compilar(variante?.body ?? modelo.body, {
        canal: 'sms',
        dados: GRANDE,
        semente: 5,
        previa: false,
        sms: { removerAcentuacao: variante?.stripAccents ?? false },
      })

      expect(r.ok, `${modelo.key} não compilou`).toBe(true)
      if (!r.ok || !r.sms) continue

      expect(r.sms.segmentos, `${modelo.key} custaria ${r.sms.segmentos} segmentos`).toBe(1)
    }
  })

  it('um corpo deliberadamente enorme também é contido', async () => {
    const { compilar } = await import('./compile')

    // O caso de quem escreve texto novo na tela sem olhar o contador.
    const r = compilar('Oi {{nome}}! '.repeat(40), {
      canal: 'sms',
      dados: GRANDE,
      previa: false,
      semente: 1,
    })

    expect(r.ok).toBe(true)
    if (r.ok && r.sms) expect(r.sms.segmentos).toBe(1)
  })

  it('a PRÉVIA não corta — ela precisa denunciar o excesso', async () => {
    const { compilar } = await import('./compile')

    /*
     * Se a prévia cortasse, o contador ao lado mostraria "1 segmento" para um
     * texto que não cabe, e quem está escrevendo nunca saberia que precisa
     * encurtar. A prévia mostra o problema; o envio o contém.
     */
    const r = compilar('Oi {{nome}}! '.repeat(40), {
      canal: 'sms',
      dados: GRANDE,
      previa: true,
      semente: 1,
    })

    expect(r.ok).toBe(true)
    if (r.ok && r.sms) expect(r.sms.segmentos).toBeGreaterThan(1)
  })
})
