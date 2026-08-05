import { CANONICAL_EVENTS, type CanonicalEvent } from '@/db/schema/enums'
import { getByPath, listLeafPaths } from './path'

/**
 * Adivinhar o mapeamento a partir do que a plataforma mandou (§4.2, passo 3).
 *
 * POR QUE ISTO EXISTE
 *
 * A tela já sabia tudo o que precisava e ainda assim perguntava. Ela detectava
 * oito campos no payload — `$.name`, `$.phone`, `$.email`, `$.cpf` — mostrava
 * "8 campos detectados" no cabeçalho, e deixava os dezoito seletores em
 * "— não usar —", cada um com "— não encontrado" embaixo. Quem conectou tinha
 * de abrir dezoito listas e escolher à mão o que qualquer pessoa lendo
 * `"name": "JESSICA RODRIGUES DE OLIVEIRA"` acertaria de primeira.
 *
 * O mapeamento sugerido do catálogo não ajudava porque ele descreve UM formato:
 * `$.data.user.name`, aninhado. O Techloto manda tudo plano, na raiz. Um
 * caminho fixo só acerta a plataforma para a qual foi escrito — e o sistema se
 * vende como plugável em qualquer uma.
 *
 * COMO ELA DECIDE
 *
 * Duas evidências, e as duas precisam concordar quando existem:
 *
 *   NOME do campo — `phone`, `telefone`, `celular` todos apontam para telefone.
 *   FORMATO do valor — 11 dígitos com DDD é telefone; texto com `@` é e-mail.
 *
 * O formato desempata o que o nome não resolve e recusa o que o nome sugere
 * errado: um campo chamado `email` contendo `null` não vira e-mail, e um `id`
 * que é um uuid não vira identificador de pedido se houver outro melhor.
 *
 * NADA AQUI TOCA O BANCO. Módulo puro, testável, chamado pela tela.
 */

/** Um palpite, com o motivo — a tela mostra o motivo para dar o que conferir. */
export type Palpite = {
  caminho: string
  /** Quanto se confia: só o melhor de cada campo entra, e empate não entra. */
  peso: number
}

type Regra = {
  /** Pedaços de nome que apontam para este campo, do mais forte ao mais fraco. */
  nomes: string[]
  /**
   * Nomes do objeto PAI que confirmam o palpite.
   *
   * Num payload aninhado, `$.data.user.name` e `$.data.draw.name` têm a mesma
   * folha e a mesma cara: os dois são `name` com texto dentro. O que os separa
   * é onde moram. Sem isto os dois empatam e nenhum é sugerido — e a tela volta
   * a mostrar "— não usar —" bem no campo mais óbvio da integração.
   */
  pais?: string[]
  /**
   * Nomes que só valem DENTRO do pai certo.
   *
   * `name` é sorteio em `$.draw.name` e é pessoa em `$.name`. Aceitá-lo solto
   * fez o nome da apostadora virar "Sorteio" no primeiro teste — um palpite
   * errado que a tela entrega pronto é pior que campo vazio, porque ninguém
   * confere o que já parece resolvido.
   */
  nomesSoComPai?: string[]
  /** Confirma pelo formato do valor. Sem isto, o nome sozinho vale menos. */
  formato?: (valor: unknown) => boolean
  /** Recusa mesmo com o nome batendo. */
  recusa?: (valor: unknown) => boolean
}

const texto = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const numero = (v: unknown): boolean => typeof v === 'number' || /^-?\d+([.,]\d+)?$/.test(String(v))

/** Só dígitos, para conferir formato sem depender de máscara. */
const digitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '')

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const URL = /^https?:\/\//i
/** ISO 8601 com ou sem fuso: `2026-08-05T14:25:21.740-03:00`. */
const DATA_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/**
 * As regras da identidade do contato.
 *
 * A ordem dentro de `nomes` importa: `user_id` ganha de `id` porque é mais
 * específico, e num payload com os dois o certo é o primeiro.
 */
const PAIS_DA_PESSOA = ['user', 'usuario', 'customer', 'cliente', 'contact', 'contato', 'apostador']
const PAIS_DA_APOSTA = ['order', 'pedido', 'aposta', 'bet', 'transaction', 'transacao', 'payment']
const PAIS_DO_SORTEIO = ['draw', 'sorteio', 'extracao', 'campaign', 'campanha', 'game']

