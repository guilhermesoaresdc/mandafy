/**
 * SMS: alfabeto GSM-7, segmentos e custo (§6.4).
 *
 * O detalhe que economiza dinheiro de verdade: o GSM-7 cabe 160 caracteres por
 * segmento. UM caractere fora do alfabeto joga a mensagem inteira para UCS-2 e
 * o limite despenca para 70. Um 🎟️ perdido pode triplicar a fatura.
 *
 * Para o português isso é pior do que parece: `é`, `à`, `ü` estão no GSM-7, mas
 * `á`, `â`, `ã`, `ê`, `í`, `ó`, `ô`, `õ`, `ú` e `ç` minúsculo NÃO estão. Ou
 * seja, "ação", "você" e "número" já custam o dobro. É por isso que "remover
 * acentuação" é uma opção oferecida no editor, e por que o contador mostra
 * exatamente quais caracteres estouraram.
 */

/** Alfabeto básico do 3GPP TS 23.038. Cada caractere ocupa 1 septeto. */
const GSM7_BASICO =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà'

/** Tabela de extensão: cada um custa 2 septetos (ESC + caractere). */
const GSM7_EXTENDIDO = '\f^{}\\[~]|€'

const BASICO = new Set(GSM7_BASICO.split(''))
const EXTENDIDO = new Set(GSM7_EXTENDIDO.split(''))

/** Limites do 3GPP. Em mensagem multipartes o cabeçalho UDH come espaço. */
export const LIMITE_GSM7_UNICO = 160
export const LIMITE_GSM7_MULTIPLO = 153
export const LIMITE_UCS2_UNICO = 70
export const LIMITE_UCS2_MULTIPLO = 67

/** Preço por segmento, em centavos. Ajustável quando houver contrato fechado. */
export const PRECO_SEGMENTO_CENTAVOS = 6

export type Codificacao = 'GSM-7' | 'UCS-2'

export type ContagemSms = {
  codificacao: Codificacao
  /** Septetos no GSM-7; unidades UTF-16 no UCS-2. */
  unidades: number
  segmentos: number
  /** Quanto ainda cabe sem abrir mais um segmento. */
  restante: number
  limite: number
  custoCentavos: number
  /** Os caracteres que jogaram a mensagem para UCS-2, sem repetir. */
  forcaramUcs2: string[]
}

export function ehGsm7(texto: string): boolean {
  for (const c of texto) {
    if (!BASICO.has(c) && !EXTENDIDO.has(c)) return false
  }
  return true
}

/** Caracteres fora do GSM-7, na ordem em que aparecem, sem repetir. */
export function foraDoGsm7(texto: string): string[] {
  const vistos = new Set<string>()
  const ordem: string[] = []
  for (const c of texto) {
    if (BASICO.has(c) || EXTENDIDO.has(c) || vistos.has(c)) continue
    vistos.add(c)
    ordem.push(c)
  }
  return ordem
}

function septetos(texto: string): number {
  let total = 0
  for (const c of texto) total += EXTENDIDO.has(c) ? 2 : 1
  return total
}

export function contarSms(texto: string): ContagemSms {
  const forcaramUcs2 = foraDoGsm7(texto)
  const codificacao: Codificacao = forcaramUcs2.length === 0 ? 'GSM-7' : 'UCS-2'

  // No UCS-2 a unidade é a de UTF-16: um emoji fora do BMP consome duas.
  const unidades = codificacao === 'GSM-7' ? septetos(texto) : texto.length

  const limiteUnico = codificacao === 'GSM-7' ? LIMITE_GSM7_UNICO : LIMITE_UCS2_UNICO
  const limiteMultiplo = codificacao === 'GSM-7' ? LIMITE_GSM7_MULTIPLO : LIMITE_UCS2_MULTIPLO

  let segmentos: number
  let limite: number
  if (unidades <= limiteUnico) {
    segmentos = unidades === 0 ? 0 : 1
    limite = limiteUnico
  } else {
    segmentos = Math.ceil(unidades / limiteMultiplo)
    limite = limiteMultiplo * segmentos
  }

  return {
    codificacao,
    unidades,
    segmentos,
    restante: Math.max(0, limite - unidades),
    limite,
    custoCentavos: segmentos * PRECO_SEGMENTO_CENTAVOS,
    forcaramUcs2,
  }
}

/**
 * Remove emoji e outros pictogramas.
 *
 * Obrigatório na variante SMS (§6.4). Cobre os blocos de emoji, símbolos
 * diversos, dingbats e bandeiras, mais os modificadores que os acompanham
 * (seletor de variação, tom de pele, junção de largura zero).
 */
/*
 * `2300-23FF` entrou depois, e a falta dele custava dinheiro de verdade: é o
 * bloco de "símbolos técnicos", que abriga ⏰ ⌛ ⏳ ▶ — o relógio que abre a
 * mensagem de "campanha encerrando" é U+23F0. Ele sobrevivia à limpeza e
 * jogava a mensagem inteira para UCS-2 sozinho, cortando o limite de 160 para
 * 70. Um caractere invisível para quem escreve, dois segmentos a mais na fatura.
 */
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{200D}\u{20E3}]/gu

