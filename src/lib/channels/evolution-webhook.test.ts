import { describe, expect, it } from 'vitest'
import { normalizarUrlEvolution } from './evolution-admin'
import { extrairTexto, lerRetorno, statusDoAck, telefoneDoJid } from './evolution-webhook'

/**
 * O formato aqui é ditado pela Evolution, não por nós. Cada caso foi montado a
 * partir do código-fonte dela — é a única forma de perceber uma quebra de
 * contrato antes que ela apareça como "o histórico parou de atualizar".
 */

const envelope = (event: string, data: unknown) => ({
  event,
  instance: 'mandafy-chip1-ab12cd',
  data,
  destination: 'https://app.exemplo.com/api/evolution/tok',
  date_time: '2026-08-01T12:00:00.000Z',
  sender: '5511988887777@s.whatsapp.net',
  server_url: 'https://evolution.exemplo.com',
  apikey: 'nao-autentica-nada',
})

describe('lerRetorno — conexão', () => {
  it('traduz os três estados', () => {
    expect(lerRetorno(envelope('connection.update', { state: 'open' }))?.retorno).toMatchObject({
      tipo: 'conexao',
      estado: 'conectado',
    })
    expect(
      lerRetorno(envelope('connection.update', { state: 'connecting' }))?.retorno,
    ).toMatchObject({ tipo: 'conexao', estado: 'conectando' })
    expect(lerRetorno(envelope('connection.update', { state: 'close' }))?.retorno).toMatchObject({
      tipo: 'conexao',
      estado: 'desconectado',
    })
  })

  it('trata "refused" como desconectado', () => {
    // A Evolution manda `refused` quando o QR estoura o limite de tentativas.
    // Qualquer coisa que não seja open ou connecting é "fora do ar".
    expect(lerRetorno(envelope('connection.update', { state: 'refused' }))?.retorno).toMatchObject({
      estado: 'desconectado',
    })
  })

  it('aproveita o número quando a Evolution informa', () => {
    const r = lerRetorno(
      envelope('connection.update', { state: 'open', wuid: '5511988887777@s.whatsapp.net' }),
    )
    expect(r?.retorno).toMatchObject({ telefone: '+5511988887777' })
  })

  it('aceita a grafia da inscrição (CONNECTION_UPDATE)', () => {
    expect(lerRetorno(envelope('CONNECTION_UPDATE', { state: 'open' }))?.retorno.tipo).toBe(
      'conexao',
    )
  })
})

describe('lerRetorno — status de entrega', () => {
  it('lê o id e o ack', () => {
    const r = lerRetorno(
      envelope('messages.update', {
        keyId: '3EB0C1',
        remoteJid: '5511988887777@s.whatsapp.net',
        fromMe: true,
        status: 'DELIVERY_ACK',
        instanceId: 'x',
      }),
    )
    expect(r?.retorno).toEqual({ tipo: 'status', providerMessageId: '3EB0C1', ack: 'DELIVERY_ACK' })
  })

  it('ignora ack desconhecido em vez de gravar lixo', () => {
    const r = lerRetorno(envelope('messages.update', { keyId: '3EB0C1', status: 'INVENTADO' }))
    expect(r?.retorno.tipo).toBe('ignorado')
  })
})

describe('statusDoAck', () => {
  it('só avança o estado, nunca regride', () => {
    expect(statusDoAck('DELIVERY_ACK')).toBe('delivered')
    expect(statusDoAck('READ')).toBe('read')
    expect(statusDoAck('PLAYED')).toBe('read')
    expect(statusDoAck('ERROR')).toBe('failed')

    // PENDING e SERVER_ACK são degraus ANTERIORES ao que já registramos como
    // enviado. Aplicá-los apagaria informação boa.
    expect(statusDoAck('PENDING')).toBeNull()
    expect(statusDoAck('SERVER_ACK')).toBeNull()
  })
})

