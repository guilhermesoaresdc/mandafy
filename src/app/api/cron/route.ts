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

/**
 * Três desfechos, não dois.
 *
 * Responder 401 tanto para "o servidor não tem segredo configurado" quanto
 * para "o segredo enviado não bate" custa horas de diagnóstico: quem opera não
 * tem como saber de qual lado mexer, e os dois lados ficam parecendo errados
 * ao mesmo tempo. São problemas diferentes, com correções em painéis
 * diferentes, e a resposta precisa dizer qual é.
 *
 * `sem_segredo` não vaza nada de útil para quem sonda: revela que o endpoint
 * está desconfigurado, o que já é visível pelo fato de ele recusar tudo.
 */
type Autorizacao = 'ok' | 'sem_segredo' | 'segredo_curto' | 'nao_confere'

/**
 * Tamanho mínimo do segredo.
 *
 * Exigido aqui e não no esquema do ambiente: lá, uma regra violada derruba o
 * app inteiro com erro opaco, e um segredo curto digitado no painel da
 * hospedagem viraria queda total do site em vez de disparo automático parado.
 * Aqui ele recusa só a chamada, e diz o porquê.
 */
const CRON_SECRET_MINIMO = 16

function autorizar(request: NextRequest): Autorizacao {
  /*
   * `trim` no segredo do ambiente: colar um valor num painel web arrasta
   * espaço ou quebra de linha com frequência, e o resultado seria um 401
   * eterno com os dois valores parecendo idênticos na tela. Um segredo não
   * muda de significado por causa de espaço nas pontas.
   */
  const segredo = serverEnv().CRON_SECRET?.trim()
  if (!segredo) return 'sem_segredo'
  if (segredo.length < CRON_SECRET_MINIMO) return 'segredo_curto'

  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const enviado = match?.[1]?.trim()
  if (!enviado) return 'nao_confere'

  // Comparação de tempo constante: comparar com === vaza o tamanho do prefixo
  // correto pelo tempo de resposta, e o segredo é adivinhável byte a byte.
  const a = Buffer.from(enviado, 'utf8')
  const b = Buffer.from(segredo, 'utf8')
  const confere = a.length === b.length && timingSafeEqual(a, b)

  return confere ? 'ok' : 'nao_confere'
}

function recusa(motivo: Exclude<Autorizacao, 'ok'>): NextResponse {
  if (motivo === 'sem_segredo') {
    // 503 e não 401: o problema é do servidor, não de quem chamou. Um
    // agendador que recebe 401 conclui que a própria credencial está errada e
    // manda o operador procurar no lugar errado.
    return NextResponse.json(
      {
        ok: false,
        error: 'cron_secret_ausente',
        hint:
          'A variável CRON_SECRET não existe neste ambiente. Defina-a nas variáveis do ' +
          'projeto e publique de novo — na Vercel, variável nova só vale a partir do ' +
          'próximo deploy.',
      },
      { status: 503 },
    )
  }

  if (motivo === 'segredo_curto') {
    return NextResponse.json(
      {
        ok: false,
        error: 'cron_secret_curto',
        hint: `O CRON_SECRET deste ambiente tem menos de ${CRON_SECRET_MINIMO} caracteres. Um segredo curto se descobre por tentativa, e quem o descobrir dispara seus envios. Troque por um valor longo nos dois lados e publique de novo.`,
      },
      { status: 503 },
    )
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'nao_autorizado',
      hint:
        'O segredo enviado não confere com o CRON_SECRET deste ambiente. Confira se o valor ' +
        'no agendador é idêntico ao da Vercel, e se a Vercel foi publicada depois de ele mudar.',
    },
    { status: 401 },
  )
}

/**
 * Executa o batimento e NUNCA deixa uma exceção escapar crua.
 *
 * Sem isto o Next responde 500 com corpo vazio, e quem opera fica com um
 * número. Aconteceu: o batimento passou a autenticar e começou a estourar por
 * outro motivo, e o log do agendador dizia apenas "respondeu 500" — nenhuma
 * pista de onde olhar, num ambiente cujo log de servidor quem opera não abre.
 *
 * A mensagem do Postgres vai no corpo porque é ela que diz o que fazer, e erro
 * de esquema ou de permissão não carrega dado pessoal (§14.1). A rota já exige
 * o segredo do cron para chegar até aqui, então não é informação pública.
 */
async function bater(): Promise<NextResponse> {
  try {
    return await baterMesmo()
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro)
    log.error('batimento estourou', { reason: mensagem.slice(0, 200) })

    return NextResponse.json(
      {
        ok: false,
        error: 'batimento_falhou',
        detail: mensagem.slice(0, 500),
        hint:
          'Se a mensagem citar uma tabela ou coluna que não existe, falta aplicar as ' +
          'alterações do banco: abra /api/health e veja o campo "estrutura", ou ' +
          'Configurações → Sistema.',
      },
      { status: 500 },
    )
  }
}

async function baterMesmo(): Promise<NextResponse> {
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
  const autorizacao = autorizar(request)
  if (autorizacao !== 'ok') return recusa(autorizacao)
  return bater()
}

/** POST para quem agenda por webhook (QStash e afins mandam POST). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const autorizacao = autorizar(request)
  if (autorizacao !== 'ok') return recusa(autorizacao)
  return bater()
}
