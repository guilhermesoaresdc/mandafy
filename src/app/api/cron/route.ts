import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { serverEnv } from '@/env'
import { classifyDbError } from '@/lib/db-errors'
import { tickDeEnvio } from '@/lib/delivery/tick'
import { createLogger } from '@/lib/logger'
import {
  manutencaoHoraria,
  pegarTrava,
  precisaManutencao,
  precisaZerar,
  soltarTrava,
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

/*
 * A TRAVA VIVE EM `lib/manutencao`, e não mais aqui.
 *
 * Ela existe porque duas invocações sobrepostas — um cron atrasado somado ao
 * seguinte — fariam trabalho repetido e, pior, atropelariam o espaçamento entre
 * envios do mesmo chip: cada invocação respeita o próprio ritmo, mas duas em
 * paralelo dobram a cadência que §7.2 existe para segurar.
 *
 * Era um `pg_try_advisory_lock` daqui mesmo, e foi o que parou o sistema
 * inteiro: advisory lock é de SESSÃO, e atrás do pooler em modo transação quem
 * pega não é quem solta. `pegarTrava`/`soltarTrava` explicam o caso completo.
 */

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
type Autorizacao =
  | 'ok'
  | 'sem_segredo'
  | 'segredo_curto'
  /** Não veio cabeçalho `Authorization` nenhum. */
  | 'sem_cabecalho'
  /** Veio, mas não no formato `Bearer <segredo>`. */
  | 'formato_invalido'
  /** Bem formado, valor diferente. */
  | { tipo: 'nao_confere'; recebidos: number }

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

  /*
   * Os três motivos de recusa são separados porque cada um se conserta num
   * lugar diferente, e antes os três respondiam a mesma coisa.
   *
   * O caso comum na configuração de um agendador externo é o cabeçalho ir sem
   * o prefixo `Bearer ` — o campo do painel pede nome e valor separados, e é
   * natural colar só o segredo. Isso produzia exatamente a mesma resposta de
   * um segredo desatualizado, então quem estava com o formato errado ia
   * revirar as variáveis da Vercel, que estavam certas.
   */
  const header = request.headers.get('authorization')
  if (!header || header.trim() === '') return 'sem_cabecalho'

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const enviado = match?.[1]?.trim()
  if (!enviado) return 'formato_invalido'

  // Comparação de tempo constante: comparar com === vaza o tamanho do prefixo
  // correto pelo tempo de resposta, e o segredo é adivinhável byte a byte.
  const a = Buffer.from(enviado, 'utf8')
  const b = Buffer.from(segredo, 'utf8')
  const confere = a.length === b.length && timingSafeEqual(a, b)

  return confere ? 'ok' : { tipo: 'nao_confere', recebidos: enviado.length }
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

  if (motivo === 'sem_cabecalho') {
    return NextResponse.json(
      {
        ok: false,
        error: 'sem_credencial',
        hint:
          'A chamada chegou sem o cabeçalho Authorization. No agendador, adicione um ' +
          'cabeçalho com nome "Authorization" e valor "Bearer SEU_SEGREDO" — o nome e o ' +
          'valor vão em campos separados.',
      },
      { status: 401 },
    )
  }

  if (motivo === 'formato_invalido') {
    return NextResponse.json(
      {
        ok: false,
        error: 'formato_invalido',
        hint:
          'O cabeçalho Authorization veio, mas não no formato esperado. O valor precisa ser ' +
          'a palavra Bearer, um espaço, e então o segredo: "Bearer SEU_SEGREDO". Colar só o ' +
          'segredo, sem o prefixo, cai aqui.',
      },
      { status: 401 },
    )
  }

  /*
   * Informa o tamanho do que FOI ENVIADO, nunca o do segredo do servidor.
   * Quem chamou já sabe o que mandou, então isto não revela nada a quem sonda
   * — e resolve na hora os dois enganos mais comuns: o valor que veio cortado
   * ao colar, e o que veio com aspas ou "Bearer" duplicado grudado.
   */
  return NextResponse.json(
    {
      ok: false,
      error: 'nao_autorizado',
      recebidos: motivo.recebidos,
      hint:
        `O segredo chegou bem formado (${motivo.recebidos} caracteres) mas não confere com o ` +
        'CRON_SECRET deste ambiente. Se esse número não bate com o tamanho do seu segredo, ' +
        'ele foi cortado ou veio com algo grudado ao colar. Se bate, o valor da Vercel é ' +
        'outro — variável alterada lá só vale depois de publicar de novo.',
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
    /*
     * A CAUSA, não só a mensagem de fora.
     *
     * O Drizzle embrulha o erro do Postgres: `message` vira "Failed query: …
     * params: …" e o motivo verdadeiro — "permission denied for table x",
     * "relation does not exist" — fica em `cause`. Reportar só a mensagem
     * externa mostra a consulta que falhou e esconde POR QUE falhou, que é a
     * única parte acionável. Custou uma rodada inteira de diagnóstico.
     *
     * `classifyDbError` percorre a cadeia até a raiz e já remove credenciais.
     */
    const { hint, detail, code } = classifyDbError(erro)
    const mensagem = erro instanceof Error ? erro.message : String(erro)

    log.error('batimento estourou', { code, reason: (detail ?? mensagem).slice(0, 200) })

    return NextResponse.json(
      {
        ok: false,
        error: 'batimento_falhou',
        causa: detail ?? mensagem.slice(0, 300),
        consulta: mensagem.slice(0, 300),
        ...(code ? { code } : {}),
        hint,
      },
      { status: 500 },
    )
  }
}

async function baterMesmo(): Promise<NextResponse> {
  const inicio = Date.now()

  /*
   * Trava por LINHA, não `pg_try_advisory_lock`.
   *
   * O advisory lock é de sessão, e atrás do pooler em modo transação a sessão
   * que pega não é a mesma que solta — a trava ficava presa e todo batimento
   * seguinte respondia "ocupado" com 200. Ver `pegarTrava` em lib/manutencao.
   */
  const pego = await pegarTrava()

  if (!pego) {
    // 200, não 409: para o agendador isto não é erro, e responder erro faria
    // serviços como o QStash acumularem retentativas de algo que está certo.
    return NextResponse.json({ ok: true, ocupado: true })
  }

  try {
    const agora = new Date()

    /*
     * A manutenção vem antes do envio — é ela que cria a partição do dia e zera
     * o teto diário — mas NÃO pode impedi-lo.
     *
     * Antes ela rodava solta na mesma tentativa, e qualquer falha ali derrubava
     * a invocação inteira: nenhuma mensagem saía porque uma escrita de
     * contabilidade não deu certo. É a prioridade invertida — o propósito deste
     * endpoint é entregar mensagem; saber que horas a manutenção rodou é
     * secundário.
     *
     * A falha vai na resposta, para não sumir, e o envio segue.
     */
    const manutencao: Record<string, unknown> = {}

    /*
     * Cada tarefa numa tentativa PRÓPRIA, e a ordem importa mais do que parece.
     *
     * Com as duas no mesmo bloco, uma falha na zeragem pulava a manutenção
     * horária — e foi assim que o sistema ficou preso num laço circular: a
     * zeragem falhava por falta de permissão em `system_state`, e quem
     * reconcede permissão é `mandafy_maintain_partitions()`, que roda DENTRO da
     * manutenção horária. A rotina que consertava só rodava depois da que
     * quebrava, então nunca rodava.
     *
     * Separadas, a horária roda mesmo com a zeragem quebrada, reconcede, e o
     * batimento seguinte encontra tudo no lugar. O sistema se destrava sozinho.
     */
    const tarefas: [string, () => Promise<unknown>][] = [
      ['horaria', async () => ((await precisaManutencao(agora)) ? manutencaoHoraria() : undefined)],
      ['zerados', async () => ((await precisaZerar(agora)) ? zerarContadoresDiarios() : undefined)],
    ]

    for (const [nome, executar] of tarefas) {
      try {
        const resultado = await executar()
        if (resultado !== undefined) manutencao[nome] = resultado
      } catch (erro) {
        const { detail, code } = classifyDbError(erro)
        manutencao[`${nome}_falhou`] =
          detail ?? (erro instanceof Error ? erro.message.slice(0, 300) : 'erro')
        if (code) manutencao[`${nome}_code`] = code
        log.error('tarefa de manutenção falhou; o envio continua', { tarefa: nome, code })
      }
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
    await soltarTrava()
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
