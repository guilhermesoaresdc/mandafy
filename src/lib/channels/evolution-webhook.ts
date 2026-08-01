/**
 * Leitura do que a Evolution manda de volta (§8.1, §8.2).
 *
 * Este arquivo é PURO: recebe o corpo do POST e devolve um retorno já
 * classificado. Nada de banco, nada de rede — é o que permite ter teste do
 * formato sem subir uma Evolution.
 *
 * O contrato veio do código-fonte dela, não da documentação:
 *   - `whatsapp.baileys.service.ts` monta cada payload
 *   - `utils/renderStatus.ts` traduz o ack numérico do Baileys para texto
 *   - `types/wa.types.ts` lista os eventos
 *
 * O envelope é sempre o mesmo:
 *   { event, instance, data, destination, date_time, sender, server_url, apikey }
 * com `event` em minúsculo e pontuado (`connection.update`), mesmo que a
 * inscrição use MAIÚSCULO com underscore (`CONNECTION_UPDATE`).
 *
 * NÃO autentique pelo campo `apikey` do corpo: quem controla o corpo controla
 * esse campo. A autenticação é o token na URL (ver drizzle/0016).
 */

/** Ack do Baileys já traduzido pela Evolution. A ordem é a da escada. */
export const ACKS = ['ERROR', 'PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED'] as const
export type Ack = (typeof ACKS)[number]

export type RetornoEvolution =
  /** A conexão do aparelho mudou de estado. */
  | {
      tipo: 'conexao'
      estado: 'conectado' | 'conectando' | 'desconectado'
      /** JID do número conectado, quando a Evolution informa. */
      telefone: string | null
    }
  /** Uma mensagem NOSSA mudou de estado no aparelho do destinatário. */
  | { tipo: 'status'; providerMessageId: string; ack: Ack }
  /** Uma mensagem chegou. Só as recebidas — as nossas voltam com fromMe. */
  | { tipo: 'recebida'; deJid: string; texto: string; nome: string | null }
  /** Confirmação do id de uma mensagem que acabou de sair. */
  | { tipo: 'saiu'; providerMessageId: string }
  /** Evento que não nos interessa. Responder 200 e seguir. */
  | { tipo: 'ignorado'; evento: string }

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null
}

/**
 * O corpo da mensagem, em qualquer das formas que o WhatsApp usa.
 *
 * A Evolution já normaliza `extendedTextMessage` em `conversation`, mas nem
 * sempre — depende do caminho que criou o objeto. Ler as duas custa nada, e
 * quem responde "SAIR" citando a mensagem anterior cai na segunda forma. Perder
 * esse caso significaria ignorar um pedido de descadastro (§14.1).
 */
export function extrairTexto(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>

  const direto = texto(m.conversation)
  if (direto) return direto

  const estendida = m.extendedTextMessage as { text?: unknown } | undefined
  const doEstendido = texto(estendida?.text)
  if (doEstendido) return doEstendido

  // Legenda de imagem ou vídeo: quem manda "SAIR" numa legenda pediu para sair.
  for (const chave of ['imageMessage', 'videoMessage', 'documentMessage']) {
    const media = m[chave] as { caption?: unknown } | undefined
    const legenda = texto(media?.caption)
    if (legenda) return legenda
  }

  // Resposta a botão ou lista.
  const botao = m.buttonsResponseMessage as { selectedDisplayText?: unknown } | undefined
  const doBotao = texto(botao?.selectedDisplayText)
  if (doBotao) return doBotao

  const lista = m.listResponseMessage as { title?: unknown } | undefined
  return texto(lista?.title)
}

/** `5511988887777@s.whatsapp.net` → `+5511988887777`. Grupo devolve null. */
export function telefoneDoJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null

  // Grupo (`@g.us`), status e broadcast não são pessoas — ignorar.
  if (!jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) return null

  const digitos = (jid.split('@')[0] ?? '').replace(/\D/g, '')
  return digitos.length >= 10 ? `+${digitos}` : null
}

export type EnvelopeEvolution = {
  evento: string
  instancia: string | null
  retorno: RetornoEvolution
}

export function lerRetorno(corpo: unknown): EnvelopeEvolution | null {
  if (typeof corpo !== 'object' || corpo === null) return null

  const envelope = corpo as { event?: unknown; instance?: unknown; data?: unknown }
  const evento = texto(envelope.event)
  if (!evento) return null

  // A inscrição usa CONNECTION_UPDATE, o envio usa connection.update. Aceitar
  // as duas grafias evita depender de qual lado da Evolution montou o payload.
  const normalizado = evento.toLowerCase().replace(/_/g, '.')
  const instancia = texto(envelope.instance)
  const dados = envelope.data

  return { evento: normalizado, instancia, retorno: classificar(normalizado, dados) }
}

function classificar(evento: string, dados: unknown): RetornoEvolution {
  if (typeof dados !== 'object' || dados === null) return { tipo: 'ignorado', evento }
  const d = dados as Record<string, unknown>

  if (evento === 'connection.update') {
    const bruto = texto(d.state)
    const estado =
      bruto === 'open' ? 'conectado' : bruto === 'connecting' ? 'conectando' : 'desconectado'

    return { tipo: 'conexao', estado, telefone: telefoneDoJid(d.wuid) }
  }

  if (evento === 'messages.update') {
    // `keyId` é o id que o WhatsApp deu à mensagem — o mesmo que guardamos em
    // provider_message_id quando ela saiu.
    const id = texto(d.keyId) ?? texto(d.messageId)
    const ack = texto(d.status)
    if (!id || !ack || !(ACKS as readonly string[]).includes(ack)) {
      return { tipo: 'ignorado', evento }
    }

    return { tipo: 'status', providerMessageId: id, ack: ack as Ack }
  }

  const chave = d.key as { id?: unknown; remoteJid?: unknown; fromMe?: unknown } | undefined

  if (evento === 'messages.upsert') {
    /*
     * `fromMe` distingue o que a pessoa escreveu do eco da nossa própria
     * mensagem. Sem essa checagem, um envio nosso contendo a palavra "cancelar"
     * descadastraria o contato — o sistema se auto-sabotando.
     */
    if (chave?.fromMe === true) return { tipo: 'ignorado', evento }

    const deJid = texto(chave?.remoteJid)
    const conteudo = extrairTexto(d.message)
    if (!deJid || !conteudo) return { tipo: 'ignorado', evento }

    return { tipo: 'recebida', deJid, texto: conteudo, nome: texto(d.pushName) }
  }

  if (evento === 'send.message') {
    const id = texto(chave?.id)
    return id ? { tipo: 'saiu', providerMessageId: id } : { tipo: 'ignorado', evento }
  }

  return { tipo: 'ignorado', evento }
}

/**
 * O ack vira qual status do nosso histórico (§8.1)?
 *
 * `null` quer dizer "não mexa": PENDING e SERVER_ACK são degraus anteriores ao
 * que já registramos como `sent`, e regredir o status apagaria informação.
 */
export function statusDoAck(ack: Ack): 'delivered' | 'read' | 'failed' | null {
  if (ack === 'DELIVERY_ACK') return 'delivered'
  if (ack === 'READ' || ack === 'PLAYED') return 'read'
  if (ack === 'ERROR') return 'failed'
  return null
}
