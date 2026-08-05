/**
 * As tarefas periódicas do sistema (§7.3, §10.2), fora do worker.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 *
 * Elas moravam dentro de `src/worker/index.ts`, presas ao agendador repetível
 * do BullMQ — que só existe se houver um processo de pé. Quem publica só na
 * Vercel não tem esse processo, e sem estas rotinas o sistema apodrece em
 * silêncio: `sent_today` nunca zera e toda instância bate o teto no segundo
 * dia; as partições do dia seguinte não são criadas; leads atrasados nunca
 * viram lead.
 *
 * Aqui elas viram funções puras de agendador. O worker continua chamando as
 * mesmas, e o tick por HTTP também — nenhuma lógica duplicada entre os dois
 * caminhos, que é o que faria os dois divergirem com o tempo.
 *
 * O "quando rodou pela última vez" vive em `system_state`, porque um tick sem
 * estado não sabe o que a invocação anterior fez.
 */

import { eq, sql } from 'drizzle-orm'
import { db, withTenant } from '@/db'
import { organizations, systemState, waInstances } from '@/db/schema'
import { purgeExpiredSessions } from '@/lib/auth/session'
import { varrerLeadsAtrasados } from '@/lib/crm/criar-lead'
import { reenfileirarPendentes } from '@/lib/delivery/enqueue'
import { avaliarEscada, limitesDoEstagio } from '@/lib/delivery/warmup'
import { reprocessPending } from '@/lib/ingest/normalize'
import { createLogger } from '@/lib/logger'

const log = createLogger('manutencao')

const FUSO = process.env.DEFAULT_TIMEZONE ?? 'America/Sao_Paulo'

export const TAREFAS = {
  horaria: 'manutencao.horaria',
  diaria: 'manutencao.diaria',
} as const

// ── Registro de execução ─────────────────────────────────────────────────────

export async function ultimaExecucao(chave: string): Promise<Date | null> {
  const [linha] = await db
    .select({ ranAt: systemState.ranAt })
    .from(systemState)
    .where(eq(systemState.key, chave))
    .limit(1)

  return linha?.ranAt ?? null
}

export async function registrarExecucao(
  chave: string,
  detalhe?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(systemState)
    .values({ key: chave, ranAt: new Date(), detail: detalhe ?? null })
    .onConflictDoUpdate({
      target: systemState.key,
      set: { ranAt: new Date(), detail: detalhe ?? null },
    })
}

/**
 * A trava do batimento — e o motivo de ela NÃO ser um advisory lock (§7.1).
 *
 * O SINTOMA
 *
 * O cron chamava `/api/cron` a cada minuto, recebia `200 OK` em ~6 segundos,
 * sem uma falha sequer — e nada acontecia. Evento recebido ficava "na fila"
 * para sempre, o painel mostrava zero enviadas e zero na fila, e o histórico só
 * tinha os envios de teste feitos à mão.
 *
 * A CAUSA
 *
 * `pg_try_advisory_lock` é uma trava de SESSÃO. Atrás do pooler da Supabase em
 * modo transação — que é o modo obrigatório na Vercel — cada consulta pode cair
 * numa sessão de backend diferente. Então:
 *
 *   1. o `SELECT pg_try_advisory_lock(…)` pega a trava na sessão A;
 *   2. a conexão volta para o pool, e a sessão A CONTINUA com a trava;
 *   3. o `pg_advisory_unlock` do `finally` cai na sessão B, devolve `false` e
 *      não solta nada;
 *   4. a sessão A guarda a trava enquanto viver no pool da Supabase;
 *   5. todo batimento seguinte lê "ocupado", responde `{ok: true}` e volta.
 *
 * Duzentos, no minuto certo, sem fazer nada — a assinatura exata de uma falha
 * silenciosa. E é o segundo problema deste projeto causado pelo mesmo pooler; o
 * primeiro foram os prepared statements em `src/db/index.ts`.
 *
 * A TRAVA POR LINHA
 *
 * Uma linha em `system_state` com prazo de validade. Não depende de sessão,
 * então funciona atrás de qualquer pooler — e se o processo morrer no meio, a
 * trava vence sozinha em vez de ficar presa até alguém reiniciar o banco.
 */
const CHAVE_TRAVA = 'batimento.trava'

/**
 * Quanto tempo a trava vale sem ser renovada.
 *
 * Maior que o teto de execução da função (60s), para que um batimento lento não
 * seja atropelado pelo seguinte; e curto o bastante para que um processo morto
 * no meio não pare o sistema por mais de um ciclo ou dois.
 */
const VALIDADE_SEGUNDOS = 90