describe('lerRetorno — mensagem recebida', () => {
  const recebida = (message: unknown, extra: Record<string, unknown> = {}) =>
    lerRetorno(
      envelope('messages.upsert', {
        key: { id: 'A1', remoteJid: '5511988887777@s.whatsapp.net', fromMe: false },
        pushName: 'Maria',
        message,
        messageType: 'conversation',
        ...extra,
      }),
    )

  it('lê texto simples', () => {
    expect(recebida({ conversation: 'SAIR' })?.retorno).toEqual({
      tipo: 'recebida',
      deJid: '5511988887777@s.whatsapp.net',
      texto: 'SAIR',
      nome: 'Maria',
    })
  })

  it('lê resposta com citação (extendedTextMessage)', () => {
    expect(recebida({ extendedTextMessage: { text: 'parar' } })?.retorno).toMatchObject({
      texto: 'parar',
    })
  })

  it('lê legenda de imagem', () => {
    expect(recebida({ imageMessage: { caption: 'cancelar' } })?.retorno).toMatchObject({
      texto: 'cancelar',
    })
  })

  it('IGNORA a nossa própria mensagem', () => {
    // Sem isto, um envio nosso com a palavra "cancelar" no corpo descadastraria
    // o contato — o sistema se sabotando sozinho.
    const r = lerRetorno(
      envelope('messages.upsert', {
        key: { id: 'A1', remoteJid: '5511988887777@s.whatsapp.net', fromMe: true },
        message: { conversation: 'Para cancelar, responda SAIR.' },
      }),
    )
    expect(r?.retorno.tipo).toBe('ignorado')
  })

  it('ignora mensagem sem texto legível', () => {
    expect(recebida({ audioMessage: { seconds: 3 } })?.retorno.tipo).toBe('ignorado')
  })
})

describe('lerRetorno — envio confirmado', () => {
  it('extrai o id da chave', () => {
    const r = lerRetorno(
      envelope('send.message', { key: { id: 'BAE5', remoteJid: 'x@s.whatsapp.net', fromMe: true } }),
    )
    expect(r?.retorno).toEqual({ tipo: 'saiu', providerMessageId: 'BAE5' })
  })
})

describe('lerRetorno — envelope inválido', () => {
  it('devolve null sem estourar', () => {
    expect(lerRetorno(null)).toBeNull()
    expect(lerRetorno('texto solto')).toBeNull()
    expect(lerRetorno({ data: {} })).toBeNull()
  })

  it('evento desconhecido vira ignorado, não erro', () => {
    // A Evolution ganha eventos a cada versão. Um evento novo não pode virar
    // 500 — ela reenfileiraria para sempre.
    expect(lerRetorno(envelope('chats.upsert', {}))?.retorno.tipo).toBe('ignorado')
  })
})

describe('telefoneDoJid', () => {
  it('converte JID de pessoa', () => {
    expect(telefoneDoJid('5511988887777@s.whatsapp.net')).toBe('+5511988887777')
  })

  it('recusa grupo, status e transmissão', () => {
    expect(telefoneDoJid('120363000000@g.us')).toBeNull()
    expect(telefoneDoJid('status@broadcast')).toBeNull()
    expect(telefoneDoJid(undefined)).toBeNull()
  })
})

describe('extrairTexto', () => {
  it('lê resposta de botão e de lista', () => {
    expect(extrairTexto({ buttonsResponseMessage: { selectedDisplayText: 'Sair' } })).toBe('Sair')
    expect(extrairTexto({ listResponseMessage: { title: 'Cancelar' } })).toBe('Cancelar')
  })

  it('devolve null quando não há texto', () => {
    expect(extrairTexto({})).toBeNull()
    expect(extrairTexto(null)).toBeNull()
  })
})

describe('endereço da Evolution (§8.2)', () => {
  /*
   * O endereço que a pessoa tem à mão é o do Manager — é o que fica na barra
   * do navegador enquanto ela olha as instâncias. Colado como está, toda
   * chamada virava `/manager/instance/create` e devolvia 404: o canal ficava
   * configurado, o QR não aparecia, e nada dizia por quê.
   */
  it('tira /manager do fim, com ou sem barra', () => {
    expect(normalizarUrlEvolution('http://187.0.0.1:8080/manager/')).toBe('http://187.0.0.1:8080')
    expect(normalizarUrlEvolution('http://187.0.0.1:8080/manager')).toBe('http://187.0.0.1:8080')
    expect(normalizarUrlEvolution('https://evo.exemplo.com/manager/')).toBe('https://evo.exemplo.com')
  })

  it('tira barras finais e espaço colado sem querer', () => {
    expect(normalizarUrlEvolution('  http://187.0.0.1:8080//  ')).toBe('http://187.0.0.1:8080')
  })

  it('deixa a raiz intacta', () => {
    expect(normalizarUrlEvolution('http://187.0.0.1:8080')).toBe('http://187.0.0.1:8080')
  })

  /*
   * Só `/manager` sai. Qualquer outro sufixo pode ser um prefixo legítimo de
   * proxy reverso — comer isso quebraria quem publica a Evolution sob um
   * caminho.
   */
  it('não come outros caminhos', () => {
    expect(normalizarUrlEvolution('https://exemplo.com/evolution')).toBe('https://exemplo.com/evolution')
    expect(normalizarUrlEvolution('https://exemplo.com/manager-antigo')).toBe(
      'https://exemplo.com/manager-antigo',
    )
  })
})
