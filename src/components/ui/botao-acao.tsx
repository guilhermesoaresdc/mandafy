'use client'

import { useActionState } from 'react'
import { Button } from './button'

/**
 * Um botão que executa uma ação de servidor e mostra o que aconteceu, ali
 * mesmo.
 *
 * Nasceu para os estados vazios. "Nenhum fluxo ainda" mandava rodar um comando
 * de terminal — para quem opera o sistema pelo navegador, isso é uma porta sem
 * maçaneta. Um vazio que convida à ação (§11.7) precisa da ação junto.
 *
 * O resultado fica na tela e não vira um aviso que some: trazer os modelos é
 * coisa que se faz uma vez, e o que foi criado é justamente o que a pessoa
 * precisa ler antes de decidir o próximo passo.
 */
export type EstadoDeAcao = { ok?: string; erro?: string }

export function BotaoAcao({
  acao,
  rotulo,
  rotuloOcupado,
  variant = 'primary',
}: {
  acao: () => Promise<EstadoDeAcao>
  rotulo: string
  rotuloOcupado: string
  variant?: 'primary' | 'secondary' | 'ghost'
}) {
  const [estado, disparar, ocupado] = useActionState<EstadoDeAcao, FormData>(() => acao(), {})

  return (
    <form action={disparar} className="flex flex-col items-center gap-2">
      <Button type="submit" size="sm" variant={variant} disabled={ocupado}>
        {ocupado ? rotuloOcupado : rotulo}
      </Button>

      {estado.ok ? (
        <p className="max-w-md rounded-lg border border-ok/40 px-3 py-2 text-2xs text-ok">
          {estado.ok}
        </p>
      ) : null}

      {estado.erro ? (
        <p className="max-w-md rounded-lg border border-fail/40 px-3 py-2 text-2xs text-fail">
          {estado.erro}
        </p>
      ) : null}
    </form>
  )
}
