'use client'

import { useActionState, useEffect, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ChannelPad,
  Field,
  Input,
  Separator,
  fieldDescriptionId,
} from '@/components/ui'
import {
  CHANNELS,
  MESSAGE_CATEGORIES,
  MESSAGE_CATEGORY_LABELS,
  type Channel,
} from '@/db/schema/enums'
import { analisar } from '@/lib/messages/analise'
import { compilarTodos, variaveisDoCorpo } from '@/lib/messages/compile'
import { CONTATO_EXEMPLO, VARIAVEIS_DISPONIVEIS } from '@/lib/messages/exemplo'
import { amostras, contarCombinacoes, sementeDeTexto } from '@/lib/messages/spintax'
import { corpoEfetivo } from '@/lib/messages/sync'
import { cn } from '@/lib/utils'
import {
  alternarCanalAction,
  ressincronizarAction,
  salvarCorpoAction,
  salvarVarianteAction,
  type MensagemState,
} from '../actions'
import { EnviarTeste } from './enviar-teste'
import { PreviaEmail, PreviaSms, PreviaTelegram, PreviaWhatsapp } from './previa'

/**
 * Editor de mensagem (§6).
 *
 * É um dos poucos componentes de cliente autorizados por §13.2, e por um motivo
 * concreto: a prévia das quatro saídas precisa acompanhar a digitação. Compilar
 * no servidor a cada tecla trocaria uma prévia instantânea por uma ida e volta
 * de rede — e a prévia é o produto aqui.
 *
 * O compilador é o MESMO que o worker usa na entrega. Se a prévia mostrasse
 * outra coisa, ela não valeria nada.
 */

export type VarianteEditavel = {
  channel: Channel
  enabled: boolean
  synced: boolean
  body: string | null
  subject: string | null
  preheader: string | null
  stripAccents: boolean
  linkShorten: boolean
}

export type MensagemEditavel = {
  id: string
  key: string
  name: string
  category: (typeof MESSAGE_CATEGORIES)[number]
  body: string
  ignoreQuietHours: boolean
  active: boolean
}

const DICAS = [
  ['**negrito**', 'negrito'],
  ['*itálico*', 'itálico'],
  ['~riscado~', 'riscado'],
  ['[texto](link)', 'link'],
  ['{{nome}}', 'variável'],
  ['{Oi|Olá}', 'variação'],
] as const

