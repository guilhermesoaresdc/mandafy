import { describe, expect, it } from 'vitest'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import {
  CAMPOS,
  EVENTOS,
  camposDoEvento,
  descreverEvento,
  nomeDoCampo,
  resumoDoEvento,
  valorDoCampo,
} from './vocabulario'

/**
 * O vocabulário da interface (§11.7).
 *
 * O que estes testes seguram é uma regressão de tradução: o dia em que um
 * evento novo entra em `CANONICAL_EVENTS` e ninguém lhe dá nome, a linha do
 * tempo volta a mostrar `withdrawal.pending` para quem opera a banca. O
 * compilador não pega isso sozinho porque `descreverEvento` aceita string.
 */

describe('vocabulário — campos', () => {
  it('todo campo do contato de exemplo tem nome em português', () => {
    /*
     * O contato de exemplo é o que o editor de mensagem oferece: se um campo
     * está lá e não está aqui, ele aparece no seletor de variáveis como
     * identificador cru, que é exatamente o que este módulo existe para acabar.
     */
    const semNome = Object.keys(CONTATO_EXEMPLO).filter((chave) => !CAMPOS[chave])
    expect(semNome, 'campos sem tradução').toEqual([])
  })

  it('campo desconhecido ganha rótulo legível em vez de sumir', () => {
    // A plataforma manda o que quiser. Esconder o que não está no catálogo
    // seria esconder dado que a banca precisa ver.
    expect(nomeDoCampo('cupom_usado')).toBe('Cupom usado')
    expect(nomeDoCampo('taxa_cents')).toBe('Taxa')
  })

  it('centavos viram reais, mesmo em campo que ninguém previu', () => {
    // A convenção de §4.1 é o sufixo `_cents`. Sem esta regra, um campo novo
    // apareceria como "50000" — que se lê como cinquenta mil e são quinhentos.
    expect(valorDoCampo('valor_cents', 500)).toBe('R$ 5,00')
    expect(valorDoCampo('taxa_cents', 250)).toBe('R$ 2,50')
  })

  it('vazio é traço, e não "null" na tela', () => {
    expect(valorDoCampo('palpite', null)).toBe('—')
    expect(valorDoCampo('palpite', '')).toBe('—')
    expect(valorDoCampo('palpite', undefined)).toBe('—')
  })
})

describe('vocabulário — eventos', () => {
  it('todo evento canônico tem nome e explicação', () => {
    for (const evento of CANONICAL_EVENTS) {
      const descrito = EVENTOS[evento]
      expect(descrito, `${evento} sem tradução`).toBeTruthy()
      // Nome curto e frase de apoio: o primeiro vai na linha do tempo, a
      // segunda no detalhe e no `title`.
      expect(descrito.nome.length).toBeGreaterThan(3)
      expect(descrito.ajuda.length).toBeGreaterThan(15)
    }
  })

  it('nenhum nome de evento é o próprio código', () => {
    for (const evento of CANONICAL_EVENTS) {
      expect(EVENTOS[evento].nome).not.toContain('.')
    }
  })

  it('evento fora do catálogo não quebra a tela', () => {
    const desconhecido = descreverEvento('order.refunded')
    expect(desconhecido.nome).toBe('order refunded')
    expect(desconhecido.tom).toBe('neutro')
  })
})

describe('vocabulário — detalhe do evento', () => {
  const pagamento = {
    valor_cents: 500,
    modalidade: 'Grupo',
    palpite: 'Elefante (grupo 11)',
    link_pagamento: 'https://exemplo.test/pagar',
    external_id: 'AP-48213',
  }

  it('o dinheiro vem primeiro, o link por último', () => {
    const campos = camposDoEvento(pagamento).map((c) => c.chave)
    expect(campos[0]).toBe('valor_cents')
    expect(campos[campos.length - 1]).toBe('link_pagamento')
  })

  it('cada campo sai com rótulo e valor formatado', () => {
    const campos = camposDoEvento(pagamento)
    expect(campos[0]).toMatchObject({ rotulo: 'Valor da aposta', valor: 'R$ 5,00' })
  })

  it('o resumo cabe numa linha e deixa link e id de fora', () => {
    // Três campos no máximo: o resumo mora na linha do tempo, ao lado da hora,
    // e um resumo que não cabe é um resumo cortado no meio de uma palavra.
    const resumo = resumoDoEvento(pagamento)
    expect(resumo).toBe('R$ 5,00 · Grupo · Elefante (grupo 11)')
    expect(resumo).not.toContain('http')
    expect(resumo).not.toContain('AP-48213')
  })

  it('evento sem detalhe nenhum devolve vazio, e não um separador solto', () => {
    expect(resumoDoEvento({})).toBe('')
    expect(resumoDoEvento(null)).toBe('')
    expect(camposDoEvento('não é objeto')).toEqual([])
  })

  it('campo nulo não vira linha no detalhe', () => {
    const campos = camposDoEvento({ valor_cents: 100, palpite: null, sorteio: '' })
    expect(campos.map((c) => c.chave)).toEqual(['valor_cents'])
  })
})
