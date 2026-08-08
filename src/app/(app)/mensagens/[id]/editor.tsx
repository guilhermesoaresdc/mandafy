'use client'

import { useActionState, useEffect, useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
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
import { SeletorDeVariaveis, inserirNoCursor } from '@/components/mensagens/variaveis'
import { nomeDoCampo } from '@/lib/vocabulario'
import { analisar } from '@/lib/messages/analise'
import { compilar, variaveisDoCorpo } from '@/lib/messages/compile'
import { CONTATO_EXEMPLO } from '@/lib/messages/exemplo'
import { amostras, contarCombinacoes, sementeDeTexto } from '@/lib/messages/spintax'
import { corpoEfetivo } from '@/lib/messages/sync'
import { cn } from '@/lib/utils'
import {
  ressincronizarAction,
  salvarCorpoAction,
  salvarVarianteAction,
  type MensagemState,
} from '../actions'
import { EnviarTeste } from './enviar-teste'
import { PadCanalMensagem } from './pad-canal'
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
  const campoRef = useRef<HTMLTextAreaElement | null>(null)

  /** Insere a variável onde o cursor parou, e devolve o foco ao texto. */
  function inserirVariavel(trecho: string): void {
    const { proximo, cursor } = inserirNoCursor(campoRef.current, trecho, corpo)
    setCorpo(proximo)

    requestAnimationFrame(() => {
      const campo = campoRef.current
      if (!campo) return
      campo.focus()
      campo.setSelectionRange(cursor, cursor)
    })
  }

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

  /*
   * A prévia compila o que CADA CANAL vai mandar, e não o corpo principal
   * quatro vezes.
   *
   * A diferença aparecia no dinheiro. O contador de SMS media o texto
   * principal, sem a opção "remover acentuação" que a caixa ao lado dele
   * mostrava marcada — então ele pintava "3 segmentos" em vermelho para uma
   * mensagem que sairia em 1, e a pessoa que marcava a caixa não via o número
   * mudar. Uma opção que não move o contador parece uma opção que não funciona.
   *
   * `corpoEfetivo` é a mesma função que o envio usa: variante customizada tem
   * texto próprio, variante sincronizada segue o principal.
   */
  const compilacoes = useMemo(() => {
    const saida = {} as Record<Channel, ReturnType<typeof compilar>>

    for (const canal of CHANNELS) {
      const variante = porCanal.get(canal)

      saida[canal] = compilar(corpoEfetivo(corpo, variante ?? null), {
        canal,
        dados: CONTATO_EXEMPLO,
        previa: true,
        semente,
        preheader: variante?.preheader ?? null,
        ...(canal === 'sms'
          ? { sms: { removerAcentuacao: variante?.stripAccents ?? false } }
          : {}),
      })
    }

    return saida
  }, [corpo, semente, porCanal])

  const avisos = useMemo(() => analisar(corpo), [corpo])
  const usadas = useMemo(() => variaveisDoCorpo(corpo), [corpo])
  const combinacoes = useMemo(() => contarCombinacoes(corpo), [corpo])
  const exemplos = useMemo(() => (combinacoes > 1 ? amostras(corpo) : []), [corpo, combinacoes])

  const desconhecidas = usadas.filter((v) => !(v in CONTATO_EXEMPLO))
  const emailVariante = porCanal.get('email')

  /**
   * O cabeçalho e o formulário de ajuste de um canal.
   *
   * O selo "customizado" fica visível SEM abrir: é a informação que muda o
   * significado da prévia — uma versão customizada não acompanha mais o texto
   * comum, e quem não sabe disso edita o texto principal e não entende por que
   * aquele canal não mudou.
   */
  function slotsDoCanal(canal: Channel) {
    const variante = porCanal.get(canal)
    const aberto = canalAberto === canal

    return {
      acoes: (
        <>
          {variante && !variante.synced ? <Badge tone="pending">customizado</Badge> : null}
          <button
            type="button"
            onClick={() => setCanalAberto(aberto ? null : canal)}
            aria-expanded={aberto}
            className="rounded-md px-1.5 py-0.5 text-2xs text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {aberto ? 'Fechar' : 'Ajustar'}
          </button>
        </>
      ),
      abaixo: aberto ? (
        <VarianteForm
          mensagemId={mensagem.id}
          corpoPrincipal={corpo}
          variante={variante}
          canal={canal}
        />
      ) : null,
    }
  }
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
      </form>

      {/*
        A prévia ficou FORA do formulário, e precisa ficar.

        O ajuste de cada canal abre dentro da prévia e tem o próprio `<form>`.
        Formulário dentro de formulário é HTML inválido: o navegador não define
        qual dos dois um botão de submit aciona, e o risco concreto era "Salvar
        esta versão" disparar o salvamento da mensagem inteira — gravando o
        texto comum e descartando o ajuste que a pessoa acabou de escrever.

        Nada se perde: todos os campos que submetem estão no cartão acima, e o
        botão de salvar se liga ao formulário pelo `id` (atributo `form`), que
        é para isso que ele existe.
      */}

      {/* ── Corpo + prévia ── */}
      {/*
        `min-w-0` nas duas colunas, e `minmax(0,1fr)` na trilha.

        Abaixo de `lg` a grade tem uma coluna só, de tamanho `auto` — e o
        mínimo de uma trilha `auto` é o min-content dos itens, não zero. O item
        de grade também nasce com `min-width: auto`. Resultado: quem tivesse um
        filho que se recusasse a encolher (aqui, a caixa de texto) empurrava a
        coluna para além da tela, e o painel do quadro virava um rolador
        horizontal de 221px. O cartão "O texto" ficava mais largo que o
        aparelho e o texto era cortado no meio da palavra.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex min-w-0 flex-col gap-3">
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
                  ref={campoRef}
                  value={corpo}
                  onChange={(e) => setCorpo(e.target.value)}
                  rows={12}
                  spellCheck
                  placeholder={
                    'Oi {{nome|"tudo bem"}}! O PIX de {{valor_cents|moeda}} da sua aposta\nem *{{palpite}}* ainda não caiu.\n\nO {{sorteio}} fecha às {{fecha_em|hora}}: {{link_pagamento}}'
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
              <CardBody className="flex flex-col gap-3">
                {/*
                  O QUE ESTÁ NO TEXTO, PELO NOME.

                  Antes esta lista mostrava `valor_cents`, `fecha_em`,
                  `retorno_cents` — o identificador do banco. Quem escreve a
                  mensagem é quem toca a banca, e para essa pessoa
                  `retorno_cents` é um enigma cujo significado só existe no
                  código-fonte. O código continua ali, em cinza, porque é ele
                  que aparece no texto; o que muda é qual dos dois é a resposta.
                */}
                {usadas.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {usadas.map((v) => (
                      <span
                        key={v}
                        title={v}
                        className={cn(
                          'inline-flex items-baseline gap-1 rounded border px-1.5 py-0.5 text-2xs',
                          v in CONTATO_EXEMPLO ? 'border-line text-ink-2' : 'border-fail text-fail',
                        )}
                      >
                        {nomeDoCampo(v)}
                        <code className="font-mono text-pending">{v}</code>
                      </span>
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

                <SeletorDeVariaveis
                  aoInserir={inserirVariavel}
                  usadas={usadas}
                  compacto
                />
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
              {/*
                Cada prévia vem com o próprio botão de ajuste. Editar só o
                assunto do e-mail, ou só o texto do SMS, sempre foi possível
                (§6.1) — mas o controle morava num cartão no fim da página, e
                quem via o problema na prévia não tinha como suspeitar disso.
              */}
              <PreviaWhatsapp
                compilacao={compilacoes.whatsapp}
                {...slotsDoCanal('whatsapp')}
              />
              <PreviaTelegram
                compilacao={compilacoes.telegram}
                {...slotsDoCanal('telegram')}
              />
              <PreviaEmail
                compilacao={compilacoes.email}
                assunto={emailVariante?.subject ?? nome}
                preheader={emailVariante?.preheader ?? ''}
                {...slotsDoCanal('email')}
              />
              <PreviaSms compilacao={compilacoes.sms} {...slotsDoCanal('sms')} />
            </CardBody>
          </Card>
        </div>

      <div className="flex items-center gap-3">
          <Button type="submit" form={`${corpoId}-form`} disabled={salvando || !alterado}>
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
                <PadCanalMensagem
                  key={canal}
                  messageId={mensagem.id}
                  canal={canal}
                  ligado={variante?.enabled ?? false}
                />
              )
            })}
          </div>

          {/*
            Só os pads aqui. O ajuste de cada versão mora na prévia daquele
            canal — havia duas portas para a mesma coisa, e a de baixo era a
            que ninguém achava.
          */}
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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

        {/*
          Uma coluna: o formulário agora abre DENTRO da prévia, que tem metade
          da largura do painel. Assunto e pré-cabeçalho lado a lado ali viram
          duas caixas onde não cabe um assunto de e-mail.
        */}
        {canal === 'email' ? (
          <div className="flex min-w-0 flex-col gap-3">
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
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
              <input
                type="checkbox"
                name="removerAcentos"
                defaultChecked={variante.stripAccents}
                className="size-3 accent-ink"
              />
              Remover acentuação (corta o custo pela metade)
            </label>
            {/*
              Desligada, e dizendo por quê.

              A caixa vinha marcada por padrão, gravava no banco e não mudava
              nada: o encurtador de §6.4 ainda não existe, e ninguém alimenta o
              gancho que o renderizador oferece. Uma opção que promete cortar o
              custo e não corta é pior que uma opção ausente — a pessoa marca,
              continua pagando o link inteiro e para de procurar onde o dinheiro
              está indo. O valor guardado é preservado para quando o serviço
              existir.
            */}
            <label className="flex items-center gap-1.5 text-2xs text-pending">
              <input
                type="checkbox"
                name="encurtarLinks"
                defaultChecked={variante.linkShorten}
                disabled
                className="size-3 accent-ink"
              />
              Encurtar links — ainda não disponível
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
            rows={8}
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
