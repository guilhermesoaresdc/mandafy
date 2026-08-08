/**
 * `npm run celular` — mede as telas num aparelho de verdade.
 *
 * POR QUE MEDIR, E NÃO CONFERIR AS CLASSES
 *
 * A barra lateral era `w-[200px] shrink-0` sem nenhum breakpoint, e nenhuma
 * suíte acusou: `tsc`, `eslint`, `next build` e o teste de fumaça leem o HTML,
 * não a largura dele. Num aparelho de 375px sobravam pouco mais de 140 pixels
 * para a tabela de leads, e a única forma de descobrir isso era abrir no
 * telefone — que é justamente de onde este app é usado.
 *
 * O QUE ELE COBRA
 *
 * 1. Nenhuma tela rola de lado. Rolagem horizontal no celular esconde metade
 *    da interface atrás de um gesto que ninguém faz.
 * 2. O conteúdo ocupa a tela toda. Este é o cheque que pega o defeito de
 *    verdade — ver o comentário em `LARGURA ÚTIL` mais abaixo.
 * 3. A gaveta abre, navega e fecha. Sem ela não há navegação abaixo de `md`.
 *
 * SEM DEPENDÊNCIA NOVA
 *
 * O CLAUDE.md fixa a stack, então este arquivo não importa Playwright: fala
 * direto o protocolo do DevTools com o Chromium que já existe na máquina, por
 * WebSocket — que o Node 22 traz de fábrica. São ~60 linhas de encanamento em
 * troca de zero pacote a mais.
 *
 * Roda contra o app compilado, como `npm run fumaca` — o desenvolvimento tem
 * outra árvore de CSS e mediria outra coisa.
 *
 * Uso:
 *   npm run build && npm run celular
 */
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const PORTA = 3121
const BASE = `http://127.0.0.1:${PORTA}`

/** iPhone SE / 13 mini: o menor aparelho que ainda aparece nos acessos. */
const APARELHO = { largura: 375, altura: 812 }

/** 90%: sobra folga para uma borda ou um respiro, e não para uma coluna. */
const FRACAO_MINIMA_DA_TELA = 0.9

const ROTAS = [
  '/painel',
  '/mensagens',
  '/fluxos',
  '/historico',
  '/leads',
  '/pipeline',
  '/canais',
  '/configuracoes/plataformas',
  '/configuracoes/sistema',
]

const env = {
  ...process.env,
  PORT: String(PORTA),
  NODE_ENV: 'production',
  APP_URL: BASE,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://mandafy_app:mandafy_app@127.0.0.1:5432/mandafy',
  DATABASE_URL_ADMIN:
    process.env.TEST_DATABASE_URL_ADMIN ?? 'postgres://mandafy:mandafy@127.0.0.1:5432/mandafy',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  SESSION_SECRET: 'x'.repeat(64),
  ENCRYPTION_KEY: 'a'.repeat(64),
  CRON_SECRET: 'c'.repeat(32),
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

let falhas = 0
function checar(rotulo, ok, detalhe = '') {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${rotulo}${detalhe ? ` → ${detalhe}` : ''}`)
  if (!ok) falhas += 1
}

/**
 * A porta já está ocupada?
 *
 * Mesmo cuidado do `fumaca.mjs`, e pela mesma razão: um servidor sobrando de
 * uma execução anterior atenderia com um build ANTIGO. Aqui custou uma sessão
 * inteira travada esperando saída que nunca vinha.
 */
function portaOcupada(porta) {
  return new Promise((resolve) => {
    const soquete = createConnection({ host: '127.0.0.1', port: porta })
    soquete.on('connect', () => {
      soquete.destroy()
      resolve(true)
    })
    soquete.on('error', () => resolve(false))
    setTimeout(() => {
      soquete.destroy()
      resolve(false)
    }, 1000)
  })
}

if (await portaOcupada(PORTA)) {
  console.log(`A porta ${PORTA} já está ocupada. Encerre o processo antes: fuser -k ${PORTA}/tcp`)
  process.exit(1)
}

/** Onde o Chromium mora nesta máquina. */
function acharChromium() {
  const candidatos = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH && `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium`,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean)

  for (const caminho of candidatos) {
    // `--version` é o único jeito honesto de dizer "isto existe E roda": o
    // caminho pode ser um link simbólico quebrado, e `existsSync` mentiria.
    const { status } = spawnSync(caminho, ['--version'], { timeout: 10_000 })
    if (status === 0) return caminho
  }
  return null
}

// ─── encanamento do DevTools ────────────────────────────────────────────────

/**
 * Um cliente CDP mínimo: manda comando, espera resposta, ouve evento.
 * O protocolo é um JSON-RPC sobre WebSocket — nada além disso é necessário
 * para navegar e medir.
 */
function conectar(endereco) {
  const soquete = new WebSocket(endereco)
  const pendentes = new Map()
  const ouvintes = new Set()
  let proximoId = 0

  soquete.addEventListener('message', (evento) => {
    const msg = JSON.parse(evento.data)
    if (msg.id != null && pendentes.has(msg.id)) {
      const { resolver, rejeitar } = pendentes.get(msg.id)
      pendentes.delete(msg.id)
      if (msg.error) rejeitar(new Error(`${msg.error.message} (${msg.error.code})`))
      else resolver(msg.result)
      return
    }
    for (const ouvinte of ouvintes) ouvinte(msg)
  })

  const aberto = new Promise((resolver, rejeitar) => {
    soquete.addEventListener('open', resolver, { once: true })
    soquete.addEventListener('error', () => rejeitar(new Error('WebSocket recusou')), { once: true })
  })

  return {
    aberto,
    enviar(metodo, params = {}, sessionId) {
      const id = (proximoId += 1)
      return new Promise((resolver, rejeitar) => {
        pendentes.set(id, { resolver, rejeitar })
        soquete.send(JSON.stringify({ id, method: metodo, params, sessionId }))
      })
    },
    aoEvento(ouvinte) {
      ouvintes.add(ouvinte)
      return () => ouvintes.delete(ouvinte)
    },
    fechar() {
      soquete.close()
    },
  }
}

// ─── sobe o servidor ────────────────────────────────────────────────────────

const servidor = spawn('npx', ['next', 'start', '-p', String(PORTA)], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  // Grupo próprio: sem isso, matar o `npx` deixa o `next start` filho segurando
  // a porta — que é como a execução anterior travou.
  detached: true,
})
let saida = ''
servidor.stdout.on('data', (d) => (saida += d))
servidor.stderr.on('data', (d) => (saida += d))

function encerrarServidor() {
  try {
    process.kill(-servidor.pid, 'SIGTERM')
  } catch {
    servidor.kill('SIGKILL')
  }
}

async function servidorPronto() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/entrar`)
      if (r.status < 500) return true
    } catch {
      /* ainda subindo */
    }
    await espera(500)
  }
  return false
}

