import { randomBytes } from 'node:crypto'
import { falhaDeRede, lerJson, TIMEOUT_PADRAO_MS } from './types'

/**
 * Ciclo de vida das instâncias na Evolution API v2 (§7.3, §8.2).
 *
 * Separado de `whatsapp.ts` de propósito: aquele arquivo ENVIA mensagem e usa a
 * apikey da instância; este ADMINISTRA o servidor e usa a apikey GLOBAL, que é
 * uma credencial muito mais poderosa. Misturar os dois faria o caminho de envio
 * — o mais quente do sistema — carregar a chave que pode apagar instâncias.
 *
 * O contrato abaixo foi conferido no código-fonte da Evolution
 * (src/api/routes/instance.router.ts e instance.controller.ts), não na
 * documentação. A spec avisa que o formato mudou entre v1 e v2 e quebra em
 * silêncio; ler a fonte é o único jeito de ter certeza.
 *
 * ATENÇÃO À CHAVE GLOBAL: ela alcança TODAS as instâncias do servidor,
 * inclusive as de outro sistema que compartilhe a mesma Evolution. Este módulo
 * nunca lista nem toca no que não foi criado por aqui — a trava está em quem
 * chama (só age sobre instância que tem linha em `wa_instances`), e a função de
 * apagar exige confirmação explícita de que a instância é gerenciada.
 */

const PROVIDER = 'evolution'

export type ServidorEvolution = {
  /** Base, ex. https://evolution.seudominio.com.br */
  url: string
  /** A apikey GLOBAL (AUTHENTICATION_API_KEY do servidor). */
  apikeyGlobal: string
}

/**
 * Normaliza o endereço da Evolution para a RAIZ da API.
 *
 * O endereço que a pessoa tem à mão é o do Manager — é o que está na barra do
 * navegador quando ela olha as instâncias, e termina em `/manager`. Colado
 * assim, toda chamada virava `/manager/instance/create`, que devolve 404: o
 * canal ficava configurado, o QR não aparecia, e nada na tela dizia por quê.
 *
 * Tirar o sufixo aqui e não só na hora de salvar conserta também quem já
 * gravou o endereço errado, sem precisar que a pessoa descubra e reedite.
 *
 * `/manager` é o único caminho removido de propósito: é a única página que a
 * Evolution serve para gente ver. Qualquer outro sufixo pode ser um prefixo
 * legítimo de proxy reverso, e comer isso quebraria quem publica a Evolution
 * sob um caminho.
 */
export function normalizarUrlEvolution(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/manager$/i, '')
}

function base(url: string): string {
  return normalizarUrlEvolution(url)
}

export type FalhaAdmin = {
  ok: false
  codigo:
    | 'sem_credencial'
    | 'credencial_recusada'
    | 'nome_em_uso'
    | 'nao_encontrada'
    | 'servidor_indisponivel'
    | 'rede'
    | 'resposta_inesperada'
  mensagem: string
}

function classificar(status: number, corpo: unknown): FalhaAdmin {
  const mensagem = extrairMensagem(corpo) ?? `HTTP ${status}`
  const texto = mensagem.toLowerCase()

  if (status === 401 || status === 403) {
    return { ok: false, codigo: 'credencial_recusada', mensagem: 'A chave global foi recusada.' }
  }

  if (status === 403 || texto.includes('already in use') || texto.includes('already exists')) {
    return { ok: false, codigo: 'nome_em_uso', mensagem: 'Já existe uma instância com esse nome no servidor.' }
  }

  if (status === 404 || texto.includes('does not exist')) {
    return { ok: false, codigo: 'nao_encontrada', mensagem: 'Instância não encontrada no servidor.' }
  }

  if (status >= 500) {
    return { ok: false, codigo: 'servidor_indisponivel', mensagem }
  }

  return { ok: false, codigo: 'resposta_inesperada', mensagem }
}

function extrairMensagem(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const registro = corpo as Record<string, unknown>

  for (const chave of ['response', 'message', 'error', '_texto']) {
    const valor = registro[chave]
    if (typeof valor === 'string' && valor.trim() !== '') return valor
    if (Array.isArray(valor) && typeof valor[0] === 'string') return valor[0]
    if (typeof valor === 'object' && valor !== null) {
      const aninhado = extrairMensagem(valor)
      if (aninhado) return aninhado
    }
  }
  return null
}

