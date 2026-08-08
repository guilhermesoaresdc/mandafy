import {
  CANONICAL_EVENTS,
  CHANNEL_LABELS,
  INTERNAL_EVENTS,
  type CanonicalEvent,
  type Channel,
} from '@/db/schema/enums'
import { formatarData, formatarHora, formatarMoeda } from '@/lib/messages/variables'
import { formatPhoneBR } from '@/lib/phone'

/**
 * O vocabulário da interface: o nome humano de cada campo e de cada evento.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * Todo o sistema fala em `order.paid`, `valor_cents`, `boas_vindas` — nomes de
 * código, e são os certos para o código. O problema é que eles vazavam para a
 * tela: a linha do tempo de um lead dizia `order.created` e nada mais, o painel
 * do fluxo dizia "Dispara em user.created", e quem escreve mensagem escolhia
 * variável numa lista de identificadores. Quem opera a banca não tem por que
 * aprender esse dicionário para saber que alguém pagou.
 *
 * §11.7 já mandava nomear pelo que a pessoa controla, não pela implementação.
 * Este módulo é onde essa tradução mora — UMA vez, e não reescrita em cada
 * tela, que é como duas telas passam a chamar a mesma coisa por nomes
 * diferentes.
 *
 * O que NÃO muda: o código, o banco, a API pública e o CSV continuam falando
 * `order.paid` e `valor_cents`. Renomear identificador é quebrar integração de
 * quem já usa; o que se traduz é o rótulo, no último instante antes do olho.
 */

// ── Campos ───────────────────────────────────────────────────────────────────

/** Como o valor é apresentado. Reaproveita os filtros de §6.3. */
export type FormatoCampo = 'texto' | 'moeda' | 'data' | 'hora' | 'telefone' | 'link'

export type Campo = {
  /** O nome que a pessoa lê. Frase curta, não identificador. */
  nome: string
  /** Uma linha explicando o que é — vai no cartão e no `title`. */
  ajuda: string
  formato: FormatoCampo
  /** Agrupa os cartões no seletor de variáveis. */
  grupo: 'Pessoa' | 'Aposta' | 'Resultado' | 'Links' | 'Tempo'
}

/**
 * O catálogo. A chave é o nome técnico — o mesmo que vai entre `{{ }}`.
 *
 * Não é exaustivo de propósito: a plataforma pode mandar campo que ninguém
 * previu, e `nomeDoCampo` devolve um rótulo legível para o que não estiver
 * aqui, em vez de esconder o dado.
 */
