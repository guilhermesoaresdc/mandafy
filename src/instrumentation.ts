/**
 * Ponto de entrada da subida do app (Next.js `register`).
 *
 * Fino de propósito: o Next compila este arquivo para OS DOIS runtimes, Node e
 * Edge, e o Edge não tem `net` nem `tls`. Importar o driver de Postgres aqui —
 * mesmo atrás de um `if` — faz o empacotador seguir o import e quebrar o build
 * inteiro com "Can't resolve 'net'".
 *
 * O `if (NEXT_RUNTIME === 'nodejs')` na forma positiva é o que o Next reconhece
 * para deixar o bloco fora do bundle do Edge. Uma saída antecipada
 * (`if (… !== 'nodejs') return`) NÃO serve: o import continua alcançável para a
 * análise estática. Já quebrou assim.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node')
  }
}
