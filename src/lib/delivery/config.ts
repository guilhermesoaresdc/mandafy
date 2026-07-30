import { and, eq } from 'drizzle-orm'
import type { Tx } from '@/db'
import { channelConfigs, waInstances } from '@/db/schema'
import type { Channel } from '@/db/schema/enums'
import { serverEnv } from '@/env'
import { decryptSecret } from '@/lib/crypto'
import type { ConfigDeCanal } from '@/lib/channels'
import type { InstanciaWhatsapp } from './warmup'

/**
 * De onde vem a credencial de cada canal (§8, §14.1).
 *
 * Duas fontes, nesta ordem: o que a organização configurou em
 * `channel_configs` (cifrado em repouso) e, na falta disso, o ambiente. O
 * ambiente é o modo de instalação única — um cliente por servidor — e o banco
 * é o modo multi-organização. Suportar os dois evita exigir configuração pelo
 * painel antes do primeiro envio de teste.
 *
 * A decifragem acontece SÓ aqui. Credencial em claro não circula pelo resto do
 * sistema, e nunca vai para log (§14.1).
 */

export type CredenciaisCanal = Record<string, string>

/** Decifra o blob de `channel_configs`, tolerando ausência. */
function abrirCredenciais(cifrado: Buffer | null): CredenciaisCanal {
  if (!cifrado || cifrado.length === 0) return {}

  try {
    const texto = decryptSecret(Buffer.from(cifrado))
    const json: unknown = JSON.parse(texto)
    if (typeof json !== 'object' || json === null) return {}

    // Só strings: um número ou objeto aqui viraria "[object Object]" no header.
    return Object.fromEntries(
      Object.entries(json as Record<string, unknown>).filter(
        (par): par is [string, string] => typeof par[1] === 'string',
      ),
    )
  } catch {
    /*
     * Credencial ilegível é o mesmo que credencial ausente para quem envia — e
     * o motivo NÃO pode ir para o log com detalhe, porque a mensagem do erro de
     * AES pode vazar informação sobre a chave. O canal simplesmente aparece
     * como não configurado.
     */
    return {}
  }
}

export type ResolucaoCanal = {
  alvo: ConfigDeCanal | null
  provider: string
  /** Por que não dá para enviar — texto para a tela, não para o cliente final. */
  falta: string | null
}

/**
 * Configuração pronta para uso do canal, ou o motivo de não haver.
 *
 * `instancia` só é usado pelo WhatsApp e vem do rodízio (§7.3): é o chip que
 * fará ESTE envio.
 */
export async function resolverCanal(
  tx: Tx,
  orgId: string,
  canal: Channel,
  instancia?: InstanciaWhatsappComSegredo | null,
): Promise<ResolucaoCanal> {
  const env = serverEnv()

  const [linha] = await tx
    .select({
      provider: channelConfigs.provider,
      credentials: channelConfigs.credentialsEncrypted,
      active: channelConfigs.active,
    })
    .from(channelConfigs)
    .where(
      and(
        eq(channelConfigs.orgId, orgId),
        eq(channelConfigs.channel, canal),
        eq(channelConfigs.isDefault, true),
      ),
    )
    .limit(1)

  const cred = abrirCredenciais(linha?.credentials ?? null)

  if (linha && !linha.active) {
    return { alvo: null, provider: linha.provider, falta: 'o canal está desligado nas configurações' }
  }

  switch (canal) {
    case 'whatsapp': {
      if (!instancia) {
        return { alvo: null, provider: 'evolution', falta: 'nenhum número de WhatsApp conectado' }
      }

      const apikey = instancia.apikey || cred.apikey || env.EVOLUTION_GLOBAL_APIKEY || ''
      const url = instancia.evolutionUrl || cred.url || env.EVOLUTION_URL || ''

      if (!url || !apikey) {
        return { alvo: null, provider: 'evolution', falta: 'a Evolution API não está configurada' }
      }

      return {
        provider: 'evolution',
        falta: null,
        alvo: { canal, config: { url, instancia: instancia.instanceName, apikey } },
      }
    }

    case 'email': {
      const provider = (linha?.provider ?? env.EMAIL_PROVIDER) as 'resend' | 'brevo'
      const apiKey = cred.apiKey || env.RESEND_API_KEY || ''
      const remetente = cred.remetente || env.EMAIL_FROM || ''

      if (!apiKey) return { alvo: null, provider, falta: 'falta a chave do provedor de e-mail' }
      if (!remetente) return { alvo: null, provider, falta: 'falta o remetente (EMAIL_FROM)' }

      // O adaptador só conhece resend e brevo; SES ainda não tem implementação.
      const suportado = provider === 'brevo' ? 'brevo' : 'resend'
      return { provider: suportado, falta: null, alvo: { canal, config: { provider: suportado, apiKey, remetente } } }
    }

    case 'sms': {
      const provider = (linha?.provider ?? env.SMS_PROVIDER) as 'smsdev' | 'comtele'
      const apiKey = cred.apiKey || env.SMS_API_KEY || ''
      const remetente = cred.remetente || env.SMS_SENDER

      if (!apiKey) return { alvo: null, provider, falta: 'falta a chave do provedor de SMS' }

      const suportado = provider === 'comtele' ? 'comtele' : 'smsdev'
      return {
        provider: suportado,
        falta: null,
        alvo: { canal, config: { provider: suportado, apiKey, ...(remetente ? { remetente } : {}) } },
      }
    }

    case 'telegram': {
      const botToken = cred.botToken || env.TELEGRAM_BOT_TOKEN || ''
      if (!botToken) return { alvo: null, provider: 'telegram', falta: 'falta o token do bot' }

      return { provider: 'telegram', falta: null, alvo: { canal, config: { botToken } } }
    }
  }
}

export type InstanciaWhatsappComSegredo = InstanciaWhatsapp & {
  evolutionUrl: string
  instanceName: string
  apikey: string
}

/** Instâncias de WhatsApp da organização, com a apikey já decifrada. */
export async function carregarInstancias(
  tx: Tx,
  orgId: string,
): Promise<InstanciaWhatsappComSegredo[]> {
  const linhas = await tx
    .select()
    .from(waInstances)
    .where(eq(waInstances.orgId, orgId))

  return linhas.map((linha) => ({
    id: linha.id,
    name: linha.name,
    status: linha.status,
    warmupStage: linha.warmupStage,
    warmupStartedAt: linha.warmupStartedAt,
    dailyCap: linha.dailyCap,
    minIntervalSeconds: linha.minIntervalSeconds,
    sentToday: linha.sentToday,
    lastSentAt: linha.lastSentAt,
    failureRate24h: Number(linha.failureRate24h),
    weight: linha.weight,
    active: linha.active,
    evolutionUrl: linha.evolutionUrl,
    instanceName: linha.instanceName,
    apikey: abrirCredenciais(linha.apikeyEncrypted).apikey ?? '',
  }))
}
