import { describe, expect, it } from 'vitest'
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
