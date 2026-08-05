import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { usesTransactionPooler } from './index'
import * as schema from './schema'
import { messages, messageVariants } from './schema'
import { linhasDoModelo } from '@/lib/messages/aplicar-modelo'
import { MENSAGENS, type ModeloMensagem } from '@/lib/messages/modelos'

/**
 * Reaplica o catálogo de modelos por cima das mensagens já gravadas (§5.2).
 *
 * POR QUE ISTO EXISTE
 *
 * O seed é idempotente por chave: se a mensagem já existe, ele pula. É o que
 * impede um deploy de apagar texto que alguém ajustou à mão — e é o
 * comportamento certo para ele.
 *
 * Mas quando o CATÁLOGO muda, quem já semeou fica preso na versão antiga para
 * sempre. Foi o que aconteceu ao trocar o vocabulário de rifa pelo de banca: o
 * código passou a estar certo e o banco continuou dizendo "12 números na
 * campanha Moto 0km".
 *
 * COMO ELE SABE O QUE PODE SOBRESCREVER
 *
 * Não por data e não por adivinhação. Cada corpo que o seed já escreveu, em
 * qualquer versão do catálogo, tem sua impressão digital em `HISTORICOS`. A
 * regra é exata:
 *
 *   corpo bate com o modelo ATUAL      → já está em dia, não faz nada
 *   corpo bate com um modelo ANTIGO    → ninguém editou, pode reaplicar
 *   corpo não bate com nada conhecido  → foi editado à mão, NÃO TOCA
 *
 * Usar `updated_at` seria mais fácil e estaria errado: ligar e desligar uma
 * mensagem também mexe nesse campo, e o comando apagaria texto de quem só
 * clicou num botão.
 *
 * SÓ ESCREVE COM `--aplicar`
 *
 * Sem a flag ele lista o que faria e sai. Um comando que reescreve o texto que
 * sai para o cliente não deve ser executável por engano — e o relatório é a
 * parte útil de qualquer forma.
 */

/**
 * SHA-256 (16 primeiros caracteres) de cada corpo que o seed já gravou.
 *
 * Extraídas das três revisões em que o catálogo viveu: 6f14971 e 0e3b262 (em
 * `seed-flows.ts`) e 552b97a (já em `modelos.ts`). Uma chave pode ter vários,
 * porque o texto mudou mais de uma vez.
 *
 * Ao mexer nos modelos de novo, ACRESCENTE aqui a digital da versão que sai —
 * senão quem tiver a versão anterior passa a ser tratado como edição manual e
 * ninguém mais recebe a atualização.
 */
const HISTORICOS: Record<string, readonly string[]> = {
  bicho_resultado_premiado: ['40a911ccb612190a', '98715a9a96ed9d7d', 'd078e2b76d683a53', 'eba91325b37a2da4'],
  bilhete_premiado: ['0a7fd9ee5c658c3e', 'c87ece3065e00e17'],
  boas_vindas: ['b6c9f10da9075829'],
  campanha_encerrando: ['44527ea9cd40f8a2', 'cf7ce56cb248732f'],
  pagamento_confirmado: ['cc735778797ecc5f', '237eeee4fe7d5b4a'],
  pix_expirou_oferta: ['361b20607084040f', 'ca4b8b9152aace41'],
  pix_lembrete_1: ['70cb71abad3e697c', '274d1859c8be8b28'],
  pix_lembrete_2: ['b38481511166aff8', 'afbafa92b66a309b'],
  pix_ultima_chance: ['c276c65b83d6e05d', '5d123ae0a2b42703'],
  pos_compra_upsell: ['a6d8782b4029fc68'],
  reativacao_7d: ['e4244c60ba3bd080', '29d0be304cd08a49'],
  saque_concluido: ['fa1dbe34990798de', 'a0700d2428d0ec88'],
  saque_processando: ['e5d143e3567caaf1', '815e4cfa68489e91'],
}

function digital(texto: string): string {
  return createHash('sha256').update(texto).digest('hex').slice(0, 16)
}

export type Desfecho =
  | 'em_dia'
  | 'reaplicado'
  | 'editado'
  | 'ausente'
  /**
   * Existe no banco e NÃO existe mais no catálogo.
   *
   * Acontece quando dois modelos são fundidos — foi o caso de
   * `bicho_resultado_premiado`, que virou `bilhete_premiado`. A linha continua
   * lá, com o texto antigo, e como nenhum fluxo a cita ela some da vista sem
   * sumir do banco. Reportar é o mínimo: apagar por conta própria seria mexer
   * numa mensagem que pode estar em uso por um fluxo que alguém montou à mão.
   */
  | 'orfa'

export type Resultado = {
  key: string
  nome: string
  desfecho: Desfecho
}

/**
 * O corpo gravado pode ser reescrito?
 *
 * Compara com o modelo atual primeiro: quem já está em dia não precisa de
 * escrita nenhuma, e reescrever à toa mudaria `updated_at` de todo mundo.
 */
function classificar(atual: string, gravado: string, key: string): Desfecho {
  if (gravado === atual) return 'em_dia'
  if ((HISTORICOS[key] ?? []).includes(digital(gravado))) return 'reaplicado'
  return 'editado'
}

/** Mesmo papel do seed e das migrations: dono das tabelas, ignora RLS. */
function adminUrl(): string {
  const url = process.env.DATABASE_URL_ADMIN ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL_ADMIN (ou DATABASE_URL) não definida.')
  return url
}

