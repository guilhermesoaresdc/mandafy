/**
 * Extração de valores por caminho, no subconjunto de JSONPath que a spec usa
 * em §4.2: `$.data.order.amount`, com suporte a índice de array
 * (`$.items[0].id`) e ao curinga de primeiro elemento (`$.items[*].id`).
 *
 * Por que não uma biblioteca de JSONPath: a spec fixa a stack e o orçamento de
 * §13. O que é preciso aqui são caminhos literais — não filtros, não recursão,
 * não expressões. Uma implementação de 40 linhas cobre o caso e não traz
 * avaliador de expressão nenhum para dentro do sistema, o que também elimina a
 * superfície de ataque de um payload malicioso vindo de webhook.
 */

/** Um segmento de caminho: nome de propriedade ou índice de array. */
type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'first' }

const MAX_DEPTH = 32

/**
 * Divide `$.data.order[0].id` em segmentos.
 * Aceita com ou sem o `$.` inicial, e também a forma `data.order`.
 */
export function parsePath(path: string): Segment[] {
  const limpo = path.trim().replace(/^\$\.?/, '')
  if (limpo === '') return []

  const segments: Segment[] = []

  for (const bruto of limpo.split('.')) {
    if (bruto === '') continue

    // Separa `items[0]` em `items` + índice, aceitando vários índices.
    const match = /^([^[\]]*)((?:\[[^[\]]*\])*)$/.exec(bruto)
    if (!match) return []

    const [, nome, indices = ''] = match
    if (nome) segments.push({ kind: 'key', key: nome })

    for (const idx of indices.matchAll(/\[([^[\]]*)\]/g)) {
      const conteudo = (idx[1] ?? '').trim()
      if (conteudo === '*') {
        segments.push({ kind: 'first' })
      } else {
        const n = Number(conteudo)
        if (!Number.isInteger(n) || n < 0) return []
        segments.push({ kind: 'index', index: n })
      }
    }

    if (segments.length > MAX_DEPTH) return []
  }

  return segments
}

/**
 * Lê o valor em `path` dentro de `source`.
 * Devolve `undefined` para caminho inexistente, inválido ou que atravesse um
 * tipo incompatível — nunca lança. Payload de webhook é dado hostil.
 */
export function getByPath(source: unknown, path: string): unknown {
  const segments = parsePath(path)
  if (segments.length === 0) return path.trim().replace(/^\$\.?/, '') === '' ? source : undefined

  let current: unknown = source

  for (const segment of segments) {
    if (current == null) return undefined

    if (segment.kind === 'key') {
      // Só objetos comuns. Array com chave textual e primitivo com propriedade
      // (`"texto".length`) não são acessos legítimos de payload.
      if (typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[segment.key]
      continue
    }

    if (!Array.isArray(current)) return undefined
    current = segment.kind === 'first' ? current[0] : current[segment.index]
  }

  return current
}

/**
 * Todos os caminhos folha de um payload, para a tela de mapeamento visual
 * (§4.2): é a lista que a pessoa arrasta para os campos canônicos.
 *
 * Arrays entram como `[0]`, porque é o elemento que a pessoa vai querer
 * mapear; o `[*]` fica disponível na interface como variação.
 */
export function listLeafPaths(payload: unknown, maxPaths = 300): string[] {
  const paths: string[] = []

  function walk(value: unknown, prefix: string, depth: number): void {
    if (paths.length >= maxPaths || depth > 12) return

    if (Array.isArray(value)) {
      // Só o primeiro elemento: os demais têm a mesma forma, e listar todos
      // transformaria um payload com 500 itens numa lista inútil.
      if (value.length > 0) walk(value[0], `${prefix}[0]`, depth + 1)
      return
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        walk(inner, prefix ? `${prefix}.${key}` : `$.${key}`, depth + 1)
      }
      return
    }

    if (prefix) paths.push(prefix)
  }

  walk(payload, '', 0)
  return paths
}