/** Pega a trava, ou devolve `false` se outro batimento está em curso. */
export async function pegarTrava(agora = new Date()): Promise<boolean> {
  /*
   * `INSERT … ON CONFLICT DO UPDATE … WHERE` num comando só, de propósito: ler
   * e depois escrever abriria a janela em que dois batimentos leem "livre"
   * antes de qualquer um gravar. O `WHERE` do `DO UPDATE` é avaliado sobre a
   * linha já bloqueada pelo próprio `ON CONFLICT`, então a decisão é atômica.
   *
   * Sem linha devolvida = outro batimento tem a trava e ela ainda vale.
   */
  /*
   * O corte vem calculado daqui, e não de `make_interval(secs => $n)` no SQL:
   * ali o Postgres não consegue inferir o tipo do parâmetro dentro da notação
   * nomeada e recusa a consulta inteira. Uma data pronta não tem essa dúvida —
   * e lê melhor.
   */
  /*
   * ISO com `::timestamptz`, e não o `Date` cru.
   *
   * Num `sql` bruto o driver não converte `Date` sozinho — ele recebe o objeto
   * e estoura com "The string argument must be of type string". Quem converte é
   * a camada de coluna do Drizzle, que aqui não está no caminho.
   */
  const marca = agora.toISOString()
  const vencidaAntesDe = new Date(agora.getTime() - VALIDADE_SEGUNDOS * 1000).toISOString()

  const linhas = await db.execute<{ pego: boolean }>(sql`
    INSERT INTO system_state (key, ran_at)
    VALUES (${CHAVE_TRAVA}, ${marca}::timestamptz)
    ON CONFLICT (key) DO UPDATE
      SET ran_at = ${marca}::timestamptz
      WHERE system_state.ran_at < ${vencidaAntesDe}::timestamptz
    RETURNING true AS pego
  `)

  return linhas.length > 0
}

/**
 * Solta a trava.
 *
 * Empurra `ran_at` para o passado em vez de apagar a linha: apagar e reinserir
 * gera mais lixo de vacuum, e uma linha com data antiga já significa "livre"
 * para a consulta acima.
 */
export async function soltarTrava(): Promise<void> {
  await db.execute(sql`
    UPDATE system_state
    SET ran_at = to_timestamp(0)
    WHERE key = ${CHAVE_TRAVA}
  `)
}

/** O dia civil no fuso de operação — `2026-08-01`. */
export function diaLocal(momento: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(momento)
}

// ── Manutenção de hora em hora ───────────────────────────────────────────────

export type ResultadoHorario = {
  particoes: string
  sessoes: number
  retomados: number
  reenviados: number
  escadas: number
  novosLeads: number
}

export async function manutencaoHoraria(): Promise<ResultadoHorario> {
  const [linha] = await db.execute<{ result: string }>(
    sql`SELECT mandafy_maintain_partitions() AS result`,
  )
  const particoes = linha?.result ?? 'sem retorno'

  const sessoes = await purgeExpiredSessions()

  /*
   * Retoma eventos gravados que não chegaram à fila — o endpoint de ingestão
   * grava e enfileira em passos separados de propósito, para que um Redis fora
   * do ar não derrube o ACK. Sem esta varredura, esses eventos ficariam
   * parados para sempre.
   */
  const retomados = await reprocessPending(200)

  // Envios gravados que não chegaram à fila — a mesma rede de segurança, do
  // outro lado do sistema.
  const reenviados = await paraCadaOrg((tx) => reenfileirarPendentes(tx))

  const escadas = await avancarAquecimento()
  const novosLeads = await varrerLeads()

  const resultado = { particoes, sessoes, retomados, reenviados, escadas, novosLeads }
  await registrarExecucao(TAREFAS.horaria, resultado)
  return resultado
}

/**
 * Roda `fn` uma vez por organização, com contexto de tenant, e soma.
 *
 * TODA rotina de manutenção precisa passar por aqui, e o motivo é uma
 * armadilha que já custou caro neste código: `db.select().from(waInstances)`
 * sem contexto devolve ZERO linhas quando o papel da aplicação está em uso —
 * a política compara `org_id` com nulo. A rotina roda, não acusa erro, não
 * altera nada, e o log diz "0 instâncias".
 *
 * O efeito era invisível e grave: a escada de aquecimento nunca subia e
 * `sent_today` nunca zerava, então toda instância batia o teto no segundo dia
 * e a operação parava em silêncio. Num Supabase onde a aplicação é dona das
 * tabelas isso funcionava por acidente — o mesmo acidente que deixa o RLS
 * decorativo.
 *
 * `organizations` é legível sem contexto desde drizzle/0011, que é o que
 * permite descobrir a lista antes de abrir cada contexto.
 */
