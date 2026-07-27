'use client'

import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { sairAction } from '@/lib/auth/actions'
import { USER_ROLE_LABELS, type UserRole } from '@/db/schema/enums'
import { cn } from '@/lib/utils'
import { LogoutIcon } from './icons'

type UserMenuProps = {
  name: string
  email: string
  role: UserRole
  orgName: string
}

export function UserMenu({ name, email, role, orgName }: UserMenuProps) {
  const iniciais = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left',
          'transition-colors hover:bg-surface-2',
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-live-soft text-2xs font-semibold text-live"
        >
          {iniciais}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-2xs font-medium text-ink">{name}</span>
          <span className="block truncate text-2xs text-pending">{USER_ROLE_LABELS[role]}</span>
        </span>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 w-56 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-xl"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-2xs font-medium text-ink">{email}</p>
            <p className="truncate text-2xs text-pending">{orgName}</p>
          </div>

          <DropdownMenu.Separator className="my-1 h-px bg-line" />

          <DropdownMenu.Item asChild>
            <form action={sairAction}>
              <button
                type="submit"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-2xs',
                  'text-ink-2 outline-none transition-colors hover:bg-surface-2 hover:text-ink',
                )}
              >
                <LogoutIcon className="size-3.5" aria-hidden="true" />
                Sair
              </button>
            </form>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
