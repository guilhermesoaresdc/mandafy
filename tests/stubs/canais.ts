import type postgres from 'postgres'
import { encryptSecret } from '@/lib/crypto'
import type { Channel } from '@/db/schema/enums'

/**
 * Configura os canais de uma organização de teste.
 *
 * POR QUE ISTO PASSOU A SER NECESSÁRIO
 *
 * `enfileirarEnvio` confere a configuração do canal ANTES de gravar qualquer
 * linha (ver `prontidao.ts`): canal sem credencial é barrado ali, sem virar
 * `notifications`. É o que impede um lote de mil contatos de encher o histórico
 * com mil linhas dizendo o mesmo "o SMS não está configurado".
 *
 * O efeito nos testes é que a precondição ficou explícita: enfileirar por
 * e-mail exige que a organização tenha e-mail configurado. Antes isso passava
 * porque a checagem só acontecia na hora de entregar, longe daqui — e um teste
 * de enfileiramento que enfileira por um canal inexistente estava, no fundo,
 * medindo menos do que aparentava.
 *
 * As credenciais são fictícias e nunca saem do banco de teste: nenhum teste
 * chega a falar com provedor de verdade (o `fetch` é substituído nos que
 * exercitam entrega).
 */

const CREDENCIAIS: Record<Exclude<Channel, 'whatsapp'>, { provider: string; cred: object }> = {
  email: { provider: 'resend', cred: { apiKey: 're_teste', remetente: 'Teste <envio@teste.local>' } },
  sms: { provider: 'smsdev', cred: { apiKey: 'sms_teste' } },
  telegram: { provider: 'telegram', cred: { botToken: '000:teste' } },
}

/**
 * Grava a apikey de uma instância de WhatsApp já inserida.
 *
 * A instância guarda a chave cifrada em `apikey_encrypted`; sem ela,
 * `resolverCanal` responde "a Evolution API não está configurada" e o canal é
 * barrado antes de enfileirar — que é o comportamento certo em produção e
 * apenas uma precondição a mais nos testes que exercitam WhatsApp.
 */
export async function conectarWhatsapp(
  admin: postgres.Sql,
  instanciaId: string,
  apikey = 'evo_teste',
): Promise<void> {
  await admin`
    UPDATE wa_instances
    SET apikey_encrypted = ${encryptSecret(JSON.stringify({ apikey }))}
    WHERE id = ${instanciaId}`
}

/**
 * Liga e-mail, SMS e Telegram na organização.
 *
 * O WhatsApp fica de fora de propósito: ele não depende de credencial, e sim de
 * um chip conectado em `wa_instances` — quem precisa dele insere a instância, e
 * quem quer testar a ausência dela simplesmente não insere.
 */
export async function configurarCanais(
  admin: postgres.Sql,
  orgId: string,
  canais: readonly Exclude<Channel, 'whatsapp'>[] = ['email', 'sms', 'telegram'],
): Promise<void> {
  for (const canal of canais) {
    const { provider, cred } = CREDENCIAIS[canal]

    await admin`
      INSERT INTO channel_configs (org_id, channel, provider, credentials_encrypted, active, is_default)
      VALUES (
        ${orgId}, ${canal}, ${provider},
        ${encryptSecret(JSON.stringify(cred))}, true, true
      )
      ON CONFLICT DO NOTHING`
  }
}
