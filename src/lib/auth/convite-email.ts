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

function corpo(dados: Dados): { assunto: string; texto: string } {
  const primeiro = dados.nome.trim().split(/\s+/)[0] ?? ''

  if (dados.proposito === 'convite') {
    return {
      assunto: `Seu acesso ao ${dados.organizacao}`,
      texto:
        `Olá${primeiro ? ` ${primeiro}` : ''},\n\n` +
        `Você foi cadastrado no painel do ${dados.organizacao}. ` +
        'Defina sua senha por este link:\n\n' +
        `${dados.link}\n\n` +
        'O link vale por 7 dias e só funciona uma vez.\n\n' +
        'Se você não esperava este convite, ignore este e-mail — sem a senha, ninguém entra.',
    }
  }

  return {
    assunto: `Redefinir sua senha do ${dados.organizacao}`,
    texto:
      `Olá${primeiro ? ` ${primeiro}` : ''},\n\n` +
      'Recebemos um pedido para redefinir sua senha. Use este link:\n\n' +
      `${dados.link}\n\n` +
      'O link vale por 1 hora e só funciona uma vez.\n\n' +
      'Se não foi você que pediu, ignore este e-mail. Sua senha atual continua valendo, ' +
      'e ninguém consegue entrar sem ela.',
  }
}

export async function enviarLinkDeSenha(dados: Dados): Promise<ResultadoConvite> {
  const { assunto, texto } = corpo(dados)

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
        assunto,
        corpo: texto,
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