export const CAMPOS: Record<string, Campo> = {
  nome: {
    nome: 'Nome do cliente',
    ajuda: 'Como veio no cadastro da plataforma. Costuma vir em caixa alta.',
    formato: 'texto',
    grupo: 'Pessoa',
  },
  telefone: {
    nome: 'Telefone',
    ajuda: 'O número do WhatsApp e do SMS, no formato internacional.',
    formato: 'telefone',
    grupo: 'Pessoa',
  },
  email: { nome: 'E-mail', ajuda: 'O e-mail do cadastro.', formato: 'texto', grupo: 'Pessoa' },
  cpf: { nome: 'CPF', ajuda: 'O CPF do cadastro.', formato: 'texto', grupo: 'Pessoa' },
  external_id: {
    nome: 'Código na plataforma',
    ajuda: 'O identificador que a plataforma de sorteio usa para este cadastro ou pedido.',
    formato: 'texto',
    grupo: 'Pessoa',
  },
  saldo_cents: {
    nome: 'Saldo na conta',
    ajuda: 'Quanto a pessoa tem de saldo na plataforma.',
    formato: 'moeda',
    grupo: 'Pessoa',
  },

  valor_cents: {
    nome: 'Valor da aposta',
    ajuda: 'Quanto a pessoa apostou, ou o valor do pedido.',
    formato: 'moeda',
    grupo: 'Aposta',
  },
  retorno_cents: {
    nome: 'Prêmio se ganhar',
    ajuda: 'Quanto a aposta paga se der certo.',
    formato: 'moeda',
    grupo: 'Aposta',
  },
  sorteio: {
    nome: 'Sorteio',
    ajuda: 'A extração da aposta — "PTV 18h", por exemplo.',
    formato: 'texto',
    grupo: 'Aposta',
  },
  modalidade: {
    nome: 'Modalidade',
    ajuda: 'Grupo, dezena, centena, milhar.',
    formato: 'texto',
    grupo: 'Aposta',
  },
  palpite: {
    nome: 'Palpite',
    ajuda: 'No que a pessoa apostou.',
    formato: 'texto',
    grupo: 'Aposta',
  },

  milhar: {
    nome: 'Milhar sorteada',
    ajuda: 'O primeiro prêmio. É texto, para não perder o zero à esquerda.',
    formato: 'texto',
    grupo: 'Resultado',
  },
  grupo: { nome: 'Grupo sorteado', ajuda: 'O número do grupo.', formato: 'texto', grupo: 'Resultado' },
  bicho: { nome: 'Bicho sorteado', ajuda: 'O bicho do grupo.', formato: 'texto', grupo: 'Resultado' },

  link_pagamento: {
    nome: 'Link de pagamento',
    ajuda: 'Onde a pessoa paga a aposta.',
    formato: 'link',
    grupo: 'Links',
  },
  link_resultado: {
    nome: 'Link do resultado',
    ajuda: 'Onde a pessoa confere o sorteio.',
    formato: 'link',
    grupo: 'Links',
  },
  pix_copia_cola: {
    nome: 'PIX copia e cola',
    ajuda: 'O código do PIX. Vai inteiro na mensagem — não encurte.',
    formato: 'texto',
    grupo: 'Links',
  },

  criado_em: {
    nome: 'Quando foi criado',
    ajuda: 'O instante em que o pedido nasceu.',
    formato: 'data',
    grupo: 'Tempo',
  },
  expira_em: {
    nome: 'Quando expira',
    ajuda: 'O instante em que o PIX perde a validade.',
    formato: 'data',
    grupo: 'Tempo',
  },
  fecha_em: {
    nome: 'Quando fecha a aposta',
    ajuda: 'A hora em que a extração para de aceitar aposta. É a urgência real.',
    formato: 'hora',
    grupo: 'Tempo',
  },
}

/**
 * Rótulo de um campo, conhecido ou não.
 *
 * O desconhecido vira "Valor pago" a partir de `valor_pago` em vez de sumir da
 * tela: dado que a plataforma manda e a interface esconde é dado que ninguém
 * descobre que tem.
 */
export function nomeDoCampo(chave: string): string {
  const conhecido = CAMPOS[chave]
  if (conhecido) return conhecido.nome

  const limpo = chave
    .replace(/_cents$/, '')
    .replace(/[_.]/g, ' ')
    .trim()

  return limpo.charAt(0).toLocaleUpperCase('pt-BR') + limpo.slice(1)
}

/**
 * O valor como a pessoa lê.
 *
 * `_cents` no fim vira dinheiro mesmo sem estar no catálogo — é a convenção de
 * §4.1, e sem ela um campo novo da plataforma apareceria como "50000" na
 * linha do tempo, que se lê como cinquenta mil reais e são quinhentos.
 */
export function valorDoCampo(chave: string, valor: unknown): string {
  if (valor === null || valor === undefined || valor === '') return '—'

  const formato = CAMPOS[chave]?.formato ?? (chave.endsWith('_cents') ? 'moeda' : 'texto')

  switch (formato) {
    case 'moeda':
      return formatarMoeda(valor) ?? String(valor)
    case 'data':
      return formatarData(valor) ?? String(valor)
    case 'hora':
      return formatarHora(valor) ?? String(valor)
    case 'telefone':
      // O número que não casa com o formato brasileiro volta como veio: um
      // telefone estrangeiro na tela vale mais que um traço.
      return (typeof valor === 'string' ? formatPhoneBR(valor) : null) ?? String(valor)
    default:
      if (typeof valor === 'object') return JSON.stringify(valor)
      return String(valor)
  }
}

