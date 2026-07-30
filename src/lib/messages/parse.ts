import { FILTROS, type Bloco, type Documento, type ErroParse, type Filtro, type FiltroNome, type No } from './ast'

/**
 * Analisador do Markdown reduzido de §6.2.
 *
 * Reduzido de propósito: só `**negrito**`, `*itálico*`, `~riscado~`, `` `mono` ``,
 * `[texto](url)`, `---` e `{{variáveis}}`. Markdown completo traria tabelas,
 * títulos e imagens que três dos quatro canais não sabem representar — e o
 * trabalho de decidir o que fazer com eles cairia em cada renderizador.
 *
 * Marcador sem fechamento não é erro fatal: vira texto literal. Quem escreve
 * "2 * 3" não quer um erro de compilação, quer ver "2 * 3".
 */

const ESCAPAVEIS = new Set(['*', '_', '~', '`', '[', ']', '(', ')', '{', '}', '\\', '-'])

const FILTROS_VALIDOS = new Set<string>(FILTROS)

/** `pedido.valor` é caminho; `valor_total` é nome simples. Ambos valem. */
const NOME_VARIAVEL = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/

type Contexto = { fonte: string; erros: ErroParse[] }

export function parseMensagem(fonte: string): Documento {
  const ctx: Contexto = { fonte, erros: [] }
  const blocos: Bloco[] = []

  // Normaliza as quebras antes de qualquer coisa: um corpo colado do Windows
  // encheria os parágrafos de \r invisíveis, e o contador de SMS cobraria por
  // eles.
  const linhas = fonte.replace(/\r\n?/g, '\n').split('\n')

  let acumulado: string[] = []
  let inicioDoBloco = 0
  let posicao = 0

  const fecharParagrafo = (): void => {
    if (acumulado.length === 0) return
    const texto = acumulado.join('\n')
    const filhos = parseInline(texto, inicioDoBloco, ctx)
    if (filhos.length > 0) blocos.push({ tipo: 'paragrafo', filhos })
    acumulado = []
  }

  for (const linha of linhas) {
    const limpa = linha.trim()

    if (limpa === '') {
      fecharParagrafo()
    } else if (/^-{3,}$/.test(limpa)) {
      fecharParagrafo()
      blocos.push({ tipo: 'regua' })
    } else {
      if (acumulado.length === 0) inicioDoBloco = posicao
      acumulado.push(linha)
    }

    posicao += linha.length + 1
  }
  fecharParagrafo()

  return { blocos, erros: ctx.erros }
}

/** Analisa o conteúdo de um parágrafo. `base` é o deslocamento na fonte. */
function parseInline(texto: string, base: number, ctx: Contexto): No[] {
  const nos: No[] = []
  let literal = ''
  let i = 0

  const despejar = (): void => {
    if (literal !== '') {
      nos.push({ tipo: 'texto', valor: literal })
      literal = ''
    }
  }

  while (i < texto.length) {
    const c = texto[i]!

    // Escape: a barra some e o próximo caractere entra literal.
    if (c === '\\' && i + 1 < texto.length && ESCAPAVEIS.has(texto[i + 1]!)) {
      literal += texto[i + 1]
      i += 2
      continue
    }

    if (c === '{' && texto[i + 1] === '{') {
      const fim = texto.indexOf('}}', i + 2)
      if (fim !== -1) {
        const variavel = parseVariavel(texto.slice(i + 2, fim), base + i, ctx)
        if (variavel) {
          despejar()
          nos.push(variavel)
          i = fim + 2
          continue
        }
      }
      literal += c
      i += 1
      continue
    }

    if (c === '`') {
      const fim = texto.indexOf('`', i + 1)
      if (fim > i + 1) {
        despejar()
        // Monoespaçado é literal: nada dentro dele é interpretado. É o único
        // jeito de escrever `**` sem virar negrito.
        nos.push({ tipo: 'mono', valor: texto.slice(i + 1, fim) })
        i = fim + 1
        continue
      }
    }

    if (c === '[') {
      const link = parseLink(texto, i, base, ctx)
      if (link) {
        despejar()
        nos.push(link.no)
        i = link.fim
        continue
      }
    }

    // `**` antes de `*`: a ordem é o que separa negrito de itálico.
    const enfase = parseEnfase(texto, i, base, ctx)
    if (enfase) {
      despejar()
      nos.push(enfase.no)
      i = enfase.fim
      continue
    }

    literal += c
    i += 1
  }

  despejar()
  return nos
}

const ENFASES = [
  ['**', 'negrito'],
  ['*', 'italico'],
  ['~', 'riscado'],
] as const

