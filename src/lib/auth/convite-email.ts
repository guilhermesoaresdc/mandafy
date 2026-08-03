import 'server-only'

import { withTenant } from '@/db'
import { enviarPeloCanal } from '@/lib/channels'
import { resolverCanal } from '@/lib/delivery/config'
import { createLogger } from '@/lib/logger'
import type { Proposito } from './tokens'

/**
 * O e-mail que leva o link de senha (§9.4).
 *
 * Usa o MESMO canal de e-mail que a operação já configurou — o adaptador, o
 * provedor e o remetente verificado. Um segundo caminho de envio exigiria
 * outra credencial, outro domínio a verificar e outra coisa para quebrar em
 * silêncio; e a primeira vez que alguém descobriria que ele quebrou seria
 * quando não conseguisse entrar no painel.
 *
 * Custo dessa escolha: se o canal de e-mail não estiver configurado, o convite
 * não sai. Quem chama recebe isso no retorno e mostra o link na tela, para que
 * o administrador possa passá-lo por outro meio. Um convite que falha em
 * silêncio seria pior — a pessoa ficaria esperando um e-mail que nunca vem.
 */

const log = createLogger('convite')

export type ResultadoConvite = { enviado: true } | { enviado: false; motivo: string }

type Dados = {
  orgId: string
  para: string
  nome: string
  link: string
  proposito: Proposito
  /** Nome da organização, para a pessoa reconhecer de onde vem. */
  organizacao: string
}

/**
 * O HTML e o texto puro da mesma mensagem.
 *
 * Os DOIS são obrigatórios, e não por capricho. O adaptador manda o campo
 * `html` como está — sem ele, o texto puro iria para lá e chegaria como um
 * bloco único, porque HTML engole quebra de linha. E sem o texto puro, quem lê
 * e-mail sem HTML (e todo filtro de spam) recebe silêncio.
 *
 * O HTML é escrito com estilo em linha e sem CSS externo porque cliente de
 * e-mail não carrega folha de estilo. O botão é uma tabela pelo mesmo motivo:
 * é a única forma que o Outlook renderiza com fundo colorido.
 *
 * O endereço aparece POR EXTENSO embaixo do botão. Cliente corporativo bloqueia
 * botão, gente desconfia de link escondido, e quem lê no celular às vezes
 * precisa copiar para outro navegador.
 */
function escapar(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

type Texto = { assunto: string; titulo: string; frase: string; botao: string; prazo: string; rodape: string }

function conteudo(dados: Dados): Texto {
  const primeiro = dados.nome.trim().split(/\s+/)[0] ?? ''
  const ola = primeiro ? `Olá, ${primeiro}.` : 'Olá.'

  if (dados.proposito === 'convite') {
    return {
      assunto: `Seu acesso ao ${dados.organizacao}`,
      titulo: ola,
      frase: `Você foi cadastrado no painel do ${dados.organizacao}. Crie sua senha para entrar.`,
      botao: 'Criar minha senha',
      prazo: 'Este link vale por 7 dias e só funciona uma vez.',
      rodape:
        'Se você não esperava este convite, ignore este e-mail — sem definir a senha, ninguém entra.',
    }
  }

  return {
    assunto: `Redefinir sua senha do ${dados.organizacao}`,
    titulo: ola,
    frase: 'Recebemos um pedido para redefinir sua senha.',
    botao: 'Escolher senha nova',
    prazo: 'Este link vale por 1 hora e só funciona uma vez.',
    rodape:
      'Se não foi você que pediu, ignore este e-mail. Sua senha atual continua valendo, e ninguém entra sem ela.',
  }
}

function montarTexto(t: Texto, link: string): string {
  return [
    t.titulo,
    '',
    t.frase,
    '',
    link,
    '',
    t.prazo,
    '',
    t.rodape,
  ].join('\n')
}

function montarHtml(t: Texto, link: string, organizacao: string): string {
  const href = escapar(link)

  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;">
        <tr><td>
          <p style="margin:0 0 24px;font-size:15px;font-weight:700;color:#111827;">${escapar(organizacao)}</p>

          <p style="margin:0 0 8px;font-size:15px;color:#111827;">${escapar(t.titulo)}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#4b5563;">${escapar(t.frase)}</p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="border-radius:8px;background:#111827;">
              <a href="${href}" style="display:inline-block;padding:12px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapar(t.botao)}</a>
            </td></tr>
          </table>

          <p style="margin:24px 0 4px;font-size:12px;color:#6b7280;">Se o botão não abrir, copie este endereço:</p>
          <p style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${href}" style="color:#2563eb;">${href}</a></p>

          <p style="margin:0 0 16px;font-size:12px;color:#6b7280;">${escapar(t.prazo)}</p>

          <hr style="border:0;border-top:1px solid #e5e7eb;margin:0 0 16px;" />
          <p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af;">${escapar(t.rodape)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export async function enviarLinkDeSenha(dados: Dados): Promise<ResultadoConvite> {
  const t = conteudo(dados)
  const texto = montarTexto(t, dados.link)
  const html = montarHtml(t, dados.link, dados.organizacao)

  try {
    const canal = await withTenant(
      { orgId: dados.orgId, userId: dados.orgId, isAdmin: true },
      (tx) => resolverCanal(tx, dados.orgId, 'email'),
    )

    if (!canal.alvo) {
      return { enviado: false, motivo: canal.falta ?? 'o canal de e-mail não está configurado' }
    }

    const resultado = await enviarPeloCanal(
      {
        para: dados.para,
        assunto: t.assunto,
        corpo: texto,
        html,
        textoPuro: texto,
        /*
         * Sem link de descadastro, e isto é deliberado.
         *
         * É e-mail transacional de acesso à conta, não comunicação de
         * marketing: quem se descadastrasse deste ficaria sem conseguir
         * recuperar a própria senha. O rodapé de §14.1 vale para o que a
         * operação envia aos CONTATOS dela, não para o acesso da equipe ao
         * painel.
         */
      },
      canal.alvo,
    )

    if (!resultado.ok) {
      // Sem e-mail no log (§14.1) — só o código do provedor.
      log.warn('link de senha não saiu', { proposito: dados.proposito, codigo: resultado.codigo })
      return { enviado: false, motivo: resultado.mensagem.slice(0, 200) }
    }

    log.info('link de senha enviado', { proposito: dados.proposito })
    return { enviado: true }
  } catch (erro) {
    log.error('falha ao enviar link de senha', {
      proposito: dados.proposito,
      reason: erro instanceof Error ? erro.message.slice(0, 160) : 'desconhecido',
    })
    return { enviado: false, motivo: 'falha ao falar com o provedor de e-mail' }
  }
}
