'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import type { Channel } from '@/db/schema/enums'

/**
 * O endereço que a pessoa cola no painel do provedor.
 *
 * Copy pelo que ela controla, não pela implementação (§11.7): a tela fala em
 * "avisos do provedor", não em "webhook de retorno". O que ela precisa saber é
 * o que deixa de funcionar sem isso — e isso está dito em uma linha, por canal.
 */

const ONDE_COLAR: Partial<Record<Channel, { titulo: string; onde: string; porque: string }>> = {
  email: {
    titulo: 'Avisos da Resend',
    onde: 'Resend → Webhooks → Add Endpoint. Marque os eventos delivered, bounced e complained.',
    porque:
      'Sem isso, endereço que não existe mais continua recebendo tentativa a cada cadência — e é assim que a entrega do domínio cai sozinha.',
  },
  sms: {
    titulo: 'Avisos do provedor de SMS',
    onde: 'No painel do provedor, no campo de callback/DLR.',
    porque: 'Sem isso, todo SMS fica em "enviado" para sempre: não dá para saber o que chegou.',
  },
  telegram: {
    titulo: 'Avisos do bot',
    onde: 'Registre com setWebhook (o botão abaixo monta o comando).',
    porque:
      'Sem isso o canal não funciona: o chat só passa a existir quando a pessoa manda /start, e é por aqui que esse /start chega.',
  },
}

export function EnderecoRetorno({
  canal,
  token,
  appUrl,
}: {
  canal: Channel
  token: string | null
  appUrl: string
}) {
  const [copiado, setCopiado] = useState<string | null>(null)
  const texto = ONDE_COLAR[canal]

  if (!texto) return null

  if (!token) {
    return (
      <p className="text-2xs text-ink-2">
        Salve a credencial para gerar o endereço de avisos deste canal.
      </p>
    )
  }

  const url = `${appUrl.replace(/\/+$/, '')}/api/retorno/${canal}/${token}`

  async function copiar(valor: string, qual: string) {
    await navigator.clipboard.writeText(valor)
    setCopiado(qual)
    setTimeout(() => setCopiado(null), 2000)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 p-2.5">
      <p className="text-2xs font-medium text-ink">{texto.titulo}</p>
      <p className="text-2xs text-ink-2">{texto.onde}</p>

      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-2xs text-ink-2">
          {url}
        </code>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copiar(url, 'url')}>
          {copiado === 'url' ? 'Copiado' : 'Copiar'}
        </Button>
      </div>

      {/*
        O Telegram é o único que exige um passo ativo: ninguém "cola" o endereço
        num painel, é uma chamada à API do bot. Sem o comando pronto, essa é a
        etapa em que a configuração trava.
      */}
      {canal === 'telegram' ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-2xs text-ink-2">
            curl &quot;https://api.telegram.org/bot&lt;TOKEN&gt;/setWebhook?url={url}&quot;
          </code>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              void copiar(
                `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=${url}"`,
                'curl',
              )
            }
          >
            {copiado === 'curl' ? 'Copiado' : 'Copiar'}
          </Button>
        </div>
      ) : null}

      <p className="text-2xs text-pending">{texto.porque}</p>
    </div>
  )
}
