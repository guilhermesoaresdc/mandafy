import { describe, expect, it } from 'vitest'
import { detectarSeparador, lerCsv, mapearColunas, normalizarCabecalho } from './csv'

/**
 * Leitura de CSV (§9.1).
 *
 * Cada caso aqui é um arquivo que chega de verdade. Um importador de lista
 * quebra pelo ARQUIVO, não pela lógica: o Excel em português grava com ponto e
 * vírgula, põe BOM no começo, e a planilha vem com uma linha em branco no fim
 * que alguém deixou ao apagar um registro.
 *
 * O modo de falha que importa não é o erro — é ler errado e não avisar. Ler a
 * planilha inteira como uma coluna só, porque o separador era `;`, produz uma
 * importação de zero contatos com cara de sucesso.
 */

describe('§9.1 — leitura de CSV', () => {
  it('lê o básico', () => {
    const r = lerCsv('nome,telefone\nMaria,11988887777\nJoão,11977776666')

    expect(r.colunas).toEqual(['nome', 'telefone'])
    expect(r.linhas).toEqual([
      { nome: 'Maria', telefone: '11988887777' },
      { nome: 'João', telefone: '11977776666' },
    ])
  })

  /*
   * O caso mais comum no Brasil, e o que falha em silêncio: Excel em português
   * usa `;` porque a vírgula é o separador decimal.
   */
  it('detecta ponto e vírgula, que é como o Excel brasileiro grava', () => {
    const r = lerCsv('nome;telefone;valor\nMaria;11988887777;10,50')

    expect(r.separador).toBe(';')
    expect(r.colunas).toEqual(['nome', 'telefone', 'valor'])
    expect(r.linhas[0]).toEqual({ nome: 'Maria', telefone: '11988887777', valor: '10,50' })
  })

  it('detecta tabulação', () => {
    expect(lerCsv('nome\ttelefone\nMaria\t11988887777').separador).toBe('\t')
  })

  /* O BOM do Excel faz a primeira coluna se chamar "﻿nome" e nada a reconhece. */
  it('descarta o BOM do Excel', () => {
    const r = lerCsv('﻿nome,telefone\nMaria,11988887777')
    expect(r.colunas[0]).toBe('nome')
  })

  it('respeita aspas, inclusive com o separador dentro', () => {
    const r = lerCsv('nome,obs\n"Silva, Maria","mora em São Paulo, SP"')

    expect(r.linhas[0]).toEqual({ nome: 'Silva, Maria', obs: 'mora em São Paulo, SP' })
  })

  it('entende aspas escapadas', () => {
    const r = lerCsv('nome\n"Maria ""Tia"" Silva"')
    expect(r.linhas[0]?.nome).toBe('Maria "Tia" Silva')
  })

  /* Endereço de duas linhas dentro de uma célula é o caso que derruba split(). */
  it('aceita quebra de linha dentro do campo', () => {
    const r = lerCsv('nome,endereco\nMaria,"Rua A, 10\nApto 20"')

    expect(r.linhas).toHaveLength(1)
    expect(r.linhas[0]?.endereco).toBe('Rua A, 10\nApto 20')
  })

  it('aceita CRLF', () => {
    const r = lerCsv('nome,telefone\r\nMaria,11988887777\r\n')
    expect(r.linhas).toHaveLength(1)
  })

  /* Planilha quase sempre termina com linhas em branco de registro apagado. */
  it('ignora linha vazia', () => {
    const r = lerCsv('nome,telefone\nMaria,11988887777\n\n,\n')
    expect(r.linhas).toHaveLength(1)
  })

  it('preenche o que faltar na linha curta', () => {
    const r = lerCsv('nome,telefone,email\nMaria,11988887777')
    expect(r.linhas[0]).toEqual({ nome: 'Maria', telefone: '11988887777', email: '' })
  })

  it('arquivo só com cabeçalho não é erro, é lista vazia', () => {
    const r = lerCsv('nome,telefone')
    expect(r.colunas).toEqual(['nome', 'telefone'])
    expect(r.linhas).toEqual([])
  })

  it('arquivo vazio não quebra', () => {
    expect(lerCsv('').linhas).toEqual([])
  })

  it('normaliza cabeçalho: acento, caixa e espaço', () => {
    expect(normalizarCabecalho(' Telefone ')).toBe('telefone')
    expect(normalizarCabecalho('E-mail')).toBe('e_mail')
    expect(normalizarCabecalho('Código')).toBe('codigo')
    expect(normalizarCabecalho('Nome Completo')).toBe('nome_completo')
  })

  it('empate no separador fica na vírgula, que é o padrão', () => {
    expect(detectarSeparador('a,b')).toBe(',')
    expect(detectarSeparador('umacolunasozinha')).toBe(',')
  })
})

describe('§9.1 — mapeamento automático de colunas', () => {
  it('reconhece os nomes mais comuns', () => {
    const mapa = mapearColunas(['nome', 'telefone', 'email', 'cpf'])

    expect(mapa).toEqual({ nome: 'nome', telefone: 'telefone', email: 'email', cpf: 'cpf' })
  })

  it('reconhece sinônimos do dia a dia', () => {
    const mapa = mapearColunas(['cliente', 'whatsapp', 'e_mail'])

    expect(mapa.nome).toBe('cliente')
    expect(mapa.telefone).toBe('whatsapp')
    expect(mapa.email).toBe('e_mail')
  })

  /*
   * Exportar, ajustar na planilha e importar de volta é o caminho mais usado
   * de todos. Os cabeçalhos que o próprio sistema exporta precisam ser
   * reconhecidos sem ninguém remapear nada à mão.
   */
  it('reconhece o cabeçalho que o próprio sistema exporta', () => {
    const doExport = [
      'lead',
      'contato',
      'telefone',
      'email',
      'etapa',
      'status',
      'responsavel',
      'valor_cents',
      'origem',
      'criado_em',
      'ultimo_evento',
    ]

    const mapa = mapearColunas(doExport)

    expect(mapa.nome).toBe('contato')
    expect(mapa.telefone).toBe('telefone')
    expect(mapa.email).toBe('email')
    expect(mapa.titulo).toBe('lead')
    expect(mapa.valor_cents).toBe('valor_cents')
  })

  it('coluna desconhecida simplesmente não é mapeada', () => {
    expect(mapearColunas(['coluna_estranha'])).toEqual({})
  })
})
