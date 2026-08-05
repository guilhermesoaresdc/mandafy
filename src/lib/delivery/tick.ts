/**
 * Enviar sem processo de pé (§7.1, §8.1).
 *
 * POR QUE EXISTE
 *
 * O worker consome filas BullMQ e precisa ficar rodando. Numa publicação só na
 * Vercel não existe onde ele rode — e sem consumidor, tudo que o sistema faz
 * termina numa linha `queued` que ninguém pega. O painel mostra "na fila" para
 * sempre e nada chega a ninguém.
 *
 * Este módulo é o consumidor alternativo: recebe uma janela de tempo, pega o
 * que está vencido em `notifications` e envia, dentro do orçamento. Chamado por
 * uma requisição HTTP periódica (ver src/app/api/cron/route.ts).
 *
 * A FILA DA VEZ É O POSTGRES, NÃO O REDIS
 *
 * `notifications` já é a fila real: tem `status`, `scheduled_for`, `attempts` e
 * índice para os pendentes. O BullMQ sempre foi um acelerador em cima disso —
 * `enqueue.ts` grava a linha ANTES de enfileirar justamente para que um Redis
 * fora do ar não perca envio. Ler do banco não é um caminho paralelo: é o mesmo
 * caminho, sem o acelerador.
 *
 * Por isso os dois modos convivem sem risco de envio duplo: quem envia de fato
 * é `processarEnvio`, e a transição para `sending` é comparação-e-troca. Se o
 * worker e o tick pegarem a mesma linha, só um dos dois UPDATEs encontra a
 * linha ainda pendente.
 *
 * O QUE ESTE MÓDULO RESPEITA
 *
 * O ritmo por instância (§7.2) e o teto diário (§7.3). Eles não são detalhe de
 * implementação da fila: são o que separa um número que dura de um número
 * banido em duas semanas. O espaçamento acontece DENTRO da invocação, porque
 * entre uma invocação e outra não há quem segure nada.
 */

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, withTenant } from '@/db'
import { notifications, organizations, waInstances } from '@/db/schema'
import { createLogger } from '@/lib/logger'
import { reprocessPending } from '@/lib/ingest/normalize'
import { paraCadaOrg } from '@/lib/manutencao'
import { processarEnvio } from './send'

const log = createLogger('tick')

/** Tentativas antes de desistir — espelha o que o worker configura no BullMQ. */
export const MAX_TENTATIVAS = 5

/** Espera antes de cada nova tentativa (§12.3 usa a mesma escada). */
export const BACKOFF_SEGUNDOS = [60, 300, 1800, 7200, 43_200] as const

/**
 * Folga antes do fim do orçamento.
 *
 * Um envio pode levar segundos: começar um quando resta menos que isto faria a
 * invocação ser cortada no meio da chamada ao provedor, deixando a linha em
 * `sending` sem ninguém para concluí-la.
 */
const MARGEM_MS = 8_000

/**
 * Quantos eventos recém-chegados normalizar por passagem.
 *
 * Baixo de propósito: um evento pode disparar uma cascata de quatro passos em
 * quatro canais, e tudo isso é escrita. O que sobrar fica para a próxima
 * passagem — que vem em seguida, ao contrário da manutenção horária.
 */
const LIMITE_NORMALIZACAO = 50

export type ResultadoTick = {
  enviados: number
  falhas: number
  jaProcessados: number
  reagendadosParaRetry: number
  /** Eventos recém-chegados que viraram evento normalizado nesta passagem. */
  normalizados: number
  /** Sobrou trabalho vencido que não coube no orçamento. */
  sobrou: boolean
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Devida = {
  id: string
  createdAt: Date
  orgId: string
  channel: string
  providerInstance: string | null
}

/**
 * O que está vencido, em ordem de vencimento.
 *
 * Por organização, e não numa consulta só, porque `notifications` está sob RLS:
 * sem `app.org_id` definido, a política compara `org_id` com nulo e a consulta
 * devolve ZERO linhas — sem erro, sem aviso. Um tick que lesse direto rodaria
 * para sempre relatando "nada a enviar" com a fila cheia.
 */
async function devidas(limite: number, agora: Date): Promise<Devida[]> {
  const orgs = await db.select({ id: organizations.id }).from(organizations)
  const todas: Devida[] = []

  for (const org of orgs) {
    const linhas = await withTenant(
      { orgId: org.id, userId: org.id, isAdmin: true },
      (tx) =>
        tx
          .select({
            id: notifications.id,
            createdAt: notifications.createdAt,
            orgId: notifications.orgId,
            channel: notifications.channel,
            providerInstance: notifications.providerInstance,
          })
          .from(notifications)
          .where(
            and(
              inArray(notifications.status, ['queued', 'scheduled']),
              // Sem `scheduled_for` é para agora — a coluna é opcional no
              // envio direto pela API.
              or(isNull(notifications.scheduledFor), lte(notifications.scheduledFor, agora)),
            ),
          )
          .orderBy(asc(notifications.scheduledFor))
          .limit(limite),
    ).catch(() => [] as Devida[])

    todas.push(...linhas)
  }

  // Ordem global de vencimento: com várias organizações, atender a mais
  // atrasada primeiro é o que impede uma fila grande de afogar as outras.
  return todas
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, limite)
}

