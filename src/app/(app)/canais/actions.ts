'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { withTenant, type Tx } from '@/db'
import { channelConfigs, waInstances } from '@/db/schema'
import { CHANNELS, type Channel } from '@/db/schema/enums'
import { serverEnv } from '@/env'
import { requireAdmin, tenantOf } from '@/lib/auth/current'
import { assertCan } from '@/lib/rbac'
import { encryptSecret } from '@/lib/crypto'
import { createLogger } from '@/lib/logger'
import { religarCanal } from '@/lib/delivery/disjuntor'
import { toE164 } from '@/lib/phone'
import { CANAL_PROVEDORES } from '@/lib/channels'
import { gerarTokenRetorno } from '@/lib/channels/retorno-lookup'
import {
  apagarInstancia,
  criarInstancia,
  desconectar,
  estadoDaConexao,
  gerarTokenWebhook,
  nomeDeInstancia,
  normalizarUrlEvolution,
  verificarServidor,
  obterQr,
  traduzirEstado,
} from '@/lib/channels/evolution-admin'
import { abrirCredenciais, resolverServidorEvolution } from '@/lib/delivery/config'
import { limitesDoEstagio } from '@/lib/delivery/warmup'

/**
 * Configuração dos canais (§8, §14.1).
 *
 * As credenciais são cifradas com AES-256-GCM ANTES de tocar o banco, e nunca
 * voltam para a tela. Quem quiser trocar a chave digita a nova; não há "ver a
 * chave atual", de propósito.
 */

const log = createLogger('canais')

export type CanalState = {
  erro?: string
  ok?: boolean
  /**
   * Salvou, mas o endereço não respondeu. Aviso e não erro: a Evolution pode
   * estar fora do ar num momento em que a credencial está certa, e recusar a
   * gravação nesse caso obrigaria a redigitar tudo depois.
   */
  aviso?: string
}

const canalSchema = z.object({
  canal: z.enum(CHANNELS),
  provider: z.string().trim().min(1).max(40),
  // Vazio significa "não mexer": permite ligar/desligar sem redigitar a chave.
  apiKey: z.string().trim().max(500).optional(),
  remetente: z.string().trim().max(200).optional(),
  /** Só o WhatsApp usa: o endereço da Evolution. */
  url: z.string().trim().max(300).optional(),
  /** Segredo com que o provedor assina o retorno (Resend, Telegram). */
  webhookSecret: z.string().trim().max(200).optional(),
  ativo: z.coerce.boolean(),
})

