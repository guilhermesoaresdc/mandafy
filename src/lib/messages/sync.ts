import type { Channel } from '@/db/schema/enums'
import type { MessageVariant } from '@/db/schema/messages'

/**
 * Propagação do corpo principal para as variantes (§6.1).
 *
 * O modelo mental da spec: "Editar o corpo principal propaga para as variantes
 * que você não tocou (elas ficam 'sincronizadas'); no momento em que você edita
 * uma variante, ela vira 'customizada' e para de receber propagação — com um
 * botão 'ressincronizar' sempre disponível."
 *
 * A regra mora aqui, isolada, porque é fácil de errar de um jeito silencioso: o
 * modo de falhar é sobrescrever o texto que alguém ajustou à mão, e ninguém
 * percebe até o cliente receber a versão errada.
 */

export type EstadoSincronia = 'sincronizado' | 'customizado'

export const ESTADO_LABELS: Record<EstadoSincronia, string> = {
  sincronizado: 'sincronizado',
  customizado: 'customizado',
}

export function estadoDa(variante: Pick<MessageVariant, 'synced'>): EstadoSincronia {
  return variante.synced ? 'sincronizado' : 'customizado'
}

/** O corpo que vale para um canal: o da variante se customizada, senão o principal. */
export function corpoEfetivo(
  corpoPrincipal: string,
  variante: Pick<MessageVariant, 'synced' | 'body'> | null,
): string {
  if (!variante || variante.synced) return corpoPrincipal
  return variante.body ?? corpoPrincipal
}

export type PropagacaoDecisao = { channel: Channel; novoCorpo: string | null; propagou: boolean }

/**
 * Decide o que fazer com cada variante quando o corpo principal muda.
 *
 * Sincronizada recebe o texto novo; customizada é preservada — inclusive
 * quando a pessoa customizou e depois apagou tudo, porque "vazio" pode ser
 * intencional num canal que ela não quer usar com aquele texto.
 */
export function propagar(
  corpoPrincipal: string,
  variantes: Pick<MessageVariant, 'channel' | 'synced' | 'body'>[],
): PropagacaoDecisao[] {
  return variantes.map((variante) =>
    variante.synced
      ? { channel: variante.channel, novoCorpo: corpoPrincipal, propagou: true }
      : { channel: variante.channel, novoCorpo: variante.body, propagou: false },
  )
}

/**
 * Editar uma variante a torna customizada — mas só se o texto realmente mudou.
 *
 * Sem essa comparação, abrir a aba de um canal e salvar sem tocar em nada
 * quebraria a sincronia à toa, e o corpo principal deixaria de propagar sem que
 * ninguém tivesse pedido isso.
 */
export function editarVariante(
  corpoPrincipal: string,
  variante: Pick<MessageVariant, 'synced' | 'body'>,
  novoCorpo: string,
): { body: string | null; synced: boolean } {
  if (novoCorpo === corpoEfetivo(corpoPrincipal, variante)) {
    return { body: variante.body, synced: variante.synced }
  }

  // Voltar a variante ao texto exato do principal é ressincronizar na prática.
  if (novoCorpo === corpoPrincipal) return { body: null, synced: true }

  return { body: novoCorpo, synced: false }
}

/** Ressincronizar: descarta o texto próprio e volta a seguir o principal. */
export function ressincronizar(): { body: null; synced: true } {
  return { body: null, synced: true }
}
