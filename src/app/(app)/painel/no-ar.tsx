import Link from 'next/link'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import type { ResumoNoAr } from '@/db/queries/no-ar'
import { formatNumber } from '@/lib/utils'

/**
 * "O que está no ar" — o bloco que responde à pergunta antes dela ser feita.
 *
 * O painel dizia quanto saiu; a tela de fluxos, o que está configurado. Faltava
 * a ponte: quais fluxos estão LIGADOS, em que evento cada um dispara, e se esse
 * evento está mesmo chegando. É no vão entre essas três coisas que mora a falha
 * cara deste sistema — plataforma mandando evento, tudo verde na tela, e
 * nenhum fluxo escutando.
 *
 * Server Component: o bloco é estático por carregamento, e §13.2 não autoriza
 * componente de cliente aqui.
 */

/** Rótulo do estado de um fluxo, com o motivo junto. */
function estadoDo(fluxo: ResumoNoAr['fluxos'][number]): { texto: string; tom: Tom } {
  if (!fluxo.active) {
    // Pausado com evento chegando é o caso que mais custa: a plataforma está
    // mandando, o texto está pronto, e basta um clique que ninguém deu.
    return fluxo.gatilhos > 0
      ? { texto: 'pausado — e o evento está chegando', tom: 'fail' }
      : { texto: 'pausado', tom: 'pending' }
  }

  if (fluxo.gatilhos === 0) {
    return { texto: 'ligado, mas o evento nunca chegou', tom: 'pending' }
  }

  return { texto: `${formatNumber(fluxo.envios)} envio(s)`, tom: 'ok' }
}

type Tom = 'ok' | 'pending' | 'fail'

export function NoAr({ resumo }: { resumo: ResumoNoAr }) {
  const nenhumLigado = resumo.ligados === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>No ar</CardTitle>
        <span className="text-2xs text-pending">
          {resumo.total === 0
            ? 'nenhum fluxo configurado'
            : `${resumo.ligados} de ${resumo.total} ligado${resumo.ligados === 1 ? '' : 's'} · últimos ${resumo.dias} dias`}
        </span>
      </CardHeader>

      <CardBody className="flex flex-col gap-2">
        {resumo.total === 0 ? (
          <p className="text-2xs text-ink-2">
            Nenhum fluxo ainda — nada será enviado automaticamente.{' '}
            <Link href="/fluxos" className="text-ink underline">
              Trazer os modelos prontos
            </Link>
            .
          </p>
        ) : null}

        {/*
          O aviso mais importante da tela, e o mais fácil de não perceber: os
          fluxos-modelo nascem pausados de propósito, então logo depois de
          instalar a resposta honesta é "nada está no ar". Um painel cheio de
          números verdes calando sobre isso é um painel que engana.
        */}
        {nenhumLigado && resumo.total > 0 ? (
          <p className="rounded-lg border border-fail/40 px-3 py-2 text-2xs text-fail">
            Nenhum fluxo ligado — nada sai automaticamente. Abra Fluxos e ligue o que quiser no
            ar.
          </p>
        ) : null}

        {resumo.fluxos.map((fluxo) => {
          const estado = estadoDo(fluxo)

          return (
            <div key={fluxo.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-40 flex-1 truncate text-2xs text-ink">{fluxo.name}</span>

              <span className="font-mono text-2xs text-pending">
                {fluxo.triggerEvent}
                {fluxo.gatilhos > 0 ? ` · ${formatNumber(fluxo.gatilhos)} recebido(s)` : ''}
              </span>

              <Badge tone={estado.tom}>{estado.texto}</Badge>
            </div>
          )
        })}

        {/*
          Evento chegando que ninguém escuta. É a explicação para "configurei
          tudo e não sai nada" — e sem esta linha ela não existe em lugar nenhum
          do sistema.
        */}
        {resumo.semOuvinte.length > 0 ? (
          <p className="mt-1 rounded-lg border border-pending/50 px-3 py-2 text-2xs text-ink-2">
            Chega{resumo.semOuvinte.length > 1 ? 'm' : ''} sem ninguém escutando:{' '}
            <span className="font-mono">
              {resumo.semOuvinte.map((e) => `${e.type} (${formatNumber(e.total)})`).join(', ')}
            </span>
            . Ligue o fluxo correspondente, ou confira a tradução do evento em Plataformas.
          </p>
        ) : null}

        {resumo.total > 0 ? (
          <div className="mt-1">
            <Button asChild variant="ghost" size="sm">
              <Link href="/fluxos">Abrir Fluxos</Link>
            </Button>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}