export async function salvarCanalAction(
  _prev: CanalState,
  formData: FormData,
): Promise<CanalState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = canalSchema.safeParse({
    canal: formData.get('canal'),
    provider: formData.get('provider'),
    apiKey: formData.get('apiKey') ?? undefined,
    remetente: formData.get('remetente') ?? undefined,
    url: formData.get('url') ?? undefined,
    webhookSecret: formData.get('webhookSecret') ?? undefined,
    ativo: formData.get('ativo') === 'on',
  })
  if (!parsed.success) return { erro: 'Dados inválidos.' }

  const { canal, provider, apiKey, remetente, url, webhookSecret, ativo } = parsed.data

  const permitidos = CANAL_PROVEDORES[canal]
  if (!permitidos.includes(provider)) {
    return { erro: `Provedor não suportado para ${canal}. Use: ${permitidos.join(', ')}.` }
  }

  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    return { erro: 'O endereço da Evolution precisa começar com http:// ou https://.' }
  }

  try {
    await withTenant(tenantOf(user), async (tx) => {
      const [existente] = await tx
        .select({
          id: channelConfigs.id,
          credentials: channelConfigs.credentialsEncrypted,
          webhookToken: channelConfigs.webhookToken,
        })
        .from(channelConfigs)
        .where(
          and(
            eq(channelConfigs.orgId, user.orgId),
            eq(channelConfigs.channel, canal),
            eq(channelConfigs.isDefault, true),
          ),
        )
        .limit(1)

      /*
       * Mescla com o que já estava lá em vez de substituir o blob inteiro.
       * O WhatsApp precisa de DOIS segredos — endereço e chave global — e é
       * normal preencher um hoje e o outro amanhã. Substituir faria o segundo
       * salvamento apagar o primeiro, e o canal voltaria a "não configurado"
       * sem ninguém entender por quê.
       */
      const atuais = abrirCredenciais(existente?.credentials ?? null)
      const mescladas: Record<string, string> = {
        ...atuais,
        ...(apiKey ? { apiKey, botToken: apiKey } : {}),
        // O WhatsApp lê `apikey`/`url` minúsculos (ver resolverCanal).
        ...(apiKey && canal === 'whatsapp' ? { apikey: apiKey } : {}),
        ...(remetente ? { remetente } : {}),
        // Tira `/manager` do fim: é o endereço que a pessoa tem à mão, e sem
        // isso toda chamada à API vira 404 (ver normalizarUrlEvolution).
        ...(url ? { url: normalizarUrlEvolution(url) } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      }

      const novasCredenciais =
        Object.keys(mescladas).length > 0 ? encryptSecret(JSON.stringify(mescladas)) : null

      /*
       * O token do webhook nasce junto com o canal e nunca é regerado: ele já
       * está colado no painel do provedor, e trocá-lo em um salvamento
       * qualquer derrubaria o retorno em silêncio — o pior modo de falha que
       * existe aqui, porque nada no painel muda de cor.
       */
      if (existente) {
        await tx
          .update(channelConfigs)
          .set({
            provider,
            active: ativo,
            // Campo em branco preserva a credencial atual.
            ...(novasCredenciais ? { credentialsEncrypted: novasCredenciais } : {}),
            ...(existente.webhookToken ? {} : { webhookToken: gerarTokenRetorno() }),
            updatedAt: new Date(),
          })
          .where(eq(channelConfigs.id, existente.id))
        return
      }

      await tx.insert(channelConfigs).values({
        orgId: user.orgId,
        channel: canal,
        provider,
        active: ativo,
        isDefault: true,
        credentialsEncrypted: novasCredenciais,
        webhookToken: gerarTokenRetorno(),
      })
    })
  } catch (erro) {
    // A mensagem de um erro de AES pode dizer coisas sobre a chave; só o canal
    // vai para o log.
    log.error('falha ao salvar canal', { canal })
    if (erro instanceof Error && erro.message.includes('ENCRYPTION_KEY')) {
      return { erro: 'ENCRYPTION_KEY não está configurada no ambiente.' }
    }
    return { erro: 'Não foi possível salvar. Tente de novo.' }
  }

  revalidatePath('/canais')

  /*
   * Confere o endereço DEPOIS de salvar, e só avisa.
   *
   * Sem isto, um endereço errado só se manifestava lá na frente: o canal
   * aparecia configurado, o botão do QR não fazia nada, e nada dizia se o
   * problema era o endereço, a chave ou o servidor fora do ar. Colar o
   * endereço do Manager (terminado em /manager) caía exatamente aí.
   *
   * Não bloqueia a gravação: a Evolution pode estar fora do ar num momento em
   * que a credencial está certa, e recusar obrigaria a redigitar tudo depois.
   */
  if (canal === 'whatsapp') {
    try {
      const servidor = await withTenant(tenantOf(user), (tx) =>
        resolverServidorEvolution(tx, user.orgId),
      )

      if (servidor) {
        const teste = await verificarServidor(servidor)
        if (!teste.ok) return { ok: true, aviso: explicarFalhaDoServidor(teste.codigo) }
      }
    } catch {
      // Um problema ao VERIFICAR não pode desfazer um salvamento que deu certo.
      log.warn('não foi possível verificar o servidor da Evolution')
    }
  }

  return { ok: true }
}

