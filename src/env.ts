import { z } from 'zod'

/**
 * Validação de ambiente do servidor.
 *
 * Regras:
 *  - Nunca importe este módulo de um Client Component. Ele contém segredos.
 *  - A validação é preguiçosa (`serverEnv()`), para que `next build` não quebre
 *    em ambiente de CI sem segredos configurados.
 */

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'formato esperado HH:MM')

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url(),

  // 32 bytes em hex — assina cookies de sessão.
  SESSION_SECRET: z.string().min(32),
  // 32 bytes em hex — AES-256-GCM das credenciais de provedor no banco (§14.1).
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY precisa ser 32 bytes em hex (64 caracteres)'),

  // Papel da aplicação (mandafy_app): RLS SEMPRE aplicado. É o que o app e o
  // worker usam.
  DATABASE_URL: z.string().min(1),
  // Papel dono das tabelas: ignora RLS. Usado só por db:migrate e db:seed.
  // Ausente = cai para DATABASE_URL (ambiente sem separação de papéis).
  DATABASE_URL_ADMIN: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1),

  /*
   * Segredo do disparador periódico (§7.1).
   *
   * Sem worker de pé, quem move a fila é uma requisição HTTP repetida — e ela
   * chega sem sessão. Ausente, a rota /api/cron recusa TODAS as chamadas: um
   * endpoint que envia mensagem e dispensa credencial é um endpoint que
   * qualquer um usa para queimar seus números.
   *
   * SEM `min()` AQUI, de propósito. O tamanho mínimo é exigido em
   * `CRON_SECRET_MINIMO`, no ponto de uso.
   *
   * O motivo é desproporção de dano: este esquema é tudo-ou-nada, e uma regra
   * violada aqui derruba o app INTEIRO com erro opaco. Quem digita um segredo
   * curto no painel da hospedagem — o erro mais natural do mundo — perderia o
   * site, e não apenas o disparo automático. Recusar a chamada do cron com uma
   * mensagem clara resolve o mesmo problema sem transformar uma configuração
   * fraca numa queda total.
   */
  CRON_SECRET: z.string().optional(),

  // Evolution API (WhatsApp) — §8.2
  EVOLUTION_URL: z.url().optional(),
  EVOLUTION_GLOBAL_APIKEY: z.string().optional(),

  // E-mail — §8.3
  EMAIL_PROVIDER: z.enum(['resend', 'ses', 'brevo']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // SMS — §8.4
  SMS_PROVIDER: z.enum(['smsdev', 'comtele', 'zenvia']).default('smsdev'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER: z.string().optional(),

  // Telegram — §8.5
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Operação — §16
  DEFAULT_TIMEZONE: z.string().default('America/Sao_Paulo'),
  QUIET_HOURS_START: timeSchema.default('21:00'),
  QUIET_HOURS_END: timeSchema.default('08:00'),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(3),
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Encurtador de links de SMS (§6.4). Sem isso, links vão inteiros.
  SHORTLINK_DOMAIN: z.string().optional(),
})

export type ServerEnv = z.infer<typeof serverSchema>

/**
 * Ambiente incompleto. Tipada para que a interface consiga distinguir
 * "faltou configurar" de "deu erro de verdade" e mostrar a mensagem certa —
 * um 500 cru manda o operador procurar bug onde só falta variável.
 */
export class ConfigError extends Error {
  readonly missing: string[]

  constructor(message: string, missing: string[]) {
    super(message)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError
}

let cached: ServerEnv | null = null

/** Lê e valida o ambiente uma única vez. Lança com mensagem legível se faltar algo. */
export function serverEnv(): ServerEnv {
  if (cached) return cached

  const parsed = serverSchema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.'))
    const detalhes = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new ConfigError(
      `Variáveis de ambiente inválidas ou ausentes:\n${detalhes}\n\n` +
        'Copie .env.example para .env e preencha. Veja a seção 16 da especificação.',
      missing,
    )
  }

  cached = parsed.data
  return cached
}

/** Só o que é seguro expor ao cliente. */
export const publicEnv = {
  appName: 'Mandafy',
} as const
