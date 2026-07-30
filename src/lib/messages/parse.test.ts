import { describe, expect, it } from 'vitest'
import { parseMensagem } from './parse'
import { variaveisUsadas } from './ast'

describe('parseMensagem — Markdown reduzido (§6.2)', () => {
  it('separa parágrafos por linha em branco e mantém a quebra simples', () => {
    const { blocos } = parseMensagem('primeira\nlinha\n\nsegundo bloco')
    expect(blocos).toHaveLength(2)
    expect(blocos[0]).toEqual({
      tipo: 'paragrafo',
      filhos: [{ tipo: 'texto', valor: 'primeira\nlinha' }],
    })
  })

  it('reconhece a régua em linha própria', () => {
    const { blocos } = parseMensagem('antes\n\n---\n\ndepois')
    expect(blocos.map((b) => b.tipo)).toEqual(['paragrafo', 'regua', 'paragrafo'])
  })

  it('trata `---` com mais traços como régua também', () => {
    expect(parseMensagem('-----').blocos[0]?.tipo).toBe('regua')
  })

  it('distingue negrito de itálico pela quantidade de asteriscos', () => {
    const { blocos } = parseMensagem('**forte** e *leve*')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]).toEqual({ tipo: 'negrito', filhos: [{ tipo: 'texto', valor: 'forte' }] })
    expect(filhos[2]).toEqual({ tipo: 'italico', filhos: [{ tipo: 'texto', valor: 'leve' }] })
  })

  it('aceita ênfase aninhada', () => {
    const { blocos } = parseMensagem('**forte com *leve* dentro**')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]?.tipo).toBe('negrito')
    if (filhos[0]?.tipo === 'negrito') {
      expect(filhos[0].filhos[1]).toEqual({ tipo: 'italico', filhos: [{ tipo: 'texto', valor: 'leve' }] })
    }
  })

  it('deixa marcador sem fechamento como texto literal', () => {
    const { blocos, erros } = parseMensagem('2 * 3 = 6')
    expect(blocos[0]).toEqual({ tipo: 'paragrafo', filhos: [{ tipo: 'texto', valor: '2 * 3 = 6' }] })
    expect(erros).toEqual([])
  })

  it('não trata `* *` como ênfase de nada', () => {
    const { blocos } = parseMensagem('a * * b')
    expect(blocos[0]).toEqual({ tipo: 'paragrafo', filhos: [{ tipo: 'texto', valor: 'a * * b' }] })
  })

  it('não interpreta nada dentro de monoespaçado', () => {
    const { blocos } = parseMensagem('`**não é negrito**`')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]).toEqual({ tipo: 'mono', valor: '**não é negrito**' })
  })

  it('respeita a barra de escape', () => {
    const { blocos } = parseMensagem('\\*sem itálico\\*')
    expect(blocos[0]).toEqual({
      tipo: 'paragrafo',
      filhos: [{ tipo: 'texto', valor: '*sem itálico*' }],
    })
  })

  it('lê link com rótulo e endereço', () => {
    const { blocos } = parseMensagem('Vai em [pagar](https://x.com/a)')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[1]).toEqual({
      tipo: 'link',
      rotulo: [{ tipo: 'texto', valor: 'pagar' }],
      url: [{ tipo: 'texto', valor: 'https://x.com/a' }],
    })
  })

  it('aceita variável dentro do endereço do link', () => {
    const { blocos } = parseMensagem('[Pagar]({{link_pagamento}})')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]?.tipo).toBe('link')
    if (filhos[0]?.tipo === 'link') {
      expect(filhos[0].url).toEqual([{ tipo: 'variavel', nome: 'link_pagamento', filtros: [] }])
    }
  })

  it('reclama de link sem endereço', () => {
    const { erros } = parseMensagem('[vazio]()')
    expect(erros[0]?.mensagem).toBe('Link sem endereço.')
  })

  it('`[texto]` sem parêntese é texto comum', () => {
    const { blocos } = parseMensagem('use [colchetes] à vontade')
    expect(blocos[0]).toEqual({
      tipo: 'paragrafo',
      filhos: [{ tipo: 'texto', valor: 'use [colchetes] à vontade' }],
    })
  })
})

