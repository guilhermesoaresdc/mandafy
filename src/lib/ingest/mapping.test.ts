import { describe, expect, it } from 'vitest'
import { applyMapping, CHAVE_EVENTO_NA_URL, MAPEAMENTO_SUGERIDO } from './mapping'

/**
 * O mapeamento é o que torna o sistema plugável em qualquer plataforma sem
 * escrever código (§4.2). Ele recebe payload de webhook — dado hostil — e
 * nunca pode lançar.
 */

/** Payload no formato que a spec descreve em §4.2, com dado de banca. */
const payload = {
  event: 'qrcode_pago',
  data: {
    user: { id: 'u_42', name: 'Maria Silva', phone: '(88) 99999-9999', email: 'MARIA@X.COM' },
    order: {
      id: 'ord_1',
      amount: 49.9,
      payout: 900,
      pix_code: '00020126...',
      checkout_url: 'https://pag.to/x',
    },
    draw: { name: 'PTV 18h', closes_at: '2026-07-30T17:50:00-03:00' },
    bet: { type: 'Grupo', pick: 'Elefante (grupo 11)' },
  },
}

describe('applyMapping', () => {
  it('traduz o evento da plataforma para o canônico', () => {
    const r = applyMapping(payload, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('order.paid')
  })

  it('extrai e normaliza o contato', () => {
    const r = applyMapping(payload, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.event.contact).toEqual({
      externalId: 'u_42',
      name: 'Maria Silva',
      // Telefone normalizado aqui, não no banco: é o que impede a mesma pessoa
      // de virar três contatos (§3.3).
      phoneE164: '+5588999999999',
      // E-mail em minúsculas, porque a coluna é citext e o índice é único.
      email: 'maria@x.com',
    })
  })

  it('aplica a transformação de dinheiro nos campos', () => {
    const r = applyMapping(payload, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.event.data.valor_cents).toBe(4990)
    // O que a banca paga se o palpite bater — também em centavos (§4.1).
    expect(r.event.data.retorno_cents).toBe(90000)
    expect(r.event.data.sorteio).toBe('PTV 18h')
    expect(r.event.data.palpite).toBe('Elefante (grupo 11)')
    expect(r.event.externalId).toBe('ord_1')
  })

  it('aceita o nome canônico direto, sem precisar de mapa', () => {
    // Plataforma que já fala a nossa língua não deveria exigir configuração.
    const r = applyMapping({ event: 'order.paid' }, { event_path: '$.event', event_map: {} })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('order.paid')
  })

  it('ignora caixa no nome do evento', () => {
    const r = applyMapping({ ...payload, event: 'QRCODE_PAGO' }, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(true)
  })

  it.each([
    ['evento ausente no payload', {}, 'evento_ausente'],
    ['evento desconhecido', { event: 'algo_que_nao_conhecemos' }, 'evento_nao_mapeado'],
  ])('recusa %s', (_caso, corpo, motivo) => {
    const r = applyMapping(corpo, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe(motivo)
  })

  it('recusa mapeamento que aponta para evento fora do catálogo canônico', () => {
    // Impede que um mapa mal configurado crie um tipo de evento inventado,
    // que nenhum fluxo dispararia e ninguém entenderia depois.
    const r = applyMapping({ event: 'x' }, { event_map: { x: 'evento.inventado' } })
    expect(r.ok).toBe(false)
  })

  it('telefone inválido não vira contato com telefone', () => {
    const r = applyMapping(
      { ...payload, data: { ...payload.data, user: { ...payload.data.user, phone: '123' } } },
      MAPEAMENTO_SUGERIDO,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.contact.phoneE164).toBeUndefined()
  })

  it('campo ausente simplesmente não entra em data', () => {
    const semCampanha = { event: 'qrcode_pago', data: { user: { id: 'u1' } } }
    const r = applyMapping(semCampanha, MAPEAMENTO_SUGERIDO)
    expect(r.ok).toBe(true)
    if (r.ok) expect('campanha' in r.event.data).toBe(false)
  })

  it('usa o valor padrão quando o caminho não existe', () => {
    const r = applyMapping(
      { event: 'order.paid' },
      { fields: { origem: { path: '$.nao.existe', default: 'desconhecida' } } },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.data.origem).toBe('desconhecida')
  })

  it.each([[null], [undefined], ['texto'], [42], [[]], [{ event: null }]])(
    'não lança com payload estranho: %s',
    (entrada) => {
      expect(() => applyMapping(entrada, MAPEAMENTO_SUGERIDO)).not.toThrow()
    },
  )

  it.each([[null], [undefined], ['nada'], [42], [{ event_map: 'não é objeto' }]])(
    'não lança com mapeamento estranho: %s',
    (mapa) => {
      expect(() => applyMapping(payload, mapa)).not.toThrow()
    },
  )

  it('cpf é reduzido a dígitos', () => {
    const r = applyMapping(
      { event: 'user.created', doc: '123.456.789-00' },
      { event_map: {}, contact: { cpf: '$.doc' } },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.contact.cpf).toBe('12345678900')
  })
})

/**
 * O nome do evento vindo da URL (§4.2).
 *
 * Plataformas de banca costumam cadastrar UMA URL POR TIPO de evento — escolhe
 * "Qrcode Pago", cola um endereço, adiciona. Nesse desenho o corpo não diz o
 * que aconteceu, porque o endereço já disse, e a ingestão recusava tudo com
 * `evento_ausente`: a plataforma marcava entrega bem sucedida e nada acontecia.
 */
describe('evento declarado na URL', () => {
  /** O corpo como uma plataforma de URL-por-evento manda: sem dizer o tipo. */
  const semEvento = (() => {
    const copia: Record<string, unknown> = { ...payload }
    delete copia.event
    return copia
  })()

  /** O que a rota de entrada grava quando a chamada traz `?evento=`. */
  const comEventoNaUrl = (corpo: object, evento: string) => ({
    ...corpo,
    [CHAVE_EVENTO_NA_URL]: evento,
  })

  it('traduz o evento quando o corpo não diz qual é', () => {
    const r = applyMapping(comEventoNaUrl(semEvento, 'qrcode_pago'), MAPEAMENTO_SUGERIDO)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('order.paid')
  })

  it('o corpo continua mandando quando ele diz', () => {
    // Acrescentar `?evento=` a uma integração que já funciona não pode mudar
    // o que ela faz — por isso a URL é reserva, e não substituição.
    const r = applyMapping(comEventoNaUrl(payload, 'bilhete_premiado'), MAPEAMENTO_SUGERIDO)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('order.paid')
  })

  it('os campos continuam sendo extraídos normalmente', () => {
    const r = applyMapping(comEventoNaUrl(semEvento, 'qrcode_pago'), MAPEAMENTO_SUGERIDO)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.data.valor_cents).toBe(4990)
    expect(r.event.contact.name).toBe('Maria Silva')
  })

  it('evento inventado na URL continua sendo recusado', () => {
    // A URL não é um atalho para furar o mapeamento: quem não tem tradução
    // continua parando aqui, e a tela de conexão mostra o motivo.
    const r = applyMapping(comEventoNaUrl(semEvento, 'inventado'), MAPEAMENTO_SUGERIDO)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe('evento_nao_mapeado')
  })
})