function parseEnfase(
  texto: string,
  inicio: number,
  base: number,
  ctx: Contexto,
): { no: No; fim: number } | null {
  /*
   * `***x***` primeiro, senão vira lixo: a busca por `**` encontraria o `**`
   * de dentro do `***` final e deixaria um asterisco solto sobrando. Quem
   * escreve copy de sorteio digita isso o tempo todo.
   */
  if (texto.startsWith('***', inicio)) {
    const fim = texto.indexOf('***', inicio + 3)
    const dentro = fim === -1 ? '' : texto.slice(inicio + 3, fim)
    if (fim !== -1 && dentro.trim() !== '') {
      return {
        no: {
          tipo: 'negrito',
          filhos: [{ tipo: 'italico', filhos: parseInline(dentro, base + inicio + 3, ctx) }],
        },
        fim: fim + 3,
      }
    }
  }

  for (const [marca, tipo] of ENFASES) {
    if (!texto.startsWith(marca, inicio)) continue

    const encontrado = texto.indexOf(marca, inicio + marca.length)
    if (encontrado === -1) continue

    const fim = fecharNaCauda(texto, inicio, encontrado, marca)
    if (fim === -1) continue

    const dentro = texto.slice(inicio + marca.length, fim)
    // `* *` não enfatiza nada; deixa o marcador passar como texto literal.
    if (dentro.trim() === '') continue

    return {
      no: { tipo, filhos: parseInline(dentro, base + inicio + marca.length, ctx) },
      fim: fim + marca.length,
    }
  }
  return null
}

/**
 * Onde o marcador de fechamento realmente começa.
 *
 * Em `**forte *e leve***` a busca por `**` cai no começo do `***` final e
 * deixaria um asterisco solto na saída. A sequência de fechamento pertence de
 * fora para dentro: o marcador externo fica com os ÚLTIMOS caracteres da
 * sequência, e os anteriores sobram para o itálico que abriu depois.
 */
function fecharNaCauda(texto: string, inicio: number, encontrado: number, marca: string): number {
  const caractere = marca[0]!
  const limite = inicio + marca.length

  let cauda = encontrado
  while (texto[cauda] === caractere) cauda += 1

  const fim = cauda - marca.length
  return fim >= limite ? fim : encontrado
}

function parseLink(
  texto: string,
  inicio: number,
  base: number,
  ctx: Contexto,
): { no: No; fim: number } | null {
  const fimRotulo = texto.indexOf(']', inicio + 1)
  if (fimRotulo === -1) return null
  if (texto[fimRotulo + 1] !== '(') return null

  const fimUrl = texto.indexOf(')', fimRotulo + 2)
  if (fimUrl === -1) return null

  const rotulo = texto.slice(inicio + 1, fimRotulo)
  const url = texto.slice(fimRotulo + 2, fimUrl)

  if (url.trim() === '') {
    ctx.erros.push({ mensagem: 'Link sem endereço.', posicao: base + inicio })
    return null
  }

  return {
    no: {
      tipo: 'link',
      rotulo: parseInline(rotulo, base + inicio + 1, ctx),
      // O endereço só aceita texto e variáveis — negrito dentro de uma URL não
      // significa nada em canal nenhum.
      url: parseInline(url, base + fimRotulo + 2, ctx).filter(
        (no) => no.tipo === 'texto' || no.tipo === 'variavel',
      ),
    },
    fim: fimUrl + 1,
  }
}

/** Conteúdo entre `{{` e `}}`: nome e filtros separados por `|`. */
function parseVariavel(corpo: string, posicao: number, ctx: Contexto): No | null {
  const partes = dividirFiltros(corpo)
  const nome = partes[0]?.trim() ?? ''

  if (!NOME_VARIAVEL.test(nome)) {
    ctx.erros.push({
      mensagem: nome === '' ? 'Variável sem nome.' : `Nome de variável inválido: ${nome}`,
      posicao,
    })
    return null
  }

  const filtros: Filtro[] = []
  for (const bruto of partes.slice(1)) {
    const parte = bruto.trim()
    if (parte === '') continue

    if (parte.startsWith('"') && parte.endsWith('"') && parte.length >= 2) {
      filtros.push({ tipo: 'padrao', valor: parte.slice(1, -1) })
      continue
    }

    if (FILTROS_VALIDOS.has(parte)) {
      filtros.push({ tipo: 'nomeado', nome: parte as FiltroNome })
      continue
    }

    ctx.erros.push({
      mensagem: `Filtro desconhecido: ${parte}. Disponíveis: ${FILTROS.join(', ')} ou um padrão entre aspas.`,
      posicao,
    })
  }

  return { tipo: 'variavel', nome, filtros }
}

/** Separa por `|`, ignorando os que estiverem dentro de aspas do padrão. */
function dividirFiltros(corpo: string): string[] {
  const partes: string[] = []
  let atual = ''
  let entreAspas = false

  for (let i = 0; i < corpo.length; i += 1) {
    const c = corpo[i]!
    if (c === '"') {
      entreAspas = !entreAspas
      atual += c
    } else if (c === '|' && !entreAspas) {
      partes.push(atual)
      atual = ''
    } else {
      atual += c
    }
  }
  partes.push(atual)
  return partes
}