/** O que fazer, em português, para cada motivo de recusa do servidor. */
function explicarFalhaDoServidor(codigo: string): string {
  switch (codigo) {
    case 'credencial_recusada':
      return 'Salvo, mas a Evolution recusou a chave. Confira se é a AUTHENTICATION_API_KEY do servidor.'
    case 'nao_encontrada':
      return 'Salvo, mas esse endereço não respondeu como uma Evolution. Use a raiz do servidor (http://ip:8080), não a página do Manager.'
    case 'servidor_indisponivel':
      return 'Salvo, mas a Evolution não respondeu. Confira se ela está no ar.'
    case 'rede':
      return 'Salvo, mas não foi possível alcançar esse endereço. Ele precisa ser acessível pela internet — endereço local ou porta fechada não serve.'
    default:
      return 'Salvo, mas a Evolution não respondeu como esperado nesse endereço.'
  }
}

// ── Provisionar da própria tela: criar na Evolution e ler o QR (§7.3) ────────

/**
 * O QR aparece aqui dentro; ninguém precisa abrir o Manager da Evolution.
 *
 * A chave GLOBAL faz isso, e ela alcança todas as instâncias do servidor —
 * inclusive as de outro sistema que compartilhe a mesma Evolution. Por isso a
 * regra vale para TODAS as ações abaixo: só age sobre instância que tem linha
 * em `wa_instances` da organização de quem clicou. O Mandafy não lista, não
 * enxerga e não toca no que não é dele.
 */

/** Encontra a instância da organização, ou nada. Nenhuma ação pula por aqui. */
async function instanciaDaOrg(tx: Tx, orgId: string, id: string) {
  const [linha] = await tx
    .select({
      id: waInstances.id,
      name: waInstances.name,
      instanceName: waInstances.instanceName,
      evolutionUrl: waInstances.evolutionUrl,
      managed: waInstances.managed,
      status: waInstances.status,
    })
    .from(waInstances)
    .where(and(eq(waInstances.id, id), eq(waInstances.orgId, orgId)))
    .limit(1)

  return linha ?? null
}

const novaInstanciaSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome ao número.').max(80),
})

export type NovaInstanciaState = { erro?: string; instanciaId?: string }

export async function criarInstanciaAction(
  _prev: NovaInstanciaState,
  formData: FormData,
): Promise<NovaInstanciaState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = novaInstanciaSchema.safeParse({ nome: formData.get('nome') })
  if (!parsed.success) return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }

  const instanceName = nomeDeInstancia(parsed.data.nome)
  const token = gerarTokenWebhook()

  try {
    const criada = await withTenant(tenantOf(user), async (tx) => {
      const servidor = await resolverServidorEvolution(tx, user.orgId)
      if (!servidor) {
        return {
          erro:
            'Configure primeiro o endereço da Evolution e a chave global, no cartão do WhatsApp acima.',
        } as const
      }

      /*
       * A instância nasce na Evolution ANTES da linha no banco. Se a ordem
       * fosse a inversa e a criação lá falhasse, sobraria uma linha órfã que o
       * rodízio escolheria para enviar — e todo envio dela falharia com 404.
       */
      const resultado = await criarInstancia(servidor, {
        instanceName,
        webhookUrl: `${serverEnv().APP_URL.replace(/\/+$/, '')}/api/evolution/${token}`,
      })

      if (!resultado.ok) return { erro: resultado.mensagem } as const

      const limites = limitesDoEstagio(0)

      const [linha] = await tx
        .insert(waInstances)
        .values({
          orgId: user.orgId,
          name: parsed.data.nome,
          evolutionUrl: servidor.url,
          instanceName: resultado.instancia.instanceName,
          apikeyEncrypted: encryptSecret(
            JSON.stringify({ apikey: resultado.instancia.apikey }),
          ),
          status: 'conectando',
          managed: true,
          webhookToken: token,
          warmupStage: 0,
          warmupStartedAt: new Date(),
          ...limites,
        })
        .returning({ id: waInstances.id })

      return { instanciaId: linha?.id } as const
    })

    if ('erro' in criada) return { erro: criada.erro }

    revalidatePath('/canais')
    return criada.instanciaId ? { instanciaId: criada.instanciaId } : { erro: 'Falha ao gravar.' }
  } catch (erro) {
    log.error('falha ao criar instância', {
      reason: erro instanceof Error ? erro.message.slice(0, 120) : 'desconhecido',
    })
    return { erro: 'Não foi possível criar o número. Confira o endereço e a chave da Evolution.' }
  }
}

