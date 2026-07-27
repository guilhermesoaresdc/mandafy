'use client'

import { useState } from 'react'
import { ChannelPadGroup } from '@/components/ui'
import type { Channel } from '@/db/schema/enums'

/**
 * Demonstração viva dos pads de canal (§11.4) enquanto o CRUD de mensagens
 * não existe. TODO Fase 3: o estado vem de `message_variants.enabled` e a
 * mudança é uma Server Action com atualização otimista (§13.2).
 *
 * O padrão de §5.1: SMS desligado por padrão nas mensagens de relacionamento,
 * porque é o canal mais caro (§8.4).
 */
export function PadDemo() {
  const [canais, setCanais] = useState<Partial<Record<Channel, boolean>>>({
    whatsapp: true,
    email: true,
    sms: false,
    telegram: true,
  })

  return (
    <ChannelPadGroup
      value={canais}
      onChange={(channel, on) => setCanais((atual) => ({ ...atual, [channel]: on }))}
    />
  )
}
