/**
 * Os quatro canais atrás de uma interface comum (§8, regra 3 do CLAUDE.md).
 *
 * Nada fora de `lib/channels` deve conhecer a Evolution, o Resend ou o SMSDev.
 * Trocar de provedor é trocar uma variável de ambiente — e uma mudança de
 * contrato do provedor é um patch dentro de um arquivo só.
 */

export * from './types'
export * from './whatsapp'
export * from './email'
export * from './sms'
export * from './telegram'

import type { Channel } from '@/db/schema/enums'
import type { DestinoEnvio, ResultadoEnvio } from './types'
import { enviarWhatsapp, type ConfigWhatsapp } from './whatsapp'
import { enviarEmail, type ConfigEmail } from './email'
import { enviarSms, type ConfigSms } from './sms'
import { enviarTelegram, type ConfigTelegram } from './telegram'

/** Configuração de cada canal, resolvida a partir de `channel_configs`. */
export type ConfigDeCanal =
  | { canal: 'whatsapp'; config: ConfigWhatsapp }
  | { canal: 'email'; config: ConfigEmail }
  | { canal: 'sms'; config: ConfigSms }
  | { canal: 'telegram'; config: ConfigTelegram }

/** Despacha para o adaptador do canal. É o único ponto de entrada do envio. */
export function enviarPeloCanal(
  destino: DestinoEnvio,
  alvo: ConfigDeCanal,
): Promise<ResultadoEnvio> {
  switch (alvo.canal) {
    case 'whatsapp':
      return enviarWhatsapp(destino, alvo.config)
    case 'email':
      return enviarEmail(destino, alvo.config)
    case 'sms':
      return enviarSms(destino, alvo.config)
    case 'telegram':
      return enviarTelegram(destino, alvo.config)
  }
}

/** Quais canais têm credencial suficiente para tentar um envio. */
export function canalConfigurado(alvo: ConfigDeCanal): boolean {
  switch (alvo.canal) {
    case 'whatsapp':
      return Boolean(alvo.config.url && alvo.config.instancia && alvo.config.apikey)
    case 'email':
      return Boolean(alvo.config.apiKey && alvo.config.remetente)
    case 'sms':
      return Boolean(alvo.config.apiKey)
    case 'telegram':
      return Boolean(alvo.config.botToken)
  }
}

export const CANAL_PROVEDORES: Record<Channel, readonly string[]> = {
  whatsapp: ['evolution'],
  email: ['resend', 'brevo'],
  sms: ['smsdev', 'comtele'],
  telegram: ['telegram'],
}
