'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Field, Input, fieldDescriptionId } from '@/components/ui'
import type { Channel } from '@/db/schema/enums'
import { CANAL_PROVEDORES } from '@/lib/channels'
import { salvarCanalAction, type CanalState } from './actions'

/**
 * Configuração de um canal.
 *
 * A chave nunca volta do servidor. Campo em branco significa "não mexer" — é
 * assim que se liga e desliga o canal sem redigitar a credencial, e é por isso
 * que não existe "ver a chave atual".
 */

const ROTULO_CHAVE: Record<Channel, string> = {
  whatsapp: 'Chave global da Evolution',
  email: 'Chave do provedor de e-mail',
  sms: 'Chave do provedor de SMS',
  telegram: 'Token do bot',
}

const DICA_CHAVE: Record<Channel, string> = {
  whatsapp: 'É a AUTHENTICATION_API_KEY do servidor. Com ela o QR aparece aqui dentro.',
  email: 'No Resend: Settings → API Keys.',
  sms: 'No painel do provedor, em integrações.',
  telegram: 'O @BotFather entrega quando você cria o bot.',
}

export function ConfigurarCanal({
  canal,
  provider,
  configurado,
  ativo,
}: {
  canal: Channel
  provider: string | null
  configurado: boolean
  ativo: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const [estado, salvar, salvando] = useActionState<CanalState, FormData>(salvarCanalAction, {})
  const chaveId = useId()
  const remetenteId = useId()
  const urlId = useId()

  const provedores = CANAL_PROVEDORES[canal]

  if (!aberto) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setAberto(true)}>
        {configurado ? 'Trocar credencial' : 'Configurar'}
      </Button>
    )
  }

  return (
    <form action={salvar} className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <input type="hidden" name="canal" value={canal} />

      {provedores.length > 1 ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-2xs font-medium text-ink-2">Provedor</legend>
          <div className="flex flex-wrap gap-2">
            {provedores.map((p, i) => (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-2xs text-ink-2 has-[:checked]:border-ink has-[:checked]:text-ink"
              >
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  defaultChecked={provider ? provider === p : i === 0}
                  className="size-3 accent-ink"
                />
                {p}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="provider" value={provedores[0] ?? canal} />
      )}

      {canal === 'whatsapp' ? (
        <Field
          label="Endereço da Evolution"
          htmlFor={urlId}
          hint="Fixe a imagem em v2.x.x — nunca latest."
        >
          <Input
            id={urlId}
            name="url"
            type="url"
            maxLength={300}
            placeholder="https://evolution.seudominio.com.br"
            className="font-mono"
            aria-describedby={fieldDescriptionId(urlId)}
          />
        </Field>
      ) : null}

      <Field
        label={ROTULO_CHAVE[canal]}
        htmlFor={chaveId}
        hint={configurado ? 'Deixe em branco para manter a atual.' : DICA_CHAVE[canal]}
        {...(estado.erro ? { error: estado.erro } : {})}
      >
        <Input
          id={chaveId}
          name="apiKey"
          type="password"
          autoComplete="off"
          maxLength={500}
          placeholder={configurado ? '•••••••••••' : ''}
          className="font-mono"
          aria-describedby={fieldDescriptionId(chaveId)}
        />
      </Field>

      {canal === 'email' || canal === 'sms' ? (
        <Field
          label={canal === 'email' ? 'Remetente' : 'Nome do remetente (se o provedor exigir)'}
          htmlFor={remetenteId}
          hint={
            canal === 'email'
              ? 'Mandafy <envio@seudominio.com.br> — use um subdomínio dedicado.'
              : undefined
          }
        >
          <Input
            id={remetenteId}
            name="remetente"
            maxLength={200}
            placeholder={canal === 'email' ? 'Mandafy <envio@seudominio.com.br>' : 'MANDAFY'}
            aria-describedby={fieldDescriptionId(remetenteId)}
          />
        </Field>
      ) : null}

      <label className="flex cursor-pointer items-center gap-2 text-2xs text-ink-2">
        <input type="checkbox" name="ativo" defaultChecked={ativo} className="size-3 accent-ink" />
        Canal ligado
      </label>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={salvando}>
          {salvando ? 'Salvando…' : 'Salvar'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setAberto(false)}>
          Fechar
        </Button>
        {estado.ok ? <span className="text-2xs text-ok">Salvo.</span> : null}
      </div>
    </form>
  )
}
