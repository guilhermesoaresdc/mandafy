'use client'

import { useId, type KeyboardEvent } from 'react'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, type Channel } from '@/db/schema/enums'
import { cn } from '@/lib/utils'
import { ChannelIcon } from './channel-icon'

type ChannelPadProps = {
  channel: Channel
  on: boolean
  onChange?: (on: boolean) => void
  disabled?: boolean
  label?: string
  className?: string
}

/**
 * O pad de canal (§11.4) — o controle mais importante da interface.
 *
 * Não é um toggle: é um pad iluminado. O visual vem de `.pad` em globals.css,
 * incluindo o `filter: grayscale(1)` que apaga o pad de verdade quando
 * desligado, em vez de só clareá-lo.
 *
 * Acessibilidade é obrigatória aqui (§11.4):
 *  - `role="switch"` + `aria-checked` para leitores de tela;
 *  - Espaço E Enter alternam o estado;
 *  - o ponto ○ / ◉ e a borda tracejada comunicam o estado sem depender de cor.
 *
 * Sem `onChange` o pad é apenas leitura (nem foco, nem clique).
 */
export function ChannelPad({
  channel,
  on,
  onChange,
  disabled = false,
  label,
  className,
}: ChannelPadProps) {
  const id = useId()
  const readOnly = !onChange
  const texto = label ?? CHANNEL_LABELS[channel]

  function toggle() {
    if (disabled || readOnly) return
    onChange?.(!on)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // O navegador já dispara click no Enter para <button>, mas não na Barra de
    // espaço em todos os casos — e role="switch" exige as duas.
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      toggle()
    }
  }

  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      aria-label={`${texto}: ${on ? 'ligado' : 'desligado'}`}
      aria-readonly={readOnly || undefined}
      disabled={disabled}
      tabIndex={readOnly ? -1 : 0}
      data-on={on}
      data-channel={channel}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      // --ch é lida pelo CSS do .pad para colorir borda, fundo e halo.
      style={{ ['--ch' as string]: `var(${CHANNEL_COLOR_VAR[channel]})` }}
      className={cn('pad select-none', readOnly && 'cursor-default', className)}
    >
      <span className="dot" aria-hidden="true" />
      <ChannelIcon channel={channel} className="size-4" aria-hidden="true" />
      <span className="text-xs font-medium">{texto}</span>
    </button>
  )
}

type ChannelPadGroupProps = {
  /** Estado de cada canal. Canal ausente conta como desligado. */
  value: Partial<Record<Channel, boolean>>
  onChange?: (channel: Channel, on: boolean) => void
  disabled?: boolean
  className?: string
  /** Ordem de exibição. Padrão: a ordem canônica dos canais. */
  channels?: readonly Channel[]
}

/** A linha de quatro pads, como aparece no editor de mensagem e nos fluxos. */
export function ChannelPadGroup({
  value,
  onChange,
  disabled,
  className,
  channels = ['whatsapp', 'email', 'sms', 'telegram'],
}: ChannelPadGroupProps) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="group" aria-label="Canais">
      {channels.map((channel) => (
        <ChannelPad
          key={channel}
          channel={channel}
          on={value[channel] ?? false}
          disabled={disabled}
          onChange={onChange ? (on) => onChange(channel, on) : undefined}
        />
      ))}
    </div>
  )
}
