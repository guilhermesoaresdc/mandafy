import { describe, expect, it } from 'vitest'
import { amostras, contarCombinacoes, resolverSpintax, sementeDeTexto } from './spintax'

const semente = sementeDeTexto('teste')

describe('resolverSpintax (§6.5)', () => {
  it('escolhe uma das alternativas', () => {
    const { texto } = resolverSpintax('{Oi|Olá|E aí} Ana', semente)
    expect(['Oi Ana', 'Olá Ana', 'E aí Ana']).toContain(texto)
  })

  it('é determinístico para a mesma semente', () => {
    const fonte = '{a|b|c} {d|e|f} {g|h|i}'
    expect(resolverSpintax(fonte, 42).texto).toBe(resolverSpintax(fonte, 42).texto)
  })

  it('sementes diferentes produzem textos diferentes', () => {
    const fonte = '{a|b|c|d|e|f|g|h}'
    const vistos = new Set(
      Array.from({ length: 40 }, (_, i) => resolverSpintax(fonte, i).texto),
    )
    expect(vistos.size).toBeGreaterThan(1)
  })

  it('resolve grupos aninhados', () => {
    const { texto } = resolverSpintax('{Oi|{Olá|E aí}}', semente)
    expect(['Oi', 'Olá', 'E aí']).toContain(texto)
  })

  it('NÃO sorteia dentro de uma variável', () => {
    // `{{nome|"tudo bem"}}` é variável com padrão, não sorteio entre dois itens.
    const { texto } = resolverSpintax('{{nome|"tudo bem"}}', semente)
    expect(texto).toBe('{{nome|"tudo bem"}}')
  })

  it('preserva a variável dentro de uma alternativa', () => {
    const { texto } = resolverSpintax('{Oi|Olá} {{primeiro_nome}}', semente)
    expect(texto).toMatch(/^(Oi|Olá) \{\{primeiro_nome\}\}$/)
  })

  it('avisa sobre chave aberta e não fechada', () => {
    const { erros } = resolverSpintax('{sem fim', semente)
    expect(erros[0]?.mensagem).toContain('não fechada')
  })

  it('avisa sobre grupo com uma alternativa só', () => {
    const { texto, erros } = resolverSpintax('{sozinho}', semente)
    expect(erros[0]?.mensagem).toContain('uma alternativa só')
    expect(texto).toBe('sozinho')
  })

  it('respeita a barra de escape antes da chave', () => {
    const { texto } = resolverSpintax('\\{literal}', semente)
    expect(texto).toBe('\\{literal}')
  })

  it('atravessa texto sem spintax sem mexer', () => {
    const fonte = 'Nada para sortear aqui. **Negrito** e [link](https://x.com).'
    expect(resolverSpintax(fonte, semente).texto).toBe(fonte)
  })
})

describe('contarCombinacoes (§6.5)', () => {
  it('texto sem variação dá uma combinação', () => {
    expect(contarCombinacoes('sem nada')).toBe(1)
  })

  it('multiplica grupos independentes', () => {
    expect(contarCombinacoes('{a|b|c} e {d|e}')).toBe(6)
  })

  it('soma as alternativas do grupo aninhado', () => {
    // {a|{b|c}} → a, b, c
    expect(contarCombinacoes('{a|{b|c}}')).toBe(3)
  })

  it('não conta variável como variação', () => {
    expect(contarCombinacoes('{{nome|"amigo"}}')).toBe(1)
  })

  it('conta o exemplo da spec', () => {
    const fonte = '{Oi|Olá|E aí} {{primeiro_nome}}, {vi que|notei que|percebi que} seu PIX ainda não foi pago.'
    expect(contarCombinacoes(fonte)).toBe(9)
  })
})

describe('amostras — os 3 exemplos ao vivo do editor (§6.5)', () => {
  it('devolve exemplos distintos quando há variação suficiente', () => {
    const lista = amostras('{a|b|c|d|e} {1|2|3|4|5}')
    expect(lista).toHaveLength(3)
    expect(new Set(lista).size).toBe(3)
  })

  it('não repete quando só existe uma combinação', () => {
    expect(amostras('texto fixo')).toEqual(['texto fixo'])
  })

  it('devolve no máximo o número de combinações existentes', () => {
    expect(amostras('{a|b}')).toHaveLength(2)
  })
})
