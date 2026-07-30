import { describe, expect, it } from 'vitest'
import { corpoEfetivo, editarVariante, estadoDa, propagar, ressincronizar } from './sync'
import type { Channel } from '@/db/schema/enums'

const variante = (channel: Channel, synced: boolean, body: string | null) => ({
  channel,
  synced,
  body,
})

describe('estado sincronizado / customizado (§6.1)', () => {
  it('o selo acompanha o campo synced', () => {
    expect(estadoDa({ synced: true })).toBe('sincronizado')
    expect(estadoDa({ synced: false })).toBe('customizado')
  })

  it('variante sincronizada usa o corpo principal', () => {
    expect(corpoEfetivo('principal', { synced: true, body: 'antigo' })).toBe('principal')
  })

  it('variante customizada usa o próprio corpo', () => {
    expect(corpoEfetivo('principal', { synced: false, body: 'meu texto' })).toBe('meu texto')
  })

  it('canal sem variante ainda segue o principal', () => {
    expect(corpoEfetivo('principal', null)).toBe('principal')
  })
})

describe('propagar (§6.1)', () => {
  it('leva o texto novo para as sincronizadas', () => {
    const decisoes = propagar('novo corpo', [
      variante('whatsapp', true, null),
      variante('email', true, null),
    ])
    expect(decisoes.every((d) => d.propagou && d.novoCorpo === 'novo corpo')).toBe(true)
  })

  it('NÃO toca nas customizadas', () => {
    // O modo de falhar aqui é silencioso: sobrescrever o ajuste de alguém e só
    // descobrir quando o cliente recebe a versão errada.
    const [decisao] = propagar('novo corpo', [variante('sms', false, 'texto curto p/ SMS')])
    expect(decisao?.propagou).toBe(false)
    expect(decisao?.novoCorpo).toBe('texto curto p/ SMS')
  })

  it('mistura os dois estados sem confundir', () => {
    const decisoes = propagar('novo', [
      variante('whatsapp', true, null),
      variante('sms', false, 'curto'),
      variante('email', true, 'sobrescrito'),
    ])
    expect(decisoes.map((d) => d.novoCorpo)).toEqual(['novo', 'curto', 'novo'])
  })

  it('preserva customização vazia — pode ser intencional', () => {
    const [decisao] = propagar('novo', [variante('sms', false, '')])
    expect(decisao?.novoCorpo).toBe('')
  })
})

describe('editarVariante (§6.1)', () => {
  it('texto diferente do principal vira customizado', () => {
    expect(editarVariante('principal', { synced: true, body: null }, 'outro')).toEqual({
      body: 'outro',
      synced: false,
    })
  })

  it('salvar sem mudar nada NÃO quebra a sincronia', () => {
    // Abrir a aba de um canal e salvar não pode fazer o corpo principal parar
    // de propagar sem ninguém ter pedido.
    expect(editarVariante('principal', { synced: true, body: null }, 'principal')).toEqual({
      body: null,
      synced: true,
    })
  })

  it('customizada que volta ao texto do principal ressincroniza sozinha', () => {
    expect(editarVariante('principal', { synced: false, body: 'outro' }, 'principal')).toEqual({
      body: null,
      synced: true,
    })
  })

  it('customizada salva de novo com o mesmo texto continua customizada', () => {
    expect(editarVariante('principal', { synced: false, body: 'meu' }, 'meu')).toEqual({
      body: 'meu',
      synced: false,
    })
  })

  it('ressincronizar descarta o texto próprio', () => {
    expect(ressincronizar()).toEqual({ body: null, synced: true })
  })
})