/**
 * Devolve à fila o que falhou e ainda tem tentativa.
 *
 * O BullMQ fazia as retentativas; sem ele, uma notificação em `failed` ficaria
 * parada para sempre — e `failed` é o estado de quem AINDA TEM chance, ao
 * contrário de `dead`. Sem isto, uma instabilidade momentânea do provedor
 * viraria perda definitiva da mensagem.
 */
export async function reativarFalhas(agora = new Date()): Promise<number> {
  return paraCadaOrg(async (tx) => {
    let total = 0

    // Quem passou do teto não volta: vira `dead`, e o painel para de prometer
    // uma nova tentativa que ninguém faria. Antes da reativação, senão a
    // última tentativa seria devolvida à fila neste mesmo ciclo.
    await tx
      .update(notifications)
      .set({
        status: 'dead',
        errorCode: sql`coalesce(${notifications.errorCode}, 'tentativas_esgotadas')`,
      })
      .where(
        and(
          eq(notifications.status, 'failed'),
          sql`${notifications.attempts} >= ${MAX_TENTATIVAS}`,
        ),
      )

    for (const [tentativa, segundos] of BACKOFF_SEGUNDOS.entries()) {
      const limite = new Date(agora.getTime() - segundos * 1000)

      const linhas = await tx
        .update(notifications)
        .set({ status: 'queued', scheduledFor: agora })
        .where(
          and(
            eq(notifications.status, 'failed'),
            eq(notifications.attempts, tentativa + 1),
            lte(notifications.attemptedAt, limite),
          ),
        )
        .returning({ id: notifications.id })

      total += linhas.length
    }

    return total
  })
}

/**
 * Quando esta instância pode enviar de novo.
 *
 * O intervalo mínimo pertence ao CHIP, não ao canal (§7.2) — é por isso que o
 * worker cria uma fila por instância. Aqui o mesmo efeito vem de esperar entre
 * um envio e outro da mesma instância dentro da invocação.
 */
type Ritmo = { proximoEm: number; intervaloMs: number; restaHoje: number }

async function ritmos(): Promise<Map<string, Ritmo>> {
  const orgs = await db.select({ id: organizations.id }).from(organizations)
  const linhas: {
    id: string
    minIntervalSeconds: number
    lastSentAt: Date | null
    sentToday: number
    dailyCap: number
  }[] = []

  // Por organização pelo mesmo motivo de `devidas`: `wa_instances` está sob
  // RLS, e sem contexto a consulta devolve vazio em silêncio.
  for (const org of orgs) {
    const daOrg = await withTenant({ orgId: org.id, userId: org.id, isAdmin: true }, (tx) =>
      tx
        .select({
          id: waInstances.id,
          minIntervalSeconds: waInstances.minIntervalSeconds,
          lastSentAt: waInstances.lastSentAt,
          sentToday: waInstances.sentToday,
          dailyCap: waInstances.dailyCap,
        })
        .from(waInstances),
    ).catch(() => [])

    linhas.push(...daOrg)
  }

  const agora = Date.now()

  return new Map(
    linhas.map((l) => {
      const intervaloMs = l.minIntervalSeconds * 1000
      const desde = l.lastSentAt ? l.lastSentAt.getTime() : 0
      return [
        l.id,
        {
          proximoEm: Math.max(agora, desde + intervaloMs),
          intervaloMs,
          restaHoje: Math.max(0, l.dailyCap - l.sentToday),
        },
      ]
    }),
  )
}

/**
 * Uma passada de envio.
 *
 * `orcamentoMs` é o tempo que a invocação tem. Numa função serverless ele vem
 * do limite da plataforma; num processo de pé pode ser generoso.
 */
