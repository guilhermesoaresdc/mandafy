import type { Channel, MessageCategory } from '@/db/schema/enums'
import { CATEGORY_REQUIRES_OPTIN } from '@/db/schema/enums'
import { agendar, JANELA_PADRAO, type JanelaSilencio, type Reagendamento } from './quiet-hours'

/**
 * Regras de guarda (§5.3).
 *
 * Rodam antes de TODO envio, nesta ordem, e o motivo vai para o log. A ordem
 * não é arbitrária: as verificações que protegem a pessoa (opt-out, supressão)
 * vêm antes das que protegem a operação (teto, dedupe), porque um envio a quem
 * pediu para sair é problema jurídico, não operacional.
 *
 * Puras de propósito — recebem o estado já carregado e não tocam no banco. É o
 * que permite testar as oito regras sem Postgres.
 */

export const MOTIVOS_SKIP = [
  'optout',
  'suppressed',
  'sem_optin',
  'frequency_cap',
  'duplicate',
  'sem_destino',
  'canal_desligado',
  'mensagem_pausada',
  'sem_numero_conectado',
] as const

export type MotivoSkip = (typeof MOTIVOS_SKIP)[number]

/**
 * As frases dos motivos moram em `@/lib/vocabulario`.
 *
 * Saíram daqui porque a TELA também precisa delas — o histórico imprimia
 * `sem_optin` cru na coluna de motivo — e este módulo é do motor de entrega:
 * importá-lo de um componente arrastaria o Drizzle e o esquema para o pacote
 * do navegador por causa de um dicionário de dez frases.
 *
 * O reexporte mantém quem já importava daqui funcionando.
 */
export { MOTIVO_LABELS } from '@/lib/vocabulario'

/** Teto diário por contato, somando todos os canais (§5.3, regra 4). */
export const LIMITE_DIARIO_PADRAO = 4

export type ContatoParaEnvio = {
  optedOutAt: Date | null
  optinAt: Date | null
  phoneE164: string | null
  email: string | null
  telegramChatId: number | null
  optinWhatsapp: boolean
  optinEmail: boolean
  optinSms: boolean
  optinTelegram: boolean
}

export type ContextoGuarda = {
  canal: Channel
  contato: ContatoParaEnvio
  categoria: MessageCategory
  /** A variante daquele canal está ligada? */
  canalLigado: boolean
  mensagemAtiva: boolean
  /** Canais em `suppressions` para este contato. */
  suprimidos: readonly Channel[]
  /** Quantas mensagens o contato já recebeu hoje. */
  recebidasHoje: number
  limiteDiario?: number
  /** Já existe notificação com o mesmo `dedupe_key`? */
  duplicado: boolean
  ignorarSilencio: boolean
  janela?: JanelaSilencio
}

export type Decisao =
  | { acao: 'enviar'; quando: Date }
  | { acao: 'reagendar'; quando: Date; abertura: Date }
  | { acao: 'pular'; motivo: MotivoSkip }

const OPTIN_POR_CANAL: Record<Channel, keyof ContatoParaEnvio> = {
  whatsapp: 'optinWhatsapp',
  email: 'optinEmail',
  sms: 'optinSms',
  telegram: 'optinTelegram',
}

/** O contato tem endereço para este canal? (§5.3, regra 6) */
export function temDestino(contato: ContatoParaEnvio, canal: Channel): boolean {
  switch (canal) {
    case 'whatsapp':
    case 'sms':
      return Boolean(contato.phoneE164)
    case 'email':
      return Boolean(contato.email)
    case 'telegram':
      return contato.telegramChatId !== null
  }
}

/**
 * Decide o destino de um envio.
 *
 * `agora` e `atrasoSegundos` entram por parâmetro para que a decisão seja
 * reproduzível: o mesmo estado sempre produz o mesmo resultado.
 */
export function decidirEnvio(
  ctx: ContextoGuarda,
  agora: Date,
  atrasoSegundos: number,
): Decisao {
  // 0. Mensagem pausada não sai por canal nenhum.
  if (!ctx.mensagemAtiva) return { acao: 'pular', motivo: 'mensagem_pausada' }

  // 1. Opt-out global.
  if (ctx.contato.optedOutAt) return { acao: 'pular', motivo: 'optout' }

  // 2. Opt-out do canal ou supressão.
  if (!ctx.contato[OPTIN_POR_CANAL[ctx.canal]]) return { acao: 'pular', motivo: 'suppressed' }
  if (ctx.suprimidos.includes(ctx.canal)) return { acao: 'pular', motivo: 'suppressed' }

  /*
   * 2b. Base legal (§14.1). Promocional exige consentimento registrado;
   * transacional se apoia em execução de contrato. Fica aqui, junto das outras
   * verificações de consentimento, e não como uma checagem esquecida no fluxo.
   */
  if (CATEGORY_REQUIRES_OPTIN[ctx.categoria] && !ctx.contato.optinAt) {
    return { acao: 'pular', motivo: 'sem_optin' }
  }

  // 7. Canal desligado na mensagem. Antes do teto: não gasta cota de quem nem
  // ia receber por aqui.
  if (!ctx.canalLigado) return { acao: 'pular', motivo: 'canal_desligado' }

  // 6. Sem endereço.
  if (!temDestino(ctx.contato, ctx.canal)) return { acao: 'pular', motivo: 'sem_destino' }

  // 4. Teto diário por contato.
  if (ctx.recebidasHoje >= (ctx.limiteDiario ?? LIMITE_DIARIO_PADRAO)) {
    return { acao: 'pular', motivo: 'frequency_cap' }
  }

  // 5. Duplicado.
  if (ctx.duplicado) return { acao: 'pular', motivo: 'duplicate' }

  // 3. Janela de silêncio — reagenda, nunca descarta.
  const quando: Reagendamento = agendar(agora, atrasoSegundos, ctx.janela ?? JANELA_PADRAO, {
    ignorarSilencio: ctx.ignorarSilencio,
  })

  return quando.silenciado
    ? { acao: 'reagendar', quando: quando.quando, abertura: quando.abertura }
    : { acao: 'enviar', quando: quando.quando }
}
