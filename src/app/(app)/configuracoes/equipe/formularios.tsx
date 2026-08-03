'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, Field, Input, PasswordInput, fieldDescriptionId } from '@/components/ui'
import { USER_ROLES, USER_ROLE_LABELS } from '@/db/schema/enums'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/regras'
import {
  convidarAction,
  reenviarConviteAction,
  trocarSenhaAction,
  type EquipeState,
  type TrocarSenhaState,
} from './actions'

/**
 * Formulários da tela de equipe.
 *
 * O link de convite aparece na tela quando o e-mail não sai. Sem isso, um canal
 * de e-mail mal configurado deixaria o administrador travado — sem nenhum
 * caminho para dar acesso a alguém, e sem entender por quê.
 */

function LinkDeReserva({ link }: { link: string }) {
  return (
    <div className="rounded-lg border border-pending/50 px-3 py-2">
      <p className="text-2xs text-ink-2">
        Copie e mande para a pessoa por outro meio. Vale 7 dias e só funciona uma vez:
      </p>
      <p className="mt-1 font-mono text-2xs break-all text-ink select-all">{link}</p>
    </div>
  )
}

export function ConvidarPessoa() {
  const [aberto, setAberto] = useState(false)
  const [estado, convidar, enviando] = useActionState<EquipeState, FormData>(convidarAction, {})

  const nomeId = useId()
  const emailId = useId()

  if (!aberto) {
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" onClick={() => setAberto(true)}>
          Dar acesso a alguém
        </Button>
        {estado.ok ? <p className="text-2xs text-ok">{estado.ok}</p> : null}
        {estado.link ? <LinkDeReserva link={estado.link} /> : null}
      </div>
    )
  }

  return (
    <Card>
      <CardBody>
        <form action={convidar} className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Nome" htmlFor={nomeId}>
              <Input id={nomeId} name="nome" required autoFocus maxLength={120} />
            </Field>

            <Field
              label="E-mail"
              htmlFor={emailId}
              hint="É para cá que vai o link de acesso."
              {...(estado.erro ? { error: estado.erro } : {})}
            >
              <Input
                id={emailId}
                name="email"
                type="email"
                required
                placeholder="pessoa@empresa.com.br"
                aria-describedby={fieldDescriptionId(emailId)}
              />
            </Field>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-2xs font-medium text-ink-2">Perfil</legend>
            <div className="flex flex-wrap gap-2">
              {USER_ROLES.map((papel, i) => (
                <label
                  key={papel}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink"
                >
                  <input
                    type="radio"
                    name="papel"
                    value={papel}
                    defaultChecked={i === USER_ROLES.length - 1}
                    className="size-3 accent-ink"
                  />
                  {USER_ROLE_LABELS[papel]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-2xs text-pending">
              Consultor enxerga apenas os próprios leads. Administrador vê tudo e gerencia a
              equipe.
            </p>
          </fieldset>

          <p className="rounded-lg border border-line px-3 py-2 text-2xs text-ink-2">
            A pessoa recebe um link e cria a própria senha. Você não define, não vê e não guarda a
            senha de ninguém.
          </p>

          {estado.ok ? <p className="text-2xs text-ok">{estado.ok}</p> : null}
          {estado.link ? <LinkDeReserva link={estado.link} /> : null}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={enviando}>
              {enviando ? 'Criando…' : 'Criar acesso e enviar link'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
              Fechar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

export function ReenviarConvite({ id }: { id: string }) {
  const [estado, reenviar, enviando] = useActionState<EquipeState, FormData>(
    reenviarConviteAction,
    {},
  )

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={reenviar}>
        <input type="hidden" name="id" value={id} />
        <Button type="submit" variant="ghost" size="sm" disabled={enviando}>
          {enviando ? 'Gerando…' : 'Reenviar link'}
        </Button>
      </form>

      {estado.ok ? <p className="max-w-xs text-right text-2xs text-ok">{estado.ok}</p> : null}
      {estado.erro ? <p className="text-2xs text-fail">{estado.erro}</p> : null}
      {estado.link ? (
        <p className="max-w-sm font-mono text-2xs break-all text-ink select-all">{estado.link}</p>
      ) : null}
    </div>
  )
}

export function TrocarSenha() {
  const [aberto, setAberto] = useState(false)
  const [estado, trocar, trocando] = useActionState<TrocarSenhaState, FormData>(
    trocarSenhaAction,
    {},
  )

  const atualId = useId()
  const novaId = useId()
  const confirmaId = useId()

  if (estado.ok) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-2xs text-ok">
          Senha trocada. Todas as sessões foram encerradas — entre de novo com a senha nova.
        </p>
        <Button asChild size="sm" variant="secondary">
          <a href="/entrar">Ir para a entrada</a>
        </Button>
      </div>
    )
  }

  if (!aberto) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setAberto(true)}>
        Trocar minha senha
      </Button>
    )
  }

  return (
    <form action={trocar} className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <Field label="Senha atual" htmlFor={atualId}>
        <PasswordInput
          id={atualId}
          name="atual"
          required
          autoFocus
          autoComplete="current-password"
        />
      </Field>

      <Field
        label="Senha nova"
        htmlFor={novaId}
        hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
      >
        <PasswordInput
          id={novaId}
          name="nova"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          aria-describedby={fieldDescriptionId(novaId)}
        />
      </Field>

      <Field
        label="Repita a senha nova"
        htmlFor={confirmaId}
        {...(estado.erro ? { error: estado.erro } : {})}
      >
        <PasswordInput id={confirmaId} name="confirmacao" required autoComplete="new-password" />
      </Field>

      <p className="text-2xs text-pending">
        Ao trocar, toda sessão aberta nesta conta é encerrada — inclusive esta.
      </p>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={trocando}>
          {trocando ? 'Trocando…' : 'Trocar senha'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