const CONTATO: Record<string, Regra> = {
  phone: {
    nomes: ['phone', 'telefone', 'celular', 'whatsapp', 'mobile', 'msisdn'],
    pais: PAIS_DA_PESSOA,
    // 10 ou 11 dígitos com DDD, ou 12/13 com o 55 na frente.
    formato: (v) => [10, 11, 12, 13].includes(digitos(v).length),
  },
  email: {
    nomes: ['email', 'e_mail', 'mail'],
    pais: PAIS_DA_PESSOA,
    formato: (v) => texto(v) && EMAIL.test(v.trim()),
  },
  cpf: {
    nomes: ['cpf', 'documento', 'document', 'tax_id'],
    pais: PAIS_DA_PESSOA,
    formato: (v) => digitos(v).length === 11,
  },
  name: {
    nomes: ['name', 'nome', 'full_name', 'nome_completo', 'cliente', 'customer'],
    pais: PAIS_DA_PESSOA,
    formato: (v) => texto(v) && !EMAIL.test(v) && digitos(v).length < 6,
  },
  external_id: {
    nomes: ['user_id', 'usuario_id', 'client_id', 'customer_id', 'uid', 'id'],
    pais: PAIS_DA_PESSOA,
    // Identificador é curto e não é frase: recusa o que parece nome ou texto.
    recusa: (v) => texto(v) && (v.includes(' ') || v.length > 64),
  },
}

/**
 * As regras dos dados que aparecem nas mensagens.
 *
 * `valor_cents` e `retorno_cents` disputam os mesmos nomes genéricos, e por
 * isso o valor apostado fica com os nomes de "preço/valor" e o retorno com os
 * de "prêmio/pagamento". Errar entre os dois é dizer ao cliente que ele ganhou
 * o que apostou.
 */
const CAMPOS: Record<string, Regra> = {
  external_id: {
    nomes: ['order_id', 'pedido_id', 'aposta_id', 'bet_id', 'transaction_id', 'codigo', 'id'],
    pais: PAIS_DA_APOSTA,
    recusa: (v) => texto(v) && (v.includes(' ') || v.length > 64),
  },
  valor_cents: {
    nomes: ['amount', 'valor', 'value', 'price', 'preco', 'total'],
    pais: PAIS_DA_APOSTA,
    formato: numero,
  },
  retorno_cents: {
    nomes: ['payout', 'premio', 'prize', 'retorno', 'ganho', 'win'],
    formato: numero,
  },
  saldo_cents: {
    nomes: ['balance', 'saldo', 'wallet'],
    formato: numero,
  },
  sorteio: {
    nomes: ['draw', 'sorteio', 'extracao', 'loteria', 'banca'],
    nomesSoComPai: ['name', 'nome', 'title', 'titulo'],
    pais: PAIS_DO_SORTEIO,
  },
  fecha_em: {
    nomes: ['closes_at', 'fecha_em', 'fechamento', 'expira_em', 'expires_at', 'deadline'],
    pais: PAIS_DO_SORTEIO,
    formato: (v) => texto(v) && DATA_ISO.test(v),
  },
  modalidade: { nomes: ['modalidade', 'bet_type', 'tipo_aposta', 'game_type'] },
  palpite: { nomes: ['palpite', 'pick', 'aposta', 'numbers', 'escolha'] },
  milhar: { nomes: ['milhar', 'thousand', 'resultado'] },
  grupo: { nomes: ['grupo', 'group'] },
  bicho: { nomes: ['bicho', 'animal'] },
  pix_copia_cola: {
    nomes: ['pix_code', 'pix_copia_cola', 'copia_cola', 'emv', 'brcode', 'qrcode'],
    formato: (v) => texto(v) && v.length > 40 && !URL.test(v),
  },
  link_pagamento: {
    nomes: ['checkout_url', 'link_pagamento', 'payment_url', 'pay_url', 'url_pagamento'],
    formato: (v) => texto(v) && URL.test(v),
  },
  link_resultado: {
    nomes: ['result_url', 'link_resultado', 'resultado_url'],
    formato: (v) => texto(v) && URL.test(v),
  },
}