// ── Eventos ──────────────────────────────────────────────────────────────────

export type EventoDescrito = {
  /** O título da linha do tempo. Frase, não identificador. */
  nome: string
  /** O que aconteceu, em uma linha. Vai no `title` e no detalhe. */
  ajuda: string
  /** Verde para o que é boa notícia, vermelho para o que não é. */
  tom: 'ok' | 'fail' | 'pending' | 'neutro'
}

export const EVENTOS: Record<CanonicalEvent, EventoDescrito> = {
  'user.created': {
    nome: 'Cadastrou-se na plataforma',
    ajuda: 'A pessoa criou a conta. É por aqui que ela entra na base.',
    tom: 'ok',
  },
  'order.created': {
    nome: 'Fez uma aposta',
    ajuda: 'A aposta foi registrada e o PIX gerado. Ainda não foi paga.',
    tom: 'pending',
  },
  'order.paid': {
    nome: 'Pagou a aposta',
    ajuda: 'O pagamento caiu e a aposta está valendo.',
    tom: 'ok',
  },
  'order.expired': {
    nome: 'O PIX venceu sem pagamento',
    ajuda: 'A aposta foi criada e o prazo do PIX passou.',
    tom: 'fail',
  },
  'order.cancelled': {
    nome: 'Cancelou a aposta',
    ajuda: 'A aposta foi cancelada antes de valer.',
    tom: 'fail',
  },
  'ticket.awarded': {
    nome: 'Ganhou',
    ajuda: 'A aposta foi premiada.',
    tom: 'ok',
  },
  'withdrawal.pending': {
    nome: 'Pediu um saque',
    ajuda: 'A pessoa pediu para retirar o dinheiro e está aguardando.',
    tom: 'pending',
  },
  'withdrawal.completed': {
    nome: 'Recebeu o saque',
    ajuda: 'O dinheiro saiu para a conta da pessoa.',
    tom: 'ok',
  },
  'campaign.created': {
    nome: 'Nova campanha criada',
    ajuda: 'A banca abriu uma campanha nova.',
    tom: 'neutro',
  },
  'campaign.ending_soon': {
    nome: 'Campanha perto do fim',
    ajuda: 'A campanha está prestes a encerrar.',
    tom: 'pending',
  },
  'contact.inactive_7d': {
    nome: 'Sumiu há 7 dias',
    ajuda: 'Uma semana sem aparecer. O Mandafy gera este evento sozinho.',
    tom: 'pending',
  },
  'contact.inactive_30d': {
    nome: 'Sumiu há 30 dias',
    ajuda: 'Um mês sem aparecer. O Mandafy gera este evento sozinho.',
    tom: 'fail',
  },
  'contact.first_purchase': {
    nome: 'Primeira compra',
    ajuda: 'Foi a primeira vez que esta pessoa pagou.',
    tom: 'ok',
  },
  'contact.repeat_purchase': {
    nome: 'Comprou de novo',
    ajuda: 'Já tinha comprado antes e voltou.',
    tom: 'ok',
  },
  'campaign.ending_24h': {
    nome: 'Campanha encerra em 24h',
    ajuda: 'Falta um dia para a campanha fechar. O Mandafy gera este evento sozinho.',
    tom: 'pending',
  },
}

/** Evento fora do catálogo ainda precisa aparecer, e com nome legível. */
export function descreverEvento(tipo: string): EventoDescrito {
  const conhecido = (EVENTOS as Record<string, EventoDescrito | undefined>)[tipo]
  if (conhecido) return conhecido

  return {
    nome: tipo.replace(/[._]/g, ' '),
    ajuda: `Evento "${tipo}", que a plataforma manda e o Mandafy ainda não nomeia.`,
    tom: 'neutro',
  }
}

