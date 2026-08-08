import { CANONICAL_EVENTS, type CanonicalEvent } from '@/db/schema/enums'

/**
 * De `qrcode-created` para "Fez uma aposta" — a tradução dos nomes que as
 * plataformas mandam (§4.2, passo 3).
 *
 * O QUE ESTAVA ACONTECENDO
 *
 * A tela avisava: "4 nomes de evento estão chegando e não são traduzidos:
 * `qrcode-created`, `new-user`, `payment-by-deposit`, `payment-by-game`.
 * Acrescente cada um no passo 3." Três problemas de uma vez.
 *
 * Primeiro, ela pedia trabalho manual para uma tradução que o sistema JÁ
 * CONHECE: os quatro nomes estão no mapeamento sugerido desde sempre. Se a
 * conexão foi criada antes daquele catálogo, ou se alguém salvou o passo 3 sem
 * eles, o evento chega e morre — e a única saída era voltar ali e reconstruir à
 * mão o que o Mandafy sabe de cor.
 *
 * Segundo, ela falava em código. `payment-by-game` não diz nada a quem toca a
 * banca; "Ganhou" diz. Pedir para alguém mapear um nome que ele não entende é
 * pedir para adivinhar.
 *
 * Terceiro, o silêncio era caro: sem tradução, nenhum fluxo dispara. O cadastro
 * chega, a mensagem de boas-vindas existe, o fluxo está ligado — e não sai
 * nada, sem erro em lugar nenhum.
 *
 * COMO ESTE MÓDULO RESOLVE
 *
 * Duas camadas, com confianças diferentes, e a diferença é o que decide o que
 * pode ser automático:
 *
 *   DICIONÁRIO — nome conhecido, tradução certa. Aplicado sozinho na ingestão,
 *   como rede de segurança para o mapa salvo que não o tenha.
 *
 *   PALPITE — nome desconhecido lido por palavra-chave (`*-paid`, `saque_*`).
 *   NUNCA é aplicado sozinho: aparece na tela como sugestão, para alguém
 *   confirmar com um clique. Um palpite errado aplicado em silêncio manda a
 *   mensagem errada para o cliente, que é pior que não mandar nada.
 *
 * Módulo puro: sem banco, sem rede, testável.
 */

/**
 * Os nomes que as plataformas de sorteio usam de verdade.
 *
 * A mais comum documenta em inglês com hífen (`new-user`) e exibe em português
 * no painel ("Novo Usuário"); outras usam português com sublinhado. As três
 * famílias moram aqui porque a chave é o que vem no corpo do webhook, não o que
 * aparece na tela do fornecedor.
 *
 * `payment-by-game` é PRÊMIO, não pagamento de aposta: a plataforma trata os
 * dois como movimentação de dinheiro e distingue pela direção. Trocá-los faria
 * quem ganhou receber "aposta confirmada".
 */
export const DICIONARIO_DE_EVENTOS: Record<string, CanonicalEvent> = {
  // Inglês com hífen
  'new-user': 'user.created',
  'user-created': 'user.created',
  'user-registered': 'user.created',
  'qrcode-created': 'order.created',
  'order-created': 'order.created',
  'payment-created': 'order.created',
  'payment-pending': 'order.created',
  'qrcode-paid': 'order.paid',
  'payment-by-deposit': 'order.paid',
  'payment-approved': 'order.paid',
  'payment-confirmed': 'order.paid',
  'order-paid': 'order.paid',
  'payment-expired': 'order.expired',
  'qrcode-expired': 'order.expired',
  'payment-cancelled': 'order.cancelled',
  'payment-canceled': 'order.cancelled',
  'order-cancelled': 'order.cancelled',
  'payment-by-game': 'ticket.awarded',
  'ticket-awarded': 'ticket.awarded',
  'prize-paid': 'ticket.awarded',
  'withdraw-requested': 'withdrawal.pending',
  'withdrawal-pending': 'withdrawal.pending',
  'withdraw-completed': 'withdrawal.completed',
  'withdrawal-completed': 'withdrawal.completed',
  /*
   * O terceiro `payment-by-*` da plataforma, visto chegando numa banca de
   * verdade ao lado de `payment-by-deposit` e `payment-by-game`.
   *
   * Estava caindo na PISTA `withdraw`, que acerta o destino — e palpite não
   * dispara sozinho, por projeto. Só que aqui não há o que confirmar: o nome é
   * conhecido, vem da mesma família dos outros dois, e deixá-lo esperando um
   * clique é pedir confirmação de algo que já sabemos.
   *
   * Vai para `completed`, e não `pending`: a plataforma dispara quando o
   * dinheiro SAI. Mandar "estamos processando seu saque" depois de pago é pior
   * do que não mandar nada.
   */
  'payment-by-withdraw': 'withdrawal.completed',
  'payment-by-withdrawal': 'withdrawal.completed',
  'campaign-created': 'campaign.created',
  'draw-created': 'campaign.created',

  // Português com sublinhado
  novo_usuario: 'user.created',
  usuario_criado: 'user.created',
  cadastro_novo: 'user.created',
  qrcode_criado: 'order.created',
  pedido_criado: 'order.created',
  aposta_criada: 'order.created',
  qrcode_pago: 'order.paid',
  pedido_pago: 'order.paid',
  pagamento_aprovado: 'order.paid',
  pedido_expirado: 'order.expired',
  pedido_cancelado: 'order.cancelled',
  bilhete_premiado: 'ticket.awarded',
  premio_pago: 'ticket.awarded',
  saque_pendente: 'withdrawal.pending',
  saque_solicitado: 'withdrawal.pending',
  saque_finalizado: 'withdrawal.completed',
  saque_pago: 'withdrawal.completed',
  nova_campanha: 'campaign.created',
  novo_sorteio: 'campaign.created',
}

