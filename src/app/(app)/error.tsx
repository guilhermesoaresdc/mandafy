'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { Button, Card, CardBody } from '@/components/ui'

/**
 * O que aparece quando uma tela autenticada estoura no servidor.
 *
 * Sem isto, o Next mostra "Application error: a server-side exception has
 * occurred" e um digest — que é um identificador para procurar no log, e o log
 * está num lugar que quem opera não abre. A pessoa fica com uma tela quebrada e
 * nenhum caminho.
 *
 * A causa mais comum aqui tem nome e conserto conhecido: uma alteração de
 * banco que ainda não foi aplicada faz a consulta falhar com "column ... does
 * not exist". Por isso os dois atalhos: o diagnóstico que abre SEM depender do
 * painel, e a tela que aplica as pendentes.
 *
 * A mensagem real do erro não é exibida de propósito — o Next a censura em
 * produção justamente porque ela pode conter nome de tabela, consulta e valor.
 * O digest é o que liga esta tela à linha do log.
 */
export default function Erro({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Vai para o console do navegador de quem está vendo a falha; em produção
    // o Next entrega só a mensagem genérica e o digest.
    console.error('Falha ao renderizar a tela:', error)
  }, [error])

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6">
      <div>
        <h1 className="text-sm font-medium text-ink">Esta tela não abriu.</h1>
        <p className="mt-1 text-2xs text-ink-2">
          O erro ficou no servidor. Quase sempre é uma alteração de banco que ainda não foi
          aplicada — o app aplica sozinho ao subir, então um novo deploy costuma resolver.
        </p>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <p className="text-2xs text-ink-2">
            <strong className="text-ink">Comece por aqui.</strong> O diagnóstico abre mesmo com o
            painel quebrado e diz exatamente o que falta.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <a href="/api/health" target="_blank" rel="noreferrer">
                Ver diagnóstico
              </a>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/configuracoes/sistema">Configurações → Sistema</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={reset}>
              Tentar de novo
            </Button>
          </div>
        </CardBody>
      </Card>

      {error.digest ? (
        <p className="font-mono text-2xs text-pending">
          Identificador da falha no log: {error.digest}
        </p>
      ) : null}
    </div>
  )
}