export function removerEmoji(texto: string): string {
  // Colapsa o espaço duplo que sobra quando o emoji estava entre palavras.
  return texto.replace(EMOJI, '').replace(/ {2,}/g, ' ')
}

export function temEmoji(texto: string): boolean {
  EMOJI.lastIndex = 0
  return EMOJI.test(texto)
}

/**
 * Tira a acentuação mantendo a letra: "ação" → "acao".
 *
 * Opcional (§6.4) porque muda o texto que o cliente lê. Compensa quando a
 * mensagem está perto do limite: costuma cortar o custo pela metade.
 */
export function removerAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC')
}

/**
 * Pontuação que NÃO é acento e mesmo assim está fora do GSM-7.
 *
 * O ACENTO NÃO ERA O VILÃO PRINCIPAL.
 *
 * `removerAcentos` decompõe a letra e joga fora o sinal diacrítico. Isso resolve
 * "ação" → "acao" e não faz absolutamente nada com `—`, `…` ou `“ ”`: esses
 * caracteres não têm decomposição canônica, são apenas outros caracteres. E um
 * travessão sozinho joga a mensagem para UCS-2 do mesmo jeito que um emoji.
 *
 * Medido no catálogo: com "remover acentuação" ligado, mais da metade dos modelos
 * continuavam em UCS-2 — todos por causa de um `—`, quase sempre vindo do nome
 * da campanha, que é texto livre digitado por quem opera. Ou seja: a pessoa
 * ligava a opção que promete cortar o custo pela metade, batizava a campanha de
 * "Moto 0km — Edição de Julho", e continuava pagando três segmentos sem nunca
 * saber por quê.
 *
 * As trocas preservam o sentido: travessão vira hífen, reticências viram três
 * pontos, aspas curvas viram aspas retas. Nenhuma perde informação para quem lê.
 */
const FORA_DO_GSM7: [RegExp, string][] = [
  [/[—–‒―]/g, '-'],
  [/[“”„«»]/g, '"'],
  [/[‘’‚‹›]/g, "'"],
  [/…/g, '...'],
  [/[•·∙]/g, '-'],
  [/[º°]/g, 'o'],
  [/ª/g, 'a'],
  [/[´`ˆ˜¨]/g, ''],
  [/[‐‑‧]/g, '-'],
  [/⁄/g, '/'],
  [/[™©®]/g, ''],
  // Traço largo e espaços exóticos que o Word e o WhatsApp arrastam junto.
  [/[ -​  　 ]/g, ' '],
]

/**
 * Deixa o texto inteiro dentro do GSM-7, ou o mais perto disso que der.
 *
 * Ordem: acentos primeiro (mantém a letra), depois a pontuação equivalente,
 * depois o que sobrou fora do alfabeto é descartado. O descarte final é a rede
 * de segurança: o valor de uma variável vem da plataforma da organização e pode
 * conter qualquer coisa — um ﷼, um 中 — e não há troca razoável para isso. Cair
 * de 160 para 70 caracteres por causa de um caractere que ninguém digitou de
 * propósito é o pior desfecho dos dois.
 */
export function paraGsm7(texto: string): string {
  let saida = removerAcentos(texto)

  for (const [de, para] of FORA_DO_GSM7) saida = saida.replace(de, para)

  saida = Array.from(saida)
    .filter((c) => BASICO.has(c) || EXTENDIDO.has(c))
    .join('')

  return saida.replace(/ {2,}/g, ' ')
}

/**
 * Troca espaços exóticos por espaço comum.
 *
 * O `Intl` em pt-BR separa "R$" do número com espaço NÃO SEPARÁVEL (U+00A0), e
 * U+00A0 está fora do alfabeto acima. Um `{{valor|moeda}}` no corpo jogaria o
 * SMS inteiro para UCS-2 — limite de 160 para 70 — por um caractere invisível.
 * Mora aqui porque é a tabela GSM-7 que dita a regra; os formatadores de §6.3
 * importam daqui.
 */
export function espacosComuns(texto: string): string {
  return texto.replace(/[   ]/g, ' ')
}

/** "R$ 0,06" a partir de centavos — o rótulo do contador do editor. */
export function formatarCusto(centavos: number): string {
  return espacosComuns(
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(centavos / 100),
  )
}

/** A linha que §6.4 pede no editor: `142/160 · 1 segmento · ~R$ 0,06`. */
export function resumoContador(contagem: ContagemSms): string {
  const plural = contagem.segmentos === 1 ? 'segmento' : 'segmentos'
  return `${contagem.unidades}/${contagem.limite} · ${contagem.segmentos} ${plural} · ~${formatarCusto(contagem.custoCentavos)}`
}
