import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { withTenant } from '@/db'
import { buscarFluxo } from '@/db/queries/flows'
import { listarMensagens } from '@/db/queries/messages'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, ChannelIcon } from '@/components/ui'
import { CHANNEL_LABELS, CHANNELS, type Channel } from '@/db/schema/enums'
import { prontidaoDosCanais } from '@/lib/delivery/prontidao'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { alternarFluxoAction } from '../actions'
import { descreverEvento } from '@/lib/vocabulario'
import { AdicionarPasso } from './adicionar-passo'
import { ConfigFluxo } from './config'
import { EditarPasso } from './editar-passo'

export const metadata: Metadata = { title: 'Fluxo · Mandafy' }
export const dynamic = 'force-dynamic'

export default async function FluxoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireAdmin()

  // As duas na mesma transação: a lista de mensagens alimenta o seletor de cada
  // passo, e abrir uma segunda conexão para ela seria outra ida ao banco por
  // uma tela que já é `force-dynamic`.
  const { completo, mensagens, prontidao } = await withTenant(tenantOf(user), async (tx) => ({
    completo: await buscarFluxo(tx, id),
    mensagens: await listarMensagens(tx),
    /*
     * A CONFIGURAÇÃO DOS CANAIS, AQUI, PORQUE AQUI NÃO HÁ NINGUÉM OLHANDO
     * NA HORA DO ENVIO.
     *
     * Um disparo manual devolve o erro para quem clicou. Um fluxo dispara
     * sozinho, de madrugada, a partir de um webhook — e se o canal não tiver
     * conexão o envio é barrado sem gerar linha no histórico (é o que mantém a
     * tela legível, ver `prontidao.ts`). O preço disso seria um fluxo mudo sem
     * nada explicando, então o aviso mora onde a pessoa configura o fluxo.
     */
    prontidao: await prontidaoDosCanais(tx, user.orgId, CHANNELS),
  }))
  if (!completo) notFound()

  const { fluxo, passos, condicoesEntrada, ritmo } = completo

  // Só os canais que ESTE fluxo usa: avisar sobre um SMS desconfigurado num
  // fluxo que só manda WhatsApp seria ruído, e ruído ensina a ignorar aviso.
  const usados = new Set<Channel>(passos.flatMap((p) => p.canais ?? []))
  const semConexao = [...usados]
    .map((canal) => prontidao.get(canal))
    .filter((p): p is NonNullable<typeof p> => Boolean(p) && !p!.pronto)

  /*
   * Só as ativas, e sem as que o próprio fluxo já usa não — usar a mesma
   * mensagem em dois passos é legítimo (um lembrete que se repete). O que não
   * faz sentido é oferecer uma mensagem pausada: ela não sairia, e o passo
   * ficaria com um defeito que só aparece no histórico.
   */
  const opcoes = mensagens
    .filter((m) => m.active)
    .map((m) => ({ id: m.id, nome: m.name, chave: m.key }))

  return (
    <SessionFrame
      title={fluxo.name}
      description="Os passos saem todos de uma vez quando o gatilho chega, cada um marcado para o seu horário."
      actions={
        <div className="flex items-center gap-2">
          <form action={alternarFluxoAction}>
            <input type="hidden" name="id" value={fluxo.id} />
            <input type="hidden" name="ativar" value={fluxo.active ? '0' : '1'} />
            <Button type="submit" variant={fluxo.active ? 'ghost' : 'primary'} size="sm">
              {fluxo.active ? 'Pausar' : 'Ativar'}
            </Button>
          </form>
          <Button asChild variant="ghost" size="sm">
            <Link href="/fluxos">Voltar</Link>
          </Button>
        </div>
      }
    >
      <div className="flex max-w-3xl flex-col gap-4">
        {semConexao.length > 0 ? (
          <Card>
            <CardBody className="flex flex-col gap-1">
              <p className="text-2xs font-medium text-fail">
                {semConexao.length === 1
                  ? 'Um canal deste fluxo não tem como enviar.'
                  : `${semConexao.length} canais deste fluxo não têm como enviar.`}
              </p>
              {semConexao.map((canal) => (
                <p key={canal.canal} className="text-2xs text-ink-2">
                  <span className="text-ink">{CHANNEL_LABELS[canal.canal]}</span>: {canal.motivo}
                </p>
              ))}
              <p className="text-2xs text-pending">
                Enquanto estiver assim, o fluxo dispara e esse canal fica de fora — sem linha no
                histórico, porque o problema é da configuração e não de cada contato.{' '}
                <Link href="/canais" className="text-ink underline underline-offset-2">
                  Abrir Canais
                </Link>
                .
              </p>
            </CardBody>
          </Card>
        ) : null}

        {!fluxo.active ? (
          <Card>
            <CardBody>
              <p className="text-2xs text-pending">
                Pausado. Nenhum evento dispara este fluxo enquanto estiver assim — revise o texto
                das mensagens e ative quando quiser.
              </p>
            </CardBody>
          </Card>
        ) : null}

        {/* ── Quando dispara e o que faz parar ── */}
        <Card>
          <CardHeader>
            <CardTitle>Quando roda</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {/*
              O NOME DO EVENTO, E NÃO O CÓDIGO DELE.

              "Dispara em user.created" obriga quem lê a saber o dicionário
              interno do sistema para responder à pergunta mais simples desta
              tela: quando isto acontece? O código continua visível ao lado, em
              cinza, porque é ele que aparece no mapeamento da plataforma e no
              histórico — mas deixa de ser a resposta principal (§11.7).
            */}
            <p className="text-2xs text-ink-2">
              Dispara <span className="text-ink">{descreverEvento(fluxo.triggerEvent).nome.toLocaleLowerCase('pt-BR')}</span>{' '}
              <span className="font-mono text-pending">({fluxo.triggerEvent})</span>
              {ritmo ? (
                <>
                  {' '}
                  no ritmo <span className="text-ink">{ritmo}</span>
                </>
              ) : null}
              .
            </p>

            {condicoesEntrada.length > 0 ? (
              <p className="text-2xs text-ink-2">
                Só quando: {condicoesEntrada.join(' e ')}.
              </p>
            ) : null}

            {fluxo.cancelOn.length > 0 ? (
              <p className="text-2xs text-ink-2">
                Para sozinho quando{' '}
                {fluxo.cancelOn.map((evento, i) => (
                  <span key={evento}>
                    {i > 0 ? ' ou ' : ''}
                    <span className="text-ink" title={evento}>
                      {descreverEvento(evento).nome.toLocaleLowerCase('pt-BR')}
                    </span>
                  </span>
                ))}
                . Tudo que ainda não saiu é cancelado no mesmo instante.
              </p>
            ) : (
              <p className="text-2xs text-pending">
                Este fluxo não para sozinho: os passos saem mesmo que a situação mude.
              </p>
            )}
          </CardBody>
        </Card>

        <ConfigFluxo
          id={fluxo.id}
          nome={fluxo.name}
          cancelKeyTemplate={fluxo.cancelKeyTemplate}
          precisaDeChave={fluxo.cancelOn.length > 0}
          janelaLigada={fluxo.quietHoursEnabled}
          maxPorDia={fluxo.maxPerContactPerDay}
        />

        {/* ── A cadência ── */}
        <Card>
          <CardHeader>
            <CardTitle>A cadência</CardTitle>
            <span className="text-2xs text-pending">tempos contados do gatilho</span>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {passos.length === 0 ? (
              <p className="text-2xs text-pending">Nenhum passo ainda.</p>
            ) : (
              passos.map((passo) => (
                <div
                  key={passo.id}
                  className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="w-16 shrink-0 font-mono text-2xs text-ink">
                      {passo.offsetLabel}
                      {/*
                        A hora marcada é o que separa "+2 dias" de "+2 dias às
                        10h", e sem ela na lista os dois passos ficam idênticos
                        na tela e diferentes no envio.
                      */}
                      {passo.sendAtLocal ? (
                        <span className="block text-pending">às {passo.sendAtLocal}</span>
                      ) : null}
                    </span>

                    <div className="min-w-36 flex-1">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/mensagens/${passo.messageId}`}
                          className="truncate text-xs text-ink underline-offset-2 hover:underline"
                        >
                          {passo.messageName}
                        </Link>
                        {passo.messageAtiva ? null : <Badge tone="fail">pausada</Badge>}
                      </div>
                      {/*
                        A CHAVE SAIU DAQUI.

                        `boas_vindas` e `reativacao_7d` embaixo do nome não
                        acrescentavam nada a quem lê "Boas-vindas" e "Reativação
                        — 7 dias" logo acima: eram o mesmo dado, escrito no
                        idioma do banco. Quem precisa da chave — a API pública, o
                        mapeamento — encontra na tela da mensagem. No lugar dela
                        entra o que a linha não dizia: se este texto é usado em
                        mais lugares, que é o que muda o efeito de editá-lo.
                      */}
                      {passo.usadaEmOutrosPassos > 0 ? (
                        <p className="truncate text-2xs text-pending">
                          também usada em mais {passo.usadaEmOutrosPassos}{' '}
                          {passo.usadaEmOutrosPassos === 1 ? 'passo' : 'passos'}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-1">
                      {CHANNELS.map((canal) => {
                        // Sem override, valem os canais ligados na mensagem.
                        const ligado = passo.canais ? passo.canais.includes(canal) : null
                        return (
                          <span
                            key={canal}
                            title={
                              ligado === null
                                ? `${CHANNEL_LABELS[canal]}: segue a mensagem`
                                : `${CHANNEL_LABELS[canal]}: ${ligado ? 'ligado' : 'desligado'}`
                            }
                            className={ligado === false ? 'opacity-20' : ligado ? '' : 'opacity-50'}
                          >
                            <ChannelIcon channel={canal} className="size-3.5" aria-hidden="true" />
                          </span>
                        )
                      })}
                    </div>

                    <EditarPasso
                      flowId={fluxo.id}
                      stepId={passo.id}
                      delaySeconds={passo.delaySeconds}
                      sendAtLocal={passo.sendAtLocal}
                      messageId={passo.messageId}
                      messageName={passo.messageName}
                      messageBody={passo.messageBody}
                      usadaEmOutrosPassos={passo.usadaEmOutrosPassos}
                      position={passo.position}
                      opcoes={opcoes}
                    />
                  </div>

                  {/*
                    O TEXTO, e não só o nome da mensagem.
                    "Boas-vindas" não responde "o que a pessoa vai receber" — e
                    era essa a pergunta de quem abria esta tela. Conferir exigia
                    sair daqui, ler noutra tela e voltar, uma vez por passo.
                  */}
                  {passo.amostra ? (
                    <p className="line-clamp-2 border-t border-line pt-2 text-2xs leading-relaxed text-ink-2">
                      {passo.amostra}
                    </p>
                  ) : (
                    <p className="border-t border-line pt-2 text-2xs text-warn">
                      Esta mensagem está em branco — o passo não vai enviar nada.
                    </p>
                  )}
                </div>
              ))
            )}

            {passos.length > 1 ? (
              <p className="mt-1 text-2xs text-pending">
                Os {passos.length} passos entram na fila juntos, no momento do gatilho. É o que
                permite cancelar todos de uma vez.
              </p>
            ) : null}

            <div className="mt-1">
              <AdicionarPasso flowId={fluxo.id} opcoes={opcoes} />
            </div>
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
