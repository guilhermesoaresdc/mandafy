import { afterEach, describe, expect, it, vi } from 'vitest'
import { enviarWhatsapp, ehPedidoDeSaida, numeroTemWhatsapp } from './whatsapp'
import { cabecalhosDescadastro, enviarEmail, separarRemetente } from './email'
import { enviarSms } from './sms'
import { enviarTelegram, linkDeCaptura, PADRAO_OPTOUT_TELEGRAM } from './telegram'
import { canalConfigurado, enviarPeloCanal } from './index'

/**
 * Os adaptadores contra respostas de provedor forjadas.
 *
 * Isto NÃO prova que uma mensagem chega ao celular de alguém — para isso é
 * preciso um chip conectado numa Evolution e as chaves dos provedores. O que
 * está provado aqui é o outro lado, que é onde os bugs moram: cada resposta
 * de erro vira o código certo, `reenviavel` só é true quando insistir faz
 * sentido, e nenhum caminho estoura uma exceção crua na fila.
 */

type Resposta = { status: number; corpo?: unknown; texto?: string }

let ultimaChamada: { url: string; init: RequestInit } | null = null

function stubFetch(...respostas: Resposta[]): void {
  let i = 0
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    ultimaChamada = { url, init }
    const r = respostas[Math.min(i++, respostas.length - 1)]!
    return Promise.resolve(
      new Response(r.texto ?? JSON.stringify(r.corpo ?? {}), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function corpoEnviado(): Record<string, unknown> {
  return JSON.parse(String(ultimaChamada?.init.body ?? '{}'))
}

afterEach(() => {
  vi.unstubAllGlobals()
  ultimaChamada = null
})

const WA = { url: 'http://evolution:8080', instancia: 'chip1', apikey: 'k' }

describe('WhatsApp — Evolution API (§8.2)', () => {
  it('usa o formato PLANO da v2, não o aninhado da v1', () => {
    // O ponto que a spec marca como crítico: o v1 é aceito e não entrega.
    stubFetch({ status: 201, corpo: { key: { id: 'MSG1' } } })
    return enviarWhatsapp({ para: '+5511988887777', corpo: 'Olá' }, WA).then(() => {
      const corpo = corpoEnviado()
      expect(corpo).toMatchObject({ number: '5511988887777', text: 'Olá', linkPreview: false })
      expect(corpo.textMessage).toBeUndefined()
      expect(corpo.options).toBeUndefined()
    })
  })

  it('manda a apikey no cabeçalho e acerta a rota da instância', async () => {
    stubFetch({ status: 201, corpo: { key: { id: 'x' } } })
    await enviarWhatsapp({ para: '+5511988887777', corpo: 'Olá' }, WA)

    expect(ultimaChamada?.url).toBe('http://evolution:8080/message/sendText/chip1')
    expect((ultimaChamada?.init.headers as Record<string, string>).apikey).toBe('k')
  })

  it('tolera barra sobrando na URL da Evolution', async () => {
    stubFetch({ status: 201, corpo: {} })
    await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, { ...WA, url: 'http://e:8080///' })
    expect(ultimaChamada?.url).toBe('http://e:8080/message/sendText/chip1')
  })

  it('envia delay para simular digitação (§6.4)', async () => {
    stubFetch({ status: 201, corpo: {} })
    await enviarWhatsapp({ para: '+5511988887777', corpo: 'x', delayMs: 2500 }, WA)
    expect(corpoEnviado().delay).toBe(2500)
  })

  it('devolve o id da mensagem no sucesso', async () => {
    stubFetch({ status: 201, corpo: { key: { id: 'ABC123' } } })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toEqual({ ok: true, provider: 'evolution', providerMessageId: 'ABC123' })
  })

  it('sem credencial nem tenta a rede', async () => {
    stubFetch({ status: 200 })
    const r = await enviarWhatsapp({ para: '+55119', corpo: 'x' }, { ...WA, apikey: '' })

    expect(r).toMatchObject({ ok: false, codigo: 'sem_credencial', reenviavel: false })
    expect(ultimaChamada).toBeNull()
  })

  it('401 é credencial recusada e NÃO se reenvia', async () => {
    stubFetch({ status: 401, corpo: { message: 'Unauthorized' } })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ codigo: 'credencial_recusada', reenviavel: false })
  })

  it('404 é instância inexistente — chip removido ou nome errado', async () => {
    stubFetch({ status: 404, corpo: { message: 'instance not found' } })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ codigo: 'instancia_desconectada', reenviavel: false })
  })

  it('400 falando de número vira sem_whatsapp', async () => {
    stubFetch({ status: 400, corpo: { message: 'number does not exists on whatsapp' } })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ codigo: 'sem_whatsapp', reenviavel: false })
  })

  it('500 é reenviável', async () => {
    stubFetch({ status: 503, corpo: { message: 'upstream' } })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ codigo: 'provedor_indisponivel', reenviavel: true })
  })

  it('HTML de balanceador não estoura o adaptador', async () => {
    // Provedor fora do ar devolve página de erro; um JSON.parse cru quebraria.
    stubFetch({ status: 502, texto: '<html>502 Bad Gateway</html>' })
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ ok: false, reenviavel: true })
  })

  it('erro de rede vira resultado, não exceção', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')))
    const r = await enviarWhatsapp({ para: '+5511988887777', corpo: 'x' }, WA)
    expect(r).toMatchObject({ ok: false, codigo: 'rede', reenviavel: true })
  })

  it('confere se o número tem WhatsApp antes do primeiro envio', async () => {
    stubFetch({ status: 200, corpo: [{ exists: true, number: '5511988887777' }] })
    expect(await numeroTemWhatsapp('+5511988887777', WA)).toBe(true)

    stubFetch({ status: 200, corpo: [{ exists: false }] })
    expect(await numeroTemWhatsapp('+5511988887777', WA)).toBe(false)
  })

  it('checagem indisponível devolve "não sei", não false', async () => {
    // Tratar indisponibilidade como "não tem WhatsApp" cancelaria envios bons.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('timeout')))
    expect(await numeroTemWhatsapp('+5511988887777', WA)).toBeNull()
  })
})

