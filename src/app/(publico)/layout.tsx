import type { ReactNode } from 'react'

/** Casca das rotas públicas: centrada, sem navegação. */
export default function PublicoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">{children}</div>
  )
}
