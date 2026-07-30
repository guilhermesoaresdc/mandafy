/**
 * Teste de fumaça: sobe o app compilado e abre cada tela autenticada.
 *
 * Existe por causa de uma classe de erro que já apareceu duas vezes: uma página
 * passa no `tsc`, no `eslint` e no `next build`, e só quebra quando alguém
 * abre — o Postgres recusa a query, ou um componente estoura na renderização.
 * Nada além de exercitar a rota de verdade pega isso.
 *
 * Uso:
 *   npm run build && npm run fumaca
 *
 * Precisa de um Postgres local com as migrations e o seed aplicados. Sem ele,
 * o script avisa e sai sem falhar, para não quebrar CI de máquina limpa.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'

const BASE = 'http://127.0.0.1:3111'
const env = {
  ...process.env,
  PORT: '3111',
  NODE_ENV: 'production',
  APP_URL: BASE,
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? 'postgres://mandafy_app:mandafy_app@127.0.0.1:5432/mandafy',
  DATABASE_URL_ADMIN:
    process.env.TEST_DATABASE_URL_ADMIN ?? 'postgres://mandafy:mandafy@127.0.0.1:5432/mandafy',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  // Valores descartáveis: este processo não emite sessão real nem cifra nada.
  SESSION_SECRET: 'x'.repeat(64),
  ENCRYPTION_KEY: 'a'.repeat(64),
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A porta já está ocupada?
 *
 * Vale o cuidado: se um servidor de uma execução anterior tiver sobrado, ele
 * atenderia as requisições com um build ANTIGO — e o teste passaria ou falharia
 * sobre código que não é o atual. Já aconteceu, e custou caro para descobrir.
 */
function portaOcupada(porta) {
  return new Promise((resolve) => {
    const soquete = createConnection({ host: '127.0.0.1', port: porta })
    soquete.on('connect', () => { soquete.destroy(); resolve(true) })
    soquete.on('error', () => resolve(false))
    setTimeout(() => { soquete.destroy(); resolve(false) }, 1000)
  })
}

if (await portaOcupada(3111)) {
  console.log('A porta 3111 já está ocupada. Encerre o processo antes: pkill -f next-server')
  process.exit(1)
}

/*
 * `detached` cria um grupo de processos próprio. Sem isso, `server.kill()`
 * mataria só o `npx` e deixaria o `next start` filho no ar segurando a porta —
 * que é exatamente como uma execução passou a testar um build velho.
 */
const server = spawn('npx', ['next', 'start', '-p', '3111'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let saida = ''
server.stdout.on('data', (d) => { saida += d })
server.stderr.on('data', (d) => { saida += d })

function encerrarServidor() {
  try {
    // O sinal negativo alcança o grupo inteiro, não só o `npx`.
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    server.kill('SIGKILL')
  }
}

async function pronto() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/entrar`)
      if (r.status < 500) return true
    } catch {}
    await espera(500)
  }
  return false
}

let falhas = 0
function checar(rotulo, ok, detalhe = '') {
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${rotulo}${detalhe ? ` → ${detalhe}` : ''}`)
  if (!ok) falhas += 1
}