export function EditorMensagem({
  mensagem,
  variantes,
}: {
  mensagem: MensagemEditavel
  variantes: VarianteEditavel[]
}) {
  const [corpo, setCorpo] = useState(mensagem.body)
  const [nome, setNome] = useState(mensagem.name)
  const [chave, setChave] = useState(mensagem.key)
  const [categoria, setCategoria] = useState(mensagem.category)
  const [ignorarSilencio, setIgnorarSilencio] = useState(mensagem.ignoreQuietHours)
  const [canalAberto, setCanalAberto] = useState<Channel | null>(null)

  const [estado, salvar, salvando] = useActionState<MensagemState, FormData>(salvarCorpoAction, {})

  const corpoId = useId()
  const nomeId = useId()
  const chaveId = useId()

  const porCanal = useMemo(
    () => new Map(variantes.map((v) => [v.channel, v])),
    [variantes],
  )

  /*
   * Semente fixa a partir do texto: a prévia não pode ficar sorteando spintax a
   * cada tecla digitada — o texto pularia embaixo do olho de quem escreve. Em
   * envio real a semente é livre, e cada destinatário recebe uma combinação.
   */
  const semente = useMemo(() => sementeDeTexto(corpo), [corpo])

  const compilacoes = useMemo(
    () => compilarTodos(corpo, { dados: CONTATO_EXEMPLO, previa: true, semente }),
    [corpo, semente],
  )

  const avisos = useMemo(() => analisar(corpo), [corpo])
  const usadas = useMemo(() => variaveisDoCorpo(corpo), [corpo])
  const combinacoes = useMemo(() => contarCombinacoes(corpo), [corpo])
  const exemplos = useMemo(() => (combinacoes > 1 ? amostras(corpo) : []), [corpo, combinacoes])

  const desconhecidas = usadas.filter((v) => !(v in CONTATO_EXEMPLO))
  const emailVariante = porCanal.get('email')
  const alterado =
    corpo !== mensagem.body ||
    nome !== mensagem.name ||
    chave !== mensagem.key ||
    categoria !== mensagem.category ||
    ignorarSilencio !== mensagem.ignoreQuietHours

  // Ctrl/⌘+Enter salva sem tirar a mão do teclado — quem escreve copy fica aqui.
  useEffect(() => {
    function atalho(evento: KeyboardEvent) {
      if ((evento.metaKey || evento.ctrlKey) && evento.key === 'Enter') {
        evento.preventDefault()
        document.getElementById(`${corpoId}-form`)?.dispatchEvent(
          new Event('submit', { cancelable: true, bubbles: true }),
        )
      }
    }
    window.addEventListener('keydown', atalho)
    return () => window.removeEventListener('keydown', atalho)
  }, [corpoId])

  return (
    <div className="flex flex-col gap-4">
      <form id={`${corpoId}-form`} action={salvar} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={mensagem.id} />
        <input type="hidden" name="corpo" value={corpo} />
        <input type="hidden" name="categoria" value={categoria} />
        {ignorarSilencio ? <input type="hidden" name="ignorarSilencio" value="on" /> : null}

        {/* ── Identidade ── */}
        <Card>
          <CardBody className="grid gap-3 md:grid-cols-2">
            <Field label="Nome da mensagem" htmlFor={nomeId}>
              <Input
                id={nomeId}
                name="nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                maxLength={80}
                required
              />
            </Field>

            <Field
              label="Chave"
              htmlFor={chaveId}
              hint="Como a API se refere a esta mensagem. Letras minúsculas, números e _."
            >
              <Input
                id={chaveId}
                name="chave"
                value={chave}
                onChange={(e) => setChave(e.target.value)}
                maxLength={60}
                pattern="[a-z][a-z0-9_]*"
                className="font-mono"
                aria-describedby={fieldDescriptionId(chaveId)}
              />
            </Field>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-2xs font-medium text-ink-2">Tipo</legend>
              <div className="flex flex-wrap gap-2">
                {MESSAGE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoria(c)}
                    aria-pressed={categoria === c}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-2xs',
                      categoria === c ? 'border-ink text-ink' : 'border-line text-ink-2',
                    )}
                  >
                    {MESSAGE_CATEGORY_LABELS[c]}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="flex cursor-pointer items-start gap-2 self-end pb-1">
              <input
                type="checkbox"
                checked={ignorarSilencio}
                onChange={(e) => setIgnorarSilencio(e.target.checked)}
                className="mt-0.5 size-3 accent-ink"
              />
              <span className="text-2xs text-ink-2">
                Pode sair de madrugada
                <span className="block text-pending">
                  Só para aviso que a pessoa está esperando — pagamento confirmado, bilhete premiado.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        {/* ── Corpo + prévia ── */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader>
                <CardTitle>O texto</CardTitle>
                <span className="text-2xs text-pending">
                  {combinacoes > 1 ? `${combinacoes} combinações` : 'sem variação'}
                </span>
              </CardHeader>
              <CardBody className="flex flex-col gap-2">
                <label htmlFor={corpoId} className="sr-only">
                  Corpo da mensagem
                </label>
                <textarea
                  id={corpoId}
                  value={corpo}
                  onChange={(e) => setCorpo(e.target.value)}
                  rows={12}
                  spellCheck
                  placeholder={
                    'Oi {{nome|"tudo bem"}}! Seu PIX de {{valor_cents|moeda}} para a campanha\n*{{campanha}}* ainda está aberto.\n\nFinaliza aqui: {{link_pagamento}}'
                  }
                  className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none placeholder:text-pending focus-visible:border-ink"
                />

                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {DICAS.map(([sintaxe, oque]) => (
                    <span key={sintaxe} className="text-2xs text-pending">
                      <code className="font-mono text-ink-2">{sintaxe}</code> {oque}
                    </span>
                  ))}
                </div>
              </CardBody>
            </Card>

            {avisos.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Antes de enviar</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-1.5">
                  {avisos.map((aviso, i) => (
                    <p
                      key={`${aviso.texto}-${i}`}
                      className={cn(
                        'text-2xs',
                        aviso.severidade === 'erro'
                          ? 'text-fail'
                          : aviso.severidade === 'atencao'
                            ? 'text-ink-2'
                            : 'text-pending',
                      )}
                    >
                      {aviso.canal ? (
                        <span className="font-medium">{aviso.canal}: </span>
                      ) : null}
                      {aviso.texto}
                    </p>
                  ))}
                </CardBody>
              </Card>
            ) : null}

            {exemplos.length > 1 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Como as variações saem</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-1.5">
                  {exemplos.map((exemplo, i) => (
                    <p key={i} className="truncate text-2xs text-ink-2">
                      {exemplo.split('\n')[0]}
                    </p>
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Variáveis</CardTitle>
              </CardHeader>
              <CardBody className="flex flex-col gap-2">
                {usadas.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {usadas.map((v) => (
                      <code
                        key={v}
                        className={cn(
                          'rounded border px-1.5 py-0.5 font-mono text-2xs',
                          v in CONTATO_EXEMPLO
                            ? 'border-line text-ink-2'
                            : 'border-fail text-fail',
                        )}
                      >
                        {v}
                      </code>
                    ))}
                  </div>
                ) : (
                  <p className="text-2xs text-pending">Nenhuma ainda.</p>
                )}

                {desconhecidas.length > 0 ? (
                  <p className="text-2xs text-fail">
                    Sem exemplo para {desconhecidas.join(', ')} — confira o nome ou combine esse
                    campo na plataforma.
                  </p>
                ) : null}

                <Separator />
                <details>
                  <summary className="cursor-pointer text-2xs text-ink-2">
                    Ver as disponíveis
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {VARIAVEIS_DISPONIVEIS.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setCorpo((atual) => `${atual}{{${v}}}`)}
                        className="rounded border border-line px-1.5 py-0.5 font-mono text-2xs text-ink-2 hover:border-ink hover:text-ink"
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </details>
              </CardBody>
            </Card>
          </div>

          {/* ── §6.6: as quatro saídas ao mesmo tempo ── */}
          <Card>
            <CardHeader>
              <CardTitle>As quatro versões</CardTitle>
              <span className="text-2xs text-pending">com um contato de exemplo</span>
            </CardHeader>
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <PreviaWhatsapp compilacao={compilacoes.whatsapp} />
              <PreviaTelegram compilacao={compilacoes.telegram} />
              <PreviaEmail
                compilacao={compilacoes.email}
                assunto={emailVariante?.subject ?? nome}
                preheader={emailVariante?.preheader ?? ''}
              />
              <PreviaSms compilacao={compilacoes.sms} />
            </CardBody>
          </Card>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={salvando || !alterado}>
            {salvando ? 'Salvando…' : 'Salvar mensagem'}
          </Button>
          {estado.error ? (
            <span role="alert" className="text-2xs text-fail">
              {estado.error}
            </span>
          ) : null}
          {estado.ok && !alterado ? <span className="text-2xs text-ok">Salvo.</span> : null}
          {alterado ? (
            <span className="text-2xs text-pending">⌘/Ctrl + Enter salva</span>
          ) : null}
        </div>
      </form>

      <EnviarTeste messageId={mensagem.id} />

      {/* ── Canais ── */}
      <Card>
        <CardHeader>
          <CardTitle>Por onde sai</CardTitle>
          <span className="text-2xs text-pending">
            Ligado acende na cor do canal; desligado apaga de verdade
          </span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((canal) => {
              const variante = porCanal.get(canal)
              return (
                <form key={canal} action={alternarCanalAction}>
                  <input type="hidden" name="id" value={mensagem.id} />
                  <input type="hidden" name="canal" value={canal} />
                  <input type="hidden" name="ligar" value={variante?.enabled ? '0' : '1'} />
                  <button type="submit" className="contents">
                    <ChannelPad channel={canal} on={variante?.enabled ?? false} onChange={() => {}} />
                  </button>
                </form>
              )
            })}
          </div>

          <Separator />

          <div className="flex flex-wrap gap-1">
            {CHANNELS.map((canal) => {
              const variante = porCanal.get(canal)
              return (
                <button
                  key={canal}
                  type="button"
                  onClick={() => setCanalAberto(canalAberto === canal ? null : canal)}
                  aria-expanded={canalAberto === canal}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-2xs',
                    canalAberto === canal ? 'border-ink text-ink' : 'border-line text-ink-2',
                  )}
                >
                  {canal}
                  {variante && !variante.synced ? <Badge tone="pending">customizado</Badge> : null}
                </button>
              )
            })}
          </div>

          {canalAberto ? (
            <VarianteForm
              mensagemId={mensagem.id}
              corpoPrincipal={corpo}
              variante={porCanal.get(canalAberto)}
              canal={canalAberto}
            />
          ) : (
            <p className="text-2xs text-pending">
              Todas as versões seguem o texto principal. Abra um canal para ajustar só ele.
            </p>
          )}
        </CardBody>
      </Card>

      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/mensagens">Voltar às mensagens</Link>
        </Button>
      </div>
    </div>
  )
}

