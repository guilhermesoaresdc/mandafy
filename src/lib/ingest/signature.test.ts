import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { dedupeHash, generateIngestToken, verifySignature } from './signature'

const SEGREDO = 'segredo-do-conector'
const CORPO = '{"event":"order.paid","data":{"order":{"id":"1"}}}'
const AGORA = 1_785_060_000_000

function assinarComTimestamp(corpo: string, segredo: string, ts: number): string {
  const t = Math.floor(ts / 1000)
  const v1 = createHmac('sha256', segredo).update(`${t}.${corpo}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('verifySignature', () => {
  it('sem segredo configurado, não há assinatura a verificar', () => {
    // Nem toda plataforma assina; isso é opcional em §4.3.
    expect(verifySignature(CORPO, null, null)).toEqual({ present: false })
  })

  it('aceita assinatura válida no formato t=…,v1=…', () => {
    const header = assinarComTimestamp(CORPO, SEGREDO, AGORA)
    expect(verifySignature(CORPO, header, SEGREDO, AGORA)).toEqual({ present: true, valid: true })
  })

  it('aceita a forma simples: hex puro sobre o corpo', () => {
    const hex = createHmac('sha256', SEGREDO).update(CORPO).digest('hex')
    expect(verifySignature(CORPO, hex, SEGREDO, AGORA)).toEqual({ present: true, valid: true })
    expect(verifySignature(CORPO, `sha256=${hex}`, SEGREDO, AGORA)).toEqual({
      present: true,
      valid: true,
    })
  })

  it('recusa assinatura de outro segredo', () => {
    const header = assinarComTimestamp(CORPO, 'segredo-errado', AGORA)
    const r = verifySignature(CORPO, header, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false, reason: 'assinatura' })
  })

  it('recusa corpo adulterado — é o ponto inteiro da assinatura', () => {
    const header = assinarComTimestamp(CORPO, SEGREDO, AGORA)
    const adulterado = CORPO.replace('"1"', '"999"')
    const r = verifySignature(adulterado, header, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false })
  })

  it('recusa assinatura antiga: proteção contra replay', () => {
    // Tolerância de 5 minutos (§12.3). Seis minutos atrás não passa.
    const header = assinarComTimestamp(CORPO, SEGREDO, AGORA - 6 * 60 * 1000)
    const r = verifySignature(CORPO, header, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false, reason: 'tempo' })
  })

  it('aceita dentro da tolerância', () => {
    const header = assinarComTimestamp(CORPO, SEGREDO, AGORA - 4 * 60 * 1000)
    expect(verifySignature(CORPO, header, SEGREDO, AGORA)).toEqual({ present: true, valid: true })
  })

  it('recusa timestamp no futuro além da tolerância', () => {
    const header = assinarComTimestamp(CORPO, SEGREDO, AGORA + 10 * 60 * 1000)
    const r = verifySignature(CORPO, header, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false, reason: 'tempo' })
  })

  it.each([
    ['header vazio', ''],
    ['lixo', 'não é assinatura'],
    ['hex curto', 'abc123'],
    ['só o timestamp', 't=1785060000'],
    ['só a assinatura', 'v1=abc'],
  ])('recusa %s sem lançar', (_caso, header) => {
    const r = verifySignature(CORPO, header, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false })
  })

  it('segredo configurado e header ausente é recusa, não passe livre', () => {
    // Aceitar sem assinatura anularia a proteção de quem se deu ao trabalho
    // de configurá-la.
    const r = verifySignature(CORPO, null, SEGREDO, AGORA)
    expect(r).toMatchObject({ present: true, valid: false })
  })
})

describe('dedupeHash', () => {
  it('é estável para o mesmo conector e corpo', () => {
    expect(dedupeHash('src-1', CORPO)).toBe(dedupeHash('src-1', CORPO))
  })

  it('difere entre conectores, mesmo com corpo idêntico', () => {
    // Duas plataformas podem mandar payload igual; uma não pode anular a outra.
    expect(dedupeHash('src-1', CORPO)).not.toBe(dedupeHash('src-2', CORPO))
  })

  it('difere para corpos diferentes', () => {
    expect(dedupeHash('src-1', CORPO)).not.toBe(dedupeHash('src-1', `${CORPO} `))
  })
})

describe('generateIngestToken', () => {
  it('gera token seguro em URL', () => {
    const token = generateIngestToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('não repete', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateIngestToken))
    expect(tokens.size).toBe(200)
  })
})