export type EstadoQr = {
  /** `qr` = leia; `conectado` = pronto; `aguardando` = a Evolution ainda gera. */
  estado: 'qr' | 'conectado' | 'aguardando' | 'erro'
  base64?: string
  /** Código de pareamento por número, alternativa a ler a imagem. */
  pairingCode?: string
  erro?: string
}

/**
 * O QR atual da instância. A tela chama isso em laço até conectar.
 *
 * A cada chamada o estado real da conexão é gravado em `wa_instances`: assim o
 * painel de saúde fica certo mesmo se o `connection.update` se perder — o
 * webhook é entrega best-effort, e depender só dele deixaria a tela mentindo.
 */
export async function qrDaInstanciaAction(id: string): Promise<EstadoQr> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  try {
    return await withTenant(tenantOf(user), async (tx) => {
      const instancia = await instanciaDaOrg(tx, user.orgId, id)
      if (!instancia) return { estado: 'erro', erro: 'Número não encontrado.' }

      const servidor = await resolverServidorEvolution(tx, user.orgId)
      if (!servidor) return { estado: 'erro', erro: 'A Evolution não está configurada.' }

      const conexao = await estadoDaConexao(servidor, instancia.instanceName)
      if (conexao.ok) {
        const traduzido = traduzirEstado(conexao.estado)
        await tx
          .update(waInstances)
          .set({
            status: traduzido,
            ...(traduzido === 'conectado' ? { lastConnectedAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(waInstances.id, instancia.id))

        if (conexao.estado === 'open') return { estado: 'conectado' }
      }

      const qr = await obterQr(servidor, instancia.instanceName)
      if (!qr.ok) return { estado: 'erro', erro: qr.mensagem }
      if (qr.qr.estado === 'conectado') return { estado: 'conectado' }
      if (qr.qr.estado === 'aguardando') return { estado: 'aguardando' }

      return {
        estado: 'qr',
        ...(qr.qr.base64 ? { base64: qr.qr.base64 } : {}),
        ...(qr.qr.pairingCode ? { pairingCode: qr.qr.pairingCode } : {}),
      }
    })
  } catch {
    return { estado: 'erro', erro: 'Não foi possível falar com a Evolution.' }
  }
}

export async function desconectarNumeroAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    const instancia = await instanciaDaOrg(tx, user.orgId, id)
    if (!instancia) return

    const servidor = await resolverServidorEvolution(tx, user.orgId)
    if (servidor) await desconectar(servidor, instancia.instanceName)

    await tx
      .update(waInstances)
      .set({ status: 'desconectado', updatedAt: new Date() })
      .where(eq(waInstances.id, instancia.id))
  })

  revalidatePath('/canais')
}

/**
 * Remove o número.
 *
 * Se o Mandafy criou a instância, ela some do servidor junto. Se as
 * credenciais foram coladas de fora, some SÓ a linha daqui — apagar lá
 * derrubaria o WhatsApp de quem já usava aquela Evolution. A distinção vem da
 * coluna `managed`, não de um palpite sobre o nome.
 */
export async function removerNumeroAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    const instancia = await instanciaDaOrg(tx, user.orgId, id)
    if (!instancia) return

    if (instancia.managed) {
      const servidor = await resolverServidorEvolution(tx, user.orgId)
      if (servidor) await apagarInstancia(servidor, instancia.instanceName, true)
    }

    await tx.delete(waInstances).where(eq(waInstances.id, instancia.id))
  })

  revalidatePath('/canais')
}

