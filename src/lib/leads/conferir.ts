import { toE164 } from '@/lib/phone'
import type { CampoDestino, LinhaCsv } from './csv'

/**
 * Conferência do arquivo de importação (§9.1, §14.1).
 *
 * O QUE UM IMPORTADOR DE LISTA PODE ESTRAGAR
 *
 * Ele é a porta por onde entra a base para a qual o sistema vai disparar. Os
 * dois danos possíveis são de naturezas diferentes:
 *
 *   gravar errado    telefone na coluna do CPF, valor com vírgula virando
 *                    centavo errado. Chato, visível, corrigível.
 *
 *   RESSUSCITAR      trazer de volta quem pediu para sair. Invisível, e a
 *                    pessoa descobre recebendo. É violação de §14.1, e a
 *                    planilha quase sempre tem o contato antigo dentro.
 *
 * O segundo é o que este módulo existe para impedir, e é a razão de a
 * importação NUNCA tocar em consentimento de contato que já existe.
 */

export type MapaColunas = Partial<Record<CampoDestino, string>>

/** Uma linha já lida e validada, pronta para virar contato. */
export type LinhaValidada = {
  linha: number
  nome: string | null
  telefone: string | null
  email: string | null
  cpf: string | null
  externalId: string | null
  tags: string[]
  valorCents: number
  titulo: string | null
}

export type LinhaRejeitada = {
  linha: number
  motivo: string
}

export type Conferencia = {
  validas: LinhaValidada[]
  rejeitadas: LinhaRejeitada[]
  /** Linhas que repetiam outra do MESMO arquivo e foram fundidas nela. */
  repetidas: number
}

/**
 * Valor em reais para centavos.
 *
 * A planilha brasileira escreve `1.234,56`; a americana, `1234.56`. Distinguir
 * pela última pontuação é o que evita `10,50` virar R$ 1.050,00 — um erro que
 * ninguém percebe até o relatório de recuperado ficar cem vezes maior.
 */
export function paraCentavos(bruto: string): number {
  const texto = bruto.trim().replace(/[^\d.,-]/g, '')
  if (texto === '') return 0

  const ultimaVirgula = texto.lastIndexOf(',')
  const ultimoPonto = texto.lastIndexOf('.')

  let normalizado: string
  if (ultimaVirgula > ultimoPonto) {
    // Vírgula é o decimal: tira os pontos de milhar.
    normalizado = texto.replace(/\./g, '').replace(',', '.')
  } else if (ultimoPonto > -1) {
    normalizado = texto.replace(/,/g, '')
  } else {
    normalizado = texto
  }

  const numero = Number(normalizado)
  if (!Number.isFinite(numero)) return 0
  return Math.round(numero * 100)
}

/** Reais ou centavos, conforme o cabeçalho tenha dito de qual se trata. */
function lerValor(bruto: string, jaEmCentavos: boolean): number {
  if (!jaEmCentavos) return paraCentavos(bruto)
  const digitos = bruto.trim().replace(/[^\d-]/g, '')
  const numero = Number(digitos)
  return Number.isFinite(numero) ? numero : 0
}

/** Só os dígitos, e só se forem 11. CPF malformado vira nulo, não erro. */
export function limparCpf(bruto: string): string | null {
  const digitos = bruto.replace(/\D/g, '')
  return digitos.length === 11 ? digitos : null
}

function normalizarEmail(bruto: string): string | null {
  const texto = bruto.trim().toLowerCase()
  // Validação deliberadamente frouxa: recusar endereço válido por causa de um
  // regex esperto custa mais que aceitar um inválido, que o bounce resolve.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto) ? texto : null
}

/**
 * Confere o arquivo inteiro ANTES de gravar qualquer coisa.
 *
 * A tela mostra este resultado e só então oferece o botão de importar. Um
 * importador que grava metade e para no erro da linha 300 deixa a base num
 * estado que ninguém sabe descrever.
 */
