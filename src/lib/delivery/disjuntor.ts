import { and, eq, sql } from 'drizzle-orm'
import type { Tx } from '@/db'
import { channelConfigs } from '@/db/schema/infra'
import type { Channel } from '@/db/schema/enums'

/**
 * O disjuntor do canal (§8.1).
 *
 * DUAS FALHAS IGUAIS E ELE DESLIGA SOZINHO
 *
 * Um canal quebrado falha em TODAS as mensagens. Chave trocada, saldo no fim,
 * chip do WhatsApp caído: mil leads num lote viram mil linhas vermelhas no
 * histórico, e a coisa que elas dizem não é sobre nenhum daqueles mil
 * contatos. O histórico é onde se procura UMA mensagem entre milhares, e ele
 * ficava soterrado por um problema único.
 *
 * `prontidao.ts` já barra o que dá para saber de antemão — canal sem
 * credencial nenhuma, sem número conectado. O que sobra, e é o que este módulo
 * pega, é o que só o provedor sabe: a credencial existe e está errada, o saldo
 * acabou, a instância caiu depois do agendamento. Aí a falha só aparece no
 * envio, uma por mensagem, para sempre.
 *
 * FALHA DE CANAL, E NÃO QUALQUER FALHA
 *
 * Esta distinção é a diferença entre uma proteção e um estrago. Um número que
 * não tem WhatsApp, um e-mail que não existe, alguém que bloqueou a banca —
 * são fatos DAQUELE CONTATO. Contá-los aqui faria dois cadastros com telefone
 * errado derrubarem o WhatsApp da banca inteira.
 *
 * O QUE ISTO CUSTA, DITO POR EXTENSO
 *
 * `provedor_indisponivel` e `rede` também entram na conta, e são passageiros:
 * uma piscada de dois minutos no provedor desliga o canal e ele só volta
 * quando alguém clicar. É o preço de "deve ser verificado para continuar" — a
 * alternativa é o canal insistir sozinho e o histórico encher. Quem preferir o
 * contrário tira os dois de `CODIGOS_DE_CANAL`, e é a única mudança
 * necessária.
 */

/** Duas: é o que foi pedido, e é o menor número que distingue acidente de padrão. */
export const FALHAS_PARA_DESLIGAR = 2

/**
 * Os códigos que valem para todo mundo igualmente.
 *
 * Ficam de FORA, de propósito, os que são fato de um contato só:
 * `destino_invalido`, `sem_whatsapp`, `bloqueado_pelo_destino`.
 */
const CODIGOS_DE_CANAL = new Set([
  'sem_credencial',
  'credencial_recusada',
  'instancia_desconectada',
  'provedor_indisponivel',
  'servidor_indisponivel',
  'limite_provedor',
  'resposta_inesperada',
  'rede',
])

export function ehFalhaDeCanal(codigo: string | null | undefined): boolean {
  return codigo != null && CODIGOS_DE_CANAL.has(codigo)
}

export type Desligamento = {
  canal: Channel
  codigo: string
  /** Quantas falhas iguais seguidas — chega em `FALHAS_PARA_DESLIGAR`. */
  falhas: number
}

/**
 * Conta a falha e, se for a segunda igual, desliga o canal.
 *
 * Devolve o desligamento quando ele acontece, e `null` quando só contou — quem
 * chama usa isso para registrar no log uma vez, e não a cada mensagem.
 *
 * O `SELECT … FOR UPDATE` não é zelo: o worker roda vários envios ao mesmo
 * tempo, e sem a trava duas falhas simultâneas leem `consecutive_failures = 0`
 * e ambas gravam 1 — o canal nunca chegaria a dois e o disjuntor nunca
 * dispararia. É a corrida que faz uma proteção existir no código e não na
 * prática.
 */
export async function registrarFalhaDeCanal(
  tx: Tx,
  orgId: string,
  canal: Channel,
  codigo: string,
  mensagem: string,
  provider: string,
  agora = new Date(),
): Promise<Desligamento | null> {
  if (!ehFalhaDeCanal(codigo)) return null

  const [linha] = await tx
    .select({
      id: channelConfigs.id,
      active: channelConfigs.active,
      falhas: channelConfigs.consecutiveFailures,
      ultimoCodigo: channelConfigs.lastErrorCode,
    })
    .from(channelConfigs)
    .where(
      and(
        eq(channelConfigs.orgId, orgId),
        eq(channelConfigs.channel, canal),
        eq(channelConfigs.isDefault, true),
      ),
    )
    .for('update')
    .limit(1)

  /*
   * Sem linha, o canal está funcionando pelas variáveis de ambiente. Nasce uma
   * linha só para poder ser desligada — sem isso o disjuntor não existiria
   * justamente na instalação mais simples, que é a que mais erra credencial.
   */
  if (!linha) {
    await tx.insert(channelConfigs).values({
      orgId,
      channel: canal,
      provider,
      active: true,
      isDefault: true,
      consecutiveFailures: 1,
      lastErrorCode: codigo,
    })
    return null
  }

  const falhas = linha.ultimoCodigo === codigo ? linha.falhas + 1 : 1
  const desliga = falhas >= FALHAS_PARA_DESLIGAR && linha.active

  await tx
    .update(channelConfigs)
    .set({
      consecutiveFailures: falhas,
      lastErrorCode: codigo,
      updatedAt: agora,
      ...(desliga
        ? {
            active: false,
            disabledAt: agora,
            // Do provedor, nunca do contato (§14.1).
            disabledReason: mensagem.slice(0, 300),
          }
        : {}),
    })
    .where(eq(channelConfigs.id, linha.id))

  return desliga ? { canal, codigo, falhas } : null
}

/**
 * Um envio que saiu zera a contagem.
 *
 * Sem isto, duas falhas separadas por três semanas e mil envios bem-sucedidos
 * desligariam o canal — "consecutivas" tem de querer dizer consecutivas.
 *
 * A condição no `WHERE` evita uma escrita por mensagem enviada: o caso comum é
 * o contador já estar em zero.
 */
export async function zerarFalhasDoCanal(
  tx: Tx,
  orgId: string,
  canal: Channel,
): Promise<void> {
  await tx
    .update(channelConfigs)
    .set({ consecutiveFailures: 0, lastErrorCode: null })
    .where(
      and(
        eq(channelConfigs.orgId, orgId),
        eq(channelConfigs.channel, canal),
        eq(channelConfigs.isDefault, true),
        sql`${channelConfigs.consecutiveFailures} > 0`,
      ),
    )
}

/**
 * Religar depois de verificar.
 *
 * Zera tudo, inclusive `disabledAt` — senão a tela continuaria dizendo "o
 * sistema desligou este canal" para um canal que a pessoa acabou de ligar.
 */
export async function religarCanal(tx: Tx, orgId: string, canal: Channel): Promise<void> {
  await tx
    .update(channelConfigs)
    .set({
      active: true,
      consecutiveFailures: 0,
      lastErrorCode: null,
      disabledAt: null,
      disabledReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(channelConfigs.orgId, orgId),
        eq(channelConfigs.channel, canal),
        eq(channelConfigs.isDefault, true),
      ),
    )
}
