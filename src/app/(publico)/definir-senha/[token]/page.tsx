import type { Metadata } from 'next'
import Link from 'next/link'
import { MENSAGEM_DO_MOTIVO } from '@/lib/auth/regras'
import { lerToken } from '@/lib/auth/tokens'
import { DefinirSenhaForm } from './form'

export const metadata: Metadata = { title: 'Definir senha · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * A tela que o link do e-mail abre (§9.4).
 *
 * Serve ao convite e à recuperação — são o mesmo mecanismo, e o texto muda
 * conforme o propósito. Fora do middleware de sessão de propósito: quem chega
 * aqui é justamente quem ainda não consegue entrar.
 *
 * O token é validado ANTES de mostrar o formulário. Deixar a pessoa escolher
 * uma senha, confirmar, e só então descobrir que o link venceu é uma
 * grosseria evitável.
 */
export default async function DefinirSenhaPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const leitura = await lerToken(token)

  if (!leitura.ok) {
    return (
      <div className="w-full max-w-[380px]">
        <Cabecalho />

        <div className="rounded-xl border border-line bg-surface p-6">
          <p className="text-xs font-medium text-fail">Este link não funciona mais.</p>
          <p className="mt-2 text-2xs text-ink-2">{MENSAGEM_DO_MOTIVO[leitura.motivo]}</p>

          <div className="mt-4 flex flex-col gap-2">
            <Link
              href="/recuperar"
              className="text-2xs text-live underline-offset-2 hover:underline"
            >
              Pedir um link novo
            </Link>
            <Link href="/entrar" className="text-2xs text-ink-2 underline-offset-2 hover:underline">
              Voltar para a entrada
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const convite = leitura.dono.proposito === 'convite'

  return (
    <div className="w-full max-w-[380px]">
      <Cabecalho />

      <div className="rounded-xl border border-line bg-surface p-6">
        <p className="text-xs font-medium text-ink">
          {convite ? 'Bem-vindo. Crie sua senha.' : 'Escolha uma senha nova.'}
        </p>
        <p className="mt-1 text-2xs text-ink-2">
          {convite
            ? 'Você foi cadastrado na equipe. Defina a senha para entrar.'
            : 'Depois de salvar, todas as sessões abertas nesta conta serão encerradas.'}
        </p>

        <p className="mt-3 font-mono text-2xs text-pending">{leitura.dono.email}</p>

        <div className="mt-4">
          <DefinirSenhaForm token={token} convite={convite} />
        </div>
      </div>
    </div>
  )
}

function Cabecalho() {
  return (
    <div className="mb-8 text-center">
      <p className="font-display text-xl font-bold tracking-tight text-ink">Mandafy</p>
      <p className="mt-1 text-xs text-ink-2">Cada mensagem no tempo certo, no canal certo.</p>
    </div>
  )
}
