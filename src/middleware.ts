import { NextResponse, type NextRequest } from 'next/server'

/**
 * O middleware faz APENAS o redirecionamento barato, olhando a presença do
 * cookie. Ele não valida a sessão.
 *
 * Motivo: o middleware roda no runtime Edge, onde `node:crypto` e o driver do
 * Postgres não existem. A validação real acontece em `requireUser()`, dentro
 * de Server Components e Server Actions, no runtime Node. Um cookie forjado
 * passa por aqui e é rejeitado lá — nenhuma decisão de autorização é tomada
 * neste arquivo.
 */

const SESSION_COOKIE = 'mandafy_session'
const LOGIN_PATH = '/entrar'

/**
 * Telas que existem PARA quem não consegue entrar.
 *
 * Mandá-las para o login seria um laço: a pessoa clica no link do e-mail para
 * criar a senha, cai na tela de entrada, e não tem senha para entrar. O acesso
 * aqui é autorizado pelo token na URL, conferido na própria página.
 */
const SEM_SESSAO = ['/definir-senha', '/recuperar']

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl

  if (SEM_SESSAO.some((rota) => pathname === rota || pathname.startsWith(`${rota}/`))) {
    return NextResponse.next()
  }

  /*
   * A tela de entrada NUNCA é redirecionada daqui.
   *
   * Antes, um cookie presente mandava /entrar para /painel. Como o middleware
   * não valida a sessão, um cookie que existe mas não vale produzia um laço
   * infinito: /painel não autenticava e mandava para /entrar, que voltava para
   * /painel. Foi o que aconteceu quando uma política de RLS impediu a leitura
   * da organização.
   *
   * Levar quem já está autenticado direto ao painel é uma gentileza, e ela
   * agora acontece na própria página /entrar, que pode validar a sessão de
   * verdade. Aqui, o silêncio é o que garante que nenhum laço seja possível.
   */
  if (pathname === LOGIN_PATH) return NextResponse.next()

  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = new URL(LOGIN_PATH, request.url)
    // Preserva o destino para voltar depois do login.
    if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * O middleware protege PÁGINAS. Tudo, exceto:
     *
     *   _next/**   assets do build
     *
     *   in/**      webhooks das plataformas: sem sessão, autenticados por token
     *              na URL (§4.3). Um redirect aqui quebraria a integração e
     *              estouraria o ACK de 50ms.
     *
     *   api/**     TODA rota de API se autentica sozinha — por chave em
     *              `Authorization: Bearer` (§12.1) ou pelo cookie, lido
     *              diretamente. Deixar o middleware na frente redirecionava a
     *              API pública inteira para a tela de login, e nenhuma chave
     *              válida conseguia passar.
     *
     *   sair/**    descadastro em um clique (§14.1). Precisa funcionar sem
     *              login, do celular de quem abriu o e-mail — e o
     *              `List-Unsubscribe-Post` do Gmail nem cookie manda.
     *
     *   arquivos com extensão (favicon, imagens, fontes)
     */
    '/((?!_next/static|_next/image|in/|api/|sair/|.*\\.[\\w]+$).*)',
  ],
}
