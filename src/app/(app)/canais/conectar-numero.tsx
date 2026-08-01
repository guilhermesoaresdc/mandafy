'use client'

/* eslint-disable @next/next/no-img-element -- o QR chega como data URI da Evolution; next/image não serve. */

import { useActionState, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Button, Card, CardBody, Field, Input, fieldDescriptionId } from '@/components/ui'
import {
  conectarNumeroAction,
  criarInstanciaAction,
  qrDaInstanciaAction,
  type CanalState,
  type EstadoQr,
  type NovaInstanciaState,
} from './actions'

/**
 * Conectar um número de WhatsApp (§7.3).
 *
 * Dois caminhos, e o primeiro é o que quase todo mundo quer: dar um nome ao
 * chip, ler o QR aqui na tela e pronto. O segundo — colar credenciais de uma
 * instância que já existe — continua porque quem já roda uma Evolution para
 * outra operação não deveria precisar recriar nada.
 *
 * O aviso sobre o número principal do negócio fica na tela, não escondido numa
 * documentação: a spec é direta sobre isso (§14.2), e um número banido
 * raramente volta.
 */
export function ConectarNumero({ servidorPronto }: { servidorPronto: boolean }) {
  const [modo, setModo] = useState<'fechado' | 'qr' | 'colar'>('fechado')

  if (modo === 'fechado') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setModo('qr')}>
          Conectar por QR Code
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setModo('colar')}>
          Colar credenciais
        </Button>
      </div>
    )
  }

  return modo === 'qr' ? (
    <ConectarPorQr servidorPronto={servidorPronto} onFechar={() => setModo('fechado')} />
  ) : (
    <ColarCredenciais onFechar={() => setModo('fechado')} />
  )
}

const AVISO = (
  <p className="rounded-lg border border-line px-3 py-2 text-2xs text-ink-2">
    O número começa no estágio <strong>Novo</strong>: 20 mensagens por dia, uma a cada 60 segundos.
    Ele sobe sozinho conforme se comporta bem — e desce se começar a falhar.
    <span className="mt-1 block text-pending">
      Não use o número principal do negócio para automação. A Evolution não é a API oficial da Meta,
      e um número banido raramente volta.
    </span>
  </p>
)

// ── Caminho do QR ────────────────────────────────────────────────────────────

