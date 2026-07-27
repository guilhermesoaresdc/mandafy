import type { Metadata, Viewport } from 'next'
import { Bricolage_Grotesque, Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

/**
 * Tipografia de §11.3.
 *  Display   → Bricolage Grotesque. Largura variável; usada expandida nos
 *              títulos, é o que dá personalidade ao painel.
 *  Interface → Geist Sans. Neutra e legível em 13–14px.
 *  Dados     → Geist Mono. Horários, ids, contadores, o log inteiro.
 *
 * `display: swap` e subset latin + latin-ext conforme §13.2.
 */

const bricolage = Bricolage_Grotesque({
  variable: '--font-bricolage',
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  weight: ['400', '600', '700'],
})

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Mandafy',
  description: 'Cada mensagem no tempo certo, no canal certo.',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: '#F5F6FA',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="pt-BR"
      className={`${bricolage.variable} ${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="min-h-dvh bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  )
}
