import { timingSafeEqual } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db'
import { serverEnv } from '@/env'
import { tickDeEnvio } from '@/lib/delivery/tick'
import { createLogger } from '@/lib/logger'
import {
  manutencaoHoraria,
  precisaManutencao,
  precisaZerar,
  zerarContadoresDiarios,
} from '@/lib/manutencao'

/**
 * O batimento do sistema quando não há worker (§7.1).
 *
 * Uma requisição periódica a esta rota faz o que o processo long-running fazia:
 * envia o que venceu, devolve à fila o que falhou e roda a manutenção. Serve
 * para Vercel Cron, GitHub Actions, QStash ou qualquer coisa que saiba chamar
 * uma URL de tempos em tempos.
 *
 * O worker continua existindo e continua sendo melhor: ele reage no instante e
 * não tem teto de duração. Esta rota é o caminho para quem publica só na
 * Vercel, onde não há onde um processo fique de pé. Os dois podem conviver —
 * a transição para `sending` é comparação-e-troca, então quem chegar segundo
 * não encontra a linha e desiste.
 *
 * AUTENTICAÇÃO
 *
 * `CRON_SECRET` em `Authorization: Bearer`. Sem a variável configurada, a rota
 * recusa TUDO — inclusive a si mesma. É deliberado: um endpoint que dispara
 * mensagem e dispensa credencial é um endpoint que qualquer um usa para queimar
 * os números do dono, e "esqueci de configurar" não pode ser o caminho aberto.
 * É o mesmo motivo do Vercel Cron mandar esse header por conta própria quando
 * a variável existe.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Teto de duração da invocação.
 *
 * 60s é o limite do plano Hobby da Vercel; o tick usa isso como orçamento e
 * para antes de estourar, deixando o resto para a próxima chamada.
 */
export const maxDuration = 60

const log = createLogger('cron')

/** Reserva para a resposta sair antes de a plataforma cortar a invocação. */
const RESERVA_MS = 5_000

/**
 * Trava do batimento.
 *
 * Duas invocações sobrepostas — um cron atrasado somado ao seguinte — fariam
 * trabalho repetido e, pior, atropelariam o espaçamento entre envios do mesmo
 * chip: cada invocação respeita o próprio ritmo, mas duas em paralelo dobram a
 * cadência que o §7.2 existe para segurar.
 *
 * `try` e não `lock`: quem não pega desiste na hora em vez de esperar e
 * executar o dobro do trabalho depois.
 */
const TRAVA = 8_270_120

function autorizado(request: NextRequest): boolean {
  const segredo = serverEnv().CRON_SECRET
  if (!segredo) return false

  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const enviado = match?.[1]?.trim()
  if (!enviado) return false

  // Comparação de tempo constante: comparar com === vaza o tamanho do prefixo
  // correto pelo tempo de resposta, e o segredo é adivinhável byte a byte.
  const a = Buffer.from(enviado, 'utf8')
  const b = Buffer.from(segredo, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

async function bater(): Promise<NextResponse> {
  const inicio = Date.now()

  const [trava] = await db.execute<{ pego: boolean }>(
    sql`SELECT pg_try_advisory_lock(${TRAVA}) AS pego`,
  )

  if (!trava?.pego) {
    // 200, não 409: para o agendador isto não é erro, e responder erro faria
    // serviços como o QStash acumularem retentativas de algo que está certo.
    return NextResponse.json({ ok: true, ocupado: true })
  }

  try {
    const agora = new Date()

    // A manutenção vem antes do envio: é ela que cria a partição do dia e zera
    // o teto diário. Enviar antes disso gastaria o teto de ontem.
    const manutencao: Record<string, unknown> = {}

    if (await precisaZerar(agora)) {
      manutencao.zerados = await zerarContadoresDiarios()
    }

    if (await precisaManutencao(agora)) {
      manutencao.horaria = await manutencaoHoraria()
    }

    const orcamento = maxDuration * 1000 - (Date.now() - inicio) - RESERVA_MS
    const envio = orcamento > 0 ? await tickDeEnvio(orcamento, 200, agora) : null

    const resposta = { ok: true, ms: Date.now() - inicio, envio, manutencao }

    // Sem nenhum dado pessoal (§14.1): só contagens.
    if (envio && (envio.enviados > 0 || envio.falhas > 0)) {
      log.info('batimento', { ...envio, ms: resposta.ms })
    }

    return NextResponse.json(resposta)
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${TRAVA})`)
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false, error: 'nao_autorizado' }, { status: 401 })
  }
  return bater()
}

/** POST para quem agenda por webhook (QStash e afins mandam POST). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!autorizado(request)) {
    return NextResponse.json({ ok: false, error: 'nao_autorizado' }, { status: 401 })
  }
  return bater()
}
