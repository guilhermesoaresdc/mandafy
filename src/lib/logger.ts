/**
 * Log estruturado em JSON.
 *
 * REGRA (§14.1): nenhum dado pessoal vai para o log da aplicação. Telefone,
 * e-mail, CPF e nome nunca entram aqui. Use identificadores — `contactId`,
 * `notificationId` — que são rastreáveis no banco por quem tem acesso, e
 * inúteis para quem só leu o stdout do container.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

/** Campos que jamais devem ser registrados. Se aparecerem, são redigidos. */
const CAMPOS_PROIBIDOS = new Set([
  'phone',
  'phoneE164',
  'phone_e164',
  'email',
  'cpf',
  'name',
  'nome',
  'telefone',
  'password',
  'senha',
  'passwordHash',
  'token',
  'apikey',
  'apiKey',
  'secret',
  'renderedBody',
  'rendered_body',
])

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = CAMPOS_PROIBIDOS.has(key) ? '[redigido]' : value
  }
  return out
}

function emit(level: Level, scope: string, message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...sanitize(fields),
  })

  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: Record<string, unknown>) =>
      process.env.NODE_ENV !== 'production' && emit('debug', scope, message, fields),
    info: (message: string, fields?: Record<string, unknown>) =>
      emit('info', scope, message, fields),
    warn: (message: string, fields?: Record<string, unknown>) =>
      emit('warn', scope, message, fields),
    error: (message: string, fields?: Record<string, unknown>) =>
      emit('error', scope, message, fields),
  }
}

export type Logger = ReturnType<typeof createLogger>
