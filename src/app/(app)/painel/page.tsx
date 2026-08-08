import type { Metadata } from 'next'
import Link from 'next/link'
import { withTenant } from '@/db'
import { saudeDasInstancias } from '@/db/queries/channels'
import { resumoNoAr } from '@/db/queries/no-ar'
import {
  funilDoPeriodo,
  metricasDoPainel,
  movimentoPorDia,
  proximosEnvios,
  saudeDosCanais,
} from '@/db/queries/painel'
import { SessionFrame } from '@/components/shell/app-shell'
import { BarraDePulso, type EnvioNaBarra } from '@/components/shell/barra-de-pulso'
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ChannelIcon,
  Evolucao,
  Funil,
  Rosca,
  Stat,
  type Fatia,
} from '@/components/ui'
import { CHANNEL_COLOR_VAR, CHANNEL_LABELS, CHANNELS } from '@/db/schema/enums'
import { requireUser, tenantOf } from '@/lib/auth/current'
import { avaliarAlertas } from '@/lib/alertas'
import { prontidaoDosCanais } from '@/lib/delivery/prontidao'
import { TAREFAS, ultimaExecucao } from '@/lib/manutencao'
import { cn, formatBRL, formatNumber, formatPercent } from '@/lib/utils'
import { NoAr } from './no-ar'

