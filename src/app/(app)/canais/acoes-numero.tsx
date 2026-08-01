'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import { LeitorDeQr } from './conectar-numero'

/**
 * Reconectar e remover um número já cadastrado (§7.3).
 *
 * Reconectar abre o mesmo leitor de QR da criação — a instância continua no
 * servidor, só perdeu a sessão do aparelho. É o caso mais comum: o celular
 * ficou dias sem internet e o WhatsApp derrubou a conexão.
 *
 * Remover confirma antes porque o efeito depende de quem criou a instância, e
 * a diferença importa: se foi o Mandafy, ela some do servidor junto; se as
 * credenciais foram coladas de fora, some só a linha daqui.
 */
export function AcoesNumero({
  id,
  nome,
  gerenciada,
  conectado,
  onRemover,
}: {
  id: string
  nome: string
  gerenciada: boolean
  conectado: boolean
  onRemover: (formData: FormData) => void
}) {
  const [lendoQr, setLendoQr] = useState(false)
  const [confirmando, setConfirmando] = useState(false)

  if (lendoQr) {
    return (
      <div className="w-full">
        <LeitorDeQr instanciaId={id} onFechar={() => setLendoQr(false)} />
      </div>
    )
  }

  if (confirmando) {
    return (
      <div className="flex w-full flex-col gap-2 rounded-lg border border-fail/40 p-3">
        <p className="text-2xs text-ink-2">
          Remover <strong>{nome}</strong>?{' '}
          {gerenciada
            ? 'A instância também será apagada da Evolution — o aparelho será desconectado.'
            : 'Sai só do Mandafy. Na Evolution ela continua de pé, como estava.'}
        </p>
        <div className="flex gap-2">
          <form action={onRemover}>
            <input type="hidden" name="id" value={id} />
            <Button type="submit" size="sm" variant="secondary">
              Remover
            </Button>
          </form>
          <Button variant="ghost" size="sm" onClick={() => setConfirmando(false)}>
            Cancelar
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      {gerenciada && !conectado ? (
        <Button variant="ghost" size="sm" onClick={() => setLendoQr(true)}>
          Reconectar
        </Button>
      ) : null}

      <Button variant="ghost" size="sm" onClick={() => setConfirmando(true)}>
        Remover
      </Button>
    </>
  )
}