/** Ajuste de uma variante — é o que a torna "customizada" (§6.1). */
function VarianteForm({
  mensagemId,
  corpoPrincipal,
  variante,
  canal,
}: {
  mensagemId: string
  corpoPrincipal: string
  variante: VarianteEditavel | undefined
  canal: Channel
}) {
  const [estado, salvar, salvando] = useActionState<MensagemState, FormData>(
    salvarVarianteAction,
    {},
  )
  const corpoId = useId()
  const assuntoId = useId()
  const preheaderId = useId()

  const efetivo = corpoEfetivo(corpoPrincipal, variante ?? null)
  const [texto, setTexto] = useState(efetivo)

  // Trocar de aba tem de trazer o texto daquele canal, não manter o anterior.
  useEffect(() => setTexto(efetivo), [canal, efetivo])

  if (!variante) return null

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <Badge tone={variante.synced ? 'ok' : 'pending'}>
          {variante.synced ? 'sincronizado' : 'customizado'}
        </Badge>
        <span className="text-2xs text-pending">
          {variante.synced
            ? 'Segue o texto principal. Editar aqui desliga essa ligação.'
            : 'Não recebe mais o texto principal.'}
        </span>

        {!variante.synced ? (
          <form action={ressincronizarAction} className="ml-auto">
            <input type="hidden" name="id" value={mensagemId} />
            <input type="hidden" name="canal" value={canal} />
            <Button type="submit" variant="ghost" size="sm">
              Ressincronizar
            </Button>
          </form>
        ) : null}
      </div>

      <form action={salvar} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={mensagemId} />
        <input type="hidden" name="canal" value={canal} />

        {canal === 'email' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Assunto" htmlFor={assuntoId}>
              <Input
                id={assuntoId}
                name="assunto"
                defaultValue={variante.subject ?? ''}
                maxLength={200}
              />
            </Field>
            <Field
              label="Pré-cabeçalho"
              htmlFor={preheaderId}
              hint="A linha que aparece depois do assunto na caixa de entrada."
            >
              <Input
                id={preheaderId}
                name="preheader"
                defaultValue={variante.preheader ?? ''}
                maxLength={200}
                aria-describedby={fieldDescriptionId(preheaderId)}
              />
            </Field>
          </div>
        ) : null}

        {canal === 'sms' ? (
          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
              <input
                type="checkbox"
                name="removerAcentos"
                defaultChecked={variante.stripAccents}
                className="size-3 accent-ink"
              />
              Remover acentuação (corta o custo pela metade)
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
              <input
                type="checkbox"
                name="encurtarLinks"
                defaultChecked={variante.linkShorten}
                className="size-3 accent-ink"
              />
              Encurtar links
            </label>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={corpoId} className="text-2xs font-medium text-ink-2">
            Texto só deste canal
          </label>
          <textarea
            id={corpoId}
            name="corpo"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={6}
            className="w-full resize-y rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus-visible:border-ink"
          />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" variant="secondary" disabled={salvando}>
            {salvando ? 'Salvando…' : 'Salvar esta versão'}
          </Button>
          {estado.error ? (
            <span role="alert" className="text-2xs text-fail">
              {estado.error}
            </span>
          ) : null}
          {estado.ok ? <span className="text-2xs text-ok">Salvo.</span> : null}
        </div>
      </form>
    </div>
  )
}
