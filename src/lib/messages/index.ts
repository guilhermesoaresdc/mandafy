/**
 * Uma fonte, quatro saídas (§6).
 *
 * Ponto de entrada único do subsistema de mensagens. Quem compõe (editor),
 * quem entrega (worker) e quem pré-visualiza usam as mesmas funções — é isso
 * que garante que a prévia mostre exatamente o que sai.
 */

export * from './ast'
export * from './parse'
export * from './variables'
export * from './spintax'
export * from './gsm'
export * from './render'
export * from './compile'
export * from './analise'
