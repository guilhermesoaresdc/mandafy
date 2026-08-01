import { describe, expect, it } from 'vitest'
import { avaliarAlertas, LIMIARES, type EstadoParaAlertas } from './alertas'
import type { SaudeCanal } from '@/db/queries/painel'
import type { SaudeInstancia } from '@/db/queries/channels'

const canal = (mudancas: Partial<SaudeCanal> = {}): SaudeCanal => ({
  canal: 'whatsapp',
  enviadas24h: 100,
  falhas24h: 0,
  taxaFalha: 0,
  ...mudancas,
})

const instancia = (mudancas: Partial<SaudeInstancia> = {}): SaudeInstancia => ({
  id: 'i1',
  name: 'Chip 1',
  instanceName: 'chip1',
  status: 'conectado',
  telefone: null,
  estagio: 3,
  estagioLabel: 'Estável',
  enviadasHoje: 10,
  tetoDiario: 300,
  intervaloMinimo: 15,
  falha24h: 0,
  ultimaConexao: null,
  ativa: true,
  peso: 1,
  gerenciada: true,
  semaforo: { cor: 'verde', texto: 'saudável' },
  ...mudancas,
})

const estado = (mudancas: Partial<EstadoParaAlertas> = {}): EstadoParaAlertas => ({
  canais: [canal()],
  instancias: [instancia()],
  naFila: 0,
  ...mudancas,
})

describe('alertas (§10.4)', () => {
  it('operação saudável não gera alerta nenhum', () => {
    expect(avaliarAlertas(estado())).toEqual([])
  })

  it('instância banida é crítico', () => {
    const alertas = avaliarAlertas(estado({ instancias: [instancia({ status: 'banido' })] }))
    expect(alertas[0]).toMatchObject({ nivel: 'critico' })
    expect(alertas[0]?.titulo).toContain('banido')
  })

  it('instância desconectada é crítico', () => {
    const alertas = avaliarAlertas(estado({ instancias: [instancia({ status: 'desconectado' })] }))
    expect(alertas.some((a) => a.titulo.includes('desconectou'))).toBe(true)
  })

  it('instância pausada por escolha NÃO alerta', () => {
    // Foi decisão de quem opera; avisar de novo é ruído.
    const alertas = avaliarAlertas(
      estado({ instancias: [instancia({ ativa: false, status: 'desconectado' })] }),
    )
    expect(alertas).toEqual([])
  })

  it('mas banimento alerta mesmo com a instância pausada', () => {
    const alertas = avaliarAlertas(
      estado({ instancias: [instancia({ ativa: false, status: 'banido' })] }),
    )
    expect(alertas).toHaveLength(1)
  })

  it('falha acima de 3% na instância é atenção — é o limiar do aquecimento', () => {
    const alertas = avaliarAlertas(estado({ instancias: [instancia({ falha24h: 0.05 })] }))
    expect(alertas[0]).toMatchObject({ nivel: 'atencao' })
    expect(alertas[0]?.titulo).toContain('5.0%')
  })

  it('teto do dia atingido é atenção, não crítico — é limite planejado', () => {
    const alertas = avaliarAlertas(
      estado({ instancias: [instancia({ enviadasHoje: 300, tetoDiario: 300 })] }),
    )
    expect(alertas[0]?.nivel).toBe('atencao')
  })

  it('canal falhando acima de 10% é crítico', () => {
    const alertas = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 80, falhas24h: 20, taxaFalha: 0.2 })] }),
    )
    expect(alertas.some((a) => a.nivel === 'critico' && a.titulo.includes('20%'))).toBe(true)
  })

  it('amostra pequena NÃO alerta, mesmo com taxa alta', () => {
    // 1 falha em 2 envios é 50% — acordar alguém por isso ensina a ignorar.
    const alertas = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 1, falhas24h: 1, taxaFalha: 0.5 })] }),
    )
    expect(alertas).toEqual([])
  })

  it('a amostra mínima é o limite exato, não aproximado', () => {
    const abaixo = avaliarAlertas(
      estado({
        canais: [canal({ enviadas24h: LIMIARES.amostraMinima - 1, falhas24h: 0, taxaFalha: 0.5 })],
      }),
    )
    const acima = avaliarAlertas(
      estado({
        canais: [canal({ enviadas24h: LIMIARES.amostraMinima, falhas24h: 0, taxaFalha: 0.5 })],
      }),
    )
    expect(abaixo).toEqual([])
    expect(acima).toHaveLength(1)
  })

  it('canal sem envio nenhum não alerta', () => {
    const alertas = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 0, falhas24h: 0, taxaFalha: null })] }),
    )
    expect(alertas).toEqual([])
  })

  it('exatamente 10% não alerta; acima disso, sim', () => {
    const noLimite = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 90, falhas24h: 10, taxaFalha: 0.1 })] }),
    )
    const acima = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 89, falhas24h: 11, taxaFalha: 0.11 })] }),
    )
    expect(noLimite).toEqual([])
    expect(acima).toHaveLength(1)
  })

  it('fila acima de 500 é atenção', () => {
    expect(avaliarAlertas(estado({ naFila: 501 }))).toHaveLength(1)
    expect(avaliarAlertas(estado({ naFila: 500 }))).toEqual([])
  })

  it('crítico vem antes de atenção', () => {
    const alertas = avaliarAlertas(
      estado({
        naFila: 900,
        instancias: [instancia({ status: 'banido' })],
      }),
    )
    expect(alertas.map((a) => a.nivel)).toEqual(['critico', 'atencao'])
  })

  it('todo alerta diz o que fazer, não só o que houve', () => {
    const alertas = avaliarAlertas(
      estado({ naFila: 900, instancias: [instancia({ status: 'banido' })] }),
    )
    expect(alertas.every((a) => a.acao.length > 20)).toBe(true)
  })
})
