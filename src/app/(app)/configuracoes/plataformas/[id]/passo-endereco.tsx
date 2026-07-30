'use client'

import { useState } from 'react'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'

/**
 * Passo 1 de §4.2: copiar o endereço de recebimento.
 *
 * O endereço contém o token — é a credencial da plataforma. Por isso o aviso
 * de tratá-lo como senha vem junto, e não escondido numa documentação.
 */
export function PassoEndereco({ endereco }: { endereco: string }) {
  const [copiado, setCopiado] = useState(false)

  async function copiar() {
    try {
      await navigator.clipboard.writeText(endereco)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sem permissão de área de transferência: o texto continua selecionável.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="mr-2 font-mono text-2xs text-pending">1</span>
          Apontar a plataforma para cá
        </CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-xs text-ink-2">
          Cole este endereço no campo de webhook da sua plataforma de sorteio, com o método POST.
        </p>

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-2xs whitespace-nowrap text-ink">
            {endereco}
          </code>
          <Button variant="secondary" size="sm" onClick={copiar}>
            {copiado ? 'Copiado' : 'Copiar'}
          </Button>
        </div>

        <p className="text-2xs text-pending">
          Trate como senha: quem tiver este endereço consegue enviar eventos em seu nome.
        </p>
      </CardBody>
    </Card>
  )
}
