import { describe, expect, it } from 'vitest'
import { decidirEnvio, temDestino, type ContatoParaEnvio, type ContextoGuarda } from './guards'

const brt = (iso: string) => new Date(`${iso}-03:00`)
const MEIO_DIA = brt('2026-07-30T12:00:00')

const CONTATO: ContatoParaEnvio = {
  optedOutAt: null,
  optinAt: brt('2026-01-01T10:00:00'),
  phoneE164: '+5511988887777',
  email: 'ana@exemplo.com',
  telegramChatId: 12345,
  optinWhatsapp: true,
  optinEmail: true,
  optinSms: true,
  optinTelegram: true,
}

const BASE: ContextoGuarda = {
  canal: 'whatsapp',
  contato: CONTATO,
  categoria: 'transacional',
  canalLigado: true,
  mensagemAtiva: true,
  suprimidos: [],
  recebidasHoje: 0,
  duplicado: false,
  ignorarSilencio: false,
}

const decidir = (mudancas: Partial<ContextoGuarda>, agora = MEIO_DIA, atraso = 10) =>
  decidirEnvio({ ...BASE, ...mudancas }, agora, atraso)

describe('temDestino (§5.3, regra 6)', () => {
  it('WhatsApp e SMS precisam de telefone', () => {
    const semFone = { ...CONTATO, phoneE164: null }
    expect(temDestino(semFone, 'whatsapp')).toBe(false)
    expect(temDestino(semFone, 'sms')).toBe(false)
    expect(temDestino(semFone, 'email')).toBe(true)
  })

  it('Telegram precisa do chat_id, não do telefone', () => {
    expect(temDestino({ ...CONTATO, telegramChatId: null }, 'telegram')).toBe(false)
  })

  it('chat_id zero é um id válido, não ausência', () => {
    expect(temDestino({ ...CONTATO, telegramChatId: 0 }, 'telegram')).toBe(true)
  })
})

describe('regras de guarda, na ordem de §5.3', () => {
  it('caminho feliz envia com o jitter somado', () => {
    const d = decidir({})
    expect(d.acao).toBe('enviar')
    if (d.acao === 'enviar') expect(d.quando.getTime()).toBe(MEIO_DIA.getTime() + 10_000)
  })

  it('1 — opt-out global bloqueia até transacional', () => {
    expect(decidir({ contato: { ...CONTATO, optedOutAt: MEIO_DIA } })).toEqual({
      acao: 'pular',
      motivo: 'optout',
    })
  })

  it('2 — opt-out do canal bloqueia só aquele canal', () => {
    const contato = { ...CONTATO, optinSms: false }
    expect(decidir({ canal: 'sms', contato }).acao).toBe('pular')
    expect(decidir({ canal: 'whatsapp', contato }).acao).toBe('enviar')
  })

  it('2 — supressão bloqueia o canal', () => {
    expect(decidir({ canal: 'email', suprimidos: ['email'] })).toEqual({
      acao: 'pular',
      motivo: 'suppressed',
    })
  })

  it('base legal — promocional sem opt-in registrado não sai (§14.1)', () => {
    const semOptin = { ...CONTATO, optinAt: null }
    expect(decidir({ categoria: 'relacionamento', contato: semOptin })).toEqual({
      acao: 'pular',
      motivo: 'sem_optin',
    })
    expect(decidir({ categoria: 'recuperacao', contato: semOptin }).acao).toBe('pular')
  })

  it('base legal — transacional sai sem opt-in, por execução de contrato', () => {
    expect(decidir({ categoria: 'transacional', contato: { ...CONTATO, optinAt: null } }).acao).toBe(
      'enviar',
    )
  })

  it('7 — canal desligado na mensagem', () => {
    expect(decidir({ canalLigado: false })).toEqual({ acao: 'pular', motivo: 'canal_desligado' })
  })

  it('6 — sem endereço para o canal', () => {
    expect(decidir({ canal: 'telegram', contato: { ...CONTATO, telegramChatId: null } })).toEqual({
      acao: 'pular',
      motivo: 'sem_destino',
    })
  })

  it('4 — teto diário por contato', () => {
    expect(decidir({ recebidasHoje: 4 })).toEqual({ acao: 'pular', motivo: 'frequency_cap' })
    expect(decidir({ recebidasHoje: 3 }).acao).toBe('enviar')
  })

  it('4 — o teto é configurável', () => {
    expect(decidir({ recebidasHoje: 3, limiteDiario: 2 }).acao).toBe('pular')
    expect(decidir({ recebidasHoje: 3, limiteDiario: 10 }).acao).toBe('enviar')
  })

  it('5 — duplicado', () => {
    expect(decidir({ duplicado: true })).toEqual({ acao: 'pular', motivo: 'duplicate' })
  })

  it('0 — mensagem pausada não sai', () => {
    expect(decidir({ mensagemAtiva: false })).toEqual({
      acao: 'pular',
      motivo: 'mensagem_pausada',
    })
  })

  it('3 — silêncio reagenda, não descarta', () => {
    const d = decidir({}, brt('2026-07-30T22:00:00'))
    expect(d.acao).toBe('reagendar')
    if (d.acao === 'reagendar') {
      expect(d.abertura.toISOString()).toBe(brt('2026-07-31T08:00:00').toISOString())
      expect(d.quando.getTime()).toBe(d.abertura.getTime() + 10_000)
    }
  })

  it('3 — transacional crítico fura a janela', () => {
    const noite = brt('2026-07-30T22:00:00')
    expect(decidir({ ignorarSilencio: true }, noite).acao).toBe('enviar')
  })
})

describe('a ordem das regras importa', () => {
  it('opt-out vence o silêncio — quem pediu para sair não é reagendado', () => {
    // Reagendar aqui seria pior que pular: a mensagem sairia de manhã para
    // alguém que pediu para não receber.
    const d = decidir({ contato: { ...CONTATO, optedOutAt: MEIO_DIA } }, brt('2026-07-30T22:00:00'))
    expect(d).toEqual({ acao: 'pular', motivo: 'optout' })
  })

  it('opt-out vence o canal desligado — o motivo no log tem de ser o certo', () => {
    const d = decidir({ canalLigado: false, contato: { ...CONTATO, optedOutAt: MEIO_DIA } })
    expect(d).toEqual({ acao: 'pular', motivo: 'optout' })
  })

  it('canal desligado vence o teto — não gasta cota de quem nem ia receber', () => {
    expect(decidir({ canalLigado: false, recebidasHoje: 99 })).toEqual({
      acao: 'pular',
      motivo: 'canal_desligado',
    })
  })

  it('sem destino vence o teto', () => {
    expect(decidir({ contato: { ...CONTATO, phoneE164: null }, recebidasHoje: 99 })).toEqual({
      acao: 'pular',
      motivo: 'sem_destino',
    })
  })
})
