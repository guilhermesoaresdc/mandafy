/**
 * Escopos e eventos, sem nada de servidor.
 *
 * Módulo separado de propósito: `keys.ts` e `webhooks.ts` falam com o banco, e
 * um componente de cliente que importasse os rótulos de lá arrastaria o driver
 * do Postgres para dentro do navegador. O build falha com
 * `Can't resolve 'fs'` — e essa mensagem não conta o que realmente aconteceu.
 *
 * Aqui só existem constantes. Servidor e cliente importam daqui.
 */

export const ESCOPOS = [
  'events:write',
  'messages:send',
  'messages:read',
  'contacts:read',
  'contacts:write',
  'leads:read',
  'leads:write',
  'flows:write',
  'channels:write',
] as const

export type Escopo = (typeof ESCOPOS)[number]

export const ESCOPO_LABELS: Record<Escopo, string> = {
  'events:write': 'Enviar eventos',
  'messages:send': 'Disparar mensagens',
  'messages:read': 'Ler o histórico de envios',
  'contacts:read': 'Ler contatos',
  'contacts:write': 'Criar e alterar contatos',
  'leads:read': 'Ler leads',
  'leads:write': 'Criar e alterar leads',
  'flows:write': 'Pausar e retomar fluxos',
  'channels:write': 'Pausar canais',
}

export const EVENTOS_SAIDA = [
  'message.sent',
  'message.delivered',
  'message.failed',
  'message.read',
  'contact.opted_out',
  'lead.created',
  'lead.stage_changed',
  'instance.disconnected',
] as const

export type EventoSaida = (typeof EVENTOS_SAIDA)[number]

export const EVENTO_LABELS: Record<EventoSaida, string> = {
  'message.sent': 'Mensagem saiu',
  'message.delivered': 'Mensagem entregue',
  'message.failed': 'Mensagem falhou',
  'message.read': 'Mensagem lida',
  'contact.opted_out': 'Contato pediu para sair',
  'lead.created': 'Lead criado',
  'lead.stage_changed': 'Lead mudou de etapa',
  'instance.disconnected': 'Número desconectou',
}

export const PREFIXO_LIVE = 'mandafy_live_'
export const PREFIXO_TEST = 'mandafy_test_'
