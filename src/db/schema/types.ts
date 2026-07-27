import { customType } from 'drizzle-orm/pg-core'

/**
 * Tipos do Postgres que o drizzle-core não expõe nativamente.
 * Os nomes precisam bater exatamente com o SQL em drizzle/.
 */

/** Texto sem distinção de caixa. Usado em e-mail (§3.1, §3.3). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext'
  },
})

/**
 * Binário. Guarda credenciais cifradas com AES-256-GCM (§14.1) —
 * nunca texto, para que um dump não seja legível.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})
