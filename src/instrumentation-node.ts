/**
 * Migrar sozinho na subida do app — a parte que só existe no runtime Node.
 *
 * POR QUE
 *
 * A operação deste sistema não tem terminal: quem opera publica pelo GitHub e
 * olha o resultado no navegador. Uma migration que só roda com `npm run
 * db:migrate` numa máquina com acesso ao banco é, na prática, uma migration que
 * não roda — e o sintoma é a tela quebrada em produção, com a correção
 * inalcançável.
 *
 * Então o app aplica as pendentes ao subir. É seguro porque cada migration é
 * atômica, registrada em `_migrations` por checksum, e o conjunto todo roda sob
 * `pg_advisory_lock` — várias instâncias subindo ao mesmo tempo depois de um
 * deploy serializam em vez de brigar (ver src/db/migrate.ts).
 *
 * O QUE ISTO NÃO FAZ
 *
 * Não semeia. Criar organização e usuário administrador é decisão de operação,
 * não consequência de um deploy, e roda pela tela de sistema.
 *
 * Não derruba o app quando falha. Um banco fora do ar não pode transformar
 * "algumas telas quebradas" em "site inteiro fora" — o estado aparece em
 * /configuracoes/sistema, e as telas que não dependem da migration nova
 * continuam servindo.
 */

// O efeito deste módulo é a própria importação. O `export` existe só para que
// o TypeScript o trate como módulo, e não como script global.
export {}

// Durante `next build` não existe banco de produção para migrar — e a Vercel
// constrói num ambiente sem as variáveis de execução.
const construindo = process.env.NEXT_PHASE === 'phase-production-build'

// Sem endereço de banco não há o que fazer, e reclamar aqui só polui o log de
// quem monta a imagem antes de configurar.
const temBanco = Boolean(process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL)

/*
 * Sem `await` no topo do módulo: o empacotador do Next recusa top-level await
 * aqui ("Top-level-await is only supported in EcmaScript Modules"). A promessa
 * fica solta de propósito — migrar não deve segurar a primeira requisição, e o
 * `catch` garante que nada escape.
 */
async function migrarNaSubida(): Promise<void> {
  const { runMigrations } = await import('./db/migrate')

  const resultado = await runMigrations((nome) => {
    console.log(`[mandafy] aplicando migration ${nome}`)
  })

  if (resultado.aplicadas.length > 0) {
    console.log(
      `[mandafy] ${resultado.aplicadas.length} migration(s) aplicada(s): ${resultado.aplicadas.join(', ')}`,
    )
  }
}

if (!construindo && temBanco && process.env.AUTO_MIGRATE !== 'false') {
  void migrarNaSubida().catch((erro: unknown) => {
    /*
     * A mensagem do Postgres entra no log porque é ela que diz o que fazer, e
     * ela não carrega dado pessoal (§14.1) — é erro de esquema. A URL do banco,
     * que carregaria a senha, nunca é registrada.
     */
    console.error(
      '[mandafy] falha ao migrar na subida:',
      erro instanceof Error ? erro.message : String(erro),
    )
  })
}
