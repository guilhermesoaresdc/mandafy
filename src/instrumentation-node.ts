/**
 * Migrar na subida do app — a parte que só existe no runtime Node.
 *
 * POR QUE
 *
 * A operação deste sistema não tem terminal: quem opera publica pelo GitHub e
 * olha o navegador. Uma migration que só roda com `npm run db:migrate` numa
 * máquina com acesso ao banco é, na prática, uma migration que não roda — e o
 * sintoma é a tela quebrada em produção, com a correção inalcançável.
 *
 * É seguro porque cada migration é atômica, registrada em `_migrations` por
 * checksum, e o conjunto roda sob `pg_advisory_lock` — várias instâncias
 * subindo ao mesmo tempo depois de um deploy serializam em vez de brigar.
 *
 * ESTA FUNÇÃO É AGUARDADA, E ISSO É O PONTO
 *
 * A primeira versão disparava e seguia (`void migrar()`). Parecia elegante —
 * não atrasa a primeira requisição — e não funciona onde mais importa: numa
 * função serverless, o que não termina antes da resposta pode ser congelado ou
 * morto. A migração era interrompida a cada tentativa, e o resultado apareceu
 * como `column "webhook_token" does not exist` numa tela que passava em todos
 * os testes.
 *
 * O Next aguarda `register()` antes de atender a primeira requisição. Aguardar
 * aqui é o que garante que nenhuma página seja servida contra um esquema
 * velho. O custo é um SELECT em `_migrations` por partida a frio.
 *
 * O QUE ISTO NÃO FAZ
 *
 * Não semeia. Criar organização e administrador é decisão de operação, não
 * consequência de um deploy, e roda pela tela de sistema.
 *
 * Não derruba o app quando falha. Um banco fora do ar não pode transformar
 * "algumas telas quebradas" em "site inteiro fora" — o estado aparece em
 * /configuracoes/sistema e em /api/health.
 */

/**
 * Teto para a espera.
 *
 * Aguardar é certo; aguardar para sempre não é. Um banco inalcançável não pode
 * segurar a subida do app indefinidamente — as telas que não dependem do banco,
 * e a própria página que diagnostica o problema, precisam continuar servindo.
 */
const TETO_MS = 20_000

export async function migrarNaSubida(): Promise<void> {
  // Durante `next build` não existe banco de produção para migrar — e a Vercel
  // constrói num ambiente sem as variáveis de execução.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  // Sem endereço de banco não há o que fazer, e reclamar aqui só polui o log de
  // quem monta a imagem antes de configurar.
  if (!process.env.DATABASE_URL_ADMIN && !process.env.DATABASE_URL) return

  if (process.env.AUTO_MIGRATE === 'false') return

  const { runMigrations } = await import('./db/migrate')

  const migrar = runMigrations((nome) => {
    console.log(`[mandafy] aplicando migration ${nome}`)
  }).then((resultado) => {
    if (resultado.aplicadas.length > 0) {
      console.log(
        `[mandafy] ${resultado.aplicadas.length} migration(s) aplicada(s): ${resultado.aplicadas.join(', ')}`,
      )
    }
  })

  const estourou = new Promise<'teto'>((resolve) => {
    const t = setTimeout(() => resolve('teto'), TETO_MS)
    // `unref` evita que o temporizador segure o processo de pé sozinho — importa
    // no worker e no `next start`, que são processos longos.
    if (typeof t.unref === 'function') t.unref()
  })

  try {
    const desfecho = await Promise.race([migrar, estourou])

    if (desfecho === 'teto') {
      console.error(
        `[mandafy] migração passou de ${TETO_MS / 1000}s e o app subiu assim mesmo. ` +
          'Confira Configurações → Sistema.',
      )
    }
  } catch (erro) {
    /*
     * A mensagem do Postgres entra no log porque é ela que diz o que fazer, e
     * ela não carrega dado pessoal (§14.1) — é erro de esquema. A URL do banco,
     * que carregaria a senha, nunca é registrada.
     */
    console.error(
      '[mandafy] falha ao migrar na subida:',
      erro instanceof Error ? erro.message : String(erro),
    )
  }
}
