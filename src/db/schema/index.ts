/**
 * Schema Drizzle do Mandafy.
 *
 * ATENÇÃO: este schema NÃO é a fonte da verdade das migrations. As migrations
 * são SQL escrito à mão em `drizzle/*.sql`, porque partições, políticas RLS,
 * citext e índices trigram não são expressáveis pelo gerador do drizzle-kit.
 * Este arquivo existe para tipar as queries e precisa espelhar aquele SQL
 * coluna a coluna. Ao alterar um, altere o outro.
 */

export * from './enums'
export * from './types'
export * from './organizations'
export * from './users'
export * from './sources'
export * from './contacts'
export * from './messages'
export * from './flows'
export * from './events'
export * from './notifications'
export * from './crm'
export * from './infra'
