import { valorPorNome, type DadosVariaveis } from '@/lib/messages/variables'

/**
 * Condições de entrada e de parada (§3.5).
 *
 * Um formato declarativo pequeno, guardado em `jsonb`. Pequeno de propósito:
 * um motor de regras completo vira linguagem de programação sem depurador, e o
 * que os fluxos-modelo precisam é comparar um campo com um valor.
 *
 *   { "valor_cents": { "maior_que": 5000 } }
 *   { "campanha": { "igual": "Moto 0km" } }
 *   { "total_orders": { "igual": 0 } }
 *
 * Sem operador, `igual` está implícito: `{ "status": "pago" }`.
 * Vários campos no mesmo objeto são um E lógico.
 */

export const OPERADORES = [
  'igual',
  'diferente',
  'maior_que',
  'menor_que',
  'contem',
  'existe',
  'em',
] as const

export type Operador = (typeof OPERADORES)[number]

export const OPERADOR_LABELS: Record<Operador, string> = {
  igual: 'é igual a',
  diferente: 'é diferente de',
  maior_que: 'é maior que',
  menor_que: 'é menor que',
  contem: 'contém',
  existe: 'está preenchido',
  em: 'é um destes',
}

export type Condicoes = Record<string, unknown>

/** Compara números quando os dois lados são numéricos; senão, texto. */
function comparavel(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null
  if (typeof valor === 'string' && valor.trim() !== '') {
    const n = Number(valor)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function textoDe(valor: unknown): string {
  return String(valor ?? '').trim().toLowerCase()
}

function avaliarOperador(operador: string, atual: unknown, esperado: unknown): boolean {
  switch (operador) {
    case 'igual':
      return textoDe(atual) === textoDe(esperado)

    case 'diferente':
      return textoDe(atual) !== textoDe(esperado)

    case 'maior_que': {
      const a = comparavel(atual)
      const b = comparavel(esperado)
      return a !== null && b !== null && a > b
    }

    case 'menor_que': {
      const a = comparavel(atual)
      const b = comparavel(esperado)
      return a !== null && b !== null && a < b
    }

    case 'contem':
      return textoDe(atual).includes(textoDe(esperado))

    case 'existe': {
      const preenchido = atual !== undefined && atual !== null && String(atual).trim() !== ''
      // `{ "cpf": { "existe": false } }` também é uma pergunta válida.
      return esperado === false ? !preenchido : preenchido
    }

    case 'em':
      return Array.isArray(esperado) && esperado.some((item) => textoDe(item) === textoDe(atual))

    default:
      /*
       * Operador desconhecido reprova, e não aprova. Um typo em
       * `{"valor": {"maiorque": 5000}}` não pode virar "sem condição" e
       * liberar o fluxo para toda a base.
       */
      return false
  }
}

/** Todas as condições passam? Objeto vazio significa "sem condição". */
export function atende(condicoes: Condicoes | null | undefined, dados: DadosVariaveis): boolean {
  if (!condicoes) return true

  const campos = Object.entries(condicoes)
  if (campos.length === 0) return true

  return campos.every(([campo, regra]) => {
    const atual = valorPorNome(dados, campo)

    // Forma curta: `{ "status": "pago" }` é o mesmo que `igual`.
    if (typeof regra !== 'object' || regra === null || Array.isArray(regra)) {
      return avaliarOperador('igual', atual, regra)
    }

    return Object.entries(regra as Record<string, unknown>).every(([operador, esperado]) =>
      avaliarOperador(operador, atual, esperado),
    )
  })
}

/** Descrição em português, para a tela do fluxo mostrar o que foi configurado. */
export function descrever(condicoes: Condicoes | null | undefined): string[] {
  if (!condicoes) return []

  return Object.entries(condicoes).flatMap(([campo, regra]) => {
    if (typeof regra !== 'object' || regra === null || Array.isArray(regra)) {
      return [`${campo} é igual a ${String(regra)}`]
    }

    return Object.entries(regra as Record<string, unknown>).map(([operador, esperado]) => {
      const rotulo = OPERADOR_LABELS[operador as Operador] ?? operador
      return operador === 'existe'
        ? `${campo} ${esperado === false ? 'está vazio' : 'está preenchido'}`
        : `${campo} ${rotulo} ${Array.isArray(esperado) ? esperado.join(', ') : String(esperado)}`
    })
  })
}
