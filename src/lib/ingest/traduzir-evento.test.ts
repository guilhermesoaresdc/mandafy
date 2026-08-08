import { describe, expect, it } from 'vitest'
import { CANONICAL_EVENTS } from '@/db/schema/enums'
import { applyMapping } from './mapping'
import {
  DICIONARIO_DE_EVENTOS,
  traducaoAutomatica,
  traduzirNomeDeEvento,
} from './traduzir-evento'

/**
 * A tradução dos nomes de evento (§4.2).
 *
 * O CASO QUE ORIGINOU ISTO
 *
 * A tela de conexão avisava: "4 nomes de evento estão chegando e não são
 * traduzidos: `qrcode-created` (8×), `new-user`, `payment-by-deposit` (5×),
 * `payment-by-game`". Os quatro estão no mapeamento sugerido desde sempre — mas
 * o motor só consulta o mapa SALVO daquela plataforma, e numa conexão criada
 * antes do catálogo (ou com o passo 3 salvo sem eles) o evento chegava e
 * morria. Cadastro entrando, fluxo ligado, mensagem pronta, e nada saindo.
 */

describe('traduzir nome de evento', () => {
  it('os quatro nomes que estavam morrendo na tela', () => {
    // Este teste é o caso real, com os nomes e as contagens que apareceram.
    expect(traducaoAutomatica('new-user')).toBe('user.created')
    expect(traducaoAutomatica('qrcode-created')).toBe('order.created')
    expect(traducaoAutomatica('payment-by-deposit')).toBe('order.paid')
    // Prêmio, não pagamento de aposta: a plataforma trata os dois como
    // movimentação de dinheiro e distingue pela direção. Trocá-los faria quem
    // ganhou receber "aposta confirmada".
    expect(traducaoAutomatica('payment-by-game')).toBe('ticket.awarded')
  })

  it('o saque da mesma família também dispara sozinho', () => {
    /*
     * `payment-by-withdraw` chegou junto com os outros dois `payment-by-*` numa
     * banca de verdade. A PISTA `withdraw` já acertava o destino — mas pista
     * vira palpite, e palpite espera um clique por projeto. Aqui não há o que
     * confirmar: o nome é conhecido, e pedir confirmação do que já se sabe é o
     * trabalho manual que este arquivo existe para remover.
     */
    expect(traducaoAutomatica('payment-by-withdraw')).toBe('withdrawal.completed')
    expect(traduzirNomeDeEvento('payment-by-withdraw').origem).toBe('dicionario')

    // A grafia varia entre plataformas; as duas são o mesmo evento.
    expect(traducaoAutomatica('payment-by-withdrawal')).toBe('withdrawal.completed')
  })

  it('caixa e separador não decidem se um evento dispara', () => {
    for (const escrita of ['New-User', 'new_user', 'NEW USER', ' new-user ', 'New.User']) {
      expect(traduzirNomeDeEvento(escrita).canonico, escrita).toBe('user.created')
    }
  })

  it('o nome já canônico passa direto', () => {
    const r = traduzirNomeDeEvento('order.paid')
    expect(r.canonico).toBe('order.paid')
    expect(r.origem).toBe('canonico')
  })

  it('nome desconhecido vira palpite, com a origem dizendo isso', () => {
    const r = traduzirNomeDeEvento('cobranca-quitada')
    expect(r.canonico).toBe('order.paid')
    expect(r.origem).toBe('palpite')
  })

  /*
   * A regra que evita o pior erro deste módulo: um palpite aplicado sozinho
   * manda a mensagem errada para o cliente. "Não saiu nada" é um problema que
   * aparece na tela; "saiu a mensagem errada" não aparece e não se desfaz.
   */
  it('palpite NÃO é aplicado sozinho', () => {
    expect(traduzirNomeDeEvento('cobranca-quitada').origem).toBe('palpite')
    expect(traducaoAutomatica('cobranca-quitada')).toBeNull()
  })

  it('o que não dá para ler não é chutado', () => {
    const r = traduzirNomeDeEvento('xpto-42')
    expect(r.canonico).toBeNull()
    expect(r.origem).toBe('nenhuma')
  })

  it('expirado é expirado, mesmo carregando a palavra pagamento', () => {
    // A ordem das pistas é a regra: `payment-expired` tem "payment" e "expired",
    // e um pagamento que expirou é um pedido expirado.
    expect(traduzirNomeDeEvento('payment-expired').canonico).toBe('order.expired')
    expect(traduzirNomeDeEvento('pagamento-cancelado').canonico).toBe('order.cancelled')
  })

  it('saque pedido e saque pago não se confundem', () => {
    // Um manda "estamos processando", o outro manda "o dinheiro caiu". Trocá-los
    // é avisar que o dinheiro saiu antes de sair.
    expect(traduzirNomeDeEvento('saque_solicitado').canonico).toBe('withdrawal.pending')
    expect(traduzirNomeDeEvento('saque_finalizado').canonico).toBe('withdrawal.completed')
  })

  it('todo destino do dicionário é um evento que o motor conhece', () => {
    // Um destino fora da lista canônica seria gravado no mapa e recusado depois,
    // na ingestão — longe daqui, e sem nada apontando para cá.
    for (const [nome, canonico] of Object.entries(DICIONARIO_DE_EVENTOS)) {
      expect(CANONICAL_EVENTS as readonly string[], nome).toContain(canonico)
    }
  })
})

describe('a ingestão usa o dicionário como rede', () => {
  const payload = { event: 'new-user', name: 'Maria', phone: '+5511988887777' }

  it('o evento conhecido é aproveitado mesmo com o mapa salvo vazio', () => {
    // O mapa desta plataforma não traduz nada — é o estado de qualquer conexão
    // criada antes do catálogo existir.
    const r = applyMapping(payload, {
      event_path: '$.event',
      event_map: {},
      contact: { name: '$.name', phone: '$.phone' },
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('user.created')
  })

  it('o mapa salvo VENCE o dicionário', () => {
    /*
     * A autoridade sobre uma plataforma é o mapa dela. Se alguém traduziu
     * `new-user` para outra coisa, foi de propósito — talvez porque naquela
     * banca o nome signifique mesmo outra coisa. A rede só pega o que ia cair.
     */
    const r = applyMapping(payload, {
      event_path: '$.event',
      event_map: { 'new-user': 'order.created' },
      contact: { name: '$.name' },
    })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.event.type).toBe('order.created')
  })

  it('o que o dicionário não conhece continua sendo recusado, com o motivo', () => {
    // Recusar é o certo: aplicar palpite em silêncio manda mensagem errada.
    const r = applyMapping(
      { event: 'xpto-42' },
      { event_path: '$.event', event_map: {}, contact: {} },
    )

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure.reason).toBe('evento_nao_mapeado')
      expect(r.failure.detail).toContain('xpto-42')
    }
  })
})
