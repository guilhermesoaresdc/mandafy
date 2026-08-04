'use client'

import { useState, type ReactNode } from 'react'
import { Badge, Card, CardBody, ChannelIcon } from '@/components/ui'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, type Channel } from '@/db/schema/enums'
import { AlternarCanal } from './alternar'

/**
 * O cartão de um canal (§11.4, §11.7).
 *
 * A regra da tela é: canal resolvido não pede atenção.
 *
 * Antes, os quatro cartões mostravam tudo ao mesmo tempo — endereço de avisos,
 * instruções do provedor, formulário de credencial — mesmo os que já estavam
 * configurados e ligados havia semanas. O resultado era uma tela em que a
 * informação que importa (qual canal está fora do ar) se perdia no meio da que
 * só importa uma vez.
 *
 * Configurado e ligado colapsa para uma linha: ícone, nome, selo e o botão de
 * desligar. O resto continua ali, atrás de "Ajustes", a um clique. Nada foi
 * removido — só deixou de gritar.
 *
 * Canal SEM configuração continua aberto, porque aí a informação ainda é
 * necessária: é o único estado em que a pessoa precisa fazer alguma coisa.
 */
export function CartaoCanal({
  canal,
  provider,
  configurado,
  ativo,
  descricao,
  /** Aparece sempre, colapsado ou não — é o estado operacional do canal. */
  resumo,
  /** Endereço de avisos, credenciais: só quando expandido. */
  ajustes,
  /** Conteúdo próprio do canal (os números do WhatsApp), sempre visível. */
  children,
}: {
  canal: Channel
  provider: string | null
  configurado: boolean
  ativo: boolean
  descricao: string
  resumo?: ReactNode
  ajustes: ReactNode
  children?: ReactNode
}) {
  /*
   * Pronto = configurado E ligado. Um canal configurado mas desligado continua
   * aberto de propósito: alguém o desligou e provavelmente vai querer mexer.
   */
  const pronto = configurado && ativo
  const [aberto, setAberto] = useState(!pronto)

  return (
    /*
     * `min-w-0` no CARTÃO, que é o item do grid: um item de grid nasce com
     * `min-width: auto` e se recusa a encolher abaixo do conteúdo. Sem isto, o
     * endereço de avisos — uma URL longa numa linha só — empurrava o cartão
     * para fora da própria coluna. Pôr no corpo não resolve: quem não encolhe
     * é o item, não o filho dele.
     */
    <Card className="min-w-0">
      <CardBody className="flex min-w-0 flex-col gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: `color-mix(in oklab, var(${CHANNEL_COLOR_VAR[canal]}) 12%, transparent)`,
              color: `var(${CHANNEL_COLOR_VAR[canal]})`,
            }}
          >
            <ChannelIcon channel={canal} className="size-4.5" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium text-ink">{CHANNEL_LABELS[canal]}</p>
              {configurado ? (
                ativo ? (
                  <Badge tone="ok">ligado</Badge>
                ) : (
                  <Badge tone="pending">desligado</Badge>
                )
              ) : (
                <Badge tone="pending">sem configuração</Badge>
              )}
              {provider ? (
                <span className="font-mono text-2xs text-pending">via {provider}</span>
              ) : null}
            </div>

            {/*
              A descrição é orientação de primeira vez. Some quando o canal já
              está resolvido — quem configurou o e-mail não precisa reler sobre
              SPF toda vez que abre a tela.
            */}
            {aberto ? <p className="mt-1 text-2xs text-ink-2">{descricao}</p> : null}
            {resumo ? <div className="mt-1">{resumo}</div> : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {configurado ? <AlternarCanal canal={canal} ativo={ativo} /> : null}

            <button
              type="button"
              onClick={() => setAberto((v) => !v)}
              aria-expanded={aberto}
              className="rounded-md px-2 py-1 text-2xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {aberto ? 'Ocultar' : 'Ajustes'}
            </button>
          </div>
        </div>

        {aberto ? ajustes : null}

        {children}
      </CardBody>
    </Card>
  )
}
