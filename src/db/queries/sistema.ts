import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { migrationsPendentes } from '@/db/migrate'
import { contarPendentes } from '@/lib/delivery/tick'
import { TAREFAS, ultimaExecucao } from '@/lib/manutencao'

/**
 * Diagnóstico do sistema, para a tela de Configurações → Sistema.
 *
 * Existe porque três das piores falhas deste projeto foram silenciosas: uma
 * migration que não rodou, um RLS que não protege e um batimento que nunca é
 * chamado. Nenhuma delas aparece como erro — todas aparecem como "está tudo
 * normal, mas nada acontece". Esta tela é o lugar onde elas viram visíveis.
 */

export type EstadoRls = {
  /** O papel `mandafy_app` existe neste banco? */
  papelExiste: boolean
  /** Com qual papel a aplicação está conectada agora? */
  papelAtual: string
  /**
   * A conexão da aplicação passa POR CIMA das políticas?
   *
   * Verdadeiro quando ela é superusuário, tem BYPASSRLS ou é dona das tabelas
   * — e nesse caso as políticas existem mas não protegem nada.
   */
  ignoraPoliticas: boolean
  /** Quantas tabelas têm RLS ligado. */
  tabelasComRls: number
}

/**
 * O RLS está realmente valendo?
 *
 * A pergunta parece boba e não é. As políticas de `drizzle/0010_rls.sql` são
 * criadas em qualquer banco, mas SEM `FORCE ROW LEVEL SECURITY` o dono das
 * tabelas passa por cima delas — e é exatamente o que acontece num Postgres
 * gerenciado onde a aplicação conecta com o papel administrador. O painel fica
 * idêntico, os testes passam, e o isolamento entre organizações não existe.
 *
 * `has_table_privilege` não responde isso: o dono passa com folga. Só os
 * atributos do papel e a propriedade das tabelas respondem.
 */
export async function estadoDoRls(): Promise<EstadoRls> {
  const [linha] = await db.execute<{
    papel_atual: string
    papel_existe: boolean
    super_ou_bypass: boolean
    dono_de_tabelas: boolean
    tabelas_com_rls: number
  }>(sql`
    SELECT
      current_user AS papel_atual,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mandafy_app') AS papel_existe,
      (SELECT bool_or(rolsuper OR rolbypassrls)
         FROM pg_roles WHERE rolname = current_user) AS super_ou_bypass,
      EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'contacts'
          AND pg_get_userbyid(c.relowner) = current_user
      ) AS dono_de_tabelas,
      (SELECT count(*)::int FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity) AS tabelas_com_rls
  `)

  return {
    papelExiste: linha?.papel_existe ?? false,
    papelAtual: linha?.papel_atual ?? 'desconhecido',
    ignoraPoliticas: Boolean(linha?.super_ou_bypass) || Boolean(linha?.dono_de_tabelas),
    tabelasComRls: linha?.tabelas_com_rls ?? 0,
  }
}

export type EstadoSistema = {
  migrations: {
    pendentes: string[]
    aplicadas: number
    total: number
    /** Papel com que as migrations seriam aplicadas, e se ele pode. */
    papel: string
    podeAplicar: boolean
  }
  rls: EstadoRls
  batimento: {
    /** `null` = nunca rodou. É o sinal de que ninguém está chamando /api/cron. */
    ultimaManutencao: Date | null
    ultimaZeragem: Date | null
    configurado: boolean
  }
  fila: { vencidos: number; futuros: number; esperaMaxSegundos: number }
  /** Erro ao consultar — o banco pode estar fora, e a tela precisa dizer isso. */
  erro?: string
}

export async function estadoDoSistema(): Promise<EstadoSistema> {
  const vazio: EstadoSistema = {
    migrations: { pendentes: [], aplicadas: 0, total: 0, papel: '?', podeAplicar: false },
    rls: { papelExiste: false, papelAtual: '?', ignoraPoliticas: false, tabelasComRls: 0 },
    batimento: { ultimaManutencao: null, ultimaZeragem: null, configurado: false },
    fila: { vencidos: 0, futuros: 0, esperaMaxSegundos: 0 },
  }

  try {
    const [migrations, rls, ultimaManutencao, ultimaZeragem, fila] = await Promise.all([
      migrationsPendentes(),
      estadoDoRls(),
      ultimaExecucao(TAREFAS.horaria),
      ultimaExecucao(TAREFAS.diaria),
      contarPendentes(),
    ])

    return {
      migrations,
      rls,
      batimento: {
        ultimaManutencao,
        ultimaZeragem,
        // A presença do segredo é a única coisa que a tela pode afirmar sem
        // chamar a si mesma. O valor nunca sai daqui.
        configurado: Boolean(process.env.CRON_SECRET),
      },
      fila,
    }
  } catch (erro) {
    return {
      ...vazio,
      erro: erro instanceof Error ? erro.message.slice(0, 300) : 'falha ao consultar o banco',
    }
  }
}