/**
 * `Payment By Deposit`, `payment_by_deposit` e `payment-by-deposit` são a mesma
 * coisa. A busca normaliza para que a caixa e o separador não decidam se um
 * evento dispara fluxo ou não.
 */
function normalizar(nome: string): string {
  return nome
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_.]+/g, '-')
}

/** O dicionário indexado pela forma normalizada — montado uma vez. */
const POR_FORMA_NORMALIZADA = new Map<string, CanonicalEvent>(
  Object.entries(DICIONARIO_DE_EVENTOS).map(([nome, canonico]) => [normalizar(nome), canonico]),
)

/**
 * Palavras que denunciam o tipo do evento quando o nome não está no dicionário.
 *
 * A ORDEM É A REGRA. `payment-expired` tem "payment" e "expired": ganha o
 * segundo, porque um pagamento que expirou é um pedido expirado, não um
 * pagamento. Por isso as pistas mais específicas vêm antes das genéricas — a
 * primeira que casar decide.
 */
const PISTAS: { termos: string[]; canonico: CanonicalEvent }[] = [
  { termos: ['cancel'], canonico: 'order.cancelled' },
  { termos: ['expir', 'vencid', 'timeout'], canonico: 'order.expired' },
  {
    termos: ['premi', 'prize', 'award', 'winner', 'ganhador', 'by-game'],
    canonico: 'ticket.awarded',
  },
  {
    termos: ['saque-pend', 'saque-solic', 'withdraw-req', 'withdrawal-pend'],
    canonico: 'withdrawal.pending',
  },
  { termos: ['saque', 'withdraw'], canonico: 'withdrawal.completed' },
  { termos: ['campanha', 'campaign', 'sorteio', 'draw'], canonico: 'campaign.created' },
  {
    // As palavras que uma plataforma usa para dizer "o dinheiro entrou". A
    // lista é generosa de propósito: aqui o custo de não reconhecer é o evento
    // ficar mudo, e o de reconhecer errado é zero — palpite não é aplicado
    // sozinho, ele vai para a tela com o rótulo "confira".
    termos: [
      'pago',
      'paid',
      'aprovad',
      'approv',
      'confirm',
      'deposit',
      'quitad',
      'liquidad',
      'recebid',
      'received',
      'credit',
    ],
    canonico: 'order.paid',
  },
  {
    termos: ['cadastr', 'registr', 'signup', 'sign-up', 'novo-usuario', 'new-user', 'user'],
    canonico: 'user.created',
  },
  {
    termos: ['qrcode', 'pix', 'pedido', 'aposta', 'order', 'bet', 'payment', 'pagamento'],
    canonico: 'order.created',
  },
]

export type Traducao = {
  /** O nome como a plataforma mandou. */
  nome: string
  canonico: CanonicalEvent | null
  /**
   * `dicionario` — nome conhecido, pode valer sozinho.
   * `palpite` — lido por palavra-chave, precisa de confirmação humana.
   * `nenhuma` — não dá para adivinhar; alguém escolhe na mão.
   */
  origem: 'canonico' | 'dicionario' | 'palpite' | 'nenhuma'
}

/**
 * Traduz um nome de evento de plataforma.
 *
 * Três tentativas, da mais confiável para a menos: o nome já é canônico, está
 * no dicionário, ou dá para deduzir por palavra-chave.
 */
export function traduzirNomeDeEvento(nome: string): Traducao {
  const limpo = nome.trim()
  if (limpo === '') return { nome, canonico: null, origem: 'nenhuma' }

  // A plataforma que já fala canônico não precisa de tradução nenhuma.
  if ((CANONICAL_EVENTS as readonly string[]).includes(limpo)) {
    return { nome, canonico: limpo as CanonicalEvent, origem: 'canonico' }
  }

  const forma = normalizar(limpo)

  const conhecido = POR_FORMA_NORMALIZADA.get(forma)
  if (conhecido) return { nome, canonico: conhecido, origem: 'dicionario' }

  for (const pista of PISTAS) {
    if (pista.termos.some((termo) => forma.includes(termo))) {
      return { nome, canonico: pista.canonico, origem: 'palpite' }
    }
  }

  return { nome, canonico: null, origem: 'nenhuma' }
}

/**
 * A tradução que pode ser aplicada SOZINHA, sem ninguém confirmar.
 *
 * Só dicionário e nome canônico. É o que a ingestão usa como rede quando o mapa
 * salvo da plataforma não tem o nome — o caso de uma conexão criada antes de o
 * catálogo existir, ou de um passo 3 salvo sem os eventos.
 *
 * O palpite fica de fora de propósito: aplicá-lo em silêncio mandaria a
 * mensagem errada para o cliente, e "não saiu nada" é um problema que aparece —
 * "saiu a mensagem errada" é um que não aparece e não se desfaz.
 */
export function traducaoAutomatica(nome: string): CanonicalEvent | null {
  const traduzido = traduzirNomeDeEvento(nome)
  return traduzido.origem === 'dicionario' || traduzido.origem === 'canonico'
    ? traduzido.canonico
    : null
}
