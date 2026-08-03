import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * O e-mail do convite (§8.3, §9.4).
 *
 * O que se verifica aqui é o que o provedor recebe — não o que o código
 * pretendia mandar. Um e-mail de acesso que chega vazio, ou com o link
 * quebrado, deixa a pessoa sem conseguir entrar e sem entender por quê.
 */

const enviados: { html?: string; textoPuro?: string; corpo: string; assunto?: string }[] = []

vi.mock('@/lib/channels', async (original) => {
  const real = await original<typeof import('@/lib/channels')>()
  return {
    ...real,
    enviarPeloCanal: (destino: (typeof enviados)[number]) => {
      enviados.push(destino)
      return Promise.resolve({ ok: true, provider: 'resend', providerMessageId: 'm1' })
    },
  }
})

vi.mock('@/db', () => ({
  withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}))

vi.mock('@/lib/delivery/config', () => ({
  resolverCanal: () =>
    Promise.resolve({
      alvo: { canal: 'email', config: { provider: 'resend', apiKey: 'k', remetente: 'a@b.c' } },
      provider: 'resend',
      falta: null,
    }),
}))

const LINK = 'https://mandafy.exemplo.com/definir-senha/AbC-123_xyz'

describe('e-mail de convite e recuperação', () => {
  let enviar: typeof import('./convite-email').enviarLinkDeSenha

  beforeEach(async () => {
    enviados.length = 0
    enviar = (await import('./convite-email')).enviarLinkDeSenha
  })

  const mandar = (proposito: 'convite' | 'recuperacao', nome = 'Maria Silva') =>
    enviar({
      orgId: 'org',
      para: 'maria@exemplo.com',
      nome,
      link: LINK,
      proposito,
      organizacao: 'Prêmia Bicho',
    })

  it('manda HTML e texto puro — os dois', async () => {
    await mandar('convite')
    const enviado = enviados[0]!

    /*
     * O adaptador faz `html ?? corpo`. Sem o campo `html`, o texto puro iria
     * para lá e chegaria como um bloco único, porque HTML engole quebra de
     * linha. E sem o texto puro, quem lê sem HTML — e todo filtro de spam —
     * recebe silêncio.
     */
    expect(enviado.html).toBeTruthy()
    expect(enviado.textoPuro).toBeTruthy()
    expect(enviado.html).not.toBe(enviado.textoPuro)
  })

  it('o link aparece clicável no HTML e por extenso nos dois', async () => {
    await mandar('convite')
    const { html, textoPuro } = enviados[0]!

    expect(html).toContain(`href="${LINK}"`)
    // Por extenso porque cliente corporativo bloqueia botão, e quem lê no
    // celular às vezes precisa copiar para outro navegador.
    expect(html).toContain(LINK)
    expect(textoPuro).toContain(LINK)
  })

  it('o assunto e o prazo mudam conforme o propósito', async () => {
    await mandar('convite')
    await mandar('recuperacao')

    expect(enviados[0]?.assunto).toContain('acesso')
    expect(enviados[0]?.textoPuro).toContain('7 dias')

    expect(enviados[1]?.assunto).toContain('Redefinir')
    expect(enviados[1]?.textoPuro).toContain('1 hora')
  })

  it('nome com HTML não escapa para dentro da mensagem', async () => {
    // O nome vem de um formulário. Sem escape, um nome com marcação viraria
    // marcação no e-mail de outra pessoa.
    await mandar('convite', '<script>alert(1)</script>')
    const html = enviados[0]?.html ?? ''

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('sem sobrenome, cumprimenta mesmo assim', async () => {
    await mandar('convite', 'Ana')
    expect(enviados[0]?.textoPuro).toContain('Olá, Ana.')
  })

  it('nome vazio não vira "Olá, ."', async () => {
    await mandar('convite', '   ')
    expect(enviados[0]?.textoPuro).toContain('Olá.')
    expect(enviados[0]?.textoPuro).not.toContain('Olá, .')
  })

  it('recuperação diz que a senha atual continua valendo', async () => {
    await mandar('recuperacao')

    // Quem recebe sem ter pedido precisa saber que não perdeu nada — senão o
    // e-mail parece aviso de invasão e gera pânico ou um clique por impulso.
    expect(enviados[0]?.textoPuro).toContain('senha atual continua valendo')
  })
})
