'use client'

import { useActionState, useId, useState } from 'react'
import { Button, Card, CardBody, Field, Input, fieldDescriptionId } from '@/components/ui'
import { CHANNEL_LABELS, CHANNELS, type Channel } from '@/db/schema/enums'
import { cn } from '@/lib/utils'
import { enviarTesteAction, type TesteState } from './teste'

/**
 * "Enviar teste" (§6.6).
 *
 * Passa pelo mesmo caminho de um envio real — guardas, compilação, fila,
 * adaptador. O resultado que aparece aqui é o resultado de verdade: se o canal
 * não estiver configurado, é isso que a tela diz, em vez de fingir sucesso.
 */

const PLACEHOLDER: Record<Channel, string> = {
  whatsapp: '(11) 98888-7777',
  sms: '(11) 98888-7777',
  email: 'voce@exemplo.com.br',
  telegram: '123456789',
}

const DICA: Record<Channel, string> = {
  whatsapp: 'Seu número, com DDD.',
  sms: 'Seu número, com DDD. Lembre que SMS custa por segmento.',
  email: 'Seu e-mail.',
  telegram: 'O id numérico da conversa. Fale com o bot e ele aparece no painel.',
}

export function EnviarTeste({ messageId }: { messageId: string }) {
  const [canal, setCanal] = useState<Channel>('whatsapp')
  const [estado, enviar, enviando] = useActionState<TesteState, FormData>(enviarTesteAction, {})
  const destinoId = useId()

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div>
          <p className="text-xs font-medium text-ink">Enviar teste</p>
          <p className="text-2xs text-pending">
            Sai pelo mesmo caminho de um envio real, sem esperar o ritmo nem a janela de silêncio.
          </p>
        </div>

        <div className="flex flex-wrap gap-1">
          {CHANNELS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCanal(c)}
              aria-pressed={canal === c}
              className={cn(
                'rounded-lg border px-2.5 py-1.5 text-2xs',
                canal === c ? 'border-ink text-ink' : 'border-line text-ink-2',
              )}
            >
              {CHANNEL_LABELS[c]}
            </button>
          ))}
        </div>

        <form action={enviar} className="flex items-end gap-2">
          <input type="hidden" name="messageId" value={messageId} />
          <input type="hidden" name="canal" value={canal} />

          <Field
            label="Para onde"
            htmlFor={destinoId}
            hint={DICA[canal]}
            className="min-w-0 flex-1"
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={destinoId}
              name="destino"
              required
              maxLength={200}
              placeholder={PLACEHOLDER[canal]}
              aria-describedby={fieldDescriptionId(destinoId)}
            />
          </Field>

          <Button type="submit" size="sm" variant="secondary" disabled={enviando} className="mb-6">
            {enviando ? 'Enviando…' : 'Enviar agora'}
          </Button>
        </form>

        {estado.linhas?.map((linha) => (
          <p
            key={linha.canal}
            className={cn('text-2xs', linha.ok ? 'text-ok' : 'text-fail')}
            role="status"
          >
            {CHANNEL_LABELS[linha.canal]}: {linha.texto}
          </p>
        ))}
      </CardBody>
    </Card>
  )
}