async function chamar(
  servidor: ServidorEvolution,
  metodo: 'GET' | 'POST' | 'DELETE',
  caminho: string,
  corpo?: unknown,
): Promise<{ ok: true; dados: unknown } | FalhaAdmin> {
  if (!servidor.url || !servidor.apikeyGlobal) {
    return { ok: false, codigo: 'sem_credencial', mensagem: 'A Evolution não está configurada.' }
  }

  try {
    const resposta = await fetch(`${base(servidor.url)}${caminho}`, {
      method: metodo,
      headers: {
        apikey: servidor.apikeyGlobal,
        ...(corpo ? { 'content-type': 'application/json' } : {}),
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      // Criar instância sobe uma conexão do WhatsApp Web e demora mais que um
      // envio comum.
      signal: AbortSignal.timeout(TIMEOUT_PADRAO_MS * 2),
    })

    const dados = await lerJson(resposta)
    if (!resposta.ok) return classificar(resposta.status, dados)

    return { ok: true, dados }
  } catch (erro) {
    const falha = falhaDeRede(PROVIDER, erro)
    return {
      ok: false,
      codigo: falha.ok ? 'rede' : falha.codigo === 'provedor_indisponivel' ? 'servidor_indisponivel' : 'rede',
      mensagem: falha.ok ? 'falha de rede' : falha.mensagem,
    }
  }
}

// ── Nome e token ─────────────────────────────────────────────────────────────

/**
 * Nome da instância no servidor.
 *
 * Prefixo `mandafy-` para que quem abrir o Manager da Evolution reconheça de
 * imediato o que é nosso — importante quando o servidor é compartilhado com
 * outra operação. O sufixo aleatório evita colisão com um nome que já exista.
 */
export function nomeDeInstancia(apelido: string): string {
  const base = apelido
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)

  return `mandafy-${base || 'chip'}-${randomBytes(3).toString('hex')}`
}

/** Segredo na URL do webhook de retorno. A Evolution não assina o que envia. */
export function gerarTokenWebhook(): string {
  return randomBytes(24).toString('base64url')
}

/** Os eventos que nos interessam. A Evolution espera MAIÚSCULO com underscore. */
export const EVENTOS_EVOLUTION = [
  // Atualiza wa_instances.status e avisa a tela do QR que conectou.
  'CONNECTION_UPDATE',
  // Preenche delivered_at e read_at (§8.1).
  'MESSAGES_UPDATE',
  // Mensagem recebida: alimenta o CRM e detecta "SAIR" (§8.2, §14.1).
  'MESSAGES_UPSERT',
  // Confirma o provider_message_id do que saiu.
  'SEND_MESSAGE',
] as const

// ── Criar ────────────────────────────────────────────────────────────────────

export type InstanciaCriada = {
  instanceName: string
  /** A apikey DA INSTÂNCIA. Vem em `hash` na resposta da v2. */
  apikey: string
  status: string
}

/**
 * Cria a instância e já registra o webhook de retorno.
 *
 * O webhook vai junto na criação, e não numa chamada depois, porque entre as
 * duas existe uma janela em que o QR já apareceu e a conexão pode completar —
 * e o `CONNECTION_UPDATE` desse momento se perderia. A tela ficaria esperando
 * um evento que nunca chega.
 */
/**
 * Confere se o endereço e a chave falam com uma Evolution de verdade.
 *
 * Existe porque a alternativa é o pior modo de falha da tela: o canal aparece
 * configurado, o botão do QR não faz nada, e nenhuma mensagem explica se o
 * endereço está errado, se a chave foi recusada ou se o servidor está fora.
 * Os três se consertam em lugares diferentes.
 *
 * `/instance/fetchInstances` é a chamada mais barata que exige autenticação:
 * responde 401 com chave errada e 404 se o caminho não for a raiz da API —
 * que é exatamente o caso de quem colou o endereço do Manager.
 */
export async function verificarServidor(servidor: ServidorEvolution): Promise<
  { ok: true } | FalhaAdmin
> {
  const resultado = await chamar(servidor, 'GET', '/instance/fetchInstances')
  return resultado.ok ? { ok: true } : resultado
}

export async function criarInstancia(
  servidor: ServidorEvolution,
  opcoes: { instanceName: string; webhookUrl: string },
): Promise<{ ok: true; instancia: InstanciaCriada } | FalhaAdmin> {
  const resultado = await chamar(servidor, 'POST', '/instance/create', {
    instanceName: opcoes.instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
    webhook: {
      enabled: true,
      url: opcoes.webhookUrl,
      // Uma URL só para todos os eventos: `byEvents` criaria /connection-update,
      // /messages-update etc., e cada uma precisaria de rota própria.
      byEvents: false,
      base64: false,
      events: [...EVENTOS_EVOLUTION],
    },
  })

  if (!resultado.ok) return resultado

  const dados = resultado.dados as {
    instance?: { instanceName?: unknown; status?: unknown }
    hash?: unknown
  } | null

  // `hash` é a apikey da instância na v2. Sem ela não há como enviar mensagem
  // depois, então a ausência é falha, não detalhe.
  const apikey = typeof dados?.hash === 'string' ? dados.hash : null
  const instanceName =
    typeof dados?.instance?.instanceName === 'string'
      ? dados.instance.instanceName
      : opcoes.instanceName

  if (!apikey) {
    return {
      ok: false,
      codigo: 'resposta_inesperada',
      mensagem:
        'A Evolution criou a instância mas não devolveu a apikey dela. Confirme que a imagem é v2 (evoapicloud/evolution-api:v2.x.x).',
    }
  }

  return {
    ok: true,
    instancia: {
      instanceName,
      apikey,
      status: typeof dados?.instance?.status === 'string' ? dados.instance.status : 'connecting',
    },
  }
}

