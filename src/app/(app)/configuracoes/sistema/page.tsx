import type { Metadata } from 'next'
import { SessionFrame } from '@/components/shell/app-shell'
import { Badge, Card, CardBody, CardHeader, CardTitle } from '@/components/ui'
import { estadoDoSistema } from '@/db/queries/sistema'
import { requireAdmin } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import {
  aplicarModelosAction,
  baterAgoraAction,
  migrarAction,
  semearAction,
  simularModelosAction,
} from './actions'
import { BotaoDeSistema } from './botoes'

export const metadata: Metadata = { title: 'Sistema · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Configurações → Sistema.
 *
 * Existe porque as três piores falhas deste projeto foram todas SILENCIOSAS:
 * uma migration que não rodou, um RLS que não protege e um batimento que
 * ninguém chama. Nenhuma aparece como erro — todas aparecem como "está tudo
 * normal, mas nada acontece". Aqui elas ficam visíveis, e cada uma tem o botão
 * que a resolve.
 *
 * Copy pelo que a pessoa controla, não pela implementação (§11.7): "as
 * mensagens estão saindo?" antes de "o cron está configurado?".
 */

/** "40 s", "12 min", "2h10". Sem arredondar para cima: o atraso é a notícia. */
function esperaEmPalavras(segundos: number): string {
  if (segundos < 60) return `${segundos} s`

  const minutos = Math.floor(segundos / 60)
  if (minutos < 60) return `${minutos} min`

  return `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')}`
}

function quandoFoi(data: Date | null): string {
  if (!data) return 'nunca'

  const minutos = Math.round((Date.now() - data.getTime()) / 60_000)
  if (minutos < 1) return 'agora mesmo'
  if (minutos < 60) return `há ${minutos} min`

  const horas = Math.round(minutos / 60)
  if (horas < 24) return `há ${horas}h`
  return `há ${Math.round(horas / 24)} dia(s)`
}

export default async function SistemaPage() {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const estado = await estadoDoSistema()

  const migrationsEmDia = estado.migrations.pendentes.length === 0
  // Mais de duas horas sem manutenção significa que ninguém está chamando: o
  // ciclo é de uma hora, e uma folga cobre atraso de agendador.
  const batimentoVivo =
    estado.batimento.ultimaManutencao !== null &&
    Date.now() - estado.batimento.ultimaManutencao.getTime() < 2 * 60 * 60 * 1000

  return (
    <SessionFrame
      title="Sistema"
      description="O estado das peças que ninguém vê — e que, quando param, param em silêncio."
    >
      <div className="flex max-w-3xl flex-col gap-4">
        {estado.erro ? (
          <Card>
            <CardBody>
              <p className="text-xs font-medium text-fail">Não consegui falar com o banco.</p>
              <p className="mt-1 font-mono text-2xs text-ink-2">{estado.erro}</p>
            </CardBody>
          </Card>
        ) : null}

        {/* ── Estrutura do banco ── */}
        <Card>
          <CardHeader>
            <CardTitle>
              Estrutura do banco{' '}
              {migrationsEmDia ? (
                <Badge tone="ok">em dia</Badge>
              ) : (
                <Badge tone="fail">{estado.migrations.pendentes.length} pendente(s)</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-2xs text-ink-2">
              {estado.migrations.aplicadas} de {estado.migrations.total} alterações aplicadas. O app
              aplica as pendentes sozinho quando sobe — este botão serve para não esperar o próximo
              deploy.
            </p>

            {migrationsEmDia ? null : (
              <ul className="flex flex-col gap-0.5">
                {estado.migrations.pendentes.map((nome) => (
                  <li key={nome} className="font-mono text-2xs text-pending">
                    {nome}
                  </li>
                ))}
              </ul>
            )}

            <BotaoDeSistema
              acao={migrarAction}
              rotulo="Aplicar agora"
              rotuloOcupado="Aplicando…"
              variante={migrationsEmDia ? 'secondary' : 'primary'}
            />
          </CardBody>
        </Card>

        {/* ── Batimento ── */}
        <Card>
          <CardHeader>
            <CardTitle>
              As mensagens estão saindo?{' '}
              {batimentoVivo ? <Badge tone="ok">sim</Badge> : <Badge tone="fail">não</Badge>}
            </CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            {batimentoVivo ? (
              <p className="text-2xs text-ink-2">
                Última verificação {quandoFoi(estado.batimento.ultimaManutencao)}. O sistema está
                percorrendo a fila sozinho.
              </p>
            ) : (
              <div className="rounded-lg border border-fail/40 px-3 py-2 text-2xs text-ink-2">
                <p className="text-fail">
                  Ninguém está chamando o batimento — nada sai da fila sozinho.
                </p>
                <p className="mt-1">
                  {estado.batimento.configurado
                    ? 'O segredo está configurado. Falta o agendador chamar /api/cron: use o Vercel Cron, ou o fluxo do GitHub Actions que já vem no repositório.'
                    : 'Falta a variável CRON_SECRET no ambiente. Sem ela a rota /api/cron recusa todas as chamadas.'}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-2xs text-ink-2">
              <span>
                <span className="text-pending">vencidas na fila </span>
                <span className="font-mono">{estado.fila.vencidos}</span>
              </span>
              <span>
                <span className="text-pending">agendadas para depois </span>
                <span className="font-mono">{estado.fila.futuros}</span>
              </span>
              <span>
                <span className="text-pending">teto diário zerado </span>
                {quandoFoi(estado.batimento.ultimaZeragem)}
              </span>
            </div>

            {/*
              O NÚMERO QUE DIZ SE SAI NA HORA.
              "Último batimento há 3 min" só conta que alguém chamou. Um
              agendador de duas em duas horas mantém esse selo verde e entrega
              um lembrete de PIX de 5 minutos duas horas depois — a espera
              abaixo é o único lugar onde isso aparece.
            */}
            {estado.fila.vencidos > 0 ? (
              <div
                className={`rounded-lg border px-3 py-2 text-2xs ${
                  estado.fila.esperaMaxSegundos > 300
                    ? 'border-warn/40 text-ink-2'
                    : 'border-line text-ink-2'
                }`}
              >
                <p>
                  A mensagem vencida mais antiga espera há{' '}
                  <span className={estado.fila.esperaMaxSegundos > 300 ? 'text-warn' : 'text-ok'}>
                    {esperaEmPalavras(estado.fila.esperaMaxSegundos)}
                  </span>
                  .
                </p>
                {estado.fila.esperaMaxSegundos > 300 ? (
                  <p className="mt-1">
                    Um lembrete marcado para 5 minutos depois do PIX está saindo com esse atraso. É
                    o agendador chamando de longe em longe — o Vercel Cron do plano gratuito roda{' '}
                    <strong>uma vez por dia</strong> e o GitHub Actions, na prática, a cada 2 ou 3
                    horas. Para cadência de verdade, aponte um serviço de 1 minuto para{' '}
                    <code className="font-mono">/api/cron</code>; o cron-job.org é gratuito e se
                    configura pelo navegador.
                  </p>
                ) : null}
              </div>
            ) : null}

            <BotaoDeSistema
              acao={baterAgoraAction}
              rotulo="Enviar o que está vencido"
              rotuloOcupado="Enviando…"
              variante={batimentoVivo ? 'secondary' : 'primary'}
              descricao="Se este botão envia e o automático não, o problema é o agendador."
            />
          </CardBody>
        </Card>

        {/* ── Isolamento entre organizações ── */}
        <Card>
          <CardHeader>
            <CardTitle>
              Isolamento entre organizações{' '}
              {estado.rls.ignoraPoliticas ? (
                <Badge tone="fail">desligado</Badge>
              ) : (
                <Badge tone="ok">ativo</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-2xs text-ink-2">
              Conectado como <span className="font-mono text-ink">{estado.rls.papelAtual}</span> ·{' '}
              {estado.rls.tabelasComRls} tabelas com política.
            </p>

            {estado.rls.ignoraPoliticas ? (
              <div className="rounded-lg border border-fail/40 px-3 py-2 text-2xs text-ink-2">
                <p className="text-fail">Este papel passa por cima das políticas.</p>
                <p className="mt-1">
                  As regras existem no banco, mas não valem para esta conexão — ela é dona das
                  tabelas ou tem privilégio de superusuário. Com uma organização só isso não vaza
                  nada hoje; com duas, uma enxergaria a outra.
                </p>
                <p className="mt-1">
                  A correção é criar o papel <span className="font-mono">mandafy_app</span> no banco
                  e apontar a variável <span className="font-mono">DATABASE_URL</span> para ele,
                  deixando <span className="font-mono">DATABASE_URL_ADMIN</span> com o papel dono. O
                  passo a passo está em <span className="font-mono">docs/supabase.md</span>.
                </p>
              </div>
            ) : (
              <p className="text-2xs text-ok">
                A aplicação conecta com um papel restrito: as políticas valem para toda consulta.
              </p>
            )}
          </CardBody>
        </Card>

        {/* ── Dados iniciais ── */}
        <Card>
          <CardHeader>
            <CardTitle>Dados iniciais</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-2xs text-ink-2">
              Cria a organização, o administrador, os perfis de ritmo, o funil padrão e os
              fluxos-modelo. Roda quantas vezes quiser: o que já existe não é duplicado nem
              sobrescrito.
            </p>

            <BotaoDeSistema
              acao={semearAction}
              rotulo="Criar o que faltar"
              rotuloOcupado="Criando…"
            />
          </CardBody>
        </Card>

        {/* ── Texto das mensagens-modelo ── */}
        <Card>
          <CardHeader>
            <CardTitle>Texto das mensagens-modelo</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-2xs text-ink-2">
              O botão acima só cria o que falta — de propósito, senão um deploy apagaria texto que
              você ajustou. A consequência é que uma mensagem criada há semanas continua com o texto
              daquele dia, mesmo depois de o modelo melhorar.
            </p>
            <p className="text-2xs text-ink-2">
              Este botão leva a versão atual às mensagens que ainda estão como o sistema as
              escreveu. <span className="text-ink">O que você editou à mão não é tocado</span> — a
              simulação diz quais são, antes de gravar qualquer coisa.
            </p>

            <BotaoDeSistema
              acao={simularModelosAction}
              rotulo="Ver o que mudaria"
              rotuloOcupado="Conferindo…"
            />
            <BotaoDeSistema
              acao={aplicarModelosAction}
              rotulo="Atualizar para valer"
              rotuloOcupado="Atualizando…"
              descricao="Reescreve o texto das mensagens não editadas."
            />
          </CardBody>
        </Card>
      </div>
    </SessionFrame>
  )
}
