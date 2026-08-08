import { describe, expect, it } from 'vitest'
import { avaliarAlertas, LIMIARES, type EstadoParaAlertas } from './alertas'
import type { SaudeCanal } from '@/db/queries/painel'
import type { SaudeInstancia } from '@/db/queries/channels'
import type { Channel } from '@/db/schema/enums'

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

  /*
   * ── O QUE IMPEDE O SISTEMA DE TRABALHAR ──
   *
   * Os casos acima dizem que algo está indo mal. Estes dizem que nada está
   * indo — e eram justamente os que o painel não sabia contar. Uma banca
   * recém-conectada via oito zeros e nenhum aviso.
   */

  const AGORA = new Date('2026-08-08T18:00:00Z')
  const pronto = (canal: Channel, ok = true) => ({
    canal,
    pronto: ok,
    motivo: ok ? null : 'falta a chave do provedor',
  })

  it('nenhum canal pronto é crítico, e traz o motivo que já estava escrito', () => {
    const alertas = avaliarAlertas(
      estado({
        prontidao: [pronto('whatsapp', false), pronto('sms', false)],
        agora: AGORA,
      }),
    )

    expect(alertas[0]).toMatchObject({ nivel: 'critico', href: '/canais' })
    expect(alertas[0]?.titulo).toContain('Nenhum canal conectado')
    // O motivo em português vem de `prontidaoDosCanais` e ficava sem leitor.
    expect(alertas[0]?.acao).toContain('falta a chave do provedor')
  })

  it('com um canal de pé, não diz que nenhum está conectado', () => {
    const alertas = avaliarAlertas(
      estado({ prontidao: [pronto('whatsapp'), pronto('sms', false)], agora: AGORA }),
    )
    expect(alertas.some((a) => a.titulo.includes('Nenhum canal conectado'))).toBe(false)
  })

  it('canal derrubado pelo disjuntor aparece mesmo com outro de pé', () => {
    // Sem isto o canal sai do rodízio em silêncio: o resto continua saindo, e
    // ninguém descobre que o SMS parou até alguém procurar.
    const alertas = avaliarAlertas(
      estado({
        prontidao: [
          pronto('whatsapp'),
          { canal: 'sms', pronto: false, motivo: 'desligado sozinho depois de 2 falhas seguidas' },
        ],
        agora: AGORA,
      }),
    )

    expect(alertas.some((a) => a.titulo.includes('SMS') && a.titulo.includes('caiu'))).toBe(true)
  })

  it('batimento parado há 3h é crítico; há 1h, não', () => {
    const parado = avaliarAlertas(
      estado({ batimento: new Date('2026-08-08T15:00:00Z'), agora: AGORA }),
    )
    expect(parado.some((a) => a.titulo === 'As mensagens não estão saindo')).toBe(true)

    const recente = avaliarAlertas(
      estado({ batimento: new Date('2026-08-08T17:00:00Z'), agora: AGORA }),
    )
    expect(recente.some((a) => a.titulo === 'As mensagens não estão saindo')).toBe(false)
  })

  it('batimento que nunca rodou é crítico e diz isso', () => {
    const alertas = avaliarAlertas(estado({ batimento: null, agora: AGORA }))
    const alerta = alertas.find((a) => a.titulo === 'As mensagens não estão saindo')
    expect(alerta?.acao).toContain('nunca rodou')
  })

  /*
   * Fila grande é normal às 19h de sábado de sorteio. O que não é normal é a
   * hora marcada já ter passado e a mensagem continuar lá — este alerta separa
   * "tem muita coisa para sair" de "não está saindo nada".
   */
  it('mensagem vencida há 42 min alerta; há 5 min, não', () => {
    const presa = avaliarAlertas(
      estado({ vencidaDesde: new Date('2026-08-08T17:18:00Z'), agora: AGORA }),
    )
    expect(presa.some((a) => a.titulo.includes('42 min'))).toBe(true)

    const recente = avaliarAlertas(
      estado({ vencidaDesde: new Date('2026-08-08T17:55:00Z'), agora: AGORA }),
    )
    expect(recente.some((a) => a.titulo.includes('espera há'))).toBe(false)
  })

  it('evento chegando sem fluxo que escute é crítico', () => {
    const alertas = avaliarAlertas(
      estado({
        noAr: { ligados: 3, semOuvinte: [{ type: 'order.paid', total: 143 }] },
        agora: AGORA,
      }),
    )

    const alerta = alertas.find((a) => a.titulo.includes('143'))
    expect(alerta).toMatchObject({ nivel: 'critico', href: '/fluxos' })
  })

  it('nenhum fluxo ligado, e nenhum evento perdido, é só atenção', () => {
    const alertas = avaliarAlertas(estado({ noAr: { ligados: 0, semOuvinte: [] }, agora: AGORA }))
    expect(alertas.find((a) => a.titulo === 'Nenhum fluxo ligado')).toMatchObject({
      nivel: 'atencao',
    })
  })

  /*
   * A REGRA PERMANENTE: se a frase manda abrir uma tela, ela virou link.
   *
   * "Abra o histórico filtrado por este canal" era uma instrução de navegação
   * escrita à mão para uma tela que nem aceitava ser apontada.
   */
  it('nenhum alerta manda abrir uma tela por extenso', () => {
    const todos = [
      ...avaliarAlertas(estado({ prontidao: [pronto('whatsapp', false)], agora: AGORA })),
      ...avaliarAlertas(estado({ batimento: null, agora: AGORA })),
      ...avaliarAlertas(estado({ naFila: LIMIARES.filaPendente + 1 })),
      ...avaliarAlertas(
        estado({ canais: [canal({ enviadas24h: 50, falhas24h: 50, taxaFalha: 0.5 })] }),
      ),
    ]

    expect(todos.length).toBeGreaterThan(0)
    for (const alerta of todos) {
      expect(alerta.acao).not.toMatch(/\bAbra o\b|\bVá em\b|\bAcesse\b/)
    }
  })

  it('o alerta de falha por canal leva ao histórico já filtrado', () => {
    const alertas = avaliarAlertas(
      estado({ canais: [canal({ enviadas24h: 50, falhas24h: 50, taxaFalha: 0.5 })] }),
    )
    expect(alertas[0]?.href).toBe('/historico?canais=whatsapp&status=failed,dead&horas=24')
  })
})
