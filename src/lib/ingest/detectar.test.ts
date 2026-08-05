import { describe, expect, it } from 'vitest'
import { detectarMapeamento, eventoCanonicoDe } from './detectar'

/**
 * Adivinhar o mapeamento (§4.2, passo 3).
 *
 * Os dois primeiros casos são o payload REAL de um Techloto conectado, copiado
 * da tela de conexão. É a plataforma de banca mais comum, e o formato dela —
 * tudo plano na raiz, nomes em inglês com hífen — é o oposto do que o
 * mapeamento sugerido do catálogo descrevia.
 */

/** `new-user`, exatamente como chegou. */
const NOVO_USUARIO = {
  id: '6a737200aa711cd866a5669d',
  cpf: '02676236075',
  date: '2026-08-05T14:25:21.740-03:00',
  name: 'JESSICA RODRIGUES DE OLIVEIRA',
  email: 'jessica@exemplo.com.br',
  event: 'new-user',
  phone: '+5511972425144',
  message: 'Novo usuário JESSICA RODRIGUES DE OLIVEIRA',
}

/** `qrcode-created`, com o valor da aposta e o id do apostador. */
const QRCODE_CRIADO = {
  id: '6a737299eebc4605d462d6ac',
  cpf: '02676236075',
  date: '2026-08-05T14:27:53.135-03:00',
  name: 'JESSICA RODRIGUES DE OLIVEIRA',
  email: 'jessica@exemplo.com.br',
  event: 'qrcode-created',
  phone: '+5511972425144',
  value: 10,
  message: 'QRcode Gerado de R$ 10.00 para JESSICA RODRIGUES DE OLIVEIRA',
  user_id: '6a737200aa711cd866a5669d',
}

/** O formato aninhado que o mapeamento sugerido descreve. */
const ANINHADO = {
  event: 'qrcode_pago',
  data: {
    user: { id: 'u_42', name: 'Maria Silva', phone: '(88) 99999-9999', email: 'maria@x.com' },
    order: { id: 'ord_1', amount: 49.9, checkout_url: 'https://pag.to/x' },
    draw: { name: 'PTV 18h', closes_at: '2026-07-30T17:50:00-03:00' },
  },
}

const caminhos = (r: Record<string, { caminho: string }>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.caminho]))

describe('§4.2 — a tela adivinha o que dá para adivinhar', () => {
  it('acha a identidade da pessoa num payload plano', () => {
    const d = detectarMapeamento(NOVO_USUARIO)

    expect(caminhos(d.contato)).toEqual({
      name: '$.name',
      phone: '$.phone',
      email: '$.email',
      cpf: '$.cpf',
      external_id: '$.id',
    })
  })

  it('prefere `user_id` a `id` para a pessoa, e deixa `id` para a aposta', () => {
    // No mesmo payload os dois existem e significam coisas diferentes. Trocá-los
    // amarraria o cancelamento ao apostador em vez de à aposta, e um pagamento
    // cancelaria os lembretes de TODAS as apostas daquela pessoa.
    const d = detectarMapeamento(QRCODE_CRIADO)

    expect(d.contato.external_id?.caminho).toBe('$.user_id')
    expect(d.campos.external_id?.caminho).toBe('$.id')
  })

  it('acha o valor da aposta', () => {
    expect(detectarMapeamento(QRCODE_CRIADO).campos.valor_cents?.caminho).toBe('$.value')
  })

  it('não inventa o que não veio', () => {
    // O Techloto não manda sorteio, palpite nem hora de fechamento. Chutar um
    // campo qualquer para eles faria a mensagem sair com o dado errado — pior
    // que sair sem.
    const d = detectarMapeamento(QRCODE_CRIADO)

    expect(d.campos.sorteio).toBeUndefined()
    expect(d.campos.palpite).toBeUndefined()
    expect(d.campos.fecha_em).toBeUndefined()
    expect(d.campos.link_pagamento).toBeUndefined()
  })

  it('`date` não vira hora de fechamento', () => {
    // Os dois são ISO 8601. O que separa é o NOME: `date` é quando aconteceu,
    // e usá-lo como prazo faria toda mensagem dizer que a aposta fecha no
    // passado.
    expect(detectarMapeamento(NOVO_USUARIO).campos.fecha_em).toBeUndefined()
  })

  it('funciona igual no formato aninhado', () => {
    const d = detectarMapeamento(ANINHADO)

    expect(caminhos(d.contato)).toMatchObject({
      name: '$.data.user.name',
      phone: '$.data.user.phone',
      email: '$.data.user.email',
      external_id: '$.data.user.id',
    })
    expect(d.campos.valor_cents?.caminho).toBe('$.data.order.amount')
    expect(d.campos.sorteio?.caminho).toBe('$.data.draw.name')
    expect(d.campos.fecha_em?.caminho).toBe('$.data.draw.closes_at')
    expect(d.campos.link_pagamento?.caminho).toBe('$.data.order.checkout_url')
  })

  it('acha onde está o nome do evento sem depender de `$.event`', () => {
    expect(detectarMapeamento(NOVO_USUARIO).eventPath).toBe('$.event')
    expect(detectarMapeamento({ type: 'x', a: 1 }).eventPath).toBe('$.type')
    expect(detectarMapeamento({ a: 1 }).eventPath).toBeNull()
  })

  it('payload que não é objeto não derruba nada', () => {
    // Vem de webhook, que é dado hostil por definição.
    expect(detectarMapeamento(null).contato).toEqual({})
    expect(detectarMapeamento('texto').campos).toEqual({})
    expect(detectarMapeamento([1, 2]).eventPath).toBeNull()
  })
})

describe('§4.1 — o nome do evento traduzido', () => {
  it('reconhece o mesmo evento escrito de vários jeitos', () => {
    // Nenhuma plataforma escolhe o nosso nome, e as duas grafias convivem no
    // mesmo painel: o rótulo do Techloto é "Qrcode Criado", o corpo manda
    // `qrcode-created`.
    for (const nome of ['new-user', 'new_user', 'novo_usuario', 'New User', 'user.created']) {
      expect(eventoCanonicoDe(nome), nome).toBe('user.created')
    }

    expect(eventoCanonicoDe('qrcode-created')).toBe('order.created')
    expect(eventoCanonicoDe('qrcode-paid')).toBe('order.paid')
    expect(eventoCanonicoDe('qrcode_pago')).toBe('order.paid')
    expect(eventoCanonicoDe('bilhete_premiado')).toBe('ticket.awarded')
    expect(eventoCanonicoDe('saque-finalizado')).toBe('withdrawal.completed')
  })

  it('devolve nada quando não reconhece, em vez de chutar', () => {
    // Um chute aqui vira fluxo disparando no evento errado — mensagem de prêmio
    // para quem acabou de se cadastrar.
    expect(eventoCanonicoDe('xpto')).toBeNull()
    expect(eventoCanonicoDe('')).toBeNull()
  })
})
