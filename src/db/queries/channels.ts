import { eq } from 'drizzle-orm'
import type { Tx } from '@/db'
import { channelConfigs, waInstances } from '@/db/schema'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { semaforo, type InstanciaWhatsapp, type Semaforo } from '@/lib/delivery/warmup'
import { estagioDe } from '@/lib/delivery/warmup'

/**
 * Estado dos canais e saúde dos números (§7.3, §8).
 *
 * Nenhuma credencial sai daqui — nem cifrada. A tela precisa saber SE existe
 * configuração, não qual é ela. Devolver o blob cifrado para o cliente seria
 * entregar material para ataque offline sem ganho nenhum de interface.
 */

export type EstadoCanal = {
  canal: Channel
  provider: string | null
  configurado: boolean
  ativo: boolean
  /**
   * Token do webhook de retorno, para a tela montar o endereço que se cola no
   * painel do provedor.
   *
   * Este SAI daqui, ao contrário das credenciais, e a diferença é de natureza:
   * a chave da Resend manda e-mail em nome do cliente, o token só recebe
   * retorno. Quem o tiver consegue forjar um bounce — dano real, e é por isso
   * que existe a assinatura por cima — mas não consegue enviar nada nem ler o
   * que já foi enviado. A tela é de admin (§9.4).
   */
  webhookToken: string | null
  /** Quando o disjuntor derrubou o canal. Nulo = se está desligado, foi alguém. */
  desligadoPeloSistema: Date | null
  /** O que o provedor respondeu na falha que derrubou — para a tela explicar. */
  motivoDoDesligamento: string | null
}

export async function estadoDosCanais(tx: Tx): Promise<EstadoCanal[]> {
  const linhas = await tx
    .select({
      channel: channelConfigs.channel,
      provider: channelConfigs.provider,
      credentials: channelConfigs.credentialsEncrypted,
      webhookToken: channelConfigs.webhookToken,
      active: channelConfigs.active,
      isDefault: channelConfigs.isDefault,
      disabledAt: channelConfigs.disabledAt,
      disabledReason: channelConfigs.disabledReason,
    })
    .from(channelConfigs)

  const porCanal = new Map(linhas.filter((l) => l.isDefault).map((l) => [l.channel, l]))

  return CHANNELS.map((canal) => {
    const linha = porCanal.get(canal)
    return {
      canal,
      provider: linha?.provider ?? null,
      configurado: Boolean(linha?.credentials && linha.credentials.length > 0),
      ativo: linha?.active ?? false,
      webhookToken: linha?.webhookToken ?? null,
      /*
       * Desligado por alguém e desligado pelo disjuntor são a mesma coluna
       * `active` e duas situações opostas (§8.1). Só `disabledAt` distingue —
       * e sem a distinção o cartão diria "você desligou este canal" para quem
       * não desligou nada.
       */
      desligadoPeloSistema: linha?.disabledAt ?? null,
      motivoDoDesligamento: linha?.disabledReason ?? null,
    }
  })
}

export type SaudeInstancia = {
  id: string
  name: string
  instanceName: string
  status: InstanciaWhatsapp['status']
  telefone: string | null
  estagio: number
  estagioLabel: string
  enviadasHoje: number
  tetoDiario: number
  intervaloMinimo: number
  falha24h: number
  ultimaConexao: Date | null
  ativa: boolean
  peso: number
  /** O Mandafy criou esta instância? Define se remover apaga do servidor. */
  gerenciada: boolean
  semaforo: { cor: Semaforo; texto: string }
}

/** Painel de saúde do número (§7.3): status, uso do teto, falha, semáforo. */
export async function saudeDasInstancias(tx: Tx): Promise<SaudeInstancia[]> {
  const linhas = await tx.select().from(waInstances).orderBy(waInstances.createdAt)

  return linhas.map((linha) => {
    const paraSemaforo: InstanciaWhatsapp = {
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
    }

    return {
      id: linha.id,
      name: linha.name,
      instanceName: linha.instanceName,
      status: linha.status,
      telefone: linha.phoneE164,
      estagio: linha.warmupStage,
      estagioLabel: estagioDe(linha.warmupStage).label,
      enviadasHoje: linha.sentToday,
      tetoDiario: linha.dailyCap,
      intervaloMinimo: linha.minIntervalSeconds,
      falha24h: Number(linha.failureRate24h),
      ultimaConexao: linha.lastConnectedAt,
      ativa: linha.active,
      peso: linha.weight,
      gerenciada: linha.managed,
      semaforo: semaforo(paraSemaforo),
    }
  })
}

export async function contarInstanciasAtivas(tx: Tx): Promise<number> {
  const linhas = await tx
    .select({ id: waInstances.id })
    .from(waInstances)
    .where(eq(waInstances.active, true))

  return linhas.length
}
