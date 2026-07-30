import { describe, expect, it } from 'vitest'
import {
  avaliarEscada,
  disponibilidade,
  escolherInstancia,
  estagioDe,
  limitesDoEstagio,
  semaforo,
  type InstanciaWhatsapp,
} from './warmup'

const AGORA = new Date('2026-07-30T12:00:00Z')
const diasAtras = (n: number) => new Date(AGORA.getTime() - n * 24 * 3600 * 1000)

const instancia = (mudancas: Partial<InstanciaWhatsapp> = {}): InstanciaWhatsapp => ({
  id: 'i1',
  name: 'Número 1',
  status: 'conectado',
  warmupStage: 0,
  warmupStartedAt: diasAtras(1),
  dailyCap: 20,
  minIntervalSeconds: 60,
  sentToday: 0,
  lastSentAt: null,
  failureRate24h: 0,
  weight: 1,
  active: true,
  ...mudancas,
})

describe('escada de aquecimento (§7.3)', () => {
  it('os tetos batem com a tabela da spec', () => {
    expect(limitesDoEstagio(0)).toEqual({ dailyCap: 20, minIntervalSeconds: 60 })
    expect(limitesDoEstagio(3)).toEqual({ dailyCap: 300, minIntervalSeconds: 15 })
    expect(limitesDoEstagio(5)).toEqual({ dailyCap: 1000, minIntervalSeconds: 5 })
  })

  it('estágio fora da faixa não estoura', () => {
    expect(estagioDe(-3).stage).toBe(0)
    expect(estagioDe(99).stage).toBe(5)
  })

  it('sobe quando cumpriu os dias e a falha está baixa', () => {
    const d = avaliarEscada(
      { warmupStage: 0, warmupStartedAt: diasAtras(4), failureRate24h: 0.01 },
      AGORA,
    )
    expect(d.acao).toBe('subir')
    expect(d.estagio).toBe(1)
  })

  it('NÃO sobe antes dos dias mínimos', () => {
    const d = avaliarEscada(
      { warmupStage: 0, warmupStartedAt: diasAtras(1), failureRate24h: 0 },
      AGORA,
    )
    expect(d.acao).toBe('manter')
    expect(d.motivo).toContain('faltam')
  })

  it('NÃO sobe com falha acima de 3% — a regra dura de §7.3', () => {
    const d = avaliarEscada(
      { warmupStage: 1, warmupStartedAt: diasAtras(60), failureRate24h: 0.05 },
      AGORA,
    )
    expect(d.acao).toBe('rebaixar')
  })

  it('falha alta rebaixa mesmo com tempo de sobra', () => {
    const d = avaliarEscada(
      { warmupStage: 4, warmupStartedAt: diasAtras(400), failureRate24h: 0.04 },
      AGORA,
    )
    expect(d.acao).toBe('rebaixar')
    expect(d.estagio).toBe(3)
    expect(d.motivo).toContain('4.0%')
  })

  it('no estágio 0 não há para onde rebaixar', () => {
    const d = avaliarEscada(
      { warmupStage: 0, warmupStartedAt: diasAtras(10), failureRate24h: 0.9 },
      AGORA,
    )
    expect(d.acao).toBe('manter')
    expect(d.estagio).toBe(0)
  })

  it('desconexões repetidas rebaixam', () => {
    const d = avaliarEscada(
      { warmupStage: 3, warmupStartedAt: diasAtras(100), failureRate24h: 0 },
      AGORA,
      { desconexoesRecentes: 3 },
    )
    expect(d.acao).toBe('rebaixar')
    expect(d.motivo).toContain('desconexões')
  })

  it('cinco falhas seguidas rebaixam, e vencem qualquer outro sinal', () => {
    const d = avaliarEscada(
      { warmupStage: 5, warmupStartedAt: diasAtras(400), failureRate24h: 0 },
      AGORA,
      { falhasSeguidas: 5 },
    )
    expect(d.acao).toBe('rebaixar')
    expect(d.estagio).toBe(4)
  })

  it('o topo da escada apenas se mantém', () => {
    const d = avaliarEscada(
      { warmupStage: 5, warmupStartedAt: diasAtras(400), failureRate24h: 0 },
      AGORA,
    )
    expect(d.acao).toBe('manter')
    expect(d.motivo).toContain('topo')
  })

  it('sem data de início não sobe — não há de onde contar os dias', () => {
    const d = avaliarEscada({ warmupStage: 0, warmupStartedAt: null, failureRate24h: 0 }, AGORA)
    expect(d.acao).toBe('manter')
  })
})