export function ehEventoConhecido(tipo: string): tipo is CanonicalEvent {
  return (CANONICAL_EVENTS as readonly string[]).includes(tipo)
}

export type CampoDoEvento = { chave: string; rotulo: string; valor: string }

/**
 * Os campos de um evento, prontos para a tela.
 *
 * A linha do tempo mostrava `order.paid` e parava aí — o que a pessoa queria
 * saber (quanto pagou, de que aposta, por qual meio) estava gravado em `data`
 * e não aparecia em lugar nenhum da interface. Aqui esse conteúdo vira lista
 * de rótulo e valor, na ordem em que interessa: dinheiro primeiro, tempo
 * depois, o resto no fim.
 */
export function camposDoEvento(dados: unknown): CampoDoEvento[] {
  if (typeof dados !== 'object' || dados === null) return []

  const entradas = Object.entries(dados as Record<string, unknown>).filter(
    ([, valor]) => valor !== null && valor !== undefined && valor !== '',
  )

  const peso = (chave: string): number => {
    if (chave.endsWith('_cents')) return 0
    if (CAMPOS[chave]?.grupo === 'Aposta') return 1
    if (CAMPOS[chave]?.grupo === 'Resultado') return 2
    if (CAMPOS[chave]?.grupo === 'Tempo') return 3
    if (CAMPOS[chave]?.grupo === 'Links') return 5
    return 4
  }

  return entradas
    .sort(([a], [b]) => peso(a) - peso(b) || a.localeCompare(b))
    .map(([chave, valor]) => ({
      chave,
      rotulo: nomeDoCampo(chave),
      valor: valorDoCampo(chave, valor),
    }))
}

/**
 * O resumo de uma linha: "R$ 5,00 · Grupo · Elefante (grupo 11)".
 *
 * Dois ou três campos, os que mais dizem, para caber na linha do tempo sem
 * abrir o detalhe. Vazio quando o evento não trouxe nada além do tipo — e aí a
 * tela não desenha um separador solto.
 */
export function resumoDoEvento(dados: unknown): string {
  const campos = camposDoEvento(dados)
  if (campos.length === 0) return ''

  const interessantes = campos.filter(
    (c) => CAMPOS[c.chave]?.formato !== 'link' && c.chave !== 'external_id',
  )

  return interessantes
    .slice(0, 3)
    .map((c) => c.valor)
    .join(' · ')
}

/**
 * O canal caiu sozinho — a frase que a tela mostra (§8.1, §11.7).
 *
 * Mora AQUI, e não em `delivery/disjuntor.ts`, por uma razão de peso literal:
 * o cartão de canal é `use client`, e importar o disjuntor arrastaria o Drizzle
 * e o esquema inteiro para o pacote do navegador por causa de uma frase. O
 * orçamento de §13.1 é requisito, não recomendação.
 *
 * A pessoa não precisa saber o que é um "disjuntor". Precisa saber que o canal
 * parou, por quê, e que voltar é um clique.
 */
export function explicarDesligamento(
  canal: Channel,
  motivo: string | null,
  falhas = 2,
): string {
  const nome = CHANNEL_LABELS[canal]
  const inicio = `${nome} falhou ${falhas} vezes seguidas e foi desligado`
  return motivo
    ? `${inicio}: ${motivo}. Verifique e ligue de novo.`
    : `${inicio}. Verifique e ligue de novo.`
}

/**
 * Por que uma mensagem não saiu, em português (§10.1).
 *
 * O histórico tem uma coluna chamada "Tempo / motivo" que, para o que falhou,
 * imprimia o código cru: `sem_optin`, `credencial_recusada`,
 * `bloqueado_pelo_destino`. Quem opera a banca lia um identificador de
 * programador na única coluna que responde "por que fulano não recebeu?".
 *
 * DOIS GRUPOS, E A DIFERENÇA IMPORTA PARA QUEM LÊ
 *
 * Os primeiros são decisões do próprio Mandafy — regras de proteção que
 * barraram o envio de propósito. Os últimos são o provedor recusando, e são os
 * que estavam sem tradução nenhuma.
 */