let navegador
let perfil
let cdp
let db

try {
  if (!(await servidorPronto())) {
    console.log('servidor não subiu\n', saida.slice(-3000))
    encerrarServidor()
    process.exit(1)
  }

  const binario = acharChromium()
  if (!binario) {
    console.log('Sem Chromium nesta máquina. Aponte CHROMIUM_PATH para o executável.')
    encerrarServidor()
    process.exit(0)
  }

  /*
   * A sessão nasce no banco, como no `fumaca.mjs`: o login é uma Server Action
   * e forjar a chamada dela exigiria o id interno da ação. O que se mede aqui
   * são as telas de DENTRO.
   */
  const postgres = (await import('postgres')).default
  db = postgres(env.DATABASE_URL_ADMIN, { max: 1 })

  const [usuario] = await db`SELECT id FROM users WHERE role = 'admin' LIMIT 1`
  if (!usuario) {
    console.log('Sem administrador no banco local. Rode `npm run db:seed` antes.')
    await db.end({ timeout: 0 })
    encerrarServidor()
    process.exit(0)
  }

  const token = randomBytes(32).toString('base64url')
  await db`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${createHash('sha256').update(token).digest('hex')}, ${usuario.id}, now() + interval '1 hour')`

  perfil = mkdtempSync(join(tmpdir(), 'mandafy-celular-'))
  navegador = spawn(
    binario,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Sem isto o Chromium reserva ~15px para a barra de rolagem e a conta de
      // "cabe na tela" sai errada por uma margem que o celular não tem.
      '--hide-scrollbars',
      `--user-data-dir=${perfil}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const endereco = await new Promise((resolver, rejeitar) => {
    let buffer = ''
    const prazo = setTimeout(() => rejeitar(new Error(`Chromium não abriu:\n${buffer}`)), 30_000)
    navegador.stderr.on('data', (d) => {
      buffer += d
      const achado = buffer.match(/ws:\/\/\S+/)
      if (achado) {
        clearTimeout(prazo)
        resolver(achado[0])
      }
    })
  })

  cdp = conectar(endereco)
  await cdp.aberto

  const { targetId } = await cdp.enviar('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.enviar('Target.attachToTarget', { targetId, flatten: true })

  const cmd = (metodo, params) => cdp.enviar(metodo, params, sessionId)

  await cmd('Page.enable')
  await cmd('Runtime.enable')
  await cmd('Network.enable')

  await cmd('Emulation.setDeviceMetricsOverride', {
    width: APARELHO.largura,
    height: APARELHO.altura,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await cmd('Emulation.setTouchEmulationEnabled', { enabled: true })
  await cmd('Network.setCookie', {
    name: 'mandafy_session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
  })

  async function avaliar(expressao) {
    const r = await cmd('Runtime.evaluate', {
      expression: expressao,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'exceção')
    return r.result.value
  }

  async function ir(rota) {
    const carregou = new Promise((resolver) => {
      const parar = cdp.aoEvento((msg) => {
        if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) {
          parar()
          resolver()
        }
      })
      setTimeout(() => {
        parar()
        resolver()
      }, 15_000)
    })
    await cmd('Page.navigate', { url: `${BASE}${rota}` })
    await carregou
    /*
     * Meio segundo depois do `load`: o layout já está resolvido quando o CSS
     * aplicou, mas as ilhas com `use client` (o kanban, os filtros) montam
     * logo em seguida e podem empurrar a largura.
     */
    await espera(600)
  }

  // ─── as telas ─────────────────────────────────────────────────────────────

  for (const rota of ROTAS) {
    await ir(rota)

    const medida = await avaliar(`(() => {
      const doc = document.documentElement
      const main = document.querySelector('main')
      const nome = (el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]

      const passandoDaTela = [...document.querySelectorAll('body *')].filter(
        (el) => el.getBoundingClientRect().right > doc.clientWidth + 1,
      )

      const vazando = passandoDaTela
        .slice(0, 3)
        .map((el) => nome(el) + ' (' + Math.round(el.getBoundingClientRect().right) + 'px)')

      /*
       * ESCONDIDO SEM AVISO.
       *
       * Passar da borda direita não é, sozinho, defeito. Há três desfechos
       * possíveis, e só um deles é problema:
       *
       *  1. Um ancestral ROLA de lado (\`overflow-x\` auto/scroll com conteúdo
       *     maior que a caixa). É o kanban: uma faixa de colunas que se arrasta
       *     com o dedo. Legítimo.
       *  2. Um ancestral CORTA COM RETICÊNCIAS (\`text-overflow: ellipsis\`). É o
       *     \`truncate\` do nome do lead: o "…" avisa que tem mais, e o resto
       *     aparece ao abrir a ficha. Legítimo.
       *  3. Um ancestral CORTA CALADO (\`overflow: hidden\` sem reticências). Aí o
       *     conteúdo ocupa layout, não aparece, e nada na tela indica que ele
       *     existe. É este que se quer pegar.
       *
       * Decide o PRIMEIRO ancestral que rola ou corta — o de dentro para fora,
       * porque é ele quem determina o destino do elemento.
       */
      const inalcancavel = passandoDaTela
        .filter((el) => {
          for (let pai = el.parentElement; pai; pai = pai.parentElement) {
            const estilo = getComputedStyle(pai)
            const overflow = estilo.overflowX

            if ((overflow === 'auto' || overflow === 'scroll') && pai.scrollWidth > pai.clientWidth + 1) {
              return false // caso 1
            }
            if (overflow === 'hidden' || overflow === 'clip') {
              return estilo.textOverflow !== 'ellipsis' // caso 2 ou 3
            }
          }
          return true
        })
        // Só o elemento mais externo de cada ramo interessa: listar os 40 filhos
        // de uma tabela cortada é ruído em cima do mesmo defeito.
        .filter((el, _, todos) => !todos.some((outro) => outro !== el && outro.contains(el)))
        .slice(0, 3)
        .map((el) => nome(el) + ' (até ' + Math.round(el.getBoundingClientRect().right) + 'px)')

      /*
       * A PÁGINA ANDA PARA O LADO? — perguntando, não deduzindo.
       *
       * O primeiro rascunho comparava \`documentElement.scrollWidth\` com
       * \`clientWidth\`, e o \`/pipeline\` acusou 1106px numa tela de 375. Era
       * mentira: o \`body\` media 375, a casca corta com \`overflow-hidden\`, e o
       * kanban rolava dentro do próprio trilho como deve. O \`scrollWidth\` da
       * raiz somava conteúdo de rolador aninhado que ninguém consegue alcançar
       * pela página.
       *
       * Mandar rolar e ver se andou não depende de qual métrica o Chromium
       * decide propagar — é o mesmo que o dedo faria.
       */
      const antes = window.scrollX
      window.scrollTo(9999, window.scrollY)
      const andou = Math.round(Math.abs(window.scrollX - antes))
      window.scrollTo(antes, window.scrollY)

      return {
        caminho: location.pathname,
        andou,
        scroll: doc.scrollWidth,
        tela: doc.clientWidth,
        principal: main ? Math.round(main.getBoundingClientRect().width) : 0,
        vazando,
        inalcancavel,
      }
    })()`)

    // Sem sessão válida tudo redireciona para /entrar — e a tela de login
    // caberia numa tela pequena sem provar nada sobre as telas de dentro.
    if (medida.caminho !== rota) {
      checar(`${rota} abre`, false, `caiu em ${medida.caminho}`)
      continue
    }

    // Rolagem horizontal no celular esconde metade da interface atrás de um
    // gesto que ninguém faz.
    checar(
      `${rota} não rola de lado`,
      medida.andou === 0,
      medida.andou > 0
        ? `andou ${medida.andou}px · ${medida.vazando.join(' · ') || 'sem culpado óbvio'}`
        : '',
    )

    /*
     * A LARGURA ÚTIL, e este é o cheque que pega o defeito de verdade.
     *
     * "Não rola de lado" não bastava — e descobri isso reintroduzindo o bug de
     * propósito: com a barra lateral de 200px de volta, as telas CONTINUARAM
     * passando. O flex ENCOLHE o `<main>` em vez de estourar o documento, então
     * nada transborda e nada acusa; o conteúdo simplesmente se espreme em 175
     * pixels, que é o sintoma que fez o operador dizer "bem ruim de mexer".
     *
     * Um medidor que não pega o defeito que motivou sua criação é pior que
     * nenhum: ele passa verde e dá a impressão de cobertura.
     */
    checar(
      `${rota} usa a tela toda`,
      medida.principal >= medida.tela * FRACAO_MINIMA_DA_TELA,
      medida.principal < medida.tela * FRACAO_MINIMA_DA_TELA
        ? `o conteúdo tem ${medida.principal}px numa tela de ${medida.tela}px`
        : '',
    )

    /*
     * E o terceiro, que os dois primeiros deixavam passar: o `/historico`
     * cabia na tela, ocupava a tela toda, e mesmo assim escondia as colunas
     * "Situação" e "Tempo / motivo" atrás da borda direita — as duas únicas que
     * respondem a pergunta que leva alguém àquela tela.
     */
    checar(
      `${rota} não esconde nada fora da tela`,
      medida.inalcancavel.length === 0,
      medida.inalcancavel.join(' · '),
    )
  }

  // ─── a gaveta ─────────────────────────────────────────────────────────────

  await ir('/painel')

  checar(
    'a barra lateral não ocupa espaço no celular',
    await avaliar(`(() => {
      const aside = document.querySelector('aside')
      return !aside || aside.getBoundingClientRect().width === 0
    })()`),
  )

  const temBotao = await avaliar(`(() => {
    const b = document.querySelector('[aria-label="Abrir menu"]')
    return !!b && b.getBoundingClientRect().width > 0
  })()`)
  checar('o botão de menu existe', temBotao)

  if (temBotao) {
    // Espera até a hidratação atender o clique: um `click()` antes disso não
    // chega em ouvinte nenhum, e o teste falharia por pressa e não por defeito.
    let abriu = false
    for (let i = 0; i < 20 && !abriu; i += 1) {
      await avaliar(`document.querySelector('[aria-label="Abrir menu"]').click()`)
      await espera(250)
      abriu = await avaliar(`!!document.querySelector('[role="dialog"]')`)
    }
    checar('a gaveta abre com os itens', abriu)

    if (abriu) {
      const temLeads = await avaliar(`(() => {
        const dialogo = document.querySelector('[role="dialog"]')
        return [...dialogo.querySelectorAll('a')].some((a) => a.textContent.trim() === 'Leads')
      })()`)
      checar('a gaveta lista as sessões', temLeads)

      await avaliar(`(() => {
        const dialogo = document.querySelector('[role="dialog"]')
        const link = [...dialogo.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Leads')
        link.click()
      })()`)

      // Navegação do Next é do lado do cliente: não há `load` para esperar.
      let navegou = false
      for (let i = 0; i < 40 && !navegou; i += 1) {
        await espera(250)
        navegou = (await avaliar(`location.pathname`)) === '/leads'
      }
      checar('a gaveta navega', navegou)

      /*
       * E FECHA. Sem isto, a tela nova abre atrás de uma gaveta que continua
       * cobrindo tudo, e o gesto seguinte de quem está em pé no balcão é
       * tocar de novo — no lugar errado.
       */
      let fechou = false
      for (let i = 0; i < 20 && !fechou; i += 1) {
        await espera(250)
        fechou = !(await avaliar(`!!document.querySelector('[role="dialog"]')`))
      }
      checar('a gaveta fecha ao navegar', fechou, fechou ? '' : 'continuou aberta')
    }
  }

  console.log(falhas === 0 ? '\nTudo coube.' : `\n${falhas} problema(s) no celular.`)
} finally {
  cdp?.fechar()
  navegador?.kill('SIGKILL')
  if (perfil) rmSync(perfil, { recursive: true, force: true })
  await db?.end({ timeout: 0 })
  encerrarServidor()
}

process.exit(falhas === 0 ? 0 : 1)
