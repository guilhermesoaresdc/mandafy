import { describe, expect, it } from 'vitest'
import { contarSms } from './gsm'
import { parseMensagem } from './parse'
import {
  formatarData,
  formatarHora,
  formatarMoeda,
  primeiroNome,
  resolverVariavel,
  valorPorNome,
  type DadosVariaveis,
} from './variables'
import type { No } from './ast'

/** Atalho: escreve `{{…}}` e devolve o nó de variável correspondente. */
function variavel(fonte: string): Extract<No, { tipo: 'variavel' }> {
  const { blocos } = parseMensagem(fonte)
  const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
  const no = filhos[0]
  if (no?.tipo !== 'variavel') throw new Error(`esperava variável em ${fonte}`)
  return no
}

function resolver(fonte: string, dados: DadosVariaveis): string | null {
  return resolverVariavel(variavel(fonte), dados)
}

describe('valorPorNome', () => {
  it('lê propriedade simples', () => {
    expect(valorPorNome({ nome: 'Ana' }, 'nome')).toBe('Ana')
  })

  it('lê caminho pontuado', () => {
    expect(valorPorNome({ pedido: { valor: 5000 } }, 'pedido.valor')).toBe(5000)
  })

  it('não alcança o protótipo', () => {
    // `{{constructor.name}}` num corpo de mensagem não pode virar "Object".
    expect(valorPorNome({}, 'constructor.name')).toBeUndefined()
    expect(valorPorNome({}, '__proto__.polluted')).toBeUndefined()
    expect(valorPorNome({}, 'toString')).toBeUndefined()
  })

  it('devolve indefinido no meio do caminho', () => {
    expect(valorPorNome({ a: 1 }, 'a.b.c')).toBeUndefined()
  })
})

describe('filtros (§6.3)', () => {
  it('moeda converte centavos em reais', () => {
    expect(formatarMoeda(5000)).toBe('R$ 50,00')
    expect(formatarMoeda(123456)).toBe('R$ 1.234,56')
    expect(formatarMoeda(6)).toBe('R$ 0,06')
  })

  it('moeda não usa espaço não separável — ele estouraria o SMS', () => {
    const formatado = formatarMoeda(5000)!
    expect(formatado).not.toContain(' ')
    expect(contarSms(formatado).codificacao).toBe('GSM-7')
  })

  it('moeda recusa o que não é número', () => {
    expect(formatarMoeda('abc')).toBeNull()
    expect(formatarMoeda(null)).toBeNull()
  })

  it('data usa o fuso de Brasília, não UTC', () => {
    // 02:00 UTC do dia 1º ainda é dia 31 no Brasil (UTC-3).
    expect(formatarData('2026-08-01T02:00:00Z')).toBe('31/07/2026')
  })

  it('hora também sai em horário de Brasília', () => {
    expect(formatarHora('2026-08-01T02:00:00Z')).toBe('23:00')
  })

  it('data aceita timestamp em segundos e em milissegundos', () => {
    expect(formatarData(1767225600)).toBe(formatarData(1767225600000))
  })

  it('data recusa string que não é data', () => {
    expect(formatarData('nem data')).toBeNull()
  })

  it('primeiro_nome arruma a caixa do cadastro', () => {
    expect(primeiroNome('MARIA DA SILVA')).toBe('Maria')
    expect(primeiroNome('joão pedro')).toBe('João')
    expect(primeiroNome('  Ana  ')).toBe('Ana')
  })

  it('maiusculo respeita acento do português', () => {
    expect(resolver('{{nome|maiusculo}}', { nome: 'joão' })).toBe('JOÃO')
  })

  it('telefone sai legível', () => {
    expect(resolver('{{fone|telefone}}', { fone: '+5511988887777' })).toBe('(11) 98888-7777')
  })
})

describe('resolução e fallback (§6.3)', () => {
  it('devolve null quando falta valor e não há padrão', () => {
    // A regra dura: nunca mandar `Oi {{nome}}!` literal para o cliente.
    expect(resolver('{{nome}}', {})).toBeNull()
  })

  it('string vazia conta como ausente', () => {
    expect(resolver('{{nome}}', { nome: '   ' })).toBeNull()
  })

  it('usa o padrão declarado quando falta', () => {
    expect(resolver('{{nome|"tudo bem"}}', {})).toBe('tudo bem')
  })

  it('ignora o padrão quando há valor', () => {
    expect(resolver('{{nome|"tudo bem"}}', { nome: 'Ana' })).toBe('Ana')
  })

  it('encadeia filtro e cai no padrão se o filtro não der conta', () => {
    expect(resolver('{{valor|moeda|"a combinar"}}', { valor: 'xyz' })).toBe('a combinar')
  })

  it('sem padrão, filtro que não dá conta também é ausência', () => {
    expect(resolver('{{valor|moeda}}', { valor: 'xyz' })).toBeNull()
  })

  it('aplica primeiro_nome e depois maiusculo na ordem escrita', () => {
    expect(resolver('{{nome|primeiro_nome|maiusculo}}', { nome: 'maria da silva' })).toBe('MARIA')
  })

  it('zero não é ausência', () => {
    expect(resolver('{{valor|moeda}}', { valor: 0 })).toBe('R$ 0,00')
  })
})