/** O último segmento do caminho, em minúsculas e sem separadores. */
function folhaDe(caminho: string): string {
  const bruto = caminho.split('.').pop() ?? ''
  return bruto.replace(/\[\d+\]/g, '').toLowerCase()
}

function pontuar(caminho: string, valor: unknown, regra: Regra): number {
  if (valor === null || valor === undefined || valor === '') return 0
  if (regra.recusa?.(valor)) return 0

  const folha = folhaDe(caminho)
  const segmentos = caminho.toLowerCase().split('.')
  const pai = segmentos[segmentos.length - 2] ?? ''
  const paiBate = Boolean(regra.pais?.some((p) => pai === p || pai.includes(p)))

  // Nome genérico só entra na disputa se estiver no lugar certo.
  const nomes =
    paiBate && regra.nomesSoComPai ? [...regra.nomes, ...regra.nomesSoComPai] : regra.nomes

  const posicao = nomes.findIndex((n) => folha === n)
  const contem = nomes.findIndex((n) => folha.includes(n))

  // Nome exato vale muito mais que nome parecido: num payload com `phone` e
  // `phone_verified`, o segundo não pode ganhar por acidente.
  let peso = posicao >= 0 ? 100 - posicao : contem >= 0 ? 40 - contem : 0
  if (peso === 0) return 0

  if (regra.formato) {
    // Formato confirma ou derruba: um campo `email` com um telefone dentro é
    // erro de quem integrou, e aceitá-lo faria o envio falhar depois.
    if (!regra.formato(valor)) return 0
    peso += 20
  }

  /*
   * O pai desempata. `$.data.user.name` e `$.data.draw.name` são idênticos aos
   * olhos da folha e do formato; morar dentro de `user` é o que faz um deles
   * ser o nome da pessoa.
   */
  if (paiBate) peso += 30

  // Campo na raiz ganha do aninhado quando os dois batem: plataformas põem o
  // que importa no topo, e o fundo costuma ser metadado.
  peso -= (caminho.split('.').length - 2) * 2

  return peso
}

function melhores(
  regras: Record<string, Regra>,
  caminhos: string[],
  payload: unknown,
): Record<string, Palpite> {
  const saida: Record<string, Palpite> = {}

  for (const [chave, regra] of Object.entries(regras)) {
    let melhor: Palpite | null = null
    let empatou = false

    for (const caminho of caminhos) {
      const peso = pontuar(caminho, getByPath(payload, caminho), regra)
      if (peso <= 0) continue

      if (!melhor || peso > melhor.peso) {
        melhor = { caminho, peso }
        empatou = false
      } else if (peso === melhor.peso) {
        empatou = true
      }
    }

    // Empate não vira palpite: sugerir um dos dois ao acaso é pior que não
    // sugerir, porque a pessoa confia no que a tela já preencheu.
    if (melhor && !empatou) saida[chave] = melhor
  }

  return saida
}

export type Deteccao = {
  /** Onde está o nome do evento. */
  eventPath: string | null
  /** O evento canônico que o nome recebido parece ser. */
  eventoCanonico: CanonicalEvent | null
  contato: Record<string, Palpite>
  campos: Record<string, Palpite>
}

/**
 * Onde o nome do evento costuma estar.
 *
 * Procurado no payload de verdade, e não fixado em `$.event`: uma plataforma
 * que chame o campo de `type` deixaria a tela apontando para um caminho vazio,
 * e o passo 3 mostraria "— não encontrado" logo no primeiro campo.
 */
const CAMINHOS_DE_EVENTO = ['event', 'evento', 'type', 'tipo', 'event_type', 'eventtype', 'action']

/**
 * O evento canônico mais parecido com o nome que a plataforma usa.
 *
 * Compara por palavra, não por igualdade: `new-user`, `new_user`, `novo_usuario`
 * e `user.created` são a mesma coisa escrita de quatro jeitos, e nenhuma
 * plataforma escolhe o nosso. Sem isto, quem recebeu `new-user` via o botão
 * "Adicionar new-user" com a lista inteira em branco ao lado.
 */
