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
 *   1. o dinheiro e a gente — compras, cadastros, recuperado;
 *   2. o que está prestes a acontecer — barra de pulso e alertas;
 *   3. as curvas — para onde a coisa está indo;
 *   4. a saúde do motor — canais, fila, falhas;
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

  const { metricas, proximos, canais, instancias, noAr, movimento, funil } = await withTenant(
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
    }),
  )

  const alertas = avaliarAlertas({ canais, instancias, naFila: metricas.naFila })

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
        {/* ── 1. O dinheiro e a gente ── */}
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <Stat
              label="Comprado hoje"
              value={formatBRL(metricas.compradoHojeCents)}
              hint={`${formatNumber(metricas.comprasHoje)} aposta(s) paga(s) · ${vendas.texto}`}
              tone={vendas.tom === 'neutral' ? 'neutral' : vendas.tom}
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
          </CardBody>
        </Card>

        {/* ── 2. O que está prestes a acontecer ── */}
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
                    <p className="text-2xs text-ink-2">{alerta.acao}</p>
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

        {/* ── 4. A saúde do motor ── */}
        <Card>
          <CardHeader>
            <CardTitle>O motor de envio</CardTitle>
            <Link
              href="/historico"
              className="text-2xs text-ink-2 underline-offset-2 hover:underline"
            >
              abrir o histórico
            </Link>
          </CardHeader>
          <CardBody className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <Stat label="Enviadas hoje" value={formatNumber(metricas.enviadasHoje)} />
            <Stat
              label="Taxa entrega"
              value={metricas.taxaEntrega === null ? '—' : formatPercent(metricas.taxaEntrega)}
              tone={
                metricas.taxaEntrega !== null && metricas.taxaEntrega < 0.8 ? 'warn' : 'neutral'
              }
            />
            <Stat label="Na fila" value={formatNumber(metricas.naFila)} />
            <Stat
              label="Falhas 24h"
              value={formatNumber(metricas.falhas24h)}
              tone={metricas.falhas24h > 0 ? 'fail' : 'neutral'}
            />
          </CardBody>
        </Card>

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
