import { cn } from '@/lib/utils'

/**
 * O giro que aparece enquanto uma ação está em curso (§13).
 *
 * SVG e `animate-spin`, sem imagem e sem dependência: ele acompanha CADA botão
 * de envio do sistema, e um arquivo a mais para baixar seria peso no orçamento
 * de §13 justamente na tela que já está esperando.
 *
 * `currentColor` de propósito — o giro herda a cor do texto do botão, então
 * funciona no primário (branco sobre roxo) e no secundário (tinta sobre claro)
 * sem uma variante para cada.
 *
 * `aria-hidden`: quem lê tela já recebe a notícia pelo `aria-busy` do botão, e
 * anunciar duas vezes a mesma coisa é ruído.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {/* O anel de fundo, apagado: sem ele o arco parece um risco solto. */}
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
