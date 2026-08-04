import type { Metadata } from 'next'
import { withTenant } from '@/db'
import { estadoDosCanais, saudeDasInstancias } from '@/db/queries/channels'
import { SessionFrame } from '@/components/shell/app-shell'
import type { Channel } from '@/db/schema/enums'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { serverEnv } from '@/env'
import { resolverServidorEvolution } from '@/lib/delivery/config'
import { CartaoCanal } from './cartao-canal'
import { ConfigurarCanal } from './configurar'
import { EnderecoRetorno } from './endereco-retorno'
import { NumerosDeWhatsapp } from './numeros'

export const metadata: Metadata = { title: 'Canais · Mandafy' }
export const dynamic = 'force-dynamic'

/**
 * Canais (§8, §11.4).
 *
 * A tela responde uma pergunta: o que está pronto e o que precisa de mim. Por
 * isso canal resolvido colapsa e canal pendente fica aberto — a área da tela é
 * distribuída pela atenção que cada canal merece agora, não pelo tamanho do
 * formulário que ele tem.
 *
 * Os números de WhatsApp vivem DENTRO do cartão do WhatsApp. Estavam numa
 * seção solta no fim da página, separados do canal a que pertencem por um
 * divisor e por três outros cartões.
 */

/** Copy pelo que a pessoa controla, não pela implementação (§11.7). */
const DESCRICOES: Record<Channel, string> = {
  whatsapp:
    'Conecte um número lendo o QR Code. Use pelo menos dois em rodízio, e nunca o número principal do negócio.',
  email: 'Verifique seu domínio de envio. Sem SPF, DKIM e DMARC no verde, a entrega degrada sozinha.',
  sms: 'O canal mais caro. Vem desligado por padrão e só entra nos passos finais de recuperação.',
  telegram: 'O mais barato e sem risco de bloqueio. Precisa que a pessoa inicie a conversa antes.',
}

export default async function CanaisPage() {
  const user = await requireAdmin()

  // O endereço público do app monta a URL de retorno que se cola no provedor.
  const appUrl = serverEnv().APP_URL

  const { canais, instancias, servidorPronto } = await withTenant(tenantOf(user), async (tx) => ({
    canais: await estadoDosCanais(tx),
    instancias: await saudeDasInstancias(tx),
    // Sem endereço e chave global não há como criar instância pelo painel — o
    // botão precisa dizer isso antes do clique, não depois.
    servidorPronto: (await resolverServidorEvolution(tx, user.orgId)) !== null,
  }))

  return (
    <SessionFrame
      title="Canais"
      description="Por onde as mensagens saem. Cada canal é independente: trocar de provedor não mexe no resto."
    >
      {/*
        `items-start` para que um cartão expandido não estique o vizinho: com
        `stretch`, abrir os ajustes do WhatsApp deixava um vão em branco do
        tamanho dele dentro do cartão do e-mail.
      */}
      <div className="grid items-start gap-3 md:grid-cols-2">
        {canais.map((canal) => (
          <CartaoCanal
            key={canal.canal}
            canal={canal.canal}
            provider={canal.provider}
            configurado={canal.configurado}
            ativo={canal.ativo}
            descricao={DESCRICOES[canal.canal]}
            ajustes={
              /*
                `items-stretch` (o padrão) de propósito: com `items-start`, o
                bloco do endereço adota a largura do CONTEÚDO — uma URL longa
                numa linha só — e vaza para fora do cartão. O `truncate` dele
                precisa de uma largura imposta de fora para ter o que truncar.
                Quem não pode esticar é só o botão, e isso se resolve nele.
              */
              <div className="flex flex-col gap-3">
                {/* O endereço de avisos do provedor (§8.1). Sem ele o canal
                    envia, mas nunca fica sabendo o que aconteceu depois. */}
                {canal.configurado ? (
                  <EnderecoRetorno
                    canal={canal.canal}
                    token={canal.webhookToken}
                    appUrl={appUrl}
                  />
                ) : null}

                <div>
                  <ConfigurarCanal
                    canal={canal.canal}
                    provider={canal.provider}
                    configurado={canal.configurado}
                    ativo={canal.ativo}
                  />
                </div>
              </div>
            }
          >
            {/*
              Os números ficam FORA dos ajustes: eles são a operação do canal,
              não a configuração dele. Quem abre a tela para pausar um chip que
              está falhando não deveria precisar expandir nada.
            */}
            {canal.canal === 'whatsapp' ? (
              <NumerosDeWhatsapp instancias={instancias} servidorPronto={servidorPronto} />
            ) : null}
          </CartaoCanal>
        ))}
      </div>
    </SessionFrame>
  )
}
