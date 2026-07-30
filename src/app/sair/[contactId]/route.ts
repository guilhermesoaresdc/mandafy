import { sql } from 'drizzle-orm'
import { db, withTenant } from '@/db'
import { descadastrar } from '@/lib/lgpd'
import { createLogger } from '@/lib/logger'

/**
 * Descadastro em um clique (§14.1).
 *
 * O link do rodapé de todo e-mail e o alvo do `List-Unsubscribe-Post`. Sem
 * login, sem confirmação, sem formulário: a spec diz "one-click, sem login", e
 * Gmail e Outlook exigem que o POST funcione sozinho.
 *
 * O id do contato é um UUID v4 — 122 bits de aleatoriedade. Não dá para
 * adivinhar, e o dano máximo de acertar um seria descadastrar alguém, que é
 * exatamente o que o titular pode pedir de qualquer forma.
 */

const log = createLogger('descadastro')

async function processar(contactId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(contactId)) {
    return pagina('Pronto. Você não recebe mais nossas mensagens.')
  }

  /*
   * A organização vem por uma função SECURITY DEFINER (drizzle/0015). Um
   * SELECT comum aqui não acharia nada: o RLS exige `app.org_id`, e descobrir
   * a organização É o passo que falta. Sem isso a página respondia "pronto"
   * sem ter descadastrado ninguém — pior que falhar, porque a pessoa acredita
   * que resolveu.
   */
  const orgId = await db
    .execute(sql`SELECT mandafy_org_do_contato(${contactId}::uuid) AS org_id`)
    .then((linhas) => {
      const primeira = Array.isArray(linhas)
        ? (linhas[0] as { org_id: string | null } | undefined)
        : undefined
      return primeira?.org_id ?? null
    })
    .catch(() => null)

  // Mesma resposta para contato inexistente: confirmar a existência de um id
  // seria vazar informação de graça.
  if (!orgId) return pagina('Pronto. Você não recebe mais nossas mensagens.')

  await withTenant({ orgId, userId: orgId, isAdmin: true }, (tx) =>
    descadastrar(tx, orgId, contactId, { motivo: 'link de descadastro' }),
  ).catch((erro: unknown) => {
    log.error('falha no descadastro', {
      reason: erro instanceof Error ? erro.message : 'desconhecido',
    })
  })

  return pagina('Pronto. Você não recebe mais nossas mensagens.')
}

/** GET para quem clica no link do e-mail. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
): Promise<Response> {
  const { contactId } = await params
  return processar(contactId)
}

/** POST para o `List-Unsubscribe-Post` do Gmail e do Outlook. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
): Promise<Response> {
  const { contactId } = await params
  await processar(contactId)
  // O cliente de e-mail não mostra nada; 204 é o que ele espera.
  return new Response(null, { status: 204 })
}

function pagina(mensagem: string): Response {
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Descadastro</title></head>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui,sans-serif;background:#fafafa;color:#18181b">
<main style="max-width:28rem;padding:2rem;text-align:center">
<p style="font-size:1rem;line-height:1.5">${mensagem}</p>
<p style="margin-top:.5rem;font-size:.8rem;color:#71717a">O pedido foi processado agora, não em 48 horas.</p>
</main></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}
