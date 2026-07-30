'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, Field, Input, fieldDescriptionId } from '@/components/ui'
import { conectarNumeroAction, type CanalState } from './actions'

/**
 * Conectar um número de WhatsApp (§7.3).
 *
 * O aviso sobre o número principal do negócio fica na tela, não escondido numa
 * documentação: a spec é direta sobre isso (§14.2), e um número banido
 * raramente volta.
 */
export function ConectarNumero() {
  const [aberto, setAberto] = useState(false)
  const [estado, conectar, conectando] = useActionState<CanalState, FormData>(
    conectarNumeroAction,
    {},
  )

  const nomeId = useId()
  const urlId = useId()
  const instanciaId = useId()
  const apikeyId = useId()
  const telefoneId = useId()

  if (!aberto) {
    return (
      <Button size="sm" onClick={() => setAberto(true)}>
        Conectar número
      </Button>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={conectar} className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Como você chama esse número"
              htmlFor={nomeId}
              hint="Ex.: Chip 1, Atendimento, Recuperação"
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

            <Field label="Telefone (opcional)" htmlFor={telefoneId} hint="Só para você reconhecer.">
              <Input
                id={telefoneId}
                name="telefone"
                maxLength={30}
                placeholder="(11) 98888-7777"
                aria-describedby={fieldDescriptionId(telefoneId)}
              />
            </Field>

            <Field
              label="Endereço da Evolution"
              htmlFor={urlId}
              hint="Fixe a versão da imagem em v2.x.x — nunca latest."
            >
              <Input
                id={urlId}
                name="evolutionUrl"
                required
                type="url"
                placeholder="https://evolution.seudominio.com.br"
                className="font-mono"
                aria-describedby={fieldDescriptionId(urlId)}
              />
            </Field>

            <Field label="Nome da instância" htmlFor={instanciaId} hint="Como ela aparece na Evolution.">
              <Input
                id={instanciaId}
                name="instanceName"
                required
                maxLength={80}
                className="font-mono"
                aria-describedby={fieldDescriptionId(instanciaId)}
              />
            </Field>
          </div>

          <Field
            label="apikey da instância"
            htmlFor={apikeyId}
            hint="Guardada cifrada. Nunca volta para a tela."
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={apikeyId}
              name="apikey"
              required
              type="password"
              autoComplete="off"
              maxLength={500}
              className="font-mono"
              aria-describedby={fieldDescriptionId(apikeyId)}
            />
          </Field>

          <p className="rounded-lg border border-line px-3 py-2 text-2xs text-ink-2">
            O número começa no estágio <strong>Novo</strong>: 20 mensagens por dia, uma a cada 60
            segundos. Ele sobe sozinho conforme se comporta bem — e desce se começar a falhar.
            <span className="mt-1 block text-pending">
              Não use o número principal do negócio para automação. A Evolution não é a API oficial
              da Meta, e um número banido raramente volta.
            </span>
          </p>

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={conectando}>
              {conectando ? 'Conectando…' : 'Conectar'}
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