export async function tickDeEnvio(
  orcamentoMs: number,
  limite = 200,
  agora = new Date(),
): Promise<ResultadoTick> {
  const fim = Date.now() + orcamentoMs
  const resultado: ResultadoTick = {
    enviados: 0,
    falhas: 0,
    jaProcessados: 0,
    reagendadosParaRetry: 0,
    normalizados: 0,
    sobrou: false,
  }

  /*
   * O EVENTO QUE CHEGOU VIRA ENVIO AQUI, ANTES DE QUALQUER OUTRA COISA.
   *
   * A rota de ingestão grava em `events_raw` e enfileira no BullMQ em passos
   * separados, de propósito: assim um Redis fora do ar não derruba o ACK que a
   * plataforma espera. Quem consome essa fila é o worker.
   *
   * Numa publicação só na Vercel não há worker. A varredura de pendentes
   * existia, mas morava na manutenção HORÁRIA — então o evento ficava parado
   * até uma hora antes de virar evento normalizado e disparar fluxo. Um
   * lembrete de PIX marcado para +5 minutos sairia com 65. Pior ainda: entre a
   * chegada do evento e a manutenção seguinte, a tela de conexão não tinha o
   * que mostrar, e quem acabou de conectar concluía que não estava funcionando.
   *
   * Aqui é barato: consulta indexada por `processed_at IS NULL`, que na maioria
   * das passagens devolve zero linhas. O limite é baixo porque cada evento pode
   * disparar uma cascata inteira, e o orçamento desta invocação é o mesmo que
   * paga o envio logo abaixo.
   *
   * Sem risco de processar duas vezes quando o worker TAMBÉM estiver de pé:
   * quem normaliza marca `processed_at`, e o índice único de `events` recusa a
   * segunda gravação do mesmo evento.
   */
  resultado.normalizados = await reprocessPending(LIMITE_NORMALIZACAO)

  resultado.reagendadosParaRetry = await reativarFalhas(agora)

  const fila = await devidas(limite, agora)
  if (fila.length === 0) return resultado

  const ritmoPorInstancia = await ritmos()

  for (const item of fila) {
    if (Date.now() + MARGEM_MS >= fim) {
      resultado.sobrou = true
      break
    }

    const ritmo = item.providerInstance ? ritmoPorInstancia.get(item.providerInstance) : undefined

    if (ritmo) {
      /*
       * Teto diário estourado: a linha fica para amanhã em vez de sair. Não é
       * falha — é a regra de §7.3 funcionando, e marcá-la como falha poluiria a
       * taxa que decide a escada de aquecimento.
       */
      if (ritmo.restaHoje <= 0) continue

      const esperar = ritmo.proximoEm - Date.now()

      // Esperar além do orçamento não adianta: a próxima invocação pega.
      if (esperar > 0 && Date.now() + esperar + MARGEM_MS >= fim) {
        resultado.sobrou = true
        continue
      }
      if (esperar > 0) await espera(esperar)
    }

    const desfecho = await processarEnvio({
      notificationId: item.id,
      createdAt: item.createdAt.toISOString(),
      orgId: item.orgId,
    })

    if (ritmo) {
      ritmo.proximoEm = Date.now() + ritmo.intervaloMs
      ritmo.restaHoje -= 1
    }

    switch (desfecho.desfecho) {
      case 'enviado':
        resultado.enviados += 1
        break
      case 'falhou':
        resultado.falhas += 1
        break
      case 'cedo_demais':
        // A consulta filtra por `scheduled_for`, então isto seria contradição.
        // Se acontecer, é relógio do app divergindo do banco.
        log.warn('vencida mas adiantada — relógios divergentes?', { notificationId: item.id })
        break
      default:
        resultado.jaProcessados += 1
    }
  }

  return resultado
}

/**
 * Cancelamentos e envios pendentes de organizações específicas.
 *
 * Existe separado porque `processarEnvio` abre o próprio contexto de tenant, e
 * quem chama o tick não tem sessão nenhuma.
 */
export async function contarPendentes(): Promise<{ vencidos: number; futuros: number }> {
  let vencidos = 0
  let futuros = 0

  await paraCadaOrg(async (tx) => {
    const [linha] = await tx.execute<{ vencidos: number; futuros: number }>(sql`
      SELECT
        count(*) FILTER (WHERE scheduled_for IS NULL OR scheduled_for <= now())::int AS vencidos,
        count(*) FILTER (WHERE scheduled_for > now())::int AS futuros
      FROM notifications
      WHERE status IN ('queued', 'scheduled')
    `)

    vencidos += linha?.vencidos ?? 0
    futuros += linha?.futuros ?? 0
    return 0
  })

  return { vencidos, futuros }
}
