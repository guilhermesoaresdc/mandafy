import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assinaturaValida,
  ehBounceDefinitivo,
  lerRetornoEmail,
} from './resend-webhook'
import { lerDlrComtele, lerDlrSmsDev, lerRespostaSmsDev, traduzirSituacao } from './sms-webhook'
import { lerRetornoTelegram, payloadValido } from './telegram-webhook'

/**
 * Testes dos retornos de e-mail, SMS e Telegram (§8.3, §8.4, §8.5).
 *
 * Os três parsers são puros de propósito: o formato de cada provedor pode ser
 * exercitado inteiro sem banco, sem rede e sem conta em nenhum deles. O que se
 * protege aqui é o que dói caro — bloquear cliente bom por um soft bounce, e
 * deixar de bloquear um endereço morto que queima a reputação do domínio.
 */

function evento(type: string, data: Record<string, unknown> = {}) {
  return { type, created_at: '2026-08-01T12:00:00.000Z', data }
}

describe('retorno de e-mail (Resend)', () => {
  it('entrega vira delivered com o id do provedor', () => {
    const r = lerRetornoEmail(evento('email.delivered', { email_id: 'abc', to: ['a@b.com'] }))
    expect(r).toEqual({ tipo: 'entregue', providerMessageId: 'abc', email: 'a@b.com' })
  })

  it('lê o destinatário mesmo quando vem como string', () => {
    const r = lerRetornoEmail(evento('email.delivered', { email_id: 'x', to: 'so@um.com' }))
    expect(r).toMatchObject({ email: 'so@um.com' })
  })

  it('hard bounce bloqueia', () => {
    const r = lerRetornoEmail(
      evento('email.bounced', {
        email_id: 'x',
        to: ['morto@nao-existe.com'],
        bounce: { type: 'Permanent', subType: 'General' },
      }),
    )
    expect(r).toMatchObject({ tipo: 'bloquear', razao: 'hard_bounce', email: 'morto@nao-existe.com' })
  })

  /*
   * O caso caro. Caixa cheia esvazia amanhã; bloquear por isso descarta um
   * cliente bom para sempre, e ninguém descobre porque a supressão é silenciosa.
   */
  it('soft bounce NÃO bloqueia', () => {
    const r = lerRetornoEmail(
      evento('email.bounced', {
        email_id: 'x',
        to: ['cheio@gmail.com'],
        bounce: { type: 'Transient', subType: 'MailboxFull' },
      }),
    )
    expect(r).toMatchObject({ tipo: 'ignorado' })
  })

  it('bounce sem tipo declarado não bloqueia — errar mantendo é recuperável', () => {
    const r = lerRetornoEmail(evento('email.bounced', { email_id: 'x', to: ['a@b.com'] }))
    expect(r).toMatchObject({ tipo: 'ignorado' })
  })

  it('reclamação de spam bloqueia como complaint', () => {
    const r = lerRetornoEmail(evento('email.complained', { email_id: 'x', to: ['a@b.com'] }))
    expect(r).toMatchObject({ tipo: 'bloquear', razao: 'complaint' })
  })

  it('falha de envio bloqueia como endereço inválido', () => {
    const r = lerRetornoEmail(evento('email.failed', { email_id: 'x', to: ['@@'], reason: 'invalid recipient' }))
    expect(r).toMatchObject({ tipo: 'bloquear', razao: 'invalid', detalhe: 'invalid recipient' })
  })

  it('abertura e clique são distinguidos', () => {
    expect(lerRetornoEmail(evento('email.opened', { email_id: 'x' }))).toMatchObject({ acao: 'aberto' })
    expect(lerRetornoEmail(evento('email.clicked', { email_id: 'x' }))).toMatchObject({ acao: 'clicado' })
  })

  it('evento desconhecido é ignorado, não derruba', () => {
    expect(lerRetornoEmail(evento('email.inventado'))).toMatchObject({ tipo: 'ignorado' })
    expect(lerRetornoEmail(null)).toBeNull()
    expect(lerRetornoEmail({ sem: 'type' })).toBeNull()
  })

  it('classifica os rótulos de bounce que os provedores usam', () => {
    expect(ehBounceDefinitivo({ bounce: { type: 'Permanent' } })).toBe(true)
    expect(ehBounceDefinitivo({ bounce_type: 'hard' })).toBe(true)
    expect(ehBounceDefinitivo({ bounce_type: 'soft' })).toBe(false)
    expect(ehBounceDefinitivo({})).toBe(false)
  })
})

