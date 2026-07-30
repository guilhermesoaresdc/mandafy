'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, Field, Input, fieldDescriptionId } from '@/components/ui'
import { ESCOPO_LABELS, ESCOPOS, EVENTO_LABELS, EVENTOS_SAIDA } from '@/lib/api/escopos'
import { criarChaveAction, criarWebhookAction, type ApiState } from './actions'

/**
 * Criar chave e webhook.
 *
 * O segredo aparece UMA vez, em destaque, com aviso explícito. Guardamos só o
 * hash — nem nós conseguimos recuperá-lo depois, e dizer isso na tela evita a
 * pergunta "onde vejo minha chave de novo?".
 */

function SegredoUmaVez({ valor, rotulo }: { valor: string; rotulo: string }) {
  const [copiado, setCopiado] = useState(false)

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-ok/50 bg-ok/5 p-3">
      <p className="text-2xs font-medium text-ink">{rotulo}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-line bg-surface px-2 py-1.5 font-mono text-2xs whitespace-nowrap text-ink">
          {valor}
        </code>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(valor).then(() => {
              setCopiado(true)
              setTimeout(() => setCopiado(false), 2000)
            })
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      <p className="text-2xs text-pending">
        Guardamos só o resumo criptográfico. Este valor não aparece de novo — nem para nós.
      </p>
    </div>
  )
}

export function NovaChave() {
  const [aberto, setAberto] = useState(false)
  const [estado, criar, criando] = useActionState<ApiState, FormData>(criarChaveAction, {})
  const nomeId = useId()

  if (estado.chaveNova) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <SegredoUmaVez valor={estado.chaveNova} rotulo="Sua chave de API" />
          <Button variant="ghost" size="sm" onClick={() => setAberto(false)}>
            Entendi
          </Button>
        </CardBody>
      </Card>
    )
  }

  if (!aberto) {
    return (
      <Button size="sm" onClick={() => setAberto(true)}>
        Nova chave
      </Button>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={criar} className="flex flex-col gap-3">
          <Field
            label="Para que serve esta chave?"
            htmlFor={nomeId}
            hint="Ex.: Plataforma de sorteio, Integração do site"
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={nomeId}
              name="nome"
              required
              autoFocus
              maxLength={80}
              aria-describedby={fieldDescriptionId(nomeId)}
            />
          </Field>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-2xs font-medium text-ink-2">Ambiente</legend>
            <div className="flex gap-2">
              {(['live', 'test'] as const).map((a, i) => (
                <label
                  key={a}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink"
                >
                  <input
                    type="radio"
                    name="ambiente"
                    value={a}
                    defaultChecked={i === 0}
                    className="size-3 accent-ink"
                  />
                  {a === 'live' ? 'Produção' : 'Teste'}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-2xs font-medium text-ink-2">
              O que esta chave pode fazer
            </legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {ESCOPOS.map((escopo) => (
                <label key={escopo} className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
                  <input type="checkbox" name="escopos" value={escopo} className="size-3 accent-ink" />
                  {ESCOPO_LABELS[escopo]}
                </label>
              ))}
            </div>
            <p className="text-2xs text-pending">
              Marque só o necessário. Uma chave que vaza faz exatamente o que você deixou marcado.
            </p>
          </fieldset>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={criando}>
              {criando ? 'Criando…' : 'Criar chave'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

export function NovoWebhook() {
  const [aberto, setAberto] = useState(false)
  const [estado, criar, criando] = useActionState<ApiState, FormData>(criarWebhookAction, {})
  const urlId = useId()

  if (estado.segredoNovo) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <SegredoUmaVez valor={estado.segredoNovo} rotulo="Segredo do webhook" />
          <p className="text-2xs text-ink-2">
            Use para validar o header <code className="font-mono">X-Mandafy-Signature</code>, que
            vem como <code className="font-mono">t=&lt;unix&gt;,v1=&lt;hmac&gt;</code> sobre{' '}
            <code className="font-mono">timestamp.corpo</code>. Rejeite o que tiver mais de 5
            minutos.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setAberto(false)}>
            Entendi
          </Button>
        </CardBody>
      </Card>
    )
  }

  if (!aberto) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setAberto(true)}>
        Novo webhook
      </Button>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={criar} className="flex flex-col gap-3">
          <Field
            label="Para onde mandamos"
            htmlFor={urlId}
            hint="Precisa ser https."
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={urlId}
              name="url"
              type="url"
              required
              autoFocus
              placeholder="https://seusistema.com.br/webhooks/mandafy"
              className="font-mono"
              aria-describedby={fieldDescriptionId(urlId)}
            />
          </Field>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-2xs font-medium text-ink-2">Quando avisar</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {EVENTOS_SAIDA.map((evento) => (
                <label key={evento} className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
                  <input type="checkbox" name="eventos" value={evento} className="size-3 accent-ink" />
                  {EVENTO_LABELS[evento]}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={criando}>
              {criando ? 'Criando…' : 'Criar webhook'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
