import { formatPhoneBR } from '@/lib/phone'
import type { Filtro, FiltroNome, No } from './ast'
import { espacosComuns } from './gsm'

/**
 * Variáveis e filtros (§6.3).
 *
 * A regra dura da spec: "Se uma variável obrigatória vier vazia, a notificação
 * vai para `failed: variavel_ausente` — nunca envia `Oi {{nome}}!` literal para
 * o cliente." Por isso a resolução devolve `null` em vez de string vazia, e
 * quem compila decide entre falhar ou usar o padrão declarado.
 */

export type DadosVariaveis = Record<string, unknown>

export const FILTRO_LABELS: Record<FiltroNome, string> = {
  moeda: 'valor em reais',
  data: 'data',
  hora: 'hora',
  maiusculo: 'tudo em maiúsculas',
  primeiro_nome: 'só o primeiro nome',
  telefone: 'telefone formatado',
}

/** Fuso do público: um "às 20h" tem de ser 20h de Brasília, não UTC. */
const FUSO = 'America/Sao_Paulo'

// Tudo que sai de um filtro vira corpo de mensagem, e o `Intl` em pt-BR usa
// espaço não separável — que está fora do GSM-7 e dobraria o custo do SMS.
// Ver `espacosComuns` em ./gsm.

/**
 * Busca por caminho pontuado (`pedido.valor`).
 *
 * Só percorre propriedades próprias: `{{constructor.name}}` num corpo de
 * mensagem não pode alcançar o protótipo.
 */
export function valorPorNome(dados: DadosVariaveis, nome: string): unknown {
  let atual: unknown = dados
  for (const parte of nome.split('.')) {
    if (typeof atual !== 'object' || atual === null) return undefined
    if (!Object.prototype.hasOwnProperty.call(atual, parte)) return undefined
    atual = (atual as Record<string, unknown>)[parte]
  }
  return atual
}

function vazio(valor: unknown): boolean {
  return valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')
}

/** Centavos → "R$ 1.234,56". Os valores canônicos são inteiros em centavos (§4.1). */
export function formatarMoeda(valor: unknown): string | null {
  const centavos = typeof valor === 'string' ? Number(valor) : valor
  if (typeof centavos !== 'number' || !Number.isFinite(centavos)) return null

  return espacosComuns(
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100),
  )
}

function paraData(valor: unknown): Date | null {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor
  if (typeof valor === 'number') {
    // Segundos ou milissegundos: abaixo de 10^11 é segundo (data de 1973 pra cá).
    const d = new Date(valor < 1e11 ? valor * 1000 : valor)
    return Number.isNaN(d.getTime()) ? null : d
  }
  if (typeof valor === 'string') {
    const d = new Date(valor)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function formatarData(valor: unknown): string | null {
  const d = paraData(valor)
  if (!d) return null
  return espacosComuns(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d),
  )
}

export function formatarHora(valor: unknown): string | null {
  const d = paraData(valor)
  if (!d) return null
  return espacosComuns(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: FUSO,
      hour: '2-digit',
      minute: '2-digit',
    }).format(d),
  )
}

/**
 * Primeiro nome, com a caixa arrumada.
 *
 * Cadastro de sorteio vem cheio de "MARIA DA SILVA" e "maria da silva"; mandar
 * "Oi MARIA" parece cobrança. Preposições ficam minúsculas.
 */
export function primeiroNome(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const primeiro = valor.trim().split(/\s+/)[0]
  if (!primeiro) return null

  const minusculo = primeiro.toLocaleLowerCase('pt-BR')
  return minusculo.charAt(0).toLocaleUpperCase('pt-BR') + minusculo.slice(1)
}

function aplicarFiltroNomeado(nome: FiltroNome, valor: unknown): string | null {
  switch (nome) {
    case 'moeda':
      return formatarMoeda(valor)
    case 'data':
      return formatarData(valor)
    case 'hora':
      return formatarHora(valor)
    case 'maiusculo':
      return typeof valor === 'string' ? valor.toLocaleUpperCase('pt-BR') : null
    case 'primeiro_nome':
      return primeiroNome(valor)
    case 'telefone':
      return typeof valor === 'string' || typeof valor === 'number'
        ? formatPhoneBR(String(valor))
        : null
  }
}

/**
 * Resolve uma variável. `null` significa "não deu" — o chamador decide se isso
 * derruba a notificação (§6.3) ou se é só uma prévia incompleta.
 */
export function resolverVariavel(
  no: Extract<No, { tipo: 'variavel' }>,
  dados: DadosVariaveis,
): string | null {
  const padrao = no.filtros.find((f): f is Extract<Filtro, { tipo: 'padrao' }> => f.tipo === 'padrao')
  const bruto = valorPorNome(dados, no.nome)

  if (vazio(bruto)) return padrao ? padrao.valor : null

  let atual: unknown = bruto
  for (const filtro of no.filtros) {
    if (filtro.tipo === 'padrao') continue
    const formatado = aplicarFiltroNomeado(filtro.nome, atual)
    // Filtro que não sabe lidar com o valor cai no padrão, se houver — melhor
    // "Oi amigo" do que uma data inválida no meio da frase.
    if (formatado === null) return padrao ? padrao.valor : null
    atual = formatado
  }

  return typeof atual === 'string' ? atual : String(atual)
}
