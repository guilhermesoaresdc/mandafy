/**
 * Leitura de CSV de lista de contatos (§9.1).
 *
 * PURO DE PROPÓSITO
 *
 * Nada de banco e nada de rede: recebe texto, devolve linhas. É o que permite
 * testar contra os arquivos que quebram de verdade — e um importador de lista
 * quebra sempre pelo arquivo, não pela lógica.
 *
 * POR QUE NÃO UMA BIBLIOTECA
 *
 * O que separa um parser de CSV de um `split(',')` são quatro coisas: aspas,
 * aspas dentro de aspas, quebra de linha DENTRO do campo, e o BOM que o Excel
 * põe no começo. Todas cabem aqui e todas têm teste. Uma dependência a mais
 * exigiria perguntar (regra da stack) e resolveria o mesmo.
 *
 * O SEPARADOR NÃO É SEMPRE VÍRGULA
 *
 * Excel em português salva CSV com PONTO E VÍRGULA, porque a vírgula é o
 * separador decimal. É o formato que vai chegar na maioria das vezes, e um
 * importador que só aceita vírgula lê a planilha inteira como uma coluna só —
 * sem erro, o que é pior. Por isso o separador é detectado.
 */

export type LinhaCsv = Record<string, string>

export type LeituraCsv = {
  /** Cabeçalhos na ordem em que apareceram, já normalizados. */
  colunas: string[]
  linhas: LinhaCsv[]
  separador: ',' | ';' | '\t'
}

/**
 * Descobre o separador pela PRIMEIRA linha.
 *
 * Conta ocorrências fora de aspas e escolhe a maior. Empate vai para a vírgula,
 * que é o padrão do formato.
 */
export function detectarSeparador(primeiraLinha: string): ',' | ';' | '\t' {
  const candidatos: (',' | ';' | '\t')[] = [',', ';', '\t']
  let melhor: ',' | ';' | '\t' = ','
  let maior = 0

  for (const sep of candidatos) {
    let contagem = 0
    let dentroDeAspas = false

    for (let i = 0; i < primeiraLinha.length; i += 1) {
      const c = primeiraLinha[i]
      if (c === '"') dentroDeAspas = !dentroDeAspas
      else if (c === sep && !dentroDeAspas) contagem += 1
    }

    if (contagem > maior) {
      maior = contagem
      melhor = sep
    }
  }

  return melhor
}

/**
 * Divide o texto em células, respeitando aspas.
 *
 * Uma máquina de estados de um passo só. A alternativa — expressão regular —
 * não dá conta de quebra de linha dentro de campo, que é justamente o caso que
 * aparece quando alguém exporta um endereço de duas linhas.
 */
function dividir(texto: string, separador: string): string[][] {
  const linhas: string[][] = []
  let linha: string[] = []
  let celula = ''
  let dentroDeAspas = false

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i]

    if (dentroDeAspas) {
      if (c === '"') {
        // `""` dentro de aspas é uma aspa literal.
        if (texto[i + 1] === '"') {
          celula += '"'
          i += 1
        } else {
          dentroDeAspas = false
        }
      } else {
        celula += c
      }
      continue
    }

    if (c === '"') {
      dentroDeAspas = true
      continue
    }

    if (c === separador) {
      linha.push(celula)
      celula = ''
      continue
    }

    if (c === '\n' || c === '\r') {
      // CRLF conta como uma quebra só.
      if (c === '\r' && texto[i + 1] === '\n') i += 1
      linha.push(celula)
      linhas.push(linha)
      linha = []
      celula = ''
      continue
    }

    celula += c
  }

  // A última linha só entra se tiver conteúdo — arquivo terminado em quebra de
  // linha não deve produzir uma linha vazia no fim.
  if (celula !== '' || linha.length > 0) {
    linha.push(celula)
    linhas.push(linha)
  }

  return linhas
}

/**
 * Normaliza um cabeçalho para comparação.
 *
 * Sem acento, sem espaço, minúsculo: "Telefone", "TELEFONE" e "telefone " são a
 * mesma coluna, e quem monta a planilha não deveria precisar saber disso.
 */
export function normalizarCabecalho(bruto: string): string {
  return bruto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

export function lerCsv(texto: string): LeituraCsv {
  // O Excel grava um BOM no começo. Sem tirar, a primeira coluna se chama
  // "﻿nome" e nenhum mapeamento automático a reconhece.
  const limpo = texto.replace(/^﻿/, '')

  const primeira = limpo.split(/\r?\n/, 1)[0] ?? ''
  const separador = detectarSeparador(primeira)

  const bruto = dividir(limpo, separador)
  if (bruto.length === 0) return { colunas: [], linhas: [], separador }

  const colunas = (bruto[0] ?? []).map(normalizarCabecalho)

  const linhas: LinhaCsv[] = []
  for (const celulas of bruto.slice(1)) {
    // Linha totalmente vazia é resíduo de planilha, não dado.
    if (celulas.every((c) => c.trim() === '')) continue

    const linha: LinhaCsv = {}
    colunas.forEach((coluna, i) => {
      if (coluna === '') return
      linha[coluna] = (celulas[i] ?? '').trim()
    })
    linhas.push(linha)
  }

  return { colunas: colunas.filter((c) => c !== ''), linhas, separador }
}

// ── Mapeamento automático ────────────────────────────────────────────────────

/** Os campos que o importador sabe preencher. */
export type CampoDestino =
  | 'nome'
  | 'telefone'
  | 'email'
  | 'cpf'
  | 'external_id'
  | 'tags'
  | 'valor_cents'
  | 'titulo'

/**
 * Nomes de coluna que apontam para cada campo.
 *
 * Inclui os cabeçalhos que o PRÓPRIO sistema exporta (`contato`, `valor_cents`,
 * `lead`) — exportar, ajustar na planilha e importar de volta é o caminho mais
 * usado de todos, e ele tem de funcionar sem remapear nada à mão.
 */
const SINONIMOS: Record<CampoDestino, readonly string[]> = {
  nome: ['nome', 'contato', 'cliente', 'nome_completo', 'name', 'full_name', 'apostador'],
  telefone: ['telefone', 'celular', 'whatsapp', 'fone', 'phone', 'tel', 'numero', 'msisdn'],
  email: ['email', 'e_mail', 'mail'],
  cpf: ['cpf', 'documento', 'doc'],
  external_id: ['external_id', 'id_externo', 'codigo', 'id', 'matricula'],
  tags: ['tags', 'etiquetas', 'marcadores'],
  valor_cents: ['valor_cents', 'valor', 'total', 'valor_total'],
  titulo: ['titulo', 'lead', 'oportunidade', 'descricao'],
}

/**
 * Adivinha o destino de cada coluna.
 *
 * Só sugere: a tela mostra o resultado e deixa corrigir. Adivinhar errado e
 * importar sem mostrar seria gravar telefone na coluna de CPF em silêncio.
 */
export function mapearColunas(colunas: string[]): Partial<Record<CampoDestino, string>> {
  const mapa: Partial<Record<CampoDestino, string>> = {}

  for (const [campo, nomes] of Object.entries(SINONIMOS) as [CampoDestino, readonly string[]][]) {
    const achada = colunas.find((c) => nomes.includes(c))
    if (achada) mapa[campo] = achada
  }

  /*
   * `id` é sinônimo fraco: numa planilha exportada de outro sistema ele é o id
   * de lá, e serve como `external_id`. Mas se já houver uma coluna melhor, ela
   * ganha — por isso a busca acima é por ordem da lista, e `external_id` e
   * `id_externo` vêm antes.
   */
  return mapa
}