describe('opt-out por palavra-chave (§8.2, §14.1)', () => {
  it('reconhece as palavras da spec', () => {
    for (const palavra of ['SAIR', 'parar', 'Cancelar', 'descadastrar', 'stop', 'remover']) {
      expect(ehPedidoDeSaida(palavra)).toBe(true)
    }
  })

  it('reconhece com espaço antes e texto depois', () => {
    expect(ehPedidoDeSaida('  SAIR por favor')).toBe(true)
  })

  it('não confunde palavra que apenas começa igual', () => {
    expect(ehPedidoDeSaida('parabéns pelo sorteio')).toBe(false)
    expect(ehPedidoDeSaida('saindo de casa agora')).toBe(false)
  })

  it('não dispara com a palavra no meio da frase', () => {
    expect(ehPedidoDeSaida('vou sair mais tarde')).toBe(false)
  })
})

describe('E-mail (§8.3)', () => {
  const CONFIG = { provider: 'resend' as const, apiKey: 'k', remetente: 'Mandafy <x@y.com>' }

  it('manda HTML e texto puro juntos — multipart é entregabilidade', async () => {
    stubFetch({ status: 200, corpo: { id: 'em_1' } })
    await enviarEmail(
      { para: 'a@b.com', corpo: 'txt', assunto: 'Oi', html: '<p>oi</p>', textoPuro: 'oi' },
      CONFIG,
    )

    const corpo = corpoEnviado()
    expect(corpo.html).toBe('<p>oi</p>')
    expect(corpo.text).toBe('oi')
  })

  it('inclui List-Unsubscribe em um clique', () => {
    // Gmail e Outlook exigem de quem manda volume.
    expect(cabecalhosDescadastro('https://x.com/sair/abc')).toEqual({
      'List-Unsubscribe': '<https://x.com/sair/abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    })
  })

  it('sem link de descadastro não inventa cabeçalho', () => {
    expect(cabecalhosDescadastro(undefined)).toEqual({})
  })

  it('separa nome e e-mail do remetente', () => {
    expect(separarRemetente('Mandafy <envio@x.com.br>')).toEqual({
      nome: 'Mandafy',
      email: 'envio@x.com.br',
    })
    expect(separarRemetente('envio@x.com.br')).toEqual({ nome: '', email: 'envio@x.com.br' })
  })

  it('422 é endereço inválido e não se reenvia', async () => {
    stubFetch({ status: 422, corpo: { message: 'Invalid `to` field' } })
    const r = await enviarEmail({ para: 'nao-e-email', corpo: 'x' }, CONFIG)
    expect(r).toMatchObject({ codigo: 'destino_invalido', reenviavel: false })
  })

  it('429 é reenviável', async () => {
    stubFetch({ status: 429, corpo: { message: 'Too many requests' } })
    const r = await enviarEmail({ para: 'a@b.com', corpo: 'x' }, CONFIG)
    expect(r).toMatchObject({ codigo: 'limite_provedor', reenviavel: true })
  })

  it('troca de provedor muda só o destino da chamada', async () => {
    stubFetch({ status: 201, corpo: { messageId: 'br_1' } })
    const r = await enviarEmail({ para: 'a@b.com', corpo: 'x' }, { ...CONFIG, provider: 'brevo' })

    expect(ultimaChamada?.url).toContain('brevo.com')
    expect(r).toMatchObject({ ok: true, provider: 'brevo', providerMessageId: 'br_1' })
  })

  it('sem chave não tenta a rede', async () => {
    stubFetch({ status: 200 })
    const r = await enviarEmail({ para: 'a@b.com', corpo: 'x' }, { ...CONFIG, apiKey: '' })
    expect(r).toMatchObject({ codigo: 'sem_credencial' })
    expect(ultimaChamada).toBeNull()
  })
})

describe('SMS (§8.4)', () => {
  const CONFIG = { provider: 'smsdev' as const, apiKey: 'k' }

  it('envia o número com DDI e sem o +', async () => {
    stubFetch({ status: 200, corpo: { situacao: 'OK', id: '99' } })
    await enviarSms({ para: '+5511988887777', corpo: 'x' }, CONFIG)
    expect(corpoEnviado().number).toBe('5511988887777')
  })

  it('200 com situação ERRO é falha, não sucesso', async () => {
    // O SMSDev responde 200 mesmo recusando. Olhar só o HTTP faria o log
    // registrar "enviado" para mensagem que nunca saiu.
    stubFetch({ status: 200, corpo: { situacao: 'ERRO', descricao: 'saldo insuficiente' } })
    const r = await enviarSms({ para: '+5511988887777', corpo: 'x' }, CONFIG)

    expect(r).toMatchObject({ ok: false, mensagem: 'saldo insuficiente', reenviavel: false })
  })

  it('sucesso devolve o id do provedor', async () => {
    stubFetch({ status: 200, corpo: { situacao: 'OK', id: 12345 } })
    const r = await enviarSms({ para: '+5511988887777', corpo: 'x' }, CONFIG)
    expect(r).toEqual({ ok: true, provider: 'smsdev', providerMessageId: '12345' })
  })

  it('Comtele responde no próprio formato', async () => {
    stubFetch({ status: 200, corpo: { Success: true, Object: 'ct-1' } })
    const r = await enviarSms(
      { para: '+5511988887777', corpo: 'x' },
      { provider: 'comtele', apiKey: 'k' },
    )

    expect(ultimaChamada?.url).toContain('comtele')
    expect(r).toMatchObject({ ok: true, providerMessageId: 'ct-1' })
  })

  it('Comtele com Success false é falha', async () => {
    stubFetch({ status: 200, corpo: { Success: false, Message: 'sem crédito' } })
    const r = await enviarSms(
      { para: '+5511988887777', corpo: 'x' },
      { provider: 'comtele', apiKey: 'k' },
    )
    expect(r).toMatchObject({ ok: false, mensagem: 'sem crédito' })
  })
})

describe('Telegram (§8.5)', () => {
  const CONFIG = { botToken: 'bot:token' }

  it('usa parse_mode HTML, não MarkdownV2', async () => {
    // MarkdownV2 exigiria escapar `_ * [ ] ( ) ~ > # + - = | { } . !`; qualquer
    // um deles num texto em português derruba o envio com 400.
    stubFetch({ status: 200, corpo: { ok: true, result: { message_id: 7 } } })
    await enviarTelegram({ para: '12345', corpo: '<b>oi</b>' }, CONFIG)

    expect(corpoEnviado().parse_mode).toBe('HTML')
  })

  it('desliga a prévia de link por padrão', async () => {
    stubFetch({ status: 200, corpo: { ok: true, result: { message_id: 1 } } })
    await enviarTelegram({ para: '1', corpo: 'x' }, CONFIG)
    expect(corpoEnviado().link_preview_options).toEqual({ is_disabled: true })
  })

  it('monta botões inline quando existem', async () => {
    stubFetch({ status: 200, corpo: { ok: true, result: { message_id: 1 } } })
    await enviarTelegram(
      { para: '1', corpo: 'x', botoes: [{ text: 'Pagar agora', url: 'https://x.com' }] },
      CONFIG,
    )

    expect(corpoEnviado().reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Pagar agora', url: 'https://x.com' }]],
    })
  })

  it('429 devolve o retry_after — ignorar estende o bloqueio do bot', async () => {
    stubFetch({
      status: 429,
      corpo: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 32 } },
    })
    const r = await enviarTelegram({ para: '1', corpo: 'x' }, CONFIG)

    expect(r).toMatchObject({ codigo: 'limite_provedor', reenviavel: true, esperarSegundos: 32 })
  })

  it('403 é bloqueio pelo destinatário e não se reenvia', async () => {
    stubFetch({ status: 403, corpo: { ok: false, description: 'bot was blocked by the user' } })
    const r = await enviarTelegram({ para: '1', corpo: 'x' }, CONFIG)
    expect(r).toMatchObject({ codigo: 'bloqueado_pelo_destino', reenviavel: false })
  })

  it('ok:false com HTTP 200 ainda é falha', async () => {
    stubFetch({ status: 200, corpo: { ok: false, description: 'chat not found' } })
    const r = await enviarTelegram({ para: '1', corpo: 'x' }, CONFIG)
    expect(r.ok).toBe(false)
  })

  it('monta o link de captura com payload', () => {
    expect(linkDeCaptura('@MeuBot', 'PED-48213')).toBe('https://t.me/MeuBot?start=PED-48213')
  })

  it('limpa caracteres que o payload do /start não aceita', () => {
    expect(linkDeCaptura('MeuBot', 'a b/c#d')).toBe('https://t.me/MeuBot?start=abcd')
  })

  it('/parar é o opt-out do Telegram', () => {
    expect(PADRAO_OPTOUT_TELEGRAM.test('/parar')).toBe(true)
    expect(PADRAO_OPTOUT_TELEGRAM.test('parar')).toBe(true)
    expect(PADRAO_OPTOUT_TELEGRAM.test('parabéns')).toBe(false)
  })
})

describe('despacho comum', () => {
  it('cada canal vai para o seu adaptador', async () => {
    stubFetch({ status: 200, corpo: { ok: true, result: { message_id: 1 } } })
    const r = await enviarPeloCanal(
      { para: '1', corpo: 'x' },
      { canal: 'telegram', config: { botToken: 't' } },
    )
    expect(r).toMatchObject({ provider: 'telegram' })
  })

  it('canalConfigurado reconhece o que falta em cada canal', () => {
    expect(canalConfigurado({ canal: 'telegram', config: { botToken: '' } })).toBe(false)
    expect(canalConfigurado({ canal: 'telegram', config: { botToken: 't' } })).toBe(true)
    expect(canalConfigurado({ canal: 'whatsapp', config: { ...WA, instancia: '' } })).toBe(false)
    expect(canalConfigurado({ canal: 'sms', config: { provider: 'smsdev', apiKey: 'k' } })).toBe(true)
    expect(
      canalConfigurado({ canal: 'email', config: { provider: 'resend', apiKey: 'k', remetente: '' } }),
    ).toBe(false)
  })
})
