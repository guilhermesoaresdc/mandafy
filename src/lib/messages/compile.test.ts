import { describe, expect, it } from 'vitest'
import { compilar, compilarTodos, variaveisDoCorpo, variaveisObrigatorias } from './compile'
import { sementeDeTexto } from './spintax'
import { analisar } from './analise'

/** O corpo que a própria spec usa como exemplo em §6.3. */
const EXEMPLO = `Oi {{nome|"tudo bem"}}! Seu PIX de {{valor|moeda}} para a campanha
*{{campanha}}* ainda está aberto.

São {{quantidade}} números esperando por você. 🎟️

Finaliza aqui: {{link_pagamento}}`

const DADOS = {
  nome: 'Ana',
  valor: 4990,
  campanha: 'Moto 0km',
  quantidade: 12,
  link_pagamento: 'https://pag.exemplo.com/x1',
}

describe('compilar — o exemplo de §6.3', () => {
  it('monta a versão de WhatsApp com os valores no lugar', () => {
    const r = compilar(EXEMPLO, { canal: 'whatsapp', dados: DADOS, semente: 1 })
    if (!r.ok) throw new Error(r.detalhe)

    expect(r.corpo).toBe(
      'Oi Ana! Seu PIX de R$ 49,90 para a campanha\n_Moto 0km_ ainda está aberto.\n\n' +
        'São 12 números esperando por você. 🎟️\n\n' +
        'Finaliza aqui: https://pag.exemplo.com/x1',
    )
  })

  it('usa o padrão quando o nome não veio', () => {
    const r = compilar(EXEMPLO, {
      canal: 'whatsapp',
      dados: { ...DADOS, nome: '' },
      semente: 1,
    })
    if (!r.ok) throw new Error(r.detalhe)
    expect(r.corpo.startsWith('Oi tudo bem!')).toBe(true)
  })

  it('derruba a notificação quando falta variável sem padrão (§6.3)', () => {
    const r = compilar(EXEMPLO, {
      canal: 'whatsapp',
      dados: { ...DADOS, campanha: undefined },
      semente: 1,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('variavel_ausente')
    expect(r.variaveis).toEqual(['campanha'])
  })

  it('nunca entrega `{{nome}}` literal ao cliente', () => {
    const r = compilar('Oi {{nome}}!', { canal: 'whatsapp', dados: {} })
    expect(r.ok).toBe(false)
  })

  it('na prévia o buraco fica visível em vez de derrubar', () => {
    const r = compilar('Oi {{nome}}!', { canal: 'whatsapp', dados: {}, previa: true })
    if (!r.ok) throw new Error(r.detalhe)
    expect(r.corpo).toBe('Oi {{nome}}!')
  })

  it('corpo vazio não compila', () => {
    const r = compilar('   ', { canal: 'whatsapp', dados: {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('corpo_vazio')
  })

  it('lista as variáveis que o corpo exige', () => {
    expect(variaveisDoCorpo(EXEMPLO)).toEqual([
      'nome',
      'valor',
      'campanha',
      'quantidade',
      'link_pagamento',
    ])
  })

  it('enxerga variável que só existe em uma alternativa do spintax', () => {
    // Sortear antes de listar esconderia `cupom`, e o envio falharia no dia em
    // que aquele ramo saísse.
    expect(variaveisDoCorpo('{Oi|Olá {{cupom}}} tudo bem')).toEqual(['cupom'])
  })
})

describe('compilarTodos — a prévia lado a lado de §6.6', () => {
  it('devolve os quatro canais', () => {
    const r = compilarTodos(EXEMPLO, { dados: DADOS })
    expect(Object.keys(r).sort()).toEqual(['email', 'sms', 'telegram', 'whatsapp'])
    expect(Object.values(r).every((c) => c.ok)).toBe(true)
  })

  it('os quatro mostram o MESMO sorteio de spintax', () => {
    const fonte = '{Oi|Olá|E aí} {{nome}}, seu PIX está aberto.'
    const r = compilarTodos(fonte, { dados: { nome: 'Ana' } })

    const saudacao = (texto: string) => texto.split(' ')[0]
    if (!r.whatsapp.ok || !r.telegram.ok || !r.sms.ok || !r.email.ok) throw new Error('falhou')

    const wa = saudacao(r.whatsapp.corpo)
    expect(saudacao(r.telegram.corpo)).toBe(wa)
    expect(saudacao(r.sms.corpo)).toBe(wa)
  })

  it('o e-mail traz HTML e texto puro', () => {
    const r = compilarTodos(EXEMPLO, { dados: DADOS })
    if (!r.email.ok) throw new Error('falhou')
    expect(r.email.html).toContain('<!doctype html>')
    expect(r.email.texto).not.toContain('<strong>')
  })

  it('o SMS vem com a contagem de segmentos', () => {
    const r = compilarTodos(EXEMPLO, { dados: DADOS })
    if (!r.sms.ok) throw new Error('falhou')
    expect(r.sms.sms?.segmentos).toBeGreaterThan(0)
    // O 🎟️ do corpo foi removido: o SMS não pode ir para UCS-2 por causa dele.
    expect(r.sms.corpo).not.toContain('🎟')
  })

  it('sem semente fixa, envios diferentes sorteiam textos diferentes', () => {
    const fonte = '{a|b|c|d|e|f|g|h} fixo'
    const vistos = new Set(
      Array.from({ length: 30 }, () => {
        const r = compilar(fonte, { canal: 'whatsapp', dados: {} })
        return r.ok ? r.corpo : ''
      }),
    )
    expect(vistos.size).toBeGreaterThan(1)
  })

  it('com semente fixa, a compilação é reproduzível a partir do log', () => {
    const fonte = '{a|b|c} {d|e|f}'
    const um = compilar(fonte, { canal: 'whatsapp', dados: {}, semente: 7 })
    const dois = compilar(fonte, { canal: 'whatsapp', dados: {}, semente: 7 })
    expect(um).toEqual(dois)
  })
})

describe('valor de variável não vira formatação', () => {
  it('nome com asteriscos sai literal', () => {
    const r = compilar('Oi {{nome}}', {
      canal: 'whatsapp',
      dados: { nome: '**Ana**' },
      semente: 1,
    })
    if (!r.ok) throw new Error(r.detalhe)
    expect(r.corpo).toBe('Oi **Ana**')
  })

  it('nome com HTML não vira tag no Telegram', () => {
    const r = compilar('Oi {{nome}}', {
      canal: 'telegram',
      dados: { nome: '<b>Ana</b>' },
      semente: 1,
    })
    if (!r.ok) throw new Error(r.detalhe)
    expect(r.corpo).toBe('Oi &lt;b&gt;Ana&lt;/b&gt;')
  })

  it('endereço com aspas não escapa do atributo href', () => {
    const r = compilar('[Pagar]({{link}})', {
      canal: 'telegram',
      dados: { link: 'https://x.com/"><script>alert(1)</script>' },
      semente: 1,
    })
    if (!r.ok) throw new Error(r.detalhe)
    expect(r.corpo).not.toContain('<script>')
  })
})

describe('analisar — os avisos do editor', () => {
  it('avisa que emoji some no SMS', () => {
    const avisos = analisar('Bilhete garantido 🎟️')
    expect(avisos.some((a) => a.canal === 'sms' && a.texto.includes('Emoji'))).toBe(true)
  })

  it('avisa que acentuação joga o SMS para UCS-2', () => {
    const avisos = analisar('Sua inscrição não terminou')
    expect(avisos.some((a) => a.canal === 'sms' && a.texto.includes('UCS-2'))).toBe(true)
  })

  it('avisa quando o SMS passa de um segmento', () => {
    const avisos = analisar('a'.repeat(200))
    expect(avisos.some((a) => a.canal === 'sms' && a.severidade === 'erro')).toBe(true)
  })

  it('avisa sobre bloco longo demais no WhatsApp', () => {
    const avisos = analisar(Array.from({ length: 14 }, (_, i) => `linha ${i}`).join('\n'))
    expect(avisos.some((a) => a.canal === 'whatsapp' && a.texto.includes('parece robô'))).toBe(true)
  })

  it('avisa quando não há variação nenhuma (§6.5)', () => {
    const avisos = analisar('Texto sempre igual para todo mundo')
    expect(avisos.some((a) => a.texto.includes('Sem variação'))).toBe(true)
  })

  it('não avisa de variação quando há spintax', () => {
    const avisos = analisar('{Oi|Olá} tudo bem')
    expect(avisos.some((a) => a.texto.includes('Sem variação'))).toBe(false)
  })

  it('repassa erro de filtro desconhecido', () => {
    const avisos = analisar('{{nome|inventado}}')
    expect(avisos.some((a) => a.severidade === 'erro' && a.texto.includes('Filtro'))).toBe(true)
  })

  it('corpo vazio não gera aviso nenhum', () => {
    expect(analisar('  ')).toEqual([])
  })
})

describe('semente', () => {
  it('sementeDeTexto é estável', () => {
    expect(sementeDeTexto('abc')).toBe(sementeDeTexto('abc'))
    expect(sementeDeTexto('abc')).not.toBe(sementeDeTexto('abd'))
  })
})

describe('variaveisObrigatorias — o que o disparo em lote precisa perguntar', () => {
  /*
   * A distinção que decide se um envio sai: variável com padrão nunca derruba
   * a compilação, então pedi-la na tela seria exigir o que o sistema já
   * resolve — inclusive o nome, que ele lê do contato.
   */
  it('ignora quem tem valor padrão', () => {
    expect(variaveisObrigatorias('Oi {{nome|primeiro_nome|"parceiro"}}, o {{sorteio}} fecha já!'))
      .toEqual(['sorteio'])
  })

  it('lista as que sairiam vazias', () => {
    expect(variaveisObrigatorias('{{sorteio}} — 1º prêmio {{milhar}}. {{link_resultado}}')).toEqual(
      ['sorteio', 'milhar', 'link_resultado'],
    )
  })

  it('filtro nomeado não é valor padrão', () => {
    // `{{valor_cents|moeda}}` formata, mas continua exigindo o valor.
    expect(variaveisObrigatorias('Prêmio de {{valor_cents|moeda}}')).toEqual(['valor_cents'])
  })

  it('enxerga dentro do spintax, como a irmã', () => {
    expect(variaveisObrigatorias('{Oi|Olá {{cupom}}} tudo bem')).toEqual(['cupom'])
  })

  it('corpo sem variável não pede nada', () => {
    expect(variaveisObrigatorias('Boa sorte hoje!')).toEqual([])
  })
})
