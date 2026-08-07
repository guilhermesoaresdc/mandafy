import { describe, expect, it } from 'vitest'
import {
  distribuir,
  proximoResponsavel,
  regrasAplicaveis,
  REGRAS_PADRAO,
  type Consultor,
} from './distribuicao'

const ana: Consultor = { id: 'a', name: 'Ana' }
const bruno: Consultor = { id: 'b', name: 'Bruno' }
const carla: Consultor = { id: 'c', name: 'Carla' }

describe('rodízio de responsável (§9.3)', () => {
  it('sem consultor não há a quem atribuir', () => {
    expect(proximoResponsavel([], new Map())).toBeNull()
  })

  it('quem tem menos leads abertos recebe', () => {
    const carga = new Map([
      ['a', 10],
      ['b', 3],
      ['c', 7],
    ])
    expect(proximoResponsavel([ana, bruno, carla], carga)?.id).toBe('b')
  })

  it('consultor sem lead nenhum vem antes de todos', () => {
    const carga = new Map([['a', 5]])
    expect(proximoResponsavel([ana, bruno], carga)?.id).toBe('b')
  })

  it('empate é estável, não sorteado', () => {
    // Com a equipe vazia, sorteio deixaria a distribuição imprevisível e
    // ninguém entenderia por que três leads caíram na mesma pessoa.
    const vazia = new Map<string, number>()
    const escolhas = Array.from({ length: 5 }, () =>
      proximoResponsavel([carla, bruno, ana], vazia)?.id,
    )
    expect(new Set(escolhas).size).toBe(1)
    expect(escolhas[0]).toBe('a')
  })
})

describe('distribuir em lote', () => {
  it('espalha em vez de mandar tudo para a mesma pessoa', () => {
    // O erro clássico: ler a carga uma vez e distribuir 10 leads com ela. Os
    // 10 iriam para o mesmo consultor, e o "rodízio" não rodaria nada.
    const destinos = distribuir(6, [ana, bruno, carla], new Map())
    const contagem = new Map<string, number>()
    for (const d of destinos) contagem.set(d.id, (contagem.get(d.id) ?? 0) + 1)

    expect(destinos).toHaveLength(6)
    expect([...contagem.values()]).toEqual([2, 2, 2])
  })

  it('equilibra a partir de uma carga desigual', () => {
    const carga = new Map([
      ['a', 4],
      ['b', 0],
      ['c', 0],
    ])
    const destinos = distribuir(4, [ana, bruno, carla], carga)

    // Os quatro vão para quem estava zerado, até emparelhar.
    expect(destinos.filter((d) => d.id === 'a')).toHaveLength(0)
  })

  it('sem consultor devolve lista vazia', () => {
    expect(distribuir(5, [], new Map())).toEqual([])
  })

  it('quantidade zero não distribui nada', () => {
    expect(distribuir(0, [ana], new Map())).toEqual([])
  })
})

describe('regras de criação automática (§9.3)', () => {
  it('traz as três regras sugeridas pela spec, mais a de cadastro novo', () => {
    expect(REGRAS_PADRAO.map((r) => r.evento)).toEqual([
      '*',
      'order.created',
      'order.paid',
      'contact.inactive_30d',
    ])
  })

  it('quem chega pela primeira vez vira lead, seja qual for o evento', () => {
    // O caso mais comum do webhook: alguém se cadastra na plataforma e não
    // existia na base. Antes disso virava contato e parava aí — o funil só
    // recebia quem já tinha histórico.
    const cadastro = regrasAplicaveis({
      evento: 'user.created',
      valorCents: null,
      jaComprou: false,
      contatoNovo: true,
    })

    expect(cadastro.map((r) => r.chave)).toEqual(['contato_novo'])
    expect(cadastro[0]?.atrasoSegundos).toBeUndefined()
  })

  it('quem já estava na base não vira lead a cada evento', () => {
    const conhecido = regrasAplicaveis({
      evento: 'user.created',
      valorCents: null,
      jaComprou: false,
      contatoNovo: false,
    })

    expect(conhecido).toEqual([])
  })

  it('cadastro novo que já chega comprando aciona as duas regras', () => {
    const regras = regrasAplicaveis({
      evento: 'order.paid',
      valorCents: 30_000,
      jaComprou: false,
      contatoNovo: true,
    })

    expect(regras.map((r) => r.chave)).toEqual(['contato_novo', 'compra_alta'])
  })

  it('order.created aciona a regra do PIX não pago', () => {
    const regras = regrasAplicaveis({ evento: 'order.created', valorCents: 5000, jaComprou: false })
    expect(regras.map((r) => r.chave)).toEqual(['pix_nao_pago_24h'])
    expect(regras[0]?.atrasoSegundos).toBe(24 * 3600)
  })

  it('compra alta só vale acima de R$ 200', () => {
    const abaixo = regrasAplicaveis({ evento: 'order.paid', valorCents: 19_999, jaComprou: true })
    const acima = regrasAplicaveis({ evento: 'order.paid', valorCents: 20_000, jaComprou: true })

    expect(abaixo).toEqual([])
    expect(acima.map((r) => r.chave)).toEqual(['compra_alta'])
  })

  it('sem valor, a regra de compra alta não dispara', () => {
    expect(regrasAplicaveis({ evento: 'order.paid', valorCents: null, jaComprou: true })).toEqual([])
  })

  it('reativação exige histórico de compra', () => {
    // Criar lead para quem nunca comprou encheria o funil de ruído.
    const semHistorico = regrasAplicaveis({
      evento: 'contact.inactive_30d',
      valorCents: null,
      jaComprou: false,
    })
    const comHistorico = regrasAplicaveis({
      evento: 'contact.inactive_30d',
      valorCents: null,
      jaComprou: true,
    })

    expect(semHistorico).toEqual([])
    expect(comHistorico.map((r) => r.chave)).toEqual(['reativacao'])
  })

  it('evento sem regra não cria nada', () => {
    expect(regrasAplicaveis({ evento: 'ticket.awarded', valorCents: 999_999, jaComprou: true })).toEqual([])
  })

  it('toda regra explica por que existe', () => {
    expect(REGRAS_PADRAO.every((r) => r.explicacao.length > 20)).toBe(true)
  })
})
