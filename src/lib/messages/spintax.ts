/**
 * Spintax (§6.5).
 *
 * `{Oi|Olá|E aí}` sorteia uma alternativa a cada envio. Não é enfeite: provedor
 * e o próprio WhatsApp tratam mensagem idêntica em massa como sinal de spam, e
 * o custo de errar isso é o número ser banido.
 *
 * O sorteio é determinístico a partir de uma semente. Assim a prévia do editor
 * é estável entre renderizações, e o texto de um envio pode ser reproduzido a
 * partir do log — mas `rendered_body` continua sendo a fonte da verdade do que
 * o cliente recebeu (§6.5).
 */

export type ErroSpintax = { mensagem: string; posicao: number }

/** Gerador determinístico pequeno (mulberry32). Não precisa ser criptográfico. */
function gerador(semente: number): () => number {
  let estado = semente >>> 0
  return () => {
    estado = (estado + 0x6d2b79f5) >>> 0
    let t = estado
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sementeDeTexto(texto: string): number {
  let hash = 2166136261
  for (let i = 0; i < texto.length; i += 1) {
    hash ^= texto.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

type Resultado = { texto: string; erros: ErroSpintax[] }

/**
 * Sorteia uma combinação. Grupos aninhados valem: `{Oi|{Olá|E aí}}`.
 *
 * `{{variavel}}` é preservado intacto — a chave dupla é atravessada sem
 * interpretação, senão `{{nome|"tudo bem"}}` viraria um sorteio entre `nome` e
 * `"tudo bem"`.
 */
export function resolverSpintax(fonte: string, semente: number): Resultado {
  const aleatorio = gerador(semente)
  const erros: ErroSpintax[] = []
  const texto = expandir(fonte, aleatorio, erros)
  return { texto, erros }
}

function expandir(fonte: string, aleatorio: () => number, erros: ErroSpintax[]): string {
  let saida = ''
  let i = 0

  while (i < fonte.length) {
    const c = fonte[i]!

    if (c === '\\' && fonte[i + 1] === '{') {
      saida += '\\{'
      i += 2
      continue
    }

    // Variável: copia `{{…}}` sem tocar.
    if (c === '{' && fonte[i + 1] === '{') {
      const fim = fonte.indexOf('}}', i + 2)
      if (fim !== -1) {
        saida += fonte.slice(i, fim + 2)
        i = fim + 2
        continue
      }
    }

    if (c === '{') {
      const grupo = lerGrupo(fonte, i)
      if (!grupo) {
        erros.push({ mensagem: 'Chave `{` aberta e não fechada.', posicao: i })
        saida += c
        i += 1
        continue
      }

      // `{só uma opção}` quase sempre é uma chave literal esquecida, não um
      // sorteio de um item só. Avisa em vez de comer a chave em silêncio.
      if (grupo.alternativas.length < 2) {
        erros.push({ mensagem: 'Grupo de variação com uma alternativa só.', posicao: i })
        saida += expandir(grupo.alternativas[0] ?? '', aleatorio, erros)
        i = grupo.fim
        continue
      }

      const escolhida = grupo.alternativas[Math.floor(aleatorio() * grupo.alternativas.length)] ?? ''
      saida += expandir(escolhida, aleatorio, erros)
      i = grupo.fim
      continue
    }

    saida += c
    i += 1
  }

  return saida
}

/** Lê `{a|b|c}` a partir de `inicio`, respeitando aninhamento. */
function lerGrupo(fonte: string, inicio: number): { alternativas: string[]; fim: number } | null {
  const alternativas: string[] = []
  let atual = ''
  let profundidade = 0
  let i = inicio + 1

  while (i < fonte.length) {
    const c = fonte[i]!

    if (c === '\\' && i + 1 < fonte.length) {
      atual += c + fonte[i + 1]
      i += 2
      continue
    }

    // Variável dentro de uma alternativa: atravessa sem contar profundidade.
    if (c === '{' && fonte[i + 1] === '{') {
      const fimVar = fonte.indexOf('}}', i + 2)
      if (fimVar !== -1) {
        atual += fonte.slice(i, fimVar + 2)
        i = fimVar + 2
        continue
      }
    }

    if (c === '{') {
      profundidade += 1
      atual += c
    } else if (c === '}') {
      if (profundidade === 0) {
        alternativas.push(atual)
        return { alternativas, fim: i + 1 }
      }
      profundidade -= 1
      atual += c
    } else if (c === '|' && profundidade === 0) {
      alternativas.push(atual)
      atual = ''
    } else {
      atual += c
    }

    i += 1
  }

  return null
}

/**
 * Quantas combinações o corpo produz. O editor mostra o número: um corpo com
 * uma variação só não protege reputação nenhuma.
 */
export function contarCombinacoes(fonte: string): number {
  let total = 1
  let i = 0

  const contarEm = (texto: string): number => {
    let parcial = 1
    let j = 0
    while (j < texto.length) {
      if (texto[j] === '{' && texto[j + 1] === '{') {
        const fim = texto.indexOf('}}', j + 2)
        j = fim === -1 ? j + 2 : fim + 2
        continue
      }
      if (texto[j] === '{') {
        const grupo = lerGrupo(texto, j)
        if (grupo) {
          parcial *= grupo.alternativas.reduce((soma, alt) => soma + contarEm(alt), 0)
          j = grupo.fim
          continue
        }
      }
      j += 1
    }
    return parcial
  }

  while (i < fonte.length) {
    if (fonte[i] === '{' && fonte[i + 1] === '{') {
      const fim = fonte.indexOf('}}', i + 2)
      i = fim === -1 ? i + 2 : fim + 2
      continue
    }
    if (fonte[i] === '{') {
      const grupo = lerGrupo(fonte, i)
      if (grupo) {
        total *= grupo.alternativas.reduce((soma, alt) => soma + contarEm(alt), 0)
        i = grupo.fim
        continue
      }
    }
    i += 1
  }

  return total
}

/** Amostras distintas para a prévia — §6.5 pede três exemplos ao vivo. */
export function amostras(fonte: string, quantidade = 3): string[] {
  const vistas = new Set<string>()
  // Tenta mais vezes que o necessário: com poucas combinações, sorteios
  // repetem, e mostrar o mesmo texto três vezes não informa nada.
  for (let tentativa = 0; tentativa < quantidade * 12 && vistas.size < quantidade; tentativa += 1) {
    vistas.add(resolverSpintax(fonte, sementeDeTexto(`${fonte}#${tentativa}`)).texto)
  }
  return [...vistas]
}