try {
  if (!await pronto()) { console.log('servidor não subiu\n', saida.slice(-3000)); process.exit(1) }

  /*
   * A sessão é criada direto no banco: o formulário de login é uma Server
   * Action, e forjar a chamada dela por HTTP exigiria o id interno da ação. O
   * que este teste quer provar é que as PÁGINAS renderizam com um usuário
   * autenticado — o caminho do login já tem teste próprio.
   */
  const postgres = (await import('postgres')).default
  const { createHash, randomBytes } = await import('node:crypto')
  const db = postgres(env.DATABASE_URL_ADMIN, { max: 1 })

  const token = randomBytes(32).toString('base64url')
  const [usuario] = await db`SELECT id, org_id FROM users WHERE role = 'admin' LIMIT 1`
  if (!usuario) {
    console.log('Sem administrador no banco local. Rode `npm run db:seed` antes.')
    await db.end({ timeout: 0 })
    process.exit(0)
  }
  await db`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (${createHash('sha256').update(token).digest('hex')}, ${usuario.id}, now() + interval '1 hour')`
  const cookie = `mandafy_session=${token}`

  const get = (p) => fetch(`${BASE}${p}`, { headers: { cookie }, redirect: 'manual' })

  for (const rota of ['/mensagens', '/fluxos', '/canais', '/historico', '/leads', '/pipeline', '/configuracoes/plataformas', '/painel']) {
    const r = await get(rota)
    const corpo = await r.text()
    const erro = corpo.includes('server-side exception') || corpo.includes('Application error')
    checar(`GET ${rota}`, r.status === 200 && !erro, `status ${r.status}${erro ? ' + exceção no HTML' : ''}`)
  }

  // O SSE do histórico: precisa abrir e mandar o primeiro evento.
  {
    const controle = new AbortController()
    const r = await fetch(`${BASE}/api/historico/stream`, {
      headers: { cookie },
      signal: controle.signal,
    })
    const tipo = r.headers.get('content-type') ?? ''
    let primeiro = ''
    if (r.body) {
      const leitor = r.body.getReader()
      const { value } = await leitor.read()
      primeiro = new TextDecoder().decode(value ?? new Uint8Array())
      void leitor.cancel()
    }
    controle.abort()
    checar('SSE /api/historico/stream', r.status === 200 && tipo.includes('text/event-stream') && primeiro.includes('pronto'), `status ${r.status}`)
  }

  // Exportação CSV dos leads.
  {
    const r = await get('/api/leads/csv')
    const corpo = await r.text()
    checar('CSV de leads', r.status === 200 && corpo.includes('lead,contato'), `status ${r.status}`)
  }

  // Exportação CSV do histórico.
  {
    const r = await get('/api/historico/csv')
    const corpo = await r.text()
    checar('CSV do histórico', r.status === 200 && corpo.includes('quando,canal,status'), `status ${r.status}`)
  }

  // Cria uma mensagem direto no banco e abre o editor.
  const [msg] = await db`
    INSERT INTO messages (org_id, key, name, body)
    VALUES (${usuario.org_id}, 'fumaca_teste', 'Fumaça', 'Oi {{nome|"amigo"}}, seu PIX de {{valor_cents|moeda}} 🎟️')
    RETURNING id`
  await db`INSERT INTO message_variants (message_id, channel) VALUES
    (${msg.id},'whatsapp'),(${msg.id},'telegram'),(${msg.id},'email'),(${msg.id},'sms')`

  try {
    const r = await get(`/mensagens/${msg.id}`)
    const corpo = await r.text()
    const erro = corpo.includes('server-side exception') || corpo.includes('Application error')
    checar(`GET /mensagens/{id}`, r.status === 200 && !erro, `status ${r.status}${erro ? ' + exceção no HTML' : ''}`)
    checar('editor renderiza o nome da mensagem', corpo.includes('Fumaça'))

    const lista = await (await get('/mensagens')).text()
    checar('lista mostra a mensagem criada', lista.includes('fumaca_teste'))

    // Um fluxo-modelo do seed, com a tela de detalhe.
    const [fluxo] = await db`SELECT id FROM flows WHERE org_id = ${usuario.org_id} LIMIT 1`
    if (fluxo) {
      const r = await get(`/fluxos/${fluxo.id}`)
      const corpo = await r.text()
      const erro = corpo.includes('server-side exception') || corpo.includes('Application error')
      checar('GET /fluxos/{id}', r.status === 200 && !erro, `status ${r.status}`)
    }
  } finally {
    await db`DELETE FROM messages WHERE id = ${msg.id}`
    await db`DELETE FROM sessions WHERE user_id = ${usuario.id}`
    await db.end({ timeout: 0 })
  }
} finally {
  encerrarServidor()
}

console.log(falhas === 0 ? '\nTudo passou.' : `\n${falhas} falha(s).`)
process.exit(falhas === 0 ? 0 : 1)