export async function paraCadaOrg(
  fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], orgId: string) => Promise<number>,
): Promise<number> {
  const orgs = await db.select({ id: organizations.id }).from(organizations)
  let total = 0

  for (const org of orgs) {
    // Uma transação por organização: um erro numa não pode impedir as outras.
    total += await withTenant({ orgId: org.id, userId: org.id, isAdmin: true }, (tx) =>
      fn(tx, org.id),
    ).catch((erro: unknown) => {
      log.error('manutenção falhou numa organização', {
        orgId: org.id,
        reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
      })
      return 0
    })
  }

  return total
}

/** Varre os leads atrasados de cada organização (§9.3). */
async function varrerLeads(): Promise<number> {
  return paraCadaOrg((tx, orgId) => varrerLeadsAtrasados(tx, orgId))
}

/**
 * Move a escada de aquecimento (§7.3).
 *
 * A progressão é automática, mas só sobe com falha abaixo de 3% — e qualquer
 * degradação REBAIXA. Um número que sobe rápido demais é um número banido em
 * duas semanas.
 */
export async function avancarAquecimento(agora = new Date()): Promise<number> {
  return paraCadaOrg(async (tx) => {
  const instancias = await tx.select().from(waInstances)
  let mexidas = 0

  for (const instancia of instancias) {
    const decisao = avaliarEscada(
      {
        warmupStage: instancia.warmupStage,
        warmupStartedAt: instancia.warmupStartedAt,
        failureRate24h: Number(instancia.failureRate24h),
      },
      agora,
    )

    if (decisao.acao === 'manter') continue

    const limites = limitesDoEstagio(decisao.estagio)
    await tx
      .update(waInstances)
      .set({
        warmupStage: decisao.estagio,
        /*
         * O relógio do estágio zera aqui.
         *
         * `DIAS_MINIMOS` é "dias NO estágio" — a própria mensagem de
         * `avaliarEscada` diz "faltam N dia(s) neste estágio". Como o cálculo
         * mede a partir de `warmupStartedAt` e ninguém o atualizava, a escada
         * subia contra o tempo TOTAL: promovia no dia 7 o que devia esperar o
         * dia 10, no dia 14 o que devia esperar o dia 24, e assim por diante.
         * Quase o dobro da velocidade — no subsistema cujo propósito é
         * justamente não acelerar.
         */
        warmupStartedAt: agora,
        ...limites,
        updatedAt: agora,
      })
      .where(eq(waInstances.id, instancia.id))

    // Sem telefone nem nome de contato no log (§14.1) — só o id da instância.
    log.info('estágio de aquecimento alterado', {
      instanceId: instancia.id,
      acao: decisao.acao,
      de: instancia.warmupStage,
      para: decisao.estagio,
      motivo: decisao.motivo,
    })
    mexidas += 1
  }

  return mexidas
  })
}

// ── Virada do dia ────────────────────────────────────────────────────────────

/**
 * Zera o contador diário de cada instância.
 *
 * Sem isto, `sentToday` cresceria para sempre e toda instância bateria o teto
 * no segundo dia — a operação inteira pararia em silêncio.
 */
export async function zerarContadoresDiarios(): Promise<number> {
  const zerados = await paraCadaOrg(async (tx) => {
    const linhas = await tx
      .update(waInstances)
      .set({ sentToday: 0, updatedAt: new Date() })
      .where(sql`${waInstances.sentToday} > 0`)
      .returning({ id: waInstances.id })

    return linhas.length
  })

  await registrarExecucao(TAREFAS.diaria, { zerados })
  return zerados
}

/**
 * Já virou o dia desde a última zeragem?
 *
 * Compara o DIA CIVIL no fuso de operação, não um intervalo de 24 horas. Com
 * intervalo, um tick que rodasse às 23h50 impediria a zeragem das 00h05 —
 * e o teto do dia seguinte começaria já consumido.
 */
export async function precisaZerar(agora = new Date()): Promise<boolean> {
  const ultima = await ultimaExecucao(TAREFAS.diaria)
  if (!ultima) return true
  return diaLocal(ultima) !== diaLocal(agora)
}

/** Passou uma hora desde a última manutenção? */
export async function precisaManutencao(agora = new Date()): Promise<boolean> {
  const ultima = await ultimaExecucao(TAREFAS.horaria)
  if (!ultima) return true
  return agora.getTime() - ultima.getTime() >= 60 * 60 * 1000
}
