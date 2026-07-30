import { describe, expect, it } from 'vitest'
import { chavesIguais, montarChave, normalizarChave, variaveisDaChave } from './cancel-key'
import { atende, descrever } from './conditions'
import { formatarOffset, lerAtraso, planejarCascata } from './schedule'

describe('chave de cancelamento (§5.1)', () => {
  it('resolve o modelo com os dados do evento', () => {
    expect(montarChave('order:{{external_id}}', { external_id: '12345' })).toEqual({
      ok: true,
      chave: 'order:12345',
    })
  })

  it('gatilho e cancelamento produzem a MESMA chave', () => {
    // A regra que faz o sistema inteiro funcionar. Se estas duas divergirem, o
    // cliente que acabou de pagar recebe "finalize seu pagamento".
    const noCreated = montarChave('order:{{external_id}}', {
      external_id: '12345',
      status: 'pendente',
    })
    const noPaid = montarChave('order:{{external_id}}', {
      external_id: '12345',
      status: 'pago',
      valor_cents: 4990,
    })

    expect(noCreated).toEqual(noPaid)
  })

  it('normaliza espaço e caixa — payload de terceiro é bagunçado', () => {
    const a = montarChave('order:{{external_id}}', { external_id: ' 12345 ' })
    const b = montarChave('order:{{external_id}}', { external_id: '12345' })
    expect(a).toEqual(b)

    const maiuscula = montarChave('order:{{external_id}}', { external_id: 'PED-A1' })
    const minuscula = montarChave('order:{{external_id}}', { external_id: 'ped-a1' })
    expect(maiuscula).toEqual(minuscula)
  })

  it('FALHA quando falta valor, em vez de gerar `order:undefined`', () => {
    // `order:undefined` casaria com qualquer outro pedido sem o campo, e
    // cancelaria envios de gente que não pagou nada.
    expect(montarChave('order:{{external_id}}', {})).toEqual({
      ok: false,
      faltando: ['external_id'],
    })
  })

  it('string vazia também é ausência', () => {
    expect(montarChave('order:{{external_id}}', { external_id: '  ' }).ok).toBe(false)
  })

  it('zero NÃO é ausência — é um id válido', () => {
    expect(montarChave('order:{{external_id}}', { external_id: 0 })).toEqual({
      ok: true,
      chave: 'order:0',
    })
  })

  it('lista todas as variáveis faltantes de uma vez', () => {
    const r = montarChave('{{a}}:{{b}}:{{c}}', { b: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.faltando).toEqual(['a', 'c'])
  })

  it('modelo vazio ou nulo falha', () => {
    expect(montarChave(null, {}).ok).toBe(false)
    expect(montarChave('   ', {}).ok).toBe(false)
  })

  it('aceita caminho pontuado', () => {
    expect(montarChave('order:{{pedido.id}}', { pedido: { id: 'X1' } })).toEqual({
      ok: true,
      chave: 'order:x1',
    })
  })

  it('tolera espaço dentro das chaves duplas', () => {
    expect(montarChave('order:{{ external_id }}', { external_id: '9' }).ok).toBe(true)
  })

  it('lista as variáveis que o modelo exige', () => {
    expect(variaveisDaChave('order:{{external_id}}-{{campanha}}')).toEqual([
      'external_id',
      'campanha',
    ])
  })

  it('chavesIguais normaliza dos dois lados', () => {
    expect(chavesIguais('Order:12345 ', 'order:12345')).toBe(true)
    expect(chavesIguais('order:12345', 'order:99999')).toBe(false)
  })

  it('normalizarChave colapsa espaço interno', () => {
    expect(normalizarChave('  campaign:Moto   0km  ')).toBe('campaign:moto 0km')
  })
})

describe('condições (§3.5)', () => {
  it('objeto vazio ou ausente libera', () => {
    expect(atende({}, {})).toBe(true)
    expect(atende(null, {})).toBe(true)
  })

  it('forma curta é igualdade', () => {
    expect(atende({ status: 'pago' }, { status: 'pago' })).toBe(true)
    expect(atende({ status: 'pago' }, { status: 'pendente' })).toBe(false)
  })

  it('maior_que compara como número', () => {
    expect(atende({ valor_cents: { maior_que: 5000 } }, { valor_cents: 9900 })).toBe(true)
    expect(atende({ valor_cents: { maior_que: 5000 } }, { valor_cents: 1000 })).toBe(false)
  })

  it('maior_que aceita número que veio como string', () => {
    // Payload de plataforma manda "9900" com frequência.
    expect(atende({ valor_cents: { maior_que: 5000 } }, { valor_cents: '9900' })).toBe(true)
  })

  it('comparação numérica com texto não numérico reprova', () => {
    expect(atende({ valor_cents: { maior_que: 5000 } }, { valor_cents: 'muito' })).toBe(false)
  })

  it('igual ignora caixa e espaço', () => {
    expect(atende({ campanha: 'Moto 0km' }, { campanha: ' moto 0km ' })).toBe(true)
  })

  it('contem procura no meio', () => {
    expect(atende({ campanha: { contem: 'moto' } }, { campanha: 'Moto 0km Julho' })).toBe(true)
  })

  it('existe distingue preenchido de vazio', () => {
    expect(atende({ cpf: { existe: true } }, { cpf: '123' })).toBe(true)
    expect(atende({ cpf: { existe: true } }, { cpf: '' })).toBe(false)
    expect(atende({ cpf: { existe: false } }, {})).toBe(true)
  })

  it('em aceita lista', () => {
    expect(atende({ status: { em: ['pago', 'aprovado'] } }, { status: 'pago' })).toBe(true)
    expect(atende({ status: { em: ['pago', 'aprovado'] } }, { status: 'negado' })).toBe(false)
  })

  it('vários campos é E lógico', () => {
    const regra = { status: 'pago', valor_cents: { maior_que: 1000 } }
    expect(atende(regra, { status: 'pago', valor_cents: 5000 })).toBe(true)
    expect(atende(regra, { status: 'pago', valor_cents: 500 })).toBe(false)
  })

  it('operador com typo REPROVA, não libera', () => {
    // Um `maiorque` escrito errado não pode virar "sem condição" e soltar o
    // fluxo para toda a base.
    expect(atende({ valor_cents: { maiorque: 5000 } }, { valor_cents: 9900 })).toBe(false)
  })

  it('campo ausente reprova nas comparações', () => {
    expect(atende({ status: 'pago' }, {})).toBe(false)
  })

  it('descreve em português para a tela', () => {
    expect(descrever({ valor_cents: { maior_que: 5000 } })).toEqual([
      'valor_cents é maior que 5000',
    ])
    expect(descrever({ cpf: { existe: true } })).toEqual(['cpf está preenchido'])
  })
})

describe('cascata (§5.1)', () => {
  const GATILHO = new Date('2026-07-30T12:00:00Z')

  /** Os passos do fluxo de recuperação de PIX, como estão na spec. */
  const PIX = [
    { id: 'p1', position: 1, delaySeconds: 5 * 60 },
    { id: 'p2', position: 2, delaySeconds: 20 * 60 },
    { id: 'p3', position: 3, delaySeconds: 95 * 60 },
    { id: 'p4', position: 4, delaySeconds: 18 * 3600 },
  ]

  it('acumula os atrasos relativos', () => {
    // +5min → +25min → +2h → +20h, contados do gatilho.
    const agenda = planejarCascata(PIX, GATILHO)
    expect(agenda.map((a) => a.offsetSeconds)).toEqual([300, 1500, 7200, 72_000])
  })

  it('os quatro saem de uma vez, com instantes diferentes', () => {
    const agenda = planejarCascata(PIX, GATILHO)
    expect(agenda).toHaveLength(4)
    expect(new Set(agenda.map((a) => a.quando.getTime())).size).toBe(4)
  })

  it('respeita a posição, não a ordem do array', () => {
    const embaralhado = [PIX[2]!, PIX[0]!, PIX[3]!, PIX[1]!]
    expect(planejarCascata(embaralhado, GATILHO).map((a) => a.position)).toEqual([1, 2, 3, 4])
  })

  it('passo imediato sai no instante do gatilho', () => {
    const agenda = planejarCascata([{ id: 'p1', position: 1, delaySeconds: 0 }], GATILHO)
    expect(agenda[0]?.quando.getTime()).toBe(GATILHO.getTime())
  })

  it('atraso negativo é tratado como zero', () => {
    const agenda = planejarCascata([{ id: 'p1', position: 1, delaySeconds: -60 }], GATILHO)
    expect(agenda[0]?.offsetSeconds).toBe(0)
  })

  it('lista vazia não quebra', () => {
    expect(planejarCascata([], GATILHO)).toEqual([])
  })
})

describe('rótulos de atraso', () => {
  it('formata como a spec escreve', () => {
    expect(formatarOffset(0)).toBe('imediato')
    expect(formatarOffset(300)).toBe('+5 min')
    expect(formatarOffset(1500)).toBe('+25 min')
    expect(formatarOffset(7200)).toBe('+2 h')
    expect(formatarOffset(72_000)).toBe('+20 h')
    expect(formatarOffset(3 * 86400)).toBe('+3 dias')
  })

  it('lê o que a pessoa digita', () => {
    expect(lerAtraso('5min')).toBe(300)
    expect(lerAtraso('2h')).toBe(7200)
    expect(lerAtraso('20 h')).toBe(72_000)
    expect(lerAtraso('3 dias')).toBe(259_200)
    expect(lerAtraso('45s')).toBe(45)
    expect(lerAtraso('0')).toBe(0)
  })

  it('sem unidade assume minutos', () => {
    expect(lerAtraso('25')).toBe(1500)
  })

  it('aceita vírgula decimal', () => {
    expect(lerAtraso('1,5h')).toBe(5400)
  })

  it('recusa o que não sabe ler', () => {
    expect(lerAtraso('depois')).toBeNull()
    expect(lerAtraso('5 luas')).toBeNull()
  })
})