describe('assinatura Svix do retorno de e-mail', () => {
  const segredo = `whsec_${Buffer.from('segredo-de-teste-com-tamanho').toString('base64')}`
  const corpo = JSON.stringify(evento('email.delivered', { email_id: 'x' }))

  function assinar(id: string, ts: string, body: string): string {
    const chave = Buffer.from(segredo.replace(/^whsec_/, ''), 'base64')
    return `v1,${createHmac('sha256', chave).update(`${id}.${ts}.${body}`).digest('base64')}`
  }

  const agora = new Date('2026-08-01T12:00:00.000Z')
  const ts = String(Math.floor(agora.getTime() / 1000))

  it('aceita assinatura correta', () => {
    const sig = assinar('msg_1', ts, corpo)
    expect(assinaturaValida(segredo, { id: 'msg_1', timestamp: ts, signature: sig }, corpo, agora)).toBe(true)
  })

  it('recusa corpo adulterado', () => {
    const sig = assinar('msg_1', ts, corpo)
    const outro = JSON.stringify(evento('email.bounced', { email_id: 'x' }))
    expect(assinaturaValida(segredo, { id: 'msg_1', timestamp: ts, signature: sig }, outro, agora)).toBe(false)
  })

  it('recusa carimbo velho — replay', () => {
    const velho = String(Math.floor(agora.getTime() / 1000) - 600)
    const sig = assinar('msg_1', velho, corpo)
    expect(assinaturaValida(segredo, { id: 'msg_1', timestamp: velho, signature: sig }, corpo, agora)).toBe(false)
  })

  /* Durante rotação de segredo o header carrega as duas assinaturas juntas. */
  it('aceita quando a assinatura válida não é a primeira da lista', () => {
    const sig = `v1,QUFB ${assinar('msg_1', ts, corpo)}`
    expect(assinaturaValida(segredo, { id: 'msg_1', timestamp: ts, signature: sig }, corpo, agora)).toBe(true)
  })

  it('recusa quando falta cabeçalho', () => {
    expect(assinaturaValida(segredo, { id: null, timestamp: ts, signature: 'v1,x' }, corpo, agora)).toBe(false)
  })
})

describe('retorno de SMS', () => {
  it('DLR do SMSDev por query string', () => {
    const r = lerDlrSmsDev(new URLSearchParams({ id: '999', situacao: 'DELIVERED' }))
    expect(r).toMatchObject({ tipo: 'status', providerMessageId: '999', estado: 'delivered' })
  })

  it('DLR de falha vira failed', () => {
    const r = lerDlrSmsDev(new URLSearchParams({ id: '1', situacao: 'UNDELIV' }))
    expect(r).toMatchObject({ estado: 'failed' })
  })

  /*
   * Estado intermediário não pode virar UPDATE: a notificação já está em
   * `sent`, e reescrever o mesmo valor a cada passo seria escrita à toa na
   * tabela de maior volume do sistema.
   */
  it('estado intermediário é ignorado', () => {
    expect(lerDlrSmsDev(new URLSearchParams({ id: '1', situacao: 'ENVIADO' }))).toMatchObject({
      tipo: 'ignorado',
    })
  })

  it('DLR sem id é ignorada', () => {
    expect(lerDlrSmsDev(new URLSearchParams({ situacao: 'OK' }))).toMatchObject({ tipo: 'ignorado' })
  })

  it('resposta do destinatário no SMSDev', () => {
    const r = lerRespostaSmsDev(new URLSearchParams({ telefone: '5588999999999', mensagem: 'SAIR' }))
    expect(r).toEqual({ tipo: 'recebida', telefone: '5588999999999', texto: 'SAIR' })
  })

  it('DLR da Comtele em PascalCase', () => {
    const r = lerDlrComtele({ MessageId: 'abc', Status: 'Delivered' })
    expect(r).toMatchObject({ tipo: 'status', providerMessageId: 'abc', estado: 'delivered' })
  })

  it('aceita id numérico — o JSON não é sempre string', () => {
    expect(lerDlrComtele({ Id: 4242, Status: 'OK' })).toMatchObject({ providerMessageId: '4242' })
  })

  /*
   * A Comtele usa o MESMO endereço para DLR e resposta. Tratar tudo como DLR
   * faria um "SAIR" virar situação desconhecida e ser descartado — um pedido
   * de descadastro perdido.
   */
  it('distingue resposta de DLR no mesmo endereço', () => {
    const r = lerDlrComtele({ Sender: '5588999999999', Content: 'PARAR' })
    expect(r).toEqual({ tipo: 'recebida', telefone: '5588999999999', texto: 'PARAR' })
  })

  it('normaliza as situações dos dois provedores', () => {
    expect(traduzirSituacao('entregue')).toBe('delivered')
    expect(traduzirSituacao('REJECTD')).toBe('failed')
    expect(traduzirSituacao('aguardando')).toBeNull()
  })
})

