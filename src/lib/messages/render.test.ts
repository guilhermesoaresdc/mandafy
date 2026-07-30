import { describe, expect, it } from 'vitest'
import { parseMensagem } from './parse'
import { renderEmail, renderSms, renderTelegram, renderWhatsapp } from './render'

const arvore = (fonte: string) => parseMensagem(fonte).blocos

const wa = (fonte: string) => renderWhatsapp(arvore(fonte))
const tg = (fonte: string) => renderTelegram(arvore(fonte))
const sms = (fonte: string, opcoes = {}) => renderSms(arvore(fonte), opcoes)
const email = (fonte: string) => renderEmail(arvore(fonte))

/**
 * A tabela de §6.2, linha por linha. É o contrato do compilador: se uma célula
 * mudar, tem de mudar aqui primeiro.
 */
describe('§6.2 — a tabela de conversão', () => {
  it('negrito', () => {
    expect(wa('**x**')).toBe('*x*')
    expect(tg('**x**')).toBe('<b>x</b>')
    expect(email('**x**').html).toContain('<strong>x</strong>')
    expect(sms('**x**')).toBe('x')
  })

  it('itálico', () => {
    expect(wa('*x*')).toBe('_x_')
    expect(tg('*x*')).toBe('<i>x</i>')
    expect(email('*x*').html).toContain('<em>x</em>')
    expect(sms('*x*')).toBe('x')
  })

  it('riscado — some inteiro no SMS, onde cada caractere custa', () => {
    expect(wa('~x~')).toBe('~x~')
    expect(tg('~x~')).toBe('<s>x</s>')
    expect(email('~x~').html).toContain('<del>x</del>')
    expect(sms('antes ~riscado~ depois')).toBe('antes depois')
  })

  it('monoespaçado', () => {
    expect(wa('`x`')).toBe('```x```')
    expect(tg('`x`')).toBe('<code>x</code>')
    expect(email('`x`').html).toContain('<code')
    expect(sms('`x`')).toBe('x')
  })

  it('link', () => {
    expect(wa('[pagar](https://x.com)')).toBe('pagar: https://x.com')
    expect(tg('[pagar](https://x.com)')).toBe('<a href="https://x.com">pagar</a>')
    expect(email('[pagar](https://x.com)').html).toContain('href="https://x.com"')
    expect(sms('[pagar](https://x.com)')).toBe('https://x.com')
  })

  it('emoji — mantido em três canais, removido no SMS', () => {
    expect(wa('bilhete 🎟️')).toContain('🎟️')
    expect(tg('bilhete 🎟️')).toContain('🎟️')
    expect(email('bilhete 🎟️').html).toContain('🎟️')
    expect(sms('bilhete 🎟️')).toBe('bilhete')
  })

  it('régua', () => {
    expect(wa('a\n\n---\n\nb')).toBe('a\n\nb')
    expect(tg('a\n\n---\n\nb')).toBe('a\n\nb')
    expect(email('a\n\n---\n\nb').html).toContain('<hr')
    expect(sms('a\n\n---\n\nb')).toBe('a\nb')
  })
})

describe('WhatsApp (§6.4)', () => {
  it('separa parágrafos com linha em branco', () => {
    expect(wa('um\n\ndois')).toBe('um\n\ndois')
  })

  it('link que já é a última coisa fica onde está', () => {
    expect(wa('Finaliza aqui: [pagar](https://x.com)')).toBe(
      'Finaliza aqui: pagar: https://x.com',
    )
  })

  it('link no meio vai para o fim, sem duplicar o endereço', () => {
    const saida = wa('Veja o [contrato](https://x.com/c) antes de pagar.')
    expect(saida).toBe('Veja o contrato antes de pagar.\n\ncontrato: https://x.com/c')
    expect(saida.match(/https:\/\/x\.com\/c/g)).toHaveLength(1)
  })

  it('vários links no meio saem em linhas separadas no fim', () => {
    const saida = wa('O [a](https://a.com) e o [b](https://b.com) valem.')
    expect(saida).toBe('O a e o b valem.\n\na: https://a.com\nb: https://b.com')
  })
})

