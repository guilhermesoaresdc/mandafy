import { describe, expect, it } from 'vitest'
import { agendar, dentroDaJanela, JANELA_PADRAO, proximaAbertura } from './quiet-hours'

/** Instante a partir do relógio de Brasília (UTC-3 fora do horário de verão). */
const brt = (iso: string) => new Date(`${iso}-03:00`)

describe('dentroDaJanela (§7.4)', () => {
  it('22h está no silêncio', () => {
    expect(dentroDaJanela(brt('2026-07-30T22:00:00'))).toBe(true)
  })

  it('03h da madrugada está no silêncio', () => {
    expect(dentroDaJanela(brt('2026-07-30T03:00:00'))).toBe(true)
  })

  it('meio-dia não está', () => {
    expect(dentroDaJanela(brt('2026-07-30T12:00:00'))).toBe(false)
  })

  it('21h em ponto já está silenciado', () => {
    expect(dentroDaJanela(brt('2026-07-30T21:00:00'))).toBe(true)
  })

  it('08h em ponto já está liberado', () => {
    expect(dentroDaJanela(brt('2026-07-30T08:00:00'))).toBe(false)
  })

  it('20h59 ainda passa', () => {
    expect(dentroDaJanela(brt('2026-07-30T20:59:00'))).toBe(false)
  })

  it('07h59 ainda está no silêncio', () => {
    expect(dentroDaJanela(brt('2026-07-30T07:59:00'))).toBe(true)
  })

  it('janela que NÃO atravessa a meia-noite também funciona', () => {
    // 12h–14h: silêncio no almoço. A união de intervalos não pode inverter.
    const almoco = { inicio: '12:00', fim: '14:00', fuso: 'America/Sao_Paulo' }
    expect(dentroDaJanela(brt('2026-07-30T13:00:00'), almoco)).toBe(true)
    expect(dentroDaJanela(brt('2026-07-30T22:00:00'), almoco)).toBe(false)
  })

  it('janela vazia significa sem silêncio', () => {
    const nenhuma = { inicio: '08:00', fim: '08:00', fuso: 'America/Sao_Paulo' }
    expect(dentroDaJanela(brt('2026-07-30T03:00:00'), nenhuma)).toBe(false)
  })

  it('respeita o fuso configurado, não o do servidor', () => {
    // 23h em Brasília é 02h do dia seguinte em UTC. No fuso de Brasília está
    // silenciado; num fuso onde ainda são 19h, não.
    const instante = brt('2026-07-30T23:00:00')
    expect(dentroDaJanela(instante, JANELA_PADRAO)).toBe(true)
    expect(dentroDaJanela(instante, { ...JANELA_PADRAO, fuso: 'America/Los_Angeles' })).toBe(false)
  })

  it('horário inválido não silencia nada', () => {
    expect(dentroDaJanela(brt('2026-07-30T03:00:00'), { inicio: '25:00', fim: '08:00', fuso: 'UTC' })).toBe(
      false,
    )
  })
})

describe('proximaAbertura (§7.4)', () => {
  it('às 22h a abertura é 08h do dia seguinte', () => {
    const abertura = proximaAbertura(brt('2026-07-30T22:00:00'))
    expect(abertura.toISOString()).toBe(brt('2026-07-31T08:00:00').toISOString())
  })

  it('às 03h a abertura é 08h do MESMO dia', () => {
    const abertura = proximaAbertura(brt('2026-07-30T03:00:00'))
    expect(abertura.toISOString()).toBe(brt('2026-07-30T08:00:00').toISOString())
  })
})

describe('agendar (§7.4)', () => {
  it('fora da janela apenas soma o jitter', () => {
    const agora = brt('2026-07-30T14:00:00')
    const r = agendar(agora, 20)

    expect(r.silenciado).toBe(false)
    expect(r.quando.getTime()).toBe(agora.getTime() + 20_000)
  })

  it('dentro da janela REAGENDA, não descarta', () => {
    const r = agendar(brt('2026-07-30T22:30:00'), 15)

    expect(r.silenciado).toBe(true)
    expect(r.quando.getTime()).toBeGreaterThan(brt('2026-07-31T08:00:00').getTime())
  })

  it('o jitter é somado à abertura — sem ele todos sairiam às 08:00:00', () => {
    // É a diferença entre uma fila que respira e um pico de centenas de
    // mensagens no mesmo segundo, que é o padrão que queima número.
    const r = agendar(brt('2026-07-30T23:00:00'), 47)
    if (!r.silenciado) throw new Error('esperava silenciado')

    expect(r.abertura.toISOString()).toBe(brt('2026-07-31T08:00:00').toISOString())
    expect(r.quando.getTime() - r.abertura.getTime()).toBe(47_000)
  })

  it('jitters diferentes espalham a fila da manhã', () => {
    const noite = brt('2026-07-30T23:00:00')
    const saidas = [5, 40, 120, 300].map((s) => agendar(noite, s).quando.getTime())
    expect(new Set(saidas).size).toBe(4)
  })

  it('transacional crítico fura a janela', () => {
    const agora = brt('2026-07-30T23:00:00')
    const r = agendar(agora, 0, JANELA_PADRAO, { ignorarSilencio: true })

    expect(r.silenciado).toBe(false)
    expect(r.quando.getTime()).toBe(agora.getTime())
  })

  it('o jitter pode EMPURRAR para dentro da janela, e isso conta', () => {
    // 20h58 + 5min cai em 21h03: já silenciado. Avaliar a janela antes de somar
    // o atraso deixaria essa mensagem sair às 21h03.
    const r = agendar(brt('2026-07-30T20:58:00'), 300)
    expect(r.silenciado).toBe(true)
  })
})
