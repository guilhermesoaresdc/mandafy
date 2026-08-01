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
  CRON_SECRET: 'c'.repeat(32),
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

  for (const rota of ['/mensagens', '/fluxos', '/canais', '/historico', '/leads', '/pipeline', '/configuracoes/plataformas', '/configuracoes/api', '/configuracoes/privacidade', '/painel']) {
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

  /*
   * A API pública de ponta a ponta: cria uma chave, autentica com ela e confere
   * que a rota responde. É o único jeito de pegar o RLS bloqueando a busca da
   * chave — que foi exatamente o bug encontrado nesta fase.
   */
  {
    const { createHash, randomBytes } = await import('node:crypto')
    const chaveApi = `mandafy_live_${randomBytes(24).toString('base64url')}`
    const hash = createHash('sha256').update(chaveApi).digest('hex')

    await db`INSERT INTO api_keys (org_id, name, key_hash, key_prefix, scopes)
      VALUES (${usuario.org_id}, 'Fumaça', ${hash}, 'mandafy_live_fuma…',
              ARRAY['messages:read','contacts:read'])`

    try {
      const r = await fetch(`${BASE}/api/v1/health`, {
        headers: { authorization: `Bearer ${chaveApi}` },
        redirect: 'manual',
      })
      const corpo = await r.text()
      checar('API v1 autentica com a chave', r.status === 200 && corpo.includes('queue'), `status ${r.status}`)

      const semChave = await fetch(`${BASE}/api/v1/health`, { redirect: 'manual' })
      checar('API v1 recusa sem chave', semChave.status === 401, `status ${semChave.status}`)

      const semEscopo = await fetch(`${BASE}/api/v1/leads`, {
        headers: { authorization: `Bearer ${chaveApi}` },
        redirect: 'manual',
      })

      /*
       * O link de descadastro precisa funcionar SEM login — é o do rodapé de
       * todo e-mail, aberto do celular de quem nunca entrou no painel.
       *
       * O contato é criado aqui, não procurado: uma verificação que se pula
       * sozinha quando o banco está vazio é uma verificação que não existe.
       */
      const [alguem] = await db`
        INSERT INTO contacts (org_id, name, external_id)
        VALUES (${usuario.org_id}, 'Fumaça', 'fumaca-descadastro')
        ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL
        DO UPDATE SET opted_out_at = NULL
        RETURNING id`

      try {
        const sair = await fetch(`${BASE}/sair/${alguem.id}`, { redirect: 'manual' })
        checar('descadastro em um clique, sem sessão', sair.status === 200, `status ${sair.status}`)

        const [depois] = await db`SELECT opted_out_at FROM contacts WHERE id = ${alguem.id}`
        checar('e o descadastro é gravado na hora', depois.opted_out_at !== null)
      } finally {
        await db`DELETE FROM contacts WHERE id = ${alguem.id}`
      }
      checar('API v1 recusa escopo que a chave não tem', semEscopo.status === 403, `status ${semEscopo.status}`)
    } finally {
      await db`DELETE FROM api_keys WHERE key_hash = ${hash}`
    }
  }

  /*
   * Ingestão das plataformas, de ponta a ponta.
   *
   * Existe por um bug que passou por tudo: a busca do token roda SEM contexto
   * de tenant (a plataforma que chama não tem sessão), e com RLS ligado o
   * SELECT devolvia zero linhas. A rota respondia 401 para toda integração
   * legítima, e o painel continuava mostrando o conector como configurado.
   * Nenhum teste unitário pega isso — só bater na rota com o banco de verdade.
   */
  {
    const tokenIngestao = randomBytes(24).toString('base64url')
    const [fonte] = await db`
      INSERT INTO sources (org_id, name, ingest_token)
      VALUES (${usuario.org_id}, 'Fumaça', ${tokenIngestao})
      RETURNING id`

    try {
      const r = await fetch(`${BASE}/in/${tokenIngestao}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ evento: 'fumaca', pedido: randomBytes(8).toString('hex') }),
      })
      const corpo = await r.text()
      checar('ingestão aceita o token da plataforma', r.status === 200, `status ${r.status} ${corpo.slice(0, 120)}`)

      const [gravado] = await db`
        SELECT count(*)::int AS n FROM events_raw WHERE source_id = ${fonte.id}`
      checar('e o payload cru foi gravado', gravado.n === 1, `${gravado.n} linha(s)`)

      const recusado = await fetch(`${BASE}/in/tokeninexistente1234567`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      checar('ingestão recusa token desconhecido', recusado.status === 401, `status ${recusado.status}`)
    } finally {
      await db`DELETE FROM events_raw WHERE source_id = ${fonte.id}`
      await db`DELETE FROM sources WHERE id = ${fonte.id}`
    }
  }

  /*
   * Retorno da Evolution: é o que tira o histórico de "enviado" e leva a
   * "entregue" e "lido". Mesma armadilha de RLS da ingestão, e o mesmo jeito
   * de pegar — POST na rota com o banco de verdade e conferir a linha depois.
   */
  {
    const tokenWebhook = randomBytes(24).toString('base64url')
    const idProvedor = `FUMACA${randomBytes(6).toString('hex').toUpperCase()}`

    const [instancia] = await db`
      INSERT INTO wa_instances (org_id, name, evolution_url, instance_name, managed, webhook_token)
      VALUES (${usuario.org_id}, 'Fumaça', 'http://127.0.0.1:1', ${'fumaca-' + randomBytes(3).toString('hex')}, true, ${tokenWebhook})
      RETURNING id`

    const [envio] = await db`
      INSERT INTO notifications (org_id, channel, status, provider, provider_message_id, sent_at)
      VALUES (${usuario.org_id}, 'whatsapp', 'sent', 'evolution', ${idProvedor}, now())
      RETURNING id, created_at`

    const mandar = (event, data) =>
      fetch(`${BASE}/api/evolution/${tokenWebhook}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event, instance: 'fumaca', data }),
      })

    try {
      const entrega = await mandar('messages.update', {
        keyId: idProvedor,
        remoteJid: '5511988887777@s.whatsapp.net',
        fromMe: true,
        status: 'DELIVERY_ACK',
      })
      checar('webhook da Evolution aceita o token', entrega.status === 200, `status ${entrega.status}`)

      const [entregue] = await db`
        SELECT status, delivered_at FROM notifications WHERE id = ${envio.id} AND created_at = ${envio.created_at}`
      checar(
        'e a mensagem vira "entregue" no histórico',
        entregue?.status === 'delivered' && entregue.delivered_at !== null,
        `status ${entregue?.status}`,
      )

      await mandar('messages.update', { keyId: idProvedor, status: 'READ' })
      const [lida] = await db`
        SELECT status, read_at FROM notifications WHERE id = ${envio.id} AND created_at = ${envio.created_at}`
      checar('e depois "lido"', lida?.status === 'read' && lida.read_at !== null, `status ${lida?.status}`)

      // Não pode regredir: o WhatsApp não garante a ordem de chegada dos acks.
      await mandar('messages.update', { keyId: idProvedor, status: 'DELIVERY_ACK' })
      const [aindaLida] = await db`
        SELECT status FROM notifications WHERE id = ${envio.id} AND created_at = ${envio.created_at}`
      checar('ack atrasado não rebaixa "lido" para "entregue"', aindaLida?.status === 'read', `status ${aindaLida?.status}`)

      // Conexão: a tela do QR e o painel de saúde dependem disto.
      await mandar('connection.update', { state: 'open', wuid: '5511988887777@s.whatsapp.net' })
      const [conectada] = await db`SELECT status, phone_e164 FROM wa_instances WHERE id = ${instancia.id}`
      checar(
        'connection.update marca a instância como conectada',
        conectada?.status === 'conectado' && conectada.phone_e164 === '+5511988887777',
        `status ${conectada?.status}`,
      )

      /*
       * "SAIR" no WhatsApp precisa descadastrar de verdade. Este é o caminho
       * de maior risco do sistema inteiro: falhar aqui significa continuar
       * mandando mensagem para quem pediu para parar (§14.1).
       */
      const telefone = `+5511${String(Math.floor(Math.random() * 900000000) + 100000000)}`
      const [quemPediu] = await db`
        INSERT INTO contacts (org_id, name, phone_e164, optin_whatsapp)
        VALUES (${usuario.org_id}, 'Fumaça', ${telefone}, true)
        RETURNING id`

      try {
        await mandar('messages.upsert', {
          key: { id: 'IN1', remoteJid: `${telefone.replace('+', '')}@s.whatsapp.net`, fromMe: false },
          pushName: 'Fumaça',
          message: { conversation: 'SAIR' },
          messageType: 'conversation',
        })

        const [saiu] = await db`
          SELECT optin_whatsapp FROM contacts WHERE id = ${quemPediu.id}`
        checar('"SAIR" no WhatsApp descadastra na hora', saiu?.optin_whatsapp === false)

        const [supressao] = await db`
          SELECT count(*)::int AS n FROM suppressions
          WHERE contact_id = ${quemPediu.id} AND channel = 'whatsapp'`
        checar('e entra na lista de supressão', supressao.n === 1, `${supressao.n} linha(s)`)

        // Eco da NOSSA mensagem não pode descadastrar ninguém.
        const [outro] = await db`
          INSERT INTO contacts (org_id, name, phone_e164, optin_whatsapp)
          VALUES (${usuario.org_id}, 'Fumaça eco', ${telefone.replace(/\d$/, '0')}, true)
          RETURNING id`
        try {
          await mandar('messages.upsert', {
            key: {
              id: 'OUT1',
              remoteJid: `${telefone.replace('+', '').replace(/\d$/, '0')}@s.whatsapp.net`,
              fromMe: true,
            },
            message: { conversation: 'Para cancelar, responda SAIR.' },
          })
          const [intacto] = await db`SELECT optin_whatsapp FROM contacts WHERE id = ${outro.id}`
          checar('o eco da nossa mensagem NÃO descadastra', intacto?.optin_whatsapp === true)
        } finally {
          await db`DELETE FROM suppressions WHERE contact_id = ${outro.id}`
          await db`DELETE FROM contacts WHERE id = ${outro.id}`
        }
      } finally {
        await db`DELETE FROM suppressions WHERE contact_id = ${quemPediu.id}`
        await db`DELETE FROM audit_log WHERE entity_id = ${quemPediu.id}`
        await db`DELETE FROM contacts WHERE id = ${quemPediu.id}`
      }

      const semToken = await fetch(`${BASE}/api/evolution/tokeninexistente1234567`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'connection.update', data: { state: 'open' } }),
      })
      checar('webhook recusa token desconhecido', semToken.status === 401, `status ${semToken.status}`)
    } finally {
      await db`DELETE FROM notifications WHERE id = ${envio.id} AND created_at = ${envio.created_at}`
      await db`DELETE FROM wa_instances WHERE id = ${instancia.id}`
    }
  }

  /*
   * O batimento (§7.1).
   *
   * É o que substitui o worker para quem publica só na Vercel. Se ele recusar
   * a credencial certa, ou aceitar a errada, o sistema ou não envia nada ou
   * envia para quem pedir — os dois desfechos silenciosos.
   */
  {
    const bater = (cabecalhos = {}) =>
      fetch(`${BASE}/api/cron`, { headers: cabecalhos, redirect: 'manual' })

    const semNada = await bater()
    checar('batimento recusa sem credencial', semNada.status === 401, `status ${semNada.status}`)

    const errada = await bater({ authorization: 'Bearer errado-mas-do-mesmo-tamanho--' })
    checar('batimento recusa credencial errada', errada.status === 401, `status ${errada.status}`)

    const certa = await bater({ authorization: `Bearer ${env.CRON_SECRET}` })
    const corpo = await certa.text()
    checar(
      'batimento roda com a credencial certa',
      certa.status === 200 && corpo.includes('"ok":true'),
      `status ${certa.status} ${corpo.slice(0, 160)}`,
    )

    // Duas chamadas seguidas não podem quebrar: a segunda encontra a trava ou
    // simplesmente não acha trabalho.
    const denovo = await bater({ authorization: `Bearer ${env.CRON_SECRET}` })
    checar('batimento é seguro de repetir', denovo.status === 200, `status ${denovo.status}`)
  }

  /*
   * Retorno de e-mail, SMS e Telegram (§8.3, §8.4, §8.5).
   *
   * A mesma armadilha de RLS da ingestão e da Evolution: a busca do canal roda
   * sem contexto de tenant, porque o provedor chama de fora. Se a função de
   * drizzle/0017 falhar, as três rotas respondem 401 para toda chamada
   * legítima — e o modo de falha é silencioso, porque nada no painel muda.
   *
   * O que se confere aqui é o efeito no banco, não o formato do payload: esse
   * já está coberto sem banco em src/lib/channels/retorno.test.ts.
   */
  {
    const tokenEmail = randomBytes(24).toString('base64url')
    const tokenSms = randomBytes(24).toString('base64url')
    const tokenTelegram = randomBytes(24).toString('base64url')

    const [cfgEmail] = await db`
      INSERT INTO channel_configs (org_id, channel, provider, webhook_token)
      VALUES (${usuario.org_id}, 'email', 'resend', ${tokenEmail})
      RETURNING id`
    const [cfgSms] = await db`
      INSERT INTO channel_configs (org_id, channel, provider, webhook_token)
      VALUES (${usuario.org_id}, 'sms', 'smsdev', ${tokenSms})
      RETURNING id`
    const [cfgTelegram] = await db`
      INSERT INTO channel_configs (org_id, channel, provider, webhook_token)
      VALUES (${usuario.org_id}, 'telegram', 'telegram', ${tokenTelegram})
      RETURNING id`

    const endereco = `fumaca-${randomBytes(5).toString('hex')}@exemplo.com`
    const telefoneSms = `+5511${String(Math.floor(Math.random() * 900000000) + 100000000)}`
    const externo = `fumaca_${randomBytes(5).toString('hex')}`
    const chatId = Math.floor(Math.random() * 1000000) + 1

    const [pessoa] = await db`
      INSERT INTO contacts (org_id, name, email, phone_e164, external_id)
      VALUES (${usuario.org_id}, 'Fumaça Retorno', ${endereco}, ${telefoneSms}, ${externo})
      RETURNING id`

    const idEmail = `re_${randomBytes(8).toString('hex')}`
    const idSms = String(Math.floor(Math.random() * 1000000))

    const [envioEmail] = await db`
      INSERT INTO notifications (org_id, contact_id, channel, status, provider, provider_message_id, sent_at)
      VALUES (${usuario.org_id}, ${pessoa.id}, 'email', 'sent', 'resend', ${idEmail}, now())
      RETURNING id, created_at`
    const [envioSms] = await db`
      INSERT INTO notifications (org_id, contact_id, channel, status, provider, provider_message_id, sent_at)
      VALUES (${usuario.org_id}, ${pessoa.id}, 'sms', 'sent', 'smsdev', ${idSms}, now())
      RETURNING id, created_at`

    const postar = (url, corpo) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      })

    try {
      // ── E-mail: entrega ──
      const entregue = await postar(`${BASE}/api/retorno/email/${tokenEmail}`, {
        type: 'email.delivered',
        data: { email_id: idEmail, to: [endereco] },
      })
      checar('retorno de e-mail aceita o token', entregue.status === 200, `status ${entregue.status}`)

      const [linhaEmail] = await db`
        SELECT status FROM notifications WHERE id = ${envioEmail.id} AND created_at = ${envioEmail.created_at}`
      checar('e o e-mail vira "entregue"', linhaEmail?.status === 'delivered', `status ${linhaEmail?.status}`)

      /*
       * O caso que justifica a rota inteira: hard bounce tem de virar supressão
       * na hora. Sem isso o endereço morto fica na fila e queima o domínio.
       */
      await postar(`${BASE}/api/retorno/email/${tokenEmail}`, {
        type: 'email.bounced',
        data: { email_id: idEmail, to: [endereco], bounce: { type: 'Permanent' } },
      })

      const [bloqueio] = await db`
        SELECT reason FROM suppressions WHERE contact_id = ${pessoa.id} AND channel = 'email'`
      checar('hard bounce vira supressão na hora', bloqueio?.reason === 'hard_bounce', `motivo ${bloqueio?.reason}`)

      // E não pode virar opt-out: ninguém pediu para sair (§14.1).
      const [aposBounce] = await db`SELECT opted_out_at FROM contacts WHERE id = ${pessoa.id}`
      checar('e NÃO marca a pessoa como descadastrada', aposBounce?.opted_out_at === null)

      // Soft bounce não bloqueia: caixa cheia esvazia amanhã.
      const outroEndereco = `fumaca-soft-${randomBytes(4).toString('hex')}@exemplo.com`
      const [softPessoa] = await db`
        INSERT INTO contacts (org_id, name, email) VALUES (${usuario.org_id}, 'Fumaça soft', ${outroEndereco})
        RETURNING id`
      try {
        await postar(`${BASE}/api/retorno/email/${tokenEmail}`, {
          type: 'email.bounced',
          data: { to: [outroEndereco], bounce: { type: 'Transient', subType: 'MailboxFull' } },
        })
        const [semBloqueio] = await db`
          SELECT count(*)::int AS n FROM suppressions WHERE contact_id = ${softPessoa.id}`
        checar('soft bounce NÃO bloqueia o endereço', semBloqueio.n === 0, `${semBloqueio.n} linha(s)`)
      } finally {
        await db`DELETE FROM suppressions WHERE contact_id = ${softPessoa.id}`
        await db`DELETE FROM contacts WHERE id = ${softPessoa.id}`
      }

      // ── SMS: a DLR chega por GET ──
      const dlr = await fetch(`${BASE}/api/retorno/sms/${tokenSms}?id=${idSms}&situacao=DELIVERED`)
      checar('DLR do SMS aceita o token por GET', dlr.status === 200, `status ${dlr.status}`)

      const [linhaSms] = await db`
        SELECT status FROM notifications WHERE id = ${envioSms.id} AND created_at = ${envioSms.created_at}`
      checar('e o SMS vira "entregue"', linhaSms?.status === 'delivered', `status ${linhaSms?.status}`)

      // ── Telegram: a captura do chat, que é a razão da rota existir ──
      const start = await postar(`${BASE}/api/retorno/telegram/${tokenTelegram}`, {
        update_id: 1,
        message: { message_id: 1, chat: { id: chatId }, from: { first_name: 'Fumaça' }, text: `/start ${externo}` },
      })
      checar('retorno do Telegram aceita o token', start.status === 200, `status ${start.status}`)

      const [vinculado] = await db`SELECT telegram_chat_id FROM contacts WHERE id = ${pessoa.id}`
      checar(
        'e o /start vincula o chat ao contato',
        Number(vinculado?.telegram_chat_id) === chatId,
        `chat ${vinculado?.telegram_chat_id}`,
      )

      await postar(`${BASE}/api/retorno/telegram/${tokenTelegram}`, {
        update_id: 2,
        message: { message_id: 2, chat: { id: chatId }, text: '/parar' },
      })
      const [saiuTelegram] = await db`SELECT optin_telegram FROM contacts WHERE id = ${pessoa.id}`
      checar('/parar descadastra do Telegram', saiuTelegram?.optin_telegram === false)

      /*
       * Voltar atrás precisa funcionar: religar o opt-in sem limpar a supressão
       * deixaria o /start sendo um botão que não faz nada (§5.3, guarda 2).
       */
      await postar(`${BASE}/api/retorno/telegram/${tokenTelegram}`, {
        update_id: 3,
        message: { message_id: 3, chat: { id: chatId }, text: `/start ${externo}` },
      })
      const [voltou] = await db`
        SELECT count(*)::int AS n FROM suppressions WHERE contact_id = ${pessoa.id} AND channel = 'telegram'`
      checar('e um /start novo remove a supressão', voltou.n === 0, `${voltou.n} linha(s)`)

      // ── Cada token só serve ao seu canal ──
      const trocado = await postar(`${BASE}/api/retorno/email/${tokenSms}`, {
        type: 'email.delivered',
        data: { email_id: idEmail },
      })
      checar('token de um canal não serve para outro', trocado.status === 401, `status ${trocado.status}`)

      const desconhecido = await postar(`${BASE}/api/retorno/email/tokeninexistente1234567`, {
        type: 'email.delivered',
        data: { email_id: idEmail },
      })
      checar('retorno recusa token desconhecido', desconhecido.status === 401, `status ${desconhecido.status}`)
    } finally {
      await db`DELETE FROM notifications WHERE contact_id = ${pessoa.id}`
      await db`DELETE FROM suppressions WHERE contact_id = ${pessoa.id}`
      await db`DELETE FROM audit_log WHERE entity_id = ${pessoa.id}`
      await db`DELETE FROM contacts WHERE id = ${pessoa.id}`
      await db`DELETE FROM channel_configs WHERE id IN (${cfgEmail.id}, ${cfgSms.id}, ${cfgTelegram.id})`
    }
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
