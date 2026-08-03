import type { Metadata } from 'next'
import { RecuperarForm } from './form'

export const metadata: Metadata = { title: 'Recuperar senha · Mandafy' }

export default function RecuperarPage() {
  return (
    <div className="w-full max-w-[360px]">
      <div className="mb-8 text-center">
        <p className="font-display text-xl font-bold tracking-tight text-ink">Mandafy</p>
        <p className="mt-1 text-xs text-ink-2">Cada mensagem no tempo certo, no canal certo.</p>
      </div>

      <div className="rounded-xl border border-line bg-surface p-6">
        <p className="text-xs font-medium text-ink">Esqueceu a senha?</p>
        <p className="mt-1 text-2xs text-ink-2">
          Informe seu e-mail e mandamos um link para você criar uma nova.
        </p>

        <div className="mt-4">
          <RecuperarForm />
        </div>
      </div>
    </div>
  )
}
