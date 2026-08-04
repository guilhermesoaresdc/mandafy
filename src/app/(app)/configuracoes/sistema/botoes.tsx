'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui'
import type { EstadoAcao } from './actions'

/**
 * Um botão que dispara uma operação de sistema e mostra o que aconteceu.
 *
 * O resultado fica na tela em vez de virar um toast: migrar e semear são
 * operações que a pessoa faz uma vez e precisa LER o resultado — o que foi
 * criado é justamente o que decide o próximo passo dela.
 */
export function BotaoDeSistema({
  acao,
  rotulo,
  rotuloOcupado,
  variante = 'secondary',
  descricao,
}: {
  acao: () => Promise<EstadoAcao>
  rotulo: string
  rotuloOcupado: string
  variante?: 'primary' | 'secondary' | 'ghost'
  descricao?: string
}) {
  const [estado, disparar, ocupado] = useActionState<EstadoAcao, FormData>(
    () => acao(),
    {},
  )

  return (
    <form action={disparar} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant={variante} disabled={ocupado}>
          {ocupado ? rotuloOcupado : rotulo}
        </Button>
        {descricao ? <span className="text-2xs text-ink-2">{descricao}</span> : null}
      </div>

      {estado.ok ? (
        <p className="rounded-lg border border-ok/40 px-3 py-2 text-2xs text-ok">{estado.ok}</p>
      ) : null}

      {estado.erro ? (
        <p className="rounded-lg border border-fail/40 px-3 py-2 font-mono text-2xs text-fail">
          {estado.erro}
        </p>
      ) : null}
    </form>
  )
}