/**
 * Recusa rodar com o papel da APLICAÇÃO.
 *
 * Sem `DATABASE_URL_ADMIN`, `adminUrl()` cai para `DATABASE_URL` — o papel
 * `mandafy_app`, com RLS sempre aplicado. Este comando não tem contexto de
 * tenant, então a política compara `org_id` com NULL e o SELECT devolve ZERO
 * linhas: o relatório dizia "nada a atualizar" e ninguém desconfiava de nada.
 *
 * Falha silenciosa é o pior desfecho possível aqui — pior que um erro, porque
 * quem lê "nada a atualizar" conclui que os modelos já estavam em dia e não
 * roda de novo. Por isso a verificação é explícita, e pergunta ao próprio
 * Postgres em vez de comparar o nome do usuário com uma constante.
 */
async function exigirPapelDono(sql: postgres.Sql): Promise<void> {
  const [linha] = await sql<{ rls_aplicado: boolean; usuario: string }[]>`
    SELECT c.relrowsecurity
             AND NOT pg_has_role(current_user, c.relowner, 'MEMBER') AS rls_aplicado,
           current_user AS usuario
    FROM pg_class c
    WHERE c.relname = 'messages' AND c.relkind = 'r'
  `

  if (!linha?.rls_aplicado) return

  throw new Error(
    `conectado como "${linha.usuario}", que é o papel da aplicação — com RLS aplicado ` +
      'ele não enxerga mensagem nenhuma sem contexto de organização, e o comando não ' +
      'atualizaria nada em silêncio.\n' +
      'Defina DATABASE_URL_ADMIN (o mesmo papel usado por db:migrate e db:seed).',
  )
}

export async function reaplicarModelos(
  aplicar: boolean,
  /** Sobrescreve o endereço. Existe para o teste, que não usa o ambiente. */
  urlExplicita?: string,
): Promise<Resultado[]> {
  const url = urlExplicita ?? adminUrl()
  const sql = postgres(url, {
    max: 1,
    prepare: !usesTransactionPooler(url),
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })
  const resultados: Resultado[] = []

  try {
    await exigirPapelDono(sql)

    for (const modelo of MENSAGENS as readonly ModeloMensagem[]) {
      const { mensagem, variantes } = linhasDoModelo(modelo)

      /*
       * Sem contexto de tenant e sem filtro por organização: o comando roda com
       * o papel dono das tabelas, como o seed e as migrations, e a intenção é
       * atualizar TODAS as organizações da instalação. Cada linha é decidida
       * pelo próprio corpo, então uma organização que editou o texto continua
       * intocada mesmo aqui.
       */
      const linhas = await db
        .select({ id: messages.id, orgId: messages.orgId, body: messages.body })
        .from(messages)
        .where(eq(messages.key, modelo.key))

      if (linhas.length === 0) {
        resultados.push({ key: modelo.key, nome: modelo.name, desfecho: 'ausente' })
        continue
      }

      for (const linha of linhas) {
        const desfecho = classificar(mensagem.body, linha.body, modelo.key)

        if (desfecho !== 'reaplicado') {
          resultados.push({ key: modelo.key, nome: modelo.name, desfecho })
          continue
        }

        if (aplicar) {
          await db
            .update(messages)
            .set({
              name: mensagem.name,
              category: mensagem.category,
              body: mensagem.body,
              ignoreQuietHours: mensagem.ignoreQuietHours,
              ...(mensagem.description ? { description: mensagem.description } : {}),
              updatedAt: new Date(),
            })
            .where(eq(messages.id, linha.id))

          /*
           * As variantes vão junto, e precisam: o assunto do e-mail, o corpo do
           * SMS e o botão do Telegram fazem parte da mensagem. Atualizar só o
           * corpo deixaria o assunto falando de campanha enquanto o texto fala
           * de aposta — pior que não atualizar nada.
           *
           * `enabled` fica de FORA. Ligar e desligar canal é decisão de operação,
           * e o comando não tem o direito de religar um SMS que alguém desligou
           * de propósito por causa do custo.
           */
          for (const variante of variantes) {
            await db
              .update(messageVariants)
              .set({
                synced: variante.synced ?? true,
                body: variante.body ?? null,
                subject: variante.subject ?? null,
                preheader: variante.preheader ?? null,
                textBody: variante.textBody ?? null,
                buttons: variante.buttons ?? null,
                stripAccents: variante.stripAccents ?? false,
                ...(variante.parseMode ? { parseMode: variante.parseMode } : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(messageVariants.messageId, linha.id),
                  eq(messageVariants.channel, variante.channel),
                ),
              )
          }
        }

        resultados.push({ key: modelo.key, nome: modelo.name, desfecho: 'reaplicado' })
      }
    }

    /*
     * Chaves que o catálogo já teve e não tem mais. `HISTORICOS` é a lista de
     * tudo que o seed um dia escreveu, então o que está lá e não está em
     * `MENSAGENS` é exatamente um modelo aposentado.
     */
    const vivas = new Set(MENSAGENS.map((m) => m.key as string))
    for (const key of Object.keys(HISTORICOS)) {
      if (vivas.has(key)) continue

      const linhas = await db
        .select({ name: messages.name })
        .from(messages)
        .where(eq(messages.key, key))

      for (const linha of linhas) {
        resultados.push({ key, nome: linha.name, desfecho: 'orfa' })
      }
    }

    return resultados
  } finally {
    await sql.end({ timeout: 5 })
  }
}