const SINONIMOS: Record<CanonicalEvent, string[]> = {
  'user.created': [
    'new user',
    'novo usuario',
    'user created',
    'usuario criado',
    'cadastro',
    'signup',
    'sign up',
    'register',
  ],
  'order.created': [
    // O Techloto mistura os dois idiomas no mesmo painel: o rótulo da tela é
    // "Qrcode Criado" e o corpo manda `qrcode-created`. Quem escreve integração
    // não normaliza isso, e não há por que a pessoa ter de saber.
    'qrcode created',
    'qrcode criado',
    'order created',
    'pix criado',
    'pix created',
    'aposta criada',
    'new order',
    'bet created',
  ],
  'order.paid': [
    'qrcode paid',
    'qrcode pago',
    'order paid',
    'pix pago',
    'pix paid',
    'pagamento',
    'payment',
    'paid',
    'aposta paga',
    'bet paid',
    /*
     * `payment-by-deposit` é como o Techloto chama o PIX que caiu — nem
     * "pago", nem "qrcode": o nome descreve o MEIO, não o desfecho. É o evento
     * mais importante da cadeia, porque é ele que manda parar os lembretes de
     * recuperação. Não reconhecê-lo deixaria a pessoa recebendo "seu PIX ainda
     * está aberto" depois de ter pagado.
     */
    'payment by deposit',
    'payment by pix',
    'deposit',
    'deposito',
    'pix recebido',
    'payment received',
    'pagamento recebido',
    'pagamento confirmado',
  ],
  'order.expired': ['expirou', 'expired', 'qrcode expired', 'qrcode expirado', 'pix expirado'],
  'order.cancelled': [
    'cancelado',
    'cancelled',
    'canceled',
    'pedido cancelado',
    'order cancelled',
  ],
  'ticket.awarded': [
    'premiado',
    'awarded',
    'bilhete premiado',
    'ticket awarded',
    'ganhou',
    'winner',
    'prize',
  ],
  'withdrawal.pending': [
    'saque pendente',
    'withdrawal pending',
    'withdraw pending',
    'saque solicitado',
  ],
  'withdrawal.completed': [
    'saque finalizado',
    'saque concluido',
    'withdrawal completed',
    'withdraw completed',
    'withdrawal finished',
  ],
  'campaign.created': [
    'nova campanha',
    'campaign created',
    'novo sorteio',
    'nova extracao',
    'draw created',
  ],
  'campaign.ending_soon': ['encerrando', 'ending soon', 'fechando', 'closing soon'],
  'contact.inactive_7d': [],
  'contact.inactive_30d': [],
  'contact.first_purchase': [],
  'contact.repeat_purchase': [],
  'campaign.ending_24h': [],
}

/** Reduz a uma forma comparável: `new-user` e `New User` viram `new user`. */
function normalizar(nome: string): string {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function eventoCanonicoDe(nome: string): CanonicalEvent | null {
  const alvo = normalizar(nome)
  if (!alvo) return null

  // O nome canônico escrito à risca continua valendo.
  const exato = CANONICAL_EVENTS.find((e) => e === nome.trim())
  if (exato) return exato

  for (const [canonico, sinonimos] of Object.entries(SINONIMOS) as [CanonicalEvent, string[]][]) {
    if (normalizar(canonico) === alvo) return canonico
    if (sinonimos.some((s) => s === alvo)) return canonico
  }

  // Nada exato: aceita conter, o que pega "user-created-webhook" e afins.
  for (const [canonico, sinonimos] of Object.entries(SINONIMOS) as [CanonicalEvent, string[]][]) {
    if (sinonimos.some((s) => alvo.includes(s) || s.includes(alvo))) return canonico
  }

  return null
}

/**
 * O que a tela deve preencher sozinha, a partir do último evento recebido.
 *
 * Devolve palpites, não decisões: quem chama usa só onde a pessoa ainda não
 * escolheu nada, para nunca sobrescrever o que ela ajustou à mão.
 */
export function detectarMapeamento(payload: unknown): Deteccao {
  const caminhos = payload ? listLeafPaths(payload) : []

  const eventPath =
    caminhos.find((c) => CAMINHOS_DE_EVENTO.includes(folhaDe(c)) && texto(getByPath(payload, c))) ??
    null

  const nome = eventPath ? String(getByPath(payload, eventPath) ?? '') : ''

  return {
    eventPath,
    eventoCanonico: nome ? eventoCanonicoDe(nome) : null,
    contato: melhores(CONTATO, caminhos, payload),
    campos: melhores(CAMPOS, caminhos, payload),
  }
}
