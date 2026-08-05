import { describe, expect, it } from 'vitest'
import { chavesIguais, montarChave, normalizarChave, variaveisDaChave } from './cancel-key'
import { atende, descrever } from './conditions'
import {
  formatarHorario,
  formatarOffset,
  lerAtraso,
  lerHorario,
  noHorarioLocal,
  planejarCascata,
} from './schedule'

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

/**
 * A hora marcada de um passo (§5.1, §7.4).
 *
 * O QUE ESTE BLOCO IMPEDE
 *
 * "+2 dias" cai exatamente na hora em que o gatilho chegou: quem cria conta às
 * 3h da manhã recebe a reativação às 3h da manhã. A hora marcada conserta isso,
 * e traz junto dois modos de falha que só aparecem em produção, dias depois:
 *
 *   sair para TRÁS      o passo 2 chegaria antes do passo 1, e o cliente lê o
 *                       "obrigado" antes da confirmação
 *   errar por uma hora   somar -3h na mão acerta metade do ano e erra a outra
 *                       metade, sem nada acusando
 *
 * Por isso o cálculo passa pelo `Intl` e por isso o teste mede em horário de
 * Brasília, e não em UTC.
 */
describe('§5.1 — a hora marcada do passo', () => {
  const SP = 'America/Sao_Paulo'

  /** Que horas são em São Paulo, para as asserções lerem como a tela lê. */
  const emSP = (d: Date) =>
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: SP,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)

  it('lê as formas que alguém digita', () => {
    expect(lerHorario('10:00')).toBe(600)
    expect(lerHorario('10h')).toBe(600)
    expect(lerHorario('9:5')).toBe(545)
    expect(lerHorario('00:00')).toBe(0)
    expect(lerHorario('23:59')).toBe(1439)
    expect(lerHorario(' 18:30 ')).toBe(1110)
  })

  it('recusa o que não é hora, em vez de chutar', () => {
    // Chutar aqui agenda o envio para uma hora que ninguém pediu.
    expect(lerHorario('24:00')).toBeNull()
    expect(lerHorario('10:60')).toBeNull()
    expect(lerHorario('amanhã')).toBeNull()
    expect(lerHorario('')).toBeNull()
    expect(lerHorario('1000')).toBeNull()
  })

  it('grava sempre no mesmo formato', () => {
    expect(formatarHorario(600)).toBe('10:00')
    expect(formatarHorario(545)).toBe('09:05')
    expect(formatarHorario(0)).toBe('00:00')
  })

  it('empurra para a frente, no mesmo dia', () => {
    // 12:00 UTC = 09:00 em São Paulo. Pedindo 10:00, falta uma hora.
    const quando = noHorarioLocal(new Date('2026-07-30T12:00:00Z'), 600, SP)
    expect(emSP(quando)).toBe('30/07, 10:00')
  })

  it('quando a hora já passou, vai para o dia seguinte — nunca para trás', () => {
    /*
     * O caso que quebraria a cascata. Às 09:00 pedindo 08:00, puxar para trás
     * daria 08:00 do MESMO dia: antes do instante que a cascata calculou, e
     * possivelmente antes do passo anterior.
     */
    const gatilho = new Date('2026-07-30T12:00:00Z')
    const quando = noHorarioLocal(gatilho, 480, SP)

    expect(emSP(quando)).toBe('31/07, 08:00')
    expect(quando.getTime()).toBeGreaterThan(gatilho.getTime())
  })

  it('em cima da hora, fica onde está', () => {
    // Adiar 24 horas por causa de um arredondamento seria pior que a imprecisão.
    const quando = noHorarioLocal(new Date('2026-07-30T12:00:00Z'), 540, SP)
    expect(emSP(quando)).toBe('30/07, 09:00')
  })

  it('zera os segundos: quem pediu 10:00 não pediu 10:00:37', () => {
    const quando = noHorarioLocal(new Date('2026-07-30T12:00:37.500Z'), 600, SP)
    expect(quando.getSeconds()).toBe(0)
    expect(quando.getMilliseconds()).toBe(0)
  })

  it('a mesma hora dá o mesmo relógio no verão e no inverno', () => {
    /*
     * O motivo de o cálculo passar pelo `Intl` em vez de somar -3h. O Brasil já
     * teve horário de verão e pode voltar a ter; com aritmética fixa, metade do
     * ano sairia uma hora fora e nada apontaria para cá.
     */
    const inverno = noHorarioLocal(new Date('2026-07-30T12:00:00Z'), 600, SP)
    const verao = noHorarioLocal(new Date('2026-01-30T12:00:00Z'), 600, SP)

    expect(emSP(inverno)).toBe('30/07, 10:00')
    expect(emSP(verao)).toBe('30/01, 10:00')
  })

  it('na cascata, o horário vale para o passo e o acumulado segue o atraso', () => {
    /*
     * A decisão de projeto que este caso prende: o passo 3 conta do ATRASO do
     * passo 2, não do horário para o qual ele foi empurrado. Encadear a partir
     * do horário faria mexer numa hora arrastar toda a cadência abaixo dela —
     * e "+2 dias" deixaria de querer dizer dois dias.
     */
    const agenda = planejarCascata(
      [
        { id: 'p1', position: 1, delaySeconds: 0 },
        { id: 'p2', position: 2, delaySeconds: 2 * 86400, sendAtLocal: '10:00' },
        { id: 'p3', position: 3, delaySeconds: 86400 },
      ],
      new Date('2026-07-30T06:00:00Z'), // 03:00 em São Paulo
      SP,
    )

    // O acumulado ignora o horário: 0, 2 dias, 3 dias.
    expect(agenda.map((a) => a.offsetSeconds)).toEqual([0, 172_800, 259_200])

    expect(emSP(agenda[0]!.quando)).toBe('30/07, 03:00')
    // Sem a hora marcada, este cairia às 03:00 de 01/08 — a madrugada de quem
    // se cadastrou de madrugada.
    expect(emSP(agenda[1]!.quando)).toBe('01/08, 10:00')
    expect(emSP(agenda[2]!.quando)).toBe('02/08, 03:00')
  })

  it('horário ilegível é ignorado, e o passo sai na hora da cascata', () => {
    // Vem de uma coluna do banco. Derrubar o fluxo inteiro por causa dela seria
    // trocar "sai na hora errada" por "não sai".
    const agenda = planejarCascata(
      [{ id: 'p1', position: 1, delaySeconds: 3600, sendAtLocal: 'meio-dia' }],
      new Date('2026-07-30T12:00:00Z'),
      SP,
    )
    expect(emSP(agenda[0]!.quando)).toBe('30/07, 10:00')
  })

  it('sem horário, nada muda — é o padrão de todo passo de recuperação', () => {
    const agenda = planejarCascata(
      [{ id: 'p1', position: 1, delaySeconds: 300 }],
      new Date('2026-07-30T12:00:00Z'),
      SP,
    )
    expect(agenda[0]!.quando.toISOString()).toBe('2026-07-30T12:05:00.000Z')
  })
})
