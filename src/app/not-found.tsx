import Link from 'next/link'
import { Button } from '@/components/ui'

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-display text-2xl font-bold text-ink">404</p>
      <div className="flex flex-col gap-1">
        <p className="font-display text-sm font-semibold text-ink">Essa página não existe.</p>
        <p className="text-xs text-ink-2">
          O endereço pode ter mudado, ou o item foi removido.
        </p>
      </div>
      <Button asChild variant="secondary">
        <Link href="/painel">Voltar ao painel</Link>
      </Button>
    </main>
  )
}
