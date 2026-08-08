import { Card, CardBody, Skeleton } from '@/components/ui'

/**
 * O que aparece enquanto a tela nova carrega (§13).
 *
 * Sem este arquivo, o App Router não pinta NADA até o servidor terminar a
 * árvore inteira — com todas as consultas. O clique fica sem resposta pelo
 * tempo do render inteiro, e o usuário conclui que o botão não funcionou.
 * Foi exatamente o sintoma relatado: "clico e demora vários segundos para
 * realmente entrar".
 *
 * Ele não deixa nada mais rápido. Devolve o CONTROLE: a navegação passa a ser
 * imediata, a casca e o título aparecem na hora, e o conteúdo preenche quando
 * chega. A diferença entre uma tela que está carregando e uma que travou é
 * inteira desta tela.
 *
 * Genérico de propósito. Um esqueleto que imita cada tela específica erra a
 * altura e produz salto de layout na troca — pior que a espera. Estas são as
 * formas que TODA tela do sistema tem: cabeçalho com título, e blocos.
 */
export default function Carregando() {
  return (
    <main className="flex min-h-0 flex-1 flex-col" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando…</span>

      <header className="flex shrink-0 items-start justify-between gap-4 px-4 pt-4 pb-3 md:px-6 md:pt-5 md:pb-4">
        <div className="flex flex-col gap-2">
          {/* Mesma altura do h1 e do parágrafo do SessionFrame: sem salto. */}
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <div className="flex flex-col gap-4">
          <Card>
            <CardBody className="flex flex-col gap-3">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </CardBody>
          </Card>

          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i}>
                <CardBody className="flex flex-col gap-3">
                  <Skeleton className="h-3 w-1/2" />
                  <Skeleton className="h-3 w-3/4" />
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