describe('Telegram (§6.4)', () => {
  it('escapa os três caracteres que quebram o parse_mode HTML', () => {
    expect(tg('1 < 2 & 3 > 2')).toBe('1 &lt; 2 &amp; 3 &gt; 2')
  })

  it('escapa aspas dentro do endereço do link', () => {
    expect(tg('[x](https://a.com/?q="1")')).toContain('href="https://a.com/?q=&quot;1&quot;"')
  })

  it('não deixa HTML digitado pelo autor virar marcação', () => {
    expect(tg('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('aninha as tags corretamente', () => {
    expect(tg('**forte *e leve***')).toBe('<b>forte <i>e leve</i></b>')
  })
})

describe('E-mail (§6.4)', () => {
  it('monta tabela de 600px com CSS embutido', () => {
    const { html } = email('oi')
    expect(html).toContain('width="600"')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('style=')
  })

  it('inclui link de descadastro — é obrigatório', () => {
    const { html, texto } = email('oi')
    expect(html).toContain('Descadastre-se aqui')
    expect(texto).toContain('Para não receber mais:')
  })

  it('gera a versão texto puro em paralelo', () => {
    const { texto } = renderEmail(arvore('**forte** e [link](https://x.com)'))
    expect(texto).toContain('forte e link: https://x.com')
    expect(texto).not.toContain('<strong>')
  })

  it('esconde o preheader quando existe', () => {
    const { html } = renderEmail(arvore('oi'), { preheader: 'olhe isto' })
    expect(html).toContain('olhe isto')
    expect(html).toContain('display:none')
  })

  it('escapa HTML do autor', () => {
    expect(email('<b>injetado</b>').html).toContain('&lt;b&gt;injetado&lt;/b&gt;')
  })

  it('quebra simples dentro do parágrafo vira <br />', () => {
    expect(email('uma\nlinha').html).toContain('uma<br />linha')
  })
})

describe('SMS (§6.4)', () => {
  it('junta parágrafos com uma quebra só, para poupar caractere', () => {
    expect(sms('um\n\ndois')).toBe('um\ndois')
  })

  it('encurta o link quando o encurtador é oferecido', () => {
    const saida = sms('Paga em [aqui](https://plataforma.exemplo.com/pedido/12345)', {
      encurtar: () => 'mdf.to/abc123',
    })
    expect(saida).toBe('Paga em mdf.to/abc123')
  })

  it('remove acentuação quando pedido', () => {
    expect(sms('Sua inscrição não terminou', { removerAcentuacao: true })).toBe(
      'Sua inscricao nao terminou',
    )
  })

  it('mantém acentuação quando não pedido', () => {
    expect(sms('Sua inscrição')).toBe('Sua inscrição')
  })
})

describe('valor de variável nunca vira formatação', () => {
  it('o nome do contato com asteriscos sai literal', () => {
    // A árvore é montada ANTES da substituição; um `**Ana**` no cadastro chega
    // como texto, não como marcador. Aqui simulamos o nó já substituído.
    const blocos = [
      { tipo: 'paragrafo' as const, filhos: [{ tipo: 'texto' as const, valor: 'Oi **Ana**' }] },
    ]
    expect(renderWhatsapp(blocos)).toBe('Oi **Ana**')
    expect(renderTelegram(blocos)).toBe('Oi **Ana**')
  })

  it('valor com HTML não vira tag no Telegram', () => {
    const blocos = [
      {
        tipo: 'paragrafo' as const,
        filhos: [{ tipo: 'texto' as const, valor: 'Oi <b>Ana</b>' }],
      },
    ]
    expect(renderTelegram(blocos)).toBe('Oi &lt;b&gt;Ana&lt;/b&gt;')
  })
})