const instanciaSchema = z.object({
  nome: z.string().trim().min(2, 'Dê um nome ao número.').max(80),
  evolutionUrl: z.url('O endereço da Evolution precisa ser uma URL.'),
  instanceName: z.string().trim().min(1, 'Informe o nome da instância.').max(80),
  apikey: z.string().trim().min(1, 'Informe a apikey da instância.').max(500),
  telefone: z.string().trim().max(30).optional(),
})

export async function conectarNumeroAction(
  _prev: CanalState,
  formData: FormData,
): Promise<CanalState> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const parsed = instanciaSchema.safeParse({
    nome: formData.get('nome'),
    evolutionUrl: formData.get('evolutionUrl'),
    instanceName: formData.get('instanceName'),
    apikey: formData.get('apikey'),
    telefone: formData.get('telefone') ?? undefined,
  })
  if (!parsed.success) {
    return { erro: parsed.error.issues[0]?.message ?? 'Dados inválidos.' }
  }

  const dados = parsed.data

  try {
    await withTenant(tenantOf(user), async (tx) => {
      // Todo número novo começa no estágio 0 da escada (§7.3): 20/dia, 60s de
      // intervalo. Não há atalho — pular o aquecimento é o caminho do ban.
      const limites = limitesDoEstagio(0)

      await tx.insert(waInstances).values({
        orgId: user.orgId,
        name: dados.nome,
        evolutionUrl: dados.evolutionUrl,
        instanceName: dados.instanceName,
        apikeyEncrypted: encryptSecret(JSON.stringify({ apikey: dados.apikey })),
        phoneE164: dados.telefone ? toE164(dados.telefone) : null,
        status: 'conectando',
        /*
         * Credencial colada de fora: a instância já existia, e provavelmente
         * outro sistema depende dela. Removê-la aqui apaga só esta linha.
         */
        managed: false,
        warmupStage: 0,
        warmupStartedAt: new Date(),
        ...limites,
      })
    })
  } catch (erro) {
    log.error('falha ao conectar número', {
      reason: erro instanceof Error && erro.message.includes('unique') ? 'nome_repetido' : 'desconhecido',
    })
    if (erro instanceof Error && erro.message.includes('wa_instances_org_name_uq')) {
      return { erro: 'Já existe um número com esse nome de instância.' }
    }
    return { erro: 'Não foi possível conectar o número. Confira os dados da Evolution.' }
  }

  revalidatePath('/canais')
  return { ok: true }
}

export async function alternarNumeroAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const id = String(formData.get('id') ?? '')
  const ativar = formData.get('ativar') === '1'
  if (!id) return

  await withTenant(tenantOf(user), async (tx) => {
    await tx
      .update(waInstances)
      .set({ active: ativar, updatedAt: new Date() })
      .where(and(eq(waInstances.id, id), eq(waInstances.orgId, user.orgId)))
  })

  revalidatePath('/canais')
}

export async function alternarCanalConfigAction(formData: FormData): Promise<void> {
  const user = await requireAdmin()
  assertCan(user, 'integracoes.gerenciar')

  const canal = String(formData.get('canal') ?? '') as Channel
  const ativar = formData.get('ativar') === '1'
  if (!CHANNELS.includes(canal)) return

  await withTenant(tenantOf(user), async (tx) => {
    /*
     * Ligar de novo é o "verifiquei" do disjuntor (§8.1), e por isso passa por
     * `religarCanal`: além de `active`, ele limpa a contagem de falhas e a
     * marca de quem desligou. Sem isso, o canal voltaria com duas falhas já
     * contadas — a primeira falha seguinte o derrubaria de novo na hora — e a
     * tela continuaria dizendo "o sistema desligou este canal" logo depois de
     * a pessoa tê-lo ligado.
     */
    if (ativar) {
      await religarCanal(tx, user.orgId, canal)
      return
    }

    await tx
      .update(channelConfigs)
      .set({ active: false, disabledAt: null, disabledReason: null, updatedAt: new Date() })
      .where(and(eq(channelConfigs.orgId, user.orgId), eq(channelConfigs.channel, canal)))
  })

  revalidatePath('/canais')
  revalidatePath('/painel')
}
