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

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const hasCookie = request.cookies.has(SESSION_COOKIE)
  const isLoginPage = pathname === LOGIN_PATH

  if (isLoginPage) {
    if (hasCookie) {
      return NextResponse.redirect(new URL('/painel', request.url))
    }
    return NextResponse.next()
  }

  if (!hasCookie) {
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
     * Tudo, exceto:
     *   _next/**      → assets do build
     *   in/**         → webhooks das plataformas: sem sessão, autenticados por
     *                   token na URL (§4.3). Um redirect aqui quebraria a
     *                   integração e estouraria o ACK de 50ms.
     *   api/health    → healthcheck do Docker
     *   arquivos com extensão (favicon, imagens, fontes)
     */
    '/((?!_next/static|_next/image|in/|api/health|.*\\.[\\w]+$).*)',
  ],
}