export const MOTIVO_LABELS: Record<string, string> = {
  // Barrado por regra nossa (§5.3)
  optout: 'a pessoa pediu para não receber',
  suppressed: 'canal bloqueado para este contato',
  sem_optin: 'sem consentimento para mensagem promocional',
  frequency_cap: 'já recebeu o limite de mensagens hoje',
  duplicate: 'envio idêntico já registrado',
  sem_destino: 'sem endereço para este canal',
  canal_desligado: 'canal desligado nesta mensagem',
  mensagem_pausada: 'a mensagem está pausada',
  sem_numero_conectado: 'nenhum número de WhatsApp conectado',

  // Recusado pelo provedor (§8.1) — estes não tinham tradução em lugar nenhum
  sem_credencial: 'falta a credencial deste canal',
  credencial_recusada: 'o provedor recusou a credencial',
  provedor_indisponivel: 'o provedor está fora do ar',
  servidor_indisponivel: 'o servidor do provedor não respondeu',
  instancia_desconectada: 'o número de WhatsApp desconectou',
  limite_provedor: 'o provedor limitou o envio por excesso',
  destino_invalido: 'o endereço não existe',
  sem_whatsapp: 'este número não tem WhatsApp',
  bloqueado_pelo_destino: 'a pessoa bloqueou a banca',
  resposta_inesperada: 'o provedor respondeu algo que não entendemos',
  rede: 'a conexão com o provedor falhou',
  tentativas_esgotadas: 'tentamos várias vezes e não saiu',
}

/**
 * A frase do motivo, ou o código quando ele é novo.
 *
 * Devolver o código cru é melhor que devolver vazio: um provedor pode inventar
 * um erro que ainda não traduzimos, e nesse caso ver `saldo_zerado` é pior que
 * ver nada apenas para quem não integra — para quem integra, é a resposta.
 */
export function explicarMotivo(codigo: string | null | undefined): string {
  if (!codigo) return ''
  return MOTIVO_LABELS[codigo] ?? codigo
}

/**
 * O Mandafy gera este aviso sozinho? (§5, §11.7)
 *
 * `INTERNAL_EVENTS` está descrito no esquema como "gerados internamente pelo
 * Mandafy, nunca pela plataforma" — e NADA no sistema os gera. `processarEvento`
 * é chamado de um lugar só, `ingest/normalize.ts`, ou seja: só quando a
 * plataforma manda webhook.
 *
 * O efeito na tela é cruel com quem opera. Ele liga "Reativação 7 dias", espera,
 * nada acontece, e o painel informa "o evento nunca chegou" — apontando a culpa
 * para a plataforma dele, que está sã. O sistema sabia desde o começo que aquele
 * fluxo não tinha como rodar.
 *
 * Fazer o gerador é obra grande: varredura periódica, marcação para não
 * reemitir todo dia, migration e um caminho de teste que não existe. Dizer a
 * verdade custa uma frase.
 *
 * Não é "nunca dispara", e a diferença importa: uma plataforma PODE mapear um
 * evento dela para `contact.first_purchase`, e aí ele chega. A frase certa é
 * que o Mandafy não o produz por conta própria.
 */
export function ehEventoQueOMandafyNaoGera(tipo: string): boolean {
  return (INTERNAL_EVENTS as readonly string[]).includes(tipo)
}

/** A frase que a tela mostra ao recusar a ativação de um fluxo assim. */
export function porQueNaoDispara(tipo: string): string {
  return (
    `Este fluxo depende de "${descreverEvento(tipo).nome}", um aviso que o Mandafy ` +
    'ainda não gera sozinho. Ele só roda se a sua plataforma mandar esse evento pelo webhook.'
  )
}