describe('parseMensagem — variáveis e filtros (§6.3)', () => {
  it('lê variável simples', () => {
    const { blocos } = parseMensagem('Oi {{nome}}')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[1]).toEqual({ tipo: 'variavel', nome: 'nome', filtros: [] })
  })

  it('lê filtro nomeado', () => {
    const { blocos } = parseMensagem('{{valor|moeda}}')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]).toEqual({
      tipo: 'variavel',
      nome: 'valor',
      filtros: [{ tipo: 'nomeado', nome: 'moeda' }],
    })
  })

  it('lê padrão entre aspas', () => {
    const { blocos } = parseMensagem('{{nome|"tudo bem"}}')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]).toEqual({
      tipo: 'variavel',
      nome: 'nome',
      filtros: [{ tipo: 'padrao', valor: 'tudo bem' }],
    })
  })

  it('não confunde `|` dentro das aspas com separador de filtro', () => {
    const { blocos } = parseMensagem('{{nome|"a|b"}}')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    expect(filhos[0]).toEqual({
      tipo: 'variavel',
      nome: 'nome',
      filtros: [{ tipo: 'padrao', valor: 'a|b' }],
    })
  })

  it('encadeia filtro com padrão', () => {
    const { blocos } = parseMensagem('{{nome|primeiro_nome|"amigo"}}')
    const filhos = blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
    if (filhos[0]?.tipo !== 'variavel') throw new Error('esperava variável')
    expect(filhos[0].filtros).toHaveLength(2)
  })

  it('aceita caminho pontuado', () => {
    const { blocos, erros } = parseMensagem('{{pedido.valor|moeda}}')
    expect(erros).toEqual([])
    expect(variaveisUsadas(blocos)).toEqual(['pedido.valor'])
  })

  it('acusa filtro desconhecido', () => {
    const { erros } = parseMensagem('{{nome|inventado}}')
    expect(erros[0]?.mensagem).toContain('Filtro desconhecido: inventado')
  })

  it('acusa variável sem nome', () => {
    const { erros } = parseMensagem('{{}}')
    expect(erros[0]?.mensagem).toBe('Variável sem nome.')
  })

  it('acusa nome inválido', () => {
    const { erros } = parseMensagem('{{2coisas}}')
    expect(erros[0]?.mensagem).toContain('Nome de variável inválido')
  })

  it('lista as variáveis na ordem de leitura, sem repetir', () => {
    const { blocos } = parseMensagem('{{a}} {{b}} de novo {{a}} e **{{c}}**')
    expect(variaveisUsadas(blocos)).toEqual(['a', 'b', 'c'])
  })

  it('normaliza CRLF antes de contar', () => {
    const { blocos } = parseMensagem('uma\r\nlinha')
    expect(blocos[0]).toEqual({ tipo: 'paragrafo', filhos: [{ tipo: 'texto', valor: 'uma\nlinha' }] })
  })
})

describe('sequências de asteriscos (o caso que quebra parsers ingênuos)', () => {
  const texto = (fonte: string) => {
    const { blocos } = parseMensagem(fonte)
    return blocos[0]?.tipo === 'paragrafo' ? blocos[0].filhos : []
  }

  it('`***x***` é negrito com itálico dentro', () => {
    const filhos = texto('***x***')
    expect(filhos[0]).toEqual({
      tipo: 'negrito',
      filhos: [{ tipo: 'italico', filhos: [{ tipo: 'texto', valor: 'x' }] }],
    })
  })

  it('itálico aberto dentro do negrito fecha antes dele', () => {
    // `**forte *e leve***`: os três asteriscos finais fecham o itálico e depois
    // o negrito. Sem isso sobra um `*` solto no texto entregue ao cliente.
    const filhos = texto('**forte *e leve***')
    expect(filhos).toHaveLength(1)
    expect(filhos[0]?.tipo).toBe('negrito')
    if (filhos[0]?.tipo === 'negrito') {
      expect(filhos[0].filhos[1]).toEqual({
        tipo: 'italico',
        filhos: [{ tipo: 'texto', valor: 'e leve' }],
      })
    }
  })

  it('negrito comum continua funcionando', () => {
    expect(texto('**a** e **b**').filter((n) => n.tipo === 'negrito')).toHaveLength(2)
  })
})