function ConectarPorQr({
  servidorPronto,
  onFechar,
}: {
  servidorPronto: boolean
  onFechar: () => void
}) {
  const [estado, criar, criando] = useActionState<NovaInstanciaState, FormData>(
    criarInstanciaAction,
    {},
  )
  const nomeId = useId()

  if (estado.instanciaId) {
    return <LeitorDeQr instanciaId={estado.instanciaId} onFechar={onFechar} />
  }

  return (
    <Card>
      <CardBody>
        <form action={criar} className="flex max-w-md flex-col gap-3">
          <Field
            label="Como você chama esse número"
            htmlFor={nomeId}
            hint="Ex.: Chip 1, Atendimento, Recuperação"
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={nomeId}
              name="nome"
              required
              autoFocus
              maxLength={80}
              aria-describedby={fieldDescriptionId(nomeId)}
            />
          </Field>

          {servidorPronto ? null : (
            <p className="rounded-lg border border-fail/40 px-3 py-2 text-2xs text-fail">
              Falta o endereço da Evolution e a chave global. Preencha em{' '}
              <strong>Configurar</strong>, no cartão do WhatsApp acima.
            </p>
          )}

          {AVISO}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={criando || !servidorPronto}>
              {criando ? 'Criando…' : 'Gerar QR Code'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onFechar}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}

/**
 * Mostra o QR e fica perguntando à Evolution se já conectou.
 *
 * O laço existe apesar do webhook: a entrega do `connection.update` é
 * best-effort e passa por rede que não controlamos. Uma tela que depende só
 * dele fica girando para sempre quando o evento se perde — e a pessoa já leu o
 * código, então o sistema estaria mentindo sobre o próprio estado.
 *
 * O QR do WhatsApp expira em ~20 s e a Evolution gera outro. Perguntar a cada
 * 3 s acompanha essa rotação sem pesar.
 */
export function LeitorDeQr({
  instanciaId,
  onFechar,
}: {
  instanciaId: string
  onFechar: () => void
}) {
  const [qr, setQr] = useState<EstadoQr>({ estado: 'aguardando' })
  const parar = useRef(false)

  const buscar = useCallback(async () => {
    const proximo = await qrDaInstanciaAction(instanciaId)
    if (parar.current) return
    setQr(proximo)
    if (proximo.estado === 'conectado' || proximo.estado === 'erro') parar.current = true
  }, [instanciaId])

  useEffect(() => {
    parar.current = false
    void buscar()

    const relogio = setInterval(() => {
      if (parar.current) return
      void buscar()
    }, 3000)

    return () => {
      parar.current = true
      clearInterval(relogio)
    }
  }, [buscar])

  // Conectado: a página precisa recarregar para o painel de saúde refletir o
  // número novo. `location.reload` em vez de router.refresh porque o estado
  // desta árvore inteira (a instância recém-criada) deixou de ser relevante.
  useEffect(() => {
    if (qr.estado !== 'conectado') return
    const t = setTimeout(() => window.location.reload(), 1200)
    return () => clearTimeout(t)
  }, [qr.estado])

  return (
    <Card>
      <CardBody className="flex flex-col items-center gap-3">
        {qr.estado === 'conectado' ? (
          <>
            <p className="text-xs font-medium text-ok">Conectado.</p>
            <p className="text-2xs text-ink-2">Atualizando o painel…</p>
          </>
        ) : qr.estado === 'erro' ? (
          <>
            <p className="text-xs font-medium text-fail">{qr.erro}</p>
            <Button variant="ghost" size="sm" onClick={onFechar}>
              Fechar
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-ink">Leia com o WhatsApp do celular</p>
            <p className="max-w-xs text-center text-2xs text-ink-2">
              No aparelho: <strong>Configurações → Aparelhos conectados → Conectar aparelho</strong>
              .
            </p>

            <div className="flex size-56 items-center justify-center rounded-lg border border-line bg-white">
              {qr.estado === 'qr' && qr.base64 ? (
                <img
                  src={qr.base64.startsWith('data:') ? qr.base64 : `data:image/png;base64,${qr.base64}`}
                  alt="QR Code para conectar o WhatsApp"
                  className="size-52"
                />
              ) : (
                <span className="text-2xs text-pending">gerando o código…</span>
              )}
            </div>

            {qr.pairingCode ? (
              <p className="text-2xs text-ink-2">
                Ou digite o código{' '}
                <span className="font-mono text-ink">{qr.pairingCode}</span> no celular.
              </p>
            ) : null}

            <p className="text-2xs text-pending">
              O código muda sozinho a cada poucos segundos. Deixe esta tela aberta.
            </p>

            <Button type="button" variant="ghost" size="sm" onClick={onFechar}>
              Fechar
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  )
}

// ── Caminho das credenciais coladas ──────────────────────────────────────────

function ColarCredenciais({ onFechar }: { onFechar: () => void }) {
  const [estado, conectar, conectando] = useActionState<CanalState, FormData>(
    conectarNumeroAction,
    {},
  )

  const nomeId = useId()
  const urlId = useId()
  const instanciaId = useId()
  const apikeyId = useId()
  const telefoneId = useId()

  return (
    <Card>
      <CardBody>
        <form action={conectar} className="flex flex-col gap-3">
          <p className="text-2xs text-ink-2">
            Para uma instância que <strong>já existe</strong> na sua Evolution. O Mandafy passa a
            enviar por ela, mas nunca a apaga do servidor — outro sistema pode depender dela.
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label="Como você chama esse número"
              htmlFor={nomeId}
              hint="Ex.: Chip 1, Atendimento, Recuperação"
            >
              <Input
                id={nomeId}
                name="nome"
                required
                autoFocus
                maxLength={80}
                aria-describedby={fieldDescriptionId(nomeId)}
              />
            </Field>

            <Field label="Telefone (opcional)" htmlFor={telefoneId} hint="Só para você reconhecer.">
              <Input
                id={telefoneId}
                name="telefone"
                maxLength={30}
                placeholder="(11) 98888-7777"
                aria-describedby={fieldDescriptionId(telefoneId)}
              />
            </Field>

            <Field
              label="Endereço da Evolution"
              htmlFor={urlId}
              hint="Fixe a versão da imagem em v2.x.x — nunca latest."
            >
              <Input
                id={urlId}
                name="evolutionUrl"
                required
                type="url"
                placeholder="https://evolution.seudominio.com.br"
                className="font-mono"
                aria-describedby={fieldDescriptionId(urlId)}
              />
            </Field>

            <Field
              label="Nome da instância"
              htmlFor={instanciaId}
              hint="Como ela aparece na Evolution."
            >
              <Input
                id={instanciaId}
                name="instanceName"
                required
                maxLength={80}
                className="font-mono"
                aria-describedby={fieldDescriptionId(instanciaId)}
              />
            </Field>
          </div>

          <Field
            label="apikey da instância"
            htmlFor={apikeyId}
            hint="Guardada cifrada. Nunca volta para a tela."
            {...(estado.erro ? { error: estado.erro } : {})}
          >
            <Input
              id={apikeyId}
              name="apikey"
              required
              type="password"
              autoComplete="off"
              maxLength={500}
              className="font-mono"
              aria-describedby={fieldDescriptionId(apikeyId)}
            />
          </Field>

          {AVISO}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={conectando}>
              {conectando ? 'Conectando…' : 'Conectar'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onFechar}>
              Cancelar
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )
}
