import type { ReactNode } from 'react'
import { AppShell } from '@/components/shell/app-shell'
import { requireUser } from '@/lib/auth/current'

/**
 * Área autenticada. `requireUser()` valida a sessão de verdade no servidor —
 * o middleware só checou a presença do cookie.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  return <AppShell user={user}>{children}</AppShell>
}