// ── QR code ──────────────────────────────────────────────────────────────────

export type Qr =
  | { estado: 'qr'; base64: string | null; code: string | null; pairingCode: string | null }
  | { estado: 'conectado' }
  | { estado: 'aguardando' }

/**
 * Pega o QR atual.
 *
 * A Evolution devolve o QR quando está esperando leitura, e o estado da conexão
 * quando já conectou — dois formatos diferentes na mesma rota. Distinguimos
 * pelo conteúdo, não pelo status HTTP.
 */
export async function obterQr(
  servidor: ServidorEvolution,
  instanceName: string,
): Promise<{ ok: true; qr: Qr } | FalhaAdmin> {
  const resultado = await chamar(
    servidor,
    'GET',
    `/instance/connect/${encodeURIComponent(instanceName)}`,
  )

  if (!resultado.ok) return resultado

  const dados = resultado.dados as {
    base64?: unknown
    code?: unknown
    pairingCode?: unknown
    instance?: { state?: unknown }
  } | null

  if (dados?.instance?.state === 'open') return { ok: true, qr: { estado: 'conectado' } }

  const base64 = typeof dados?.base64 === 'string' ? dados.base64 : null
  const code = typeof dados?.code === 'string' ? dados.code : null

  if (!base64 && !code) return { ok: true, qr: { estado: 'aguardando' } }

  return {
    ok: true,
    qr: {
      estado: 'qr',
      base64,
      code,
      pairingCode: typeof dados?.pairingCode === 'string' ? dados.pairingCode : null,
    },
  }
}

// ── Estado ───────────────────────────────────────────────────────────────────

/** `open` = conectado, `connecting` = lendo o QR, `close` = fora. */
export type EstadoConexao = 'open' | 'connecting' | 'close' | 'desconhecido'

export async function estadoDaConexao(
  servidor: ServidorEvolution,
  instanceName: string,
): Promise<{ ok: true; estado: EstadoConexao } | FalhaAdmin> {
  const resultado = await chamar(
    servidor,
    'GET',
    `/instance/connectionState/${encodeURIComponent(instanceName)}`,
  )

  if (!resultado.ok) return resultado

  const bruto = (resultado.dados as { instance?: { state?: unknown } } | null)?.instance?.state
  const estado: EstadoConexao =
    bruto === 'open' || bruto === 'connecting' || bruto === 'close' ? bruto : 'desconhecido'

  return { ok: true, estado }
}

/** Traduz o estado da Evolution para o nosso (§3.8). */
export function traduzirEstado(estado: EstadoConexao): 'conectado' | 'conectando' | 'desconectado' {
  if (estado === 'open') return 'conectado'
  if (estado === 'connecting') return 'conectando'
  return 'desconectado'
}

// ── Desconectar e apagar ─────────────────────────────────────────────────────

/** Desconecta o aparelho. A instância continua no servidor e pode reconectar. */
export async function desconectar(
  servidor: ServidorEvolution,
  instanceName: string,
): Promise<{ ok: true } | FalhaAdmin> {
  const resultado = await chamar(
    servidor,
    'DELETE',
    `/instance/logout/${encodeURIComponent(instanceName)}`,
  )

  // Já estava fora: o efeito desejado é o mesmo, não é erro para quem clicou.
  if (!resultado.ok && resultado.codigo === 'nao_encontrada') return { ok: true }
  return resultado.ok ? { ok: true } : resultado
}

/**
 * Apaga a instância do servidor.
 *
 * `gerenciada` é obrigatório e não tem valor padrão de propósito: apagar uma
 * instância que outro sistema criou derrubaria o WhatsApp dele. Quem chama
 * precisa afirmar que ela é nossa, e a afirmação vem da coluna `managed` — não
 * de um palpite sobre o nome.
 */
export async function apagarInstancia(
  servidor: ServidorEvolution,
  instanceName: string,
  gerenciada: boolean,
): Promise<{ ok: true } | FalhaAdmin> {
  if (!gerenciada) {
    return {
      ok: false,
      codigo: 'credencial_recusada',
      mensagem:
        'Esta instância não foi criada pelo Mandafy. Ela é removida só daqui; no servidor continua de pé.',
    }
  }

  const resultado = await chamar(
    servidor,
    'DELETE',
    `/instance/delete/${encodeURIComponent(instanceName)}`,
  )

  if (!resultado.ok && resultado.codigo === 'nao_encontrada') return { ok: true }
  return resultado.ok ? { ok: true } : resultado
}