describe('disponibilidade da instância (§5.3, regra 8)', () => {
  it('conectada e com folga está disponível', () => {
    expect(disponibilidade(instancia(), AGORA)).toEqual({ disponivel: true })
  })

  it('banida nunca envia', () => {
    expect(disponibilidade(instancia({ status: 'banido' }), AGORA)).toMatchObject({
      disponivel: false,
      motivo: 'banida',
    })
  })

  it('desconectada não envia', () => {
    expect(disponibilidade(instancia({ status: 'desconectado' }), AGORA)).toMatchObject({
      motivo: 'desconectada',
    })
  })

  it('teto diário bloqueia', () => {
    expect(disponibilidade(instancia({ sentToday: 20, dailyCap: 20 }), AGORA)).toMatchObject({
      motivo: 'teto_diario',
    })
  })

  it('intervalo mínimo bloqueia e informa quando libera', () => {
    const d = disponibilidade(
      instancia({ lastSentAt: new Date(AGORA.getTime() - 30_000), minIntervalSeconds: 60 }),
      AGORA,
    )
    expect(d).toMatchObject({ disponivel: false, motivo: 'intervalo' })
    if (!d.disponivel) {
      expect(d.liberaEm?.getTime()).toBe(AGORA.getTime() + 30_000)
    }
  })

  it('passado o intervalo, libera', () => {
    const d = disponibilidade(
      instancia({ lastSentAt: new Date(AGORA.getTime() - 61_000), minIntervalSeconds: 60 }),
      AGORA,
    )
    expect(d.disponivel).toBe(true)
  })
})

describe('rodízio (§7.3)', () => {
  it('escolhe entre as disponíveis', () => {
    const r = escolherInstancia(
      [instancia({ id: 'a' }), instancia({ id: 'b', status: 'desconectado' })],
      AGORA,
    )
    expect(r.escolhida?.id).toBe('a')
  })

  it('quando uma bate o teto, a fila migra para a próxima', () => {
    const r = escolherInstancia(
      [instancia({ id: 'cheia', sentToday: 20, dailyCap: 20 }), instancia({ id: 'livre' })],
      AGORA,
    )
    expect(r.escolhida?.id).toBe('livre')
  })

  it('sem nenhuma disponível, informa quando a primeira libera', () => {
    const r = escolherInstancia(
      [
        instancia({ id: 'a', lastSentAt: new Date(AGORA.getTime() - 10_000), minIntervalSeconds: 60 }),
        instancia({ id: 'b', lastSentAt: new Date(AGORA.getTime() - 50_000), minIntervalSeconds: 60 }),
      ],
      AGORA,
    )
    expect(r.escolhida).toBeNull()
    if (r.escolhida === null) {
      // A que libera antes é a `b`: 50s já passaram dos 60.
      expect(r.proximaLiberacao?.getTime()).toBe(AGORA.getTime() + 10_000)
    }
  })

  it('todas banidas: sem escolha e sem previsão', () => {
    const r = escolherInstancia([instancia({ status: 'banido' })], AGORA)
    expect(r.escolhida).toBeNull()
    if (r.escolhida === null) expect(r.proximaLiberacao).toBeNull()
  })

  it('o peso configurado inclina a escolha', () => {
    const lista = [instancia({ id: 'leve', weight: 1 }), instancia({ id: 'pesada', weight: 99 })]
    // Sorteio no fim da faixa cai na de peso maior.
    expect(escolherInstancia(lista, AGORA, () => 0.99).escolhida?.id).toBe('pesada')
    expect(escolherInstancia(lista, AGORA, () => 0).escolhida?.id).toBe('leve')
  })

  it('a folga no teto também pesa — senão todas batem no limite juntas', () => {
    const lista = [
      instancia({ id: 'quase-cheia', dailyCap: 100, sentToday: 99, weight: 1 }),
      instancia({ id: 'vazia', dailyCap: 100, sentToday: 0, weight: 1 }),
    ]
    const escolhas = Array.from({ length: 400 }, (_, i) =>
      escolherInstancia(lista, AGORA, () => i / 400).escolhida?.id,
    )
    const vazia = escolhas.filter((id) => id === 'vazia').length
    expect(vazia).toBeGreaterThan(escolhas.length * 0.9)
  })
})

describe('semáforo do painel de saúde (§7.3)', () => {
  it('saudável é verde', () => {
    expect(semaforo(instancia()).cor).toBe('verde')
  })

  it('banido é vermelho', () => {
    expect(semaforo(instancia({ status: 'banido' })).cor).toBe('vermelho')
  })

  it('desconectado é vermelho', () => {
    expect(semaforo(instancia({ status: 'desconectado' })).cor).toBe('vermelho')
  })

  it('falha acima de 3% é vermelho', () => {
    expect(semaforo(instancia({ failureRate24h: 0.06 })).cor).toBe('vermelho')
  })

  it('perto do teto é âmbar', () => {
    expect(semaforo(instancia({ sentToday: 17, dailyCap: 20 })).cor).toBe('ambar')
  })

  it('teto atingido é âmbar, não vermelho — é limite planejado', () => {
    expect(semaforo(instancia({ sentToday: 20, dailyCap: 20 })).cor).toBe('ambar')
  })

  it('pausado por escolha é âmbar', () => {
    expect(semaforo(instancia({ active: false })).cor).toBe('ambar')
  })
})
