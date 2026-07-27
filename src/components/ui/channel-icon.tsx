import type { SVGProps } from 'react'
import type { Channel } from '@/db/schema/enums'

/**
 * Ícones de canal como SVG inline.
 * Nenhuma biblioteca de ícones: importar uma inteira estoura o orçamento de
 * 120 KB de JS da rota inicial (§13.1, §13.2).
 */

type IconProps = SVGProps<SVGSVGElement>

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function WhatsappIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.5 8.5 0 0 1-4-1L3 20l1.2-5.3a8.4 8.4 0 0 1-1.1-4.2A8.4 8.4 0 0 1 11.6 3 8.4 8.4 0 0 1 21 11.5Z" />
      <path d="M8.9 8.3c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .6.5l.7 1.6c.1.3 0 .5-.1.7l-.4.4c-.1.2-.2.3 0 .6a6 6 0 0 0 2.6 2.3c.3.1.4 0 .6-.1l.5-.6c.2-.2.4-.2.6-.1l1.5.8c.3.2.4.3.4.5s0 .8-.3 1.2c-.3.4-1 .8-1.5.8-1.2.1-2.7-.5-4.2-1.7a10 10 0 0 1-2.6-3.4c-.4-1-.3-2 .1-2.6l.4-.4Z" />
    </svg>
  )
}

function EmailIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7 7.4 5.3c.7.5 1.5.5 2.2 0L20.5 7" />
    </svg>
  )
}

function SmsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.2 3.2a.5.5 0 0 1-.8-.4v-2.8H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z" />
      <path d="M7.5 11h.01M12 11h.01M16.5 11h.01" />
    </svg>
  )
}

function TelegramIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M21 5 3.6 11.4c-.7.2-.7.9 0 1.1l4.3 1.4L19 6.6c.3-.2.5.1.3.3l-8.8 8.3.3 4.4c.3 0 .5-.2.7-.4l2-2 4.2 3c.6.4 1.2.2 1.4-.6l2.6-12.5c.2-.9-.3-1.4-.7-1.1Z" />
    </svg>
  )
}

const ICONS: Record<Channel, (props: IconProps) => React.JSX.Element> = {
  whatsapp: WhatsappIcon,
  email: EmailIcon,
  sms: SmsIcon,
  telegram: TelegramIcon,
}

export function ChannelIcon({ channel, ...props }: IconProps & { channel: Channel }) {
  const Icon = ICONS[channel]
  return <Icon {...props} />
}
