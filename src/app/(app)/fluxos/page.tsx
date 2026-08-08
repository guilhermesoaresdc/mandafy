import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@/db";
import { listarFluxos } from "@/db/queries/flows";
import { SessionFrame } from "@/components/shell/app-shell";
import {
  Badge,
  BotaoAcao,
  Button,
  Card,
  CardBody,
  EmptyState,
} from "@/components/ui";
import { requireAdmin, tenantOf } from "@/lib/auth/current";
import { alternarFluxoAction, criarFluxosModeloAction } from "./actions";
import {
  descreverEvento,
  ehEventoQueOMandafyNaoGera,
  porQueNaoDispara,
} from "@/lib/vocabulario";
import { cn } from "@/lib/utils";
import { NovoFluxo } from "./novo-fluxo";

export const metadata: Metadata = { title: "Fluxos · Mandafy" };
export const dynamic = "force-dynamic";

export default async function FluxosPage() {
  const user = await requireAdmin();

  const lista = await withTenant(tenantOf(user), listarFluxos);

  return (
    /*
     * A descrição diz de onde vêm os eventos.
     *
     * Quem procura "como gero o webhook" vem para cá primeiro — o fluxo é o que
     * reage ao evento, então parece o lugar. Não é: o endereço nasce na
     * plataforma conectada, uma tela adiante. Uma frase aqui economiza a
     * procura.
     */
    <SessionFrame
      title="Fluxos"
      description="O que dispara, quando sai, e o que faz parar. Os eventos chegam da sua plataforma — o endereço de webhook fica em Configurações → Plataformas."
      actions={<NovoFluxo />}
    >
      {lista.length === 0 ? (
        /*
         * Vazio convida à ação (§11.7) — e a ação fica AQUI.
         *
         * Este texto mandava rodar `npm run db:seed`. Quem opera o Mandafy
         * trabalha pelo navegador: a instrução era uma porta sem maçaneta. Pior,
         * era desnecessária — o mesmo trabalho já existia num botão escondido em
         * Configurações → Sistema, onde ninguém procura quando o que falta é um
         * fluxo.
         */
        <EmptyState
          title="Nenhum fluxo ainda"
          description="Comece pela recuperação de PIX: ela avisa quem gerou o pagamento e não pagou, e para sozinha no instante em que o pagamento entra. Todos chegam pausados — você lê o texto antes de ligar."
          action={
            <BotaoAcao
              acao={criarFluxosModeloAction}
              rotulo="Trazer os nove fluxos prontos"
              rotuloOcupado="Trazendo…"
            />
          }
        />
      ) : (
        <div className="flex max-w-3xl flex-col gap-2">
          {lista.map((fluxo) => (
            <Card key={fluxo.id}>
              <CardBody className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-xs font-medium text-ink">
                        {fluxo.name}
                      </p>
                      {fluxo.active ? (
                        <Badge tone="ok">ativo</Badge>
                      ) : (
                        <Badge tone="pending">pausado</Badge>
                      )}
                      {fluxo.cancelOn.length > 0 ? (
                        <Badge tone="pending">para sozinho</Badge>
                      ) : null}
                      {fluxo.temMensagemPausada ? (
                        <Badge tone="fail">mensagem pausada</Badge>
                      ) : null}
                      {/*
                        Cinco dos quinze eventos canônicos o Mandafy não produz
                        sozinho. Quem liga um fluxo desses espera, nada
                        acontece, e o painel informa "o evento nunca chegou" —
                        apontando a culpa para a plataforma dele, que está sã.
                      */}
                      {ehEventoQueOMandafyNaoGera(fluxo.triggerEvent) ? (
                        <Badge tone="pending">ainda não dispara</Badge>
                      ) : null}
                    </div>

                    {/*
                    O NOME DO EVENTO, e o código na dica.

                    `order.created · 4 passos` obrigava a decorar um dicionário
                    para ler a própria banca. O dicionário existe desde sempre
                    em `vocabulario.ts` e era usado em outras telas — esta
                    imprimia o identificador cru, em font-mono, como se fosse
                    para um programador. O código sobrevive no `title`, onde
                    serve a quem for integrar sem atrapalhar quem for operar.
                  */}
                    <p
                      className="mt-0.5 text-2xs text-pending"
                      title={fluxo.triggerEvent}
                    >
                      {descreverEvento(fluxo.triggerEvent).nome} ·{" "}
                      {fluxo.passos.length} mensagem
                      {fluxo.passos.length === 1 ? "" : "s"}
                      {fluxo.ritmo ? ` · ${fluxo.ritmo}` : ""}
                    </p>
                  </div>

                  <form action={alternarFluxoAction}>
                    <input type="hidden" name="id" value={fluxo.id} />
                    <input
                      type="hidden"
                      name="ativar"
                      value={fluxo.active ? "0" : "1"}
                    />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={
                        !fluxo.active &&
                        ehEventoQueOMandafyNaoGera(fluxo.triggerEvent)
                      }
                      title={
                        !fluxo.active &&
                        ehEventoQueOMandafyNaoGera(fluxo.triggerEvent)
                          ? porQueNaoDispara(fluxo.triggerEvent)
                          : undefined
                      }
                    >
                      {fluxo.active ? "Pausar" : "Ativar"}
                    </Button>
                  </form>

                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/fluxos/${fluxo.id}`}>Abrir</Link>
                  </Button>
                </div>

                {/*
                  ── O QUE ESTE FLUXO MANDA, SEM ABRIR ──

                  Para responder "o que meus fluxos mandam hoje?" eram nove
                  idas e voltas, uma por fluxo. E a resposta boa já existia uma
                  tela adiante: `amostraDe` compila o corpo com o contato de
                  exemplo desde sempre, e a tela do fluxo mostra o texto real de
                  cada passo. Faltava a lista fazer a mesma pergunta.

                  Nome E texto, não um ou outro: "Boas-vindas" não diz se o
                  texto ainda fala de rifa, se está em branco, ou se é o que a
                  pessoa espera. Ler é o passo zero de confiar que o fluxo faz
                  o que diz.
                */}
                {fluxo.passos.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 border-t border-line pt-2">
                    {fluxo.passos.map((passo, i) => (
                      <li
                        key={`${fluxo.id}-${i}`}
                        className="flex min-w-0 items-baseline gap-2 text-2xs"
                      >
                        <span className="w-14 shrink-0 text-right font-mono text-pending tabular-nums">
                          {passo.offsetLabel}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-medium",
                            passo.messageAtiva ? "text-ink-2" : "text-fail",
                          )}
                        >
                          {passo.messageName}
                          {passo.messageAtiva ? "" : " (pausada)"}
                        </span>
                        {/*
                          O texto trunca, e é o único item da linha que pode:
                          o tempo e o nome respondem "quando" e "qual", e a
                          amostra responde "mais ou menos o quê" — a primeira
                          linha basta, e quem quiser o resto abre.
                        */}
                        <span className="min-w-0 truncate text-pending">
                          {passo.amostra}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-line pt-2 text-2xs text-pending">
                    Sem mensagem nenhuma — este fluxo não manda nada.
                  </p>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </SessionFrame>
  );
}
