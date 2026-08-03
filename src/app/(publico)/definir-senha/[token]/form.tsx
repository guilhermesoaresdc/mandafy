'use client'

import Link from 'next/link'
import { useActionState, useId, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, PasswordInput, fieldDescriptionId } from '@/components/ui'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/regras'
import { definirSenhaAction, type DefinirSenhaState } from '@/lib/auth/senha-actions'

function Enviar({ convite }: { convite: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="mt-1 w-full">
      {pending ? 'Salvando…' : convite ? 'Criar senha e entrar' : 'Salvar senha nova'}
    </Button>
  )
}

export function DefinirSenhaForm({ token, convite }: { token: string; convite: boolean }) {
  const [estado, definir] = useActionState<DefinirSenhaState, FormData>(definirSenhaAction, {})
  const [senha, setSenha] = useState('')
  const senhaId = useId()
  const confirmaId = useId()

  if (estado.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium text-ok">Senha salva.</p>
        <p className="text-2xs text-ink-2">
          Agora é só entrar com seu e-mail e a senha que você acabou de criar.
        </p>
        <Button asChild className="w-full">
          <Link href="/entrar">Ir para a entrada</Link>
        </Button>
      </div>
    )
  }

  const curta = senha.length > 0 && senha.length < MIN_PASSWORD_LENGTH

  return (
    <form action={definir} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      <Field
        label="Senha"
        htmlFor={senhaId}
        hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
      >
        <PasswordInput
          id={senhaId}
          name="senha"
          required
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={200}
          /*
           * `new-password` faz o gerenciador de senhas do navegador OFERECER
           * uma senha forte em vez de tentar preencher com a antiga — que é o
           * que `current-password` provocaria aqui.
           */
          autoComplete="new-password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          aria-describedby={fieldDescriptionId(senhaId)}
        />
      </Field>

      <Field
        label="Repita a senha"
        htmlFor={confirmaId}
        {...(estado.erro ? { error: estado.erro } : {})}
      >
        <PasswordInput
          id={confirmaId}
          name="confirmacao"
          required
          maxLength={200}
          autoComplete="new-password"
          aria-describedby={estado.erro ? fieldDescriptionId(confirmaId) : undefined}
        />
      </Field>

      {/*
        O aviso de tamanho aparece enquanto se digita, e some quando resolve.
        Descobrir que a senha é curta só depois de enviar o formulário custa
        uma ida ao servidor e o reinício do preenchimento.
      */}
      {curta ? (
        <p className="text-2xs text-pending">
          Faltam {MIN_PASSWORD_LENGTH - senha.length} caractere(s).
        </p>
      ) : null}

      <Enviar convite={convite} />
    </form>
  )
}