describe('retorno do Telegram', () => {
  function update(text: string, chatId = 555, from: Record<string, unknown> = { first_name: 'Ana' }) {
    return { update_id: 1, message: { message_id: 9, chat: { id: chatId }, from, text } }
  }

  it('/start com payload captura o vínculo', () => {
    const r = lerRetornoTelegram(update('/start ct_abc123'))
    expect(r).toEqual({ tipo: 'inicio', chatId: 555, payload: 'ct_abc123', nome: 'Ana' })
  })

  it('/start sem payload não tem como vincular', () => {
    expect(lerRetornoTelegram(update('/start'))).toMatchObject({ tipo: 'inicio', payload: null })
  })

  it('aceita /start@nome_do_bot, que é como chega em grupo', () => {
    expect(lerRetornoTelegram(update('/start@meubot ct_1'))).toMatchObject({ payload: 'ct_1' })
  })

  it('/parar é pedido de saída', () => {
    expect(lerRetornoTelegram(update('/parar'))).toEqual({ tipo: 'saida', chatId: 555 })
  })

  it('"sair" sem barra também é pedido de saída', () => {
    expect(lerRetornoTelegram(update('sair'))).toMatchObject({ tipo: 'saida' })
  })

  /* Editar "oi" para "parar" é o mesmo pedido; ignorar seria seguir enviando. */
  it('mensagem editada conta igual', () => {
    const bruto = { update_id: 2, edited_message: { chat: { id: 7 }, text: '/parar' } }
    expect(lerRetornoTelegram(bruto)).toEqual({ tipo: 'saida', chatId: 7 })
  })

  it('monta o nome com sobrenome, e cai no username quando não há nome', () => {
    expect(lerRetornoTelegram(update('oi', 1, { first_name: 'Ana', last_name: 'Lima' }))).toMatchObject({
      nome: 'Ana Lima',
    })
    expect(lerRetornoTelegram(update('oi', 1, { username: 'analima' }))).toMatchObject({ nome: 'analima' })
  })

  it('update sem mensagem ou sem chat é ignorado', () => {
    expect(lerRetornoTelegram({ update_id: 1 })).toMatchObject({ tipo: 'ignorado' })
    expect(lerRetornoTelegram({ message: { text: 'oi' } })).toMatchObject({ tipo: 'ignorado' })
    expect(lerRetornoTelegram(null)).toMatchObject({ tipo: 'ignorado' })
  })

  it('saneia payload digitado à mão', () => {
    expect(payloadValido("ct_1'; DROP TABLE")).toBe('ct_1DROPTABLE')
    expect(payloadValido('!!!')).toBeNull()
    expect(payloadValido(null)).toBeNull()
    expect(payloadValido('a'.repeat(100))?.length).toBe(64)
  })
})
