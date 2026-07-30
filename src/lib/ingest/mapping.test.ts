import { describe, expect, it } from 'vitest'
import { applyMapping, MAPEAMENTO_SUGERIDO } from './mapping'

/**
 * O mapeamento é o que torna o sistema plugável em qualquer plataforma sem
 * escrever código (§4.2). Ele recebe payload de webhook — dado hostil — e
 * nunca pode lançar.
 */

/** Payload no formato que a spec descreve em §4.2. */
const payload = {
  event: 'qrcode_pago',
  data: {
    user: { id: 'u_42', name: 'Maria Silva', phone: '(88) 99999-9999', email: 'MARIA@X.COM' },
    order: {
      id: 'ord_1',
      amount: 49.9,
      tickets: 10,
      pix_code: '00020126...',
      checkout_url: 'https://pag.to/x',
    },
    campaign: { title: 'Fiat Argo 2026', prize: 'Um Fiat Argo' },
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
    expect(r.event.data.quantidade).toBe(10)
    expect(r.event.data.campanha).toBe('Fiat Argo 2026')
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