export const metadata: Metadata = { title: 'Painel · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * O painel (§10.3).
 *
 * A ORDEM DA TELA É A ORDEM DAS PERGUNTAS
 *
 * Antes, o painel abria com o que o MANDAFY fez — enviadas, taxa de entrega,
 * fila, falhas — e logo abaixo com o diagnóstico de quais fluxos estão no ar.
 * Tudo isso importa, e nada disso é a primeira pergunta de quem toca uma banca
 * de manhã: "quanto entrou ontem e hoje, e quantos clientes novos chegaram".
 * Esses números existiam no banco desde a Fase 2 e não apareciam em tela
 * nenhuma.
 *
 * Agora a página desce em ordem de urgência:
 *   1. O DIA — comprado, prêmios pagos, saldo, cadastros, recuperado, ticket
 *      médio, mensagens enviadas e taxa de entrega, no mesmo bloco. Os números
 *      de envio moram aqui porque são do mesmo dia que o faturamento ao lado, e
 *      é lê-los juntos que liga uma queda de venda a uma queda de entrega;
 *   2. o que está prestes a acontecer — barra de pulso e alertas;
 *   3. as curvas — para onde a coisa está indo;
 *   4. o detalhe do motor — próximos envios e saúde por canal;
 *   5. o diagnóstico de configuração — "o que está no ar", no fim.
 *
 * O item 5 não perdeu importância: ele é a peça que pega a falha mais cara
 * deste sistema (plataforma mandando evento e nenhum fluxo escutando). Mas é
 * uma pergunta de quem está montando ou consertando, não de quem abre o painel
 * todo dia — e quem monta rola a página uma vez.
 *
 * Continua Server Component inteiro: os gráficos são SVG gerado no servidor,
 * sem um byte de JavaScript no cliente (§13.1).
 */

/** "+18% que ontem", "−7% que ontem", ou nada quando não há com que comparar. */
function compararComOntem(hoje: number, ontem: number): { texto: string; tom: 'ok' | 'fail' | 'neutral' } {
  if (ontem === 0) return { texto: hoje > 0 ? 'primeiro do dia' : 'nada ontem', tom: 'neutral' }

  const variacao = (hoje - ontem) / ontem
  // Abaixo de 1% é ruído de horário — às 9h da manhã todo número é menor que o
  // do dia inteiro de ontem, e apontar isso como queda seria alarme falso.
  if (Math.abs(variacao) < 0.01) return { texto: 'igual a ontem', tom: 'neutral' }

  return {
    texto: `${variacao > 0 ? '+' : '−'}${Math.abs(Math.round(variacao * 100))}% que ontem`,
    tom: variacao > 0 ? 'ok' : 'fail',
  }
}

export default async function PainelPage() {
  const user = await requireUser()

  const { metricas, proximos, canais, instancias, noAr, movimento, funil, prontidao } = await withTenant(
    tenantOf(user),
    async (tx) => ({
      metricas: await metricasDoPainel(tx),
      proximos: await proximosEnvios(tx),
      canais: await saudeDosCanais(tx),
      movimento: await movimentoPorDia(tx, 14),
      funil: await funilDoPeriodo(tx, 7),
      instancias: user.isAdmin ? await saudeDasInstancias(tx) : [],
      // Só para quem administra: consultor não liga nem desliga fluxo (§9.4),
      // e mostrar-lhe um alerta que ele não pode resolver é ruído.
      noAr: user.isAdmin ? await resumoNoAr(tx) : null,
      /*
       * A pergunta "dá para enviar alguma coisa agora?" tinha resposta pronta
       * desde sempre — `prontidaoDosCanais` devolve o motivo escrito em
       * português — e era feita só dentro da tela de um fluxo. O painel, que é
       * onde alguém abre quando desconfia que parou, não perguntava.
       */
      prontidao: user.isAdmin ? await prontidaoDosCanais(tx, user.orgId, CHANNELS) : null,
    }),
  )

  /*
   * O batimento fica FORA da transação com contexto de organização: ele é
   * global (uma linha em `system_state` para a instalação inteira), não tem
   * `org_id`, e lê-lo lá dentro devolveria vazio sob RLS.
   */
  const batimento = user.isAdmin ? await ultimaExecucao(TAREFAS.horaria) : undefined

  const alertas = avaliarAlertas({
    canais,
    instancias,
    naFila: metricas.naFila,
    vencidaDesde: metricas.vencidaDesde,
    ...(prontidao ? { prontidao: [...prontidao.values()] } : {}),
    ...(user.isAdmin ? { batimento } : {}),
    noAr,
  })

  const naBarra: EnvioNaBarra[] = proximos.map((e) => ({
    id: e.id,
    channel: e.channel,
    scheduledFor: e.scheduledFor.toISOString(),
  }))

  const vendas = compararComOntem(metricas.compradoHojeCents, metricas.compradoOntemCents)
  const novos = compararComOntem(metricas.cadastrosHoje, metricas.cadastrosOntem)

  const porCanal: Fatia[] = CHANNELS.map((canal) => ({
    rotulo: CHANNEL_LABELS[canal],
    valor: canais.find((c) => c.canal === canal)?.enviadas24h ?? 0,
    cor: `var(${CHANNEL_COLOR_VAR[canal]})`,
  }))

  const totalEnviado24h = porCanal.reduce((s, f) => s + f.valor, 0)

  return (
    <SessionFrame title="Painel" description={`Operação de ${user.orgName}`}>
      <div className="flex flex-col gap-4">
        {/*
          ── 1. O QUE IMPEDE O SISTEMA DE TRABALHAR ──

          Vem ANTES dos números do dia, e a ordem é a mensagem: com nenhum
          canal conectado ou o disparo parado, "Comprado R$ 0,00" não é um
          resultado ruim, é uma tela que não tem o que medir. Ler oito zeros
          antes de saber que nada pode sair é ler a resposta errada primeiro.

          O bloco some sozinho quando não há o que resolver.
        */}
        {alertas.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Precisa de atenção</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
              {alertas.map((alerta, i) => (
                <div key={`${alerta.titulo}-${i}`} className="flex items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1 size-1.5 shrink-0 rounded-full',
                      alerta.nivel === 'critico' ? 'bg-fail' : 'bg-pending',
                    )}
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-ink">{alerta.titulo}</p>
                    <p className="text-2xs text-ink-2">
                      {alerta.acao}
                      {/*
                        O alerta leva para o lugar em vez de descrevê-lo. A
                        frase antiga era "Abra o histórico filtrado por este
                        canal" — uma instrução de navegação escrita à mão para
                        uma tela que nem aceitava ser apontada.
                      */}
                      {alerta.href ? (
                        <>
                          {' '}
                          <Link
                            href={alerta.href}
                            className="font-medium text-live underline-offset-2 hover:underline"
                          >
                            resolver
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-medium text-ink">Próxima hora</h2>
            <Link href="/historico" className="text-2xs text-ink-2 underline-offset-2 hover:underline">
              ver o histórico
            </Link>
          </div>
          <BarraDePulso envios={naBarra} />
        </div>

        {/* ── 2. O dia inteiro num bloco só ── */}
        <Card>
          <CardHeader>
            <CardTitle>Hoje</CardTitle>
            <span className="text-2xs text-pending">do 00h de Brasília até agora</span>
          </CardHeader>
          <CardBody className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <Stat
              label="Comprado"
              value={formatBRL(metricas.compradoHojeCents)}
              hint={`${formatNumber(metricas.comprasHoje)} aposta(s) paga(s) · ${vendas.texto}`}
              tone={vendas.tom === 'neutral' ? 'neutral' : vendas.tom}
            />
            {/*
              O PRÊMIO AO LADO DO FATURAMENTO, e não numa aba adiante.

              Faturamento sozinho não diz como foi o dia: R$ 3 mil vendidos com
              R$ 5 mil premiados é prejuízo, e a tela mostrava isso como recorde.
              Os dois juntos, com o saldo embaixo, é a leitura de uma olhada.
            */}
            <Stat
              label="Prêmios pagos"
              value={formatBRL(metricas.premiadoHojeCents)}
              hint={`${formatNumber(metricas.premiosHoje)} aposta(s) premiada(s)`}
              tone={metricas.premiadoHojeCents > metricas.compradoHojeCents ? 'fail' : 'neutral'}
            />
            <Stat
              label="Saldo do dia"
              value={formatBRL(metricas.compradoHojeCents - metricas.premiadoHojeCents)}
              hint="comprado menos prêmios pagos"
              tone={
                metricas.compradoHojeCents - metricas.premiadoHojeCents < 0 ? 'fail' : 'neutral'
              }
            />
            <Stat
              label="Cadastros novos"
              value={formatNumber(metricas.cadastrosHoje)}
              hint={novos.texto}
              tone={novos.tom === 'neutral' ? 'neutral' : novos.tom}
            />
            <Stat
              label="Recuperado"
              value={formatBRL(metricas.recuperadoCents)}
              hint="pagou até 24h depois de uma mensagem de recuperação"
            />
            <Stat
              label="Ticket médio"
              value={
                metricas.comprasHoje === 0
                  ? '—'
                  : formatBRL(Math.round(metricas.compradoHojeCents / metricas.comprasHoje))
              }
              hint="por aposta paga hoje"
            />

            {/*
              O MOTOR DE ENVIO SUBIU PARA CÁ.

              Ele estava abaixo dos gráficos, e ali respondia tarde demais: são
              os números que dizem se o que a banca combinou com o cliente
              chegou. Enviadas e taxa de entrega são do mesmo dia que o
              faturamento ao lado — lê-los juntos é o que liga uma queda de
              venda a uma queda de entrega.
            */}
            <Stat
              label="Mensagens enviadas"
              value={formatNumber(metricas.enviadasHoje)}
              hint={
                metricas.naFila > 0 ? `${formatNumber(metricas.naFila)} ainda na fila` : 'fila vazia'
              }
            />
            <Stat
              label="Taxa de entrega"
              value={metricas.taxaEntrega === null ? '—' : formatPercent(metricas.taxaEntrega)}
              hint={
                metricas.falhas24h > 0
                  ? `${formatNumber(metricas.falhas24h)} falha(s) em 24h`
                  : 'sem falhas em 24h'
              }
              tone={
                metricas.falhas24h > 0
                  ? 'fail'
                  : metricas.taxaEntrega !== null && metricas.taxaEntrega < 0.8
                    ? 'warn'
                    : 'neutral'
              }
            />
          </CardBody>
        </Card>

        {/* ── 3. Para onde a coisa está indo ── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Quanto entrou</CardTitle>
              <span className="text-2xs text-pending">14 dias</span>
            </CardHeader>
            <CardBody>
              <Evolucao
                serie={movimento.map((d) => ({ rotulo: d.rotulo, valor: d.valorCents }))}
                formatar={formatBRL}
                vazio="Nenhuma aposta paga nos últimos 14 dias."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cadastros novos</CardTitle>
              <span className="text-2xs text-pending">14 dias</span>
            </CardHeader>
            <CardBody>
              <Evolucao
                serie={movimento.map((d) => ({ rotulo: d.rotulo, valor: d.cadastros }))}
                cor="var(--color-ch-whatsapp)"
                vazio="Nenhum cadastro novo nos últimos 14 dias."
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Do cadastro ao prêmio</CardTitle>
              <span className="text-2xs text-pending">{funil.dias} dias · eventos, não pessoas</span>
            </CardHeader>
            <CardBody>
              <Funil
                etapas={[
                  {
                    rotulo: 'Cadastraram-se',
                    valor: funil.cadastros,
                    ajuda: 'Contas criadas na plataforma no período.',
                  },
                  {
                    rotulo: 'Apostaram',
                    valor: funil.apostas,
                    ajuda: 'Apostas registradas — o PIX foi gerado.',
                  },
                  {
                    rotulo: 'Pagaram',
                    valor: funil.pagas,
                    ajuda: 'Apostas cujo pagamento caiu. A queda daqui para cima é o que a recuperação ataca.',
                  },
                  {
                    rotulo: 'Ganharam',
                    valor: funil.premiadas,
                    ajuda: 'Apostas premiadas no período.',
                  },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Por onde saiu</CardTitle>
              <span className="text-2xs text-pending">24 horas</span>
            </CardHeader>
            <CardBody>
              <Rosca
                fatias={porCanal}
                total={totalEnviado24h}
                rotuloTotal="enviadas"
                vazio="Nada saiu nas últimas 24 horas."
              />
            </CardBody>
          </Card>
        </div>

        {/* ── 4. O detalhe do motor ── */}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Próximos envios</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1">
              {proximos.length === 0 ? (
                <p className="text-2xs text-pending">Nada agendado para a próxima hora.</p>
              ) : (
                proximos.slice(0, 8).map((envio) => (
                  <div key={envio.id} className="flex items-center gap-2 text-2xs">
                    <span className="font-mono text-ink tabular-nums">
                      {envio.scheduledFor.toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'America/Sao_Paulo',
                      })}
                    </span>
                    <ChannelIcon channel={envio.channel} className="size-3" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-ink-2">
                      {envio.contactName ?? '—'}
                    </span>
                    <span className="truncate font-mono text-pending">{envio.messageKey ?? ''}</span>
                  </div>
                ))
              )}
              {proximos.length > 8 ? (
                <p className="mt-1 text-2xs text-pending">e mais {proximos.length - 8}…</p>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Canais nas últimas 24h</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-1.5">
              {canais.map((canal) => (
                <div key={canal.canal} className="flex items-center gap-2 text-2xs">
                  <ChannelIcon channel={canal.canal} className="size-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-ink-2">
                    {formatNumber(canal.enviadas24h)} enviadas
                  </span>
                  <span
                    className={cn(
                      'font-mono tabular-nums',
                      canal.taxaFalha !== null && canal.taxaFalha > 0.1 ? 'text-fail' : 'text-pending',
                    )}
                  >
                    {canal.taxaFalha === null ? '—' : `${(canal.taxaFalha * 100).toFixed(1)}% falha`}
                  </span>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>

        {/* ── 5. O diagnóstico de configuração, no fim ── */}
        {noAr ? <NoAr resumo={noAr} /> : null}
      </div>
    </SessionFrame>
  )
}