export function conferir(linhas: LinhaCsv[], mapa: MapaColunas): Conferencia {
  /*
   * O cabeçalho declara a unidade, e é a única coisa que pode declará-la.
   *
   * O próprio sistema exporta a coluna `valor_cents` já em centavos. Passar
   * esse número por `paraCentavos` multiplica por cem: exportar R$ 150,00 e
   * importar de volta viraria R$ 1.500,00, calado. Coluna chamada `valor` vem
   * de gente escrevendo reais na planilha; `valor_cents` vem da máquina.
   */
  const jaEmCentavos = mapa.valor_cents === 'valor_cents'

  const validas: LinhaValidada[] = []
  const rejeitadas: LinhaRejeitada[] = []
  /** Chave → a linha já aceita que a detém. Uma linha pode ter três chaves. */
  const vistos = new Map<string, LinhaValidada>()
  let repetidas = 0

  const pegar = (linha: LinhaCsv, campo: CampoDestino): string => {
    const coluna = mapa[campo]
    return coluna ? (linha[coluna] ?? '') : ''
  }

  linhas.forEach((linha, i) => {
    // +2: a linha 1 é o cabeçalho, e quem confere olha o número da planilha.
    const numero = i + 2

    const telefone = toE164(pegar(linha, 'telefone'))
    const email = normalizarEmail(pegar(linha, 'email'))
    const externalId = pegar(linha, 'external_id').trim() || null

    /*
     * Sem telefone NEM e-mail não há como enviar nada. Guardar o registro
     * seria acumular dado pessoal de alguém que o sistema não consegue
     * contatar — o oposto do que §14.1 pede.
     */
    if (!telefone && !email) {
      const bruto = pegar(linha, 'telefone').trim()
      rejeitadas.push({
        linha: numero,
        motivo: bruto === '' ? 'sem telefone e sem e-mail' : `telefone inválido: ${bruto}`,
      })
      return
    }

    const tagsBrutas = pegar(linha, 'tags')

    /*
     * Repetido DENTRO do arquivo — por QUALQUER das três chaves.
     *
     * Aqui morava um 23505 em produção. A versão anterior escolhia uma chave só
     * (`externalId ?? telefone ?? email`), mas o banco tem TRÊS índices únicos.
     * Duas linhas da mesma pessoa — uma identificada pelo telefone, outra pelo
     * e-mail — não pareciam repetidas por chave nenhuma, passavam as duas, e o
     * INSERT esbarrava no índice do e-mail. Nada era importado, porque a
     * gravação é uma transação.
     *
     * Uma chave nunca ia dar conta: o que faz duas linhas serem a mesma pessoa
     * é coincidir em qualquer identificador, não no que escolhemos olhar.
     */
    const chaves = [
      externalId ? `ext:${externalId}` : null,
      telefone ? `tel:${telefone}` : null,
      email ? `mail:${email}` : null,
    ].filter((c): c is string => c !== null)

    const anterior = chaves.map((c) => vistos.get(c)).find((v) => v !== undefined)

    if (anterior) {
      /*
       * Fundir, não descartar. A segunda linha existe quase sempre porque traz
       * o que falta na primeira — foi por isso que a planilha ficou com duas.
       * Jogá-la fora perderia o e-mail que só ela tinha.
       */
      fundir(anterior, {
        nome: pegar(linha, 'nome').trim() || null,
        telefone,
        email,
        cpf: limparCpf(pegar(linha, 'cpf')),
        externalId,
        tags: separarTags(tagsBrutas),
        valorCents: lerValor(pegar(linha, 'valor_cents'), jaEmCentavos),
        titulo: pegar(linha, 'titulo').trim() || null,
      })

      // As chaves que a repetida trouxe passam a apontar para a mesma linha.
      for (const c of chaves) vistos.set(c, anterior)
      repetidas += 1
      return
    }

    const aceita: LinhaValidada = {
      linha: numero,
      nome: pegar(linha, 'nome').trim() || null,
      telefone,
      email,
      cpf: limparCpf(pegar(linha, 'cpf')),
      externalId,
      tags: separarTags(tagsBrutas),
      valorCents: lerValor(pegar(linha, 'valor_cents'), jaEmCentavos),
      titulo: pegar(linha, 'titulo').trim() || null,
    }

    validas.push(aceita)
    for (const c of chaves) vistos.set(c, aceita)
  })

  return { validas, rejeitadas, repetidas }
}

function separarTags(bruto: string): string[] {
  return bruto
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter((t) => t !== '')
}

/**
 * Traz para `alvo` o que só a linha repetida tinha.
 *
 * Preenche vazio, nunca sobrescreve: a primeira linha é a que a pessoa vê na
 * prévia, e vê-la mudar de nome porque uma linha lá embaixo grafou diferente
 * seria inexplicável. Etiquetas se somam — são acréscimo por natureza — e o
 * valor entra só se ainda for zero.
 */
function fundir(alvo: LinhaValidada, extra: Omit<LinhaValidada, 'linha'>): void {
  alvo.nome ??= extra.nome
  alvo.telefone ??= extra.telefone
  alvo.email ??= extra.email
  alvo.cpf ??= extra.cpf
  alvo.externalId ??= extra.externalId
  alvo.titulo ??= extra.titulo

  if (alvo.valorCents === 0) alvo.valorCents = extra.valorCents

  for (const tag of extra.tags) {
    if (!alvo.tags.includes(tag)) alvo.tags.push(tag)
  }
}
