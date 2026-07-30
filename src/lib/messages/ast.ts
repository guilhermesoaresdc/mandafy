/**
 * Árvore da mensagem (§6.2).
 *
 * O corpo é escrito uma vez em Markdown reduzido e compilado para quatro
 * saídas. A compilação passa por esta árvore em vez de trocar strings porque
 * cada canal escapa caracteres de forma diferente — e porque o valor de uma
 * variável nunca pode virar formatação: se o nome do contato for `**x**`, o
 * cliente precisa ler `**x**`, não ver negrito. Substituir texto antes de
 * analisar deixaria esse buraco aberto.
 */

/** Filtros de §6.3. `padrao` é a forma `{{nome|"tudo bem"}}`. */
export const FILTROS = ['moeda', 'data', 'hora', 'maiusculo', 'primeiro_nome', 'telefone'] as const
export type FiltroNome = (typeof FILTROS)[number]

export type Filtro = { tipo: 'nomeado'; nome: FiltroNome } | { tipo: 'padrao'; valor: string }

export type No =
  | { tipo: 'texto'; valor: string }
  | { tipo: 'negrito'; filhos: No[] }
  | { tipo: 'italico'; filhos: No[] }
  | { tipo: 'riscado'; filhos: No[] }
  | { tipo: 'mono'; valor: string }
  | { tipo: 'link'; rotulo: No[]; url: No[] }
  | { tipo: 'variavel'; nome: string; filtros: Filtro[] }

export type Bloco = { tipo: 'paragrafo'; filhos: No[] } | { tipo: 'regua' }

export type ErroParse = { mensagem: string; posicao: number }

export type Documento = { blocos: Bloco[]; erros: ErroParse[] }

/** Percorre a árvore em ordem de leitura. Base das análises do editor. */
export function percorrer(blocos: Bloco[], visitar: (no: No) => void): void {
  const nos = (lista: No[]): void => {
    for (const no of lista) {
      visitar(no)
      switch (no.tipo) {
        case 'negrito':
        case 'italico':
        case 'riscado':
          nos(no.filhos)
          break
        case 'link':
          nos(no.rotulo)
          nos(no.url)
          break
        default:
          break
      }
    }
  }

  for (const bloco of blocos) {
    if (bloco.tipo === 'paragrafo') nos(bloco.filhos)
  }
}

/** Nomes de variável usados no documento, na ordem em que aparecem, sem repetir. */
export function variaveisUsadas(blocos: Bloco[]): string[] {
  const vistas = new Set<string>()
  const ordem: string[] = []
  percorrer(blocos, (no) => {
    if (no.tipo === 'variavel' && !vistas.has(no.nome)) {
      vistas.add(no.nome)
      ordem.push(no.nome)
    }
  })
  return ordem
}
