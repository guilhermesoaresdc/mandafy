-- O disjuntor do canal: duas falhas iguais e ele desliga sozinho (§8.1).
--
-- O QUE ACONTECIA
--
-- Um canal quebrado — chave trocada, saldo no fim, chip do WhatsApp caído —
-- falhava em TODAS as mensagens, e cada uma virava uma linha vermelha no
-- histórico. Mil leads num lote com o SMS de credencial vencida: mil linhas
-- dizendo a mesma coisa, e a coisa que elas diziam não era sobre nenhum
-- daqueles mil contatos. O histórico é onde se procura UMA mensagem entre
-- milhares, e ele ficava soterrado por um problema único.
--
-- `prontidao.ts` já resolvia metade disso: barra o canal ANTES de gravar mil
-- linhas quando dá para saber de antemão que ele não tem como funcionar. O que
-- faltava é o caso em que só o provedor sabe — a credencial existe e está
-- errada, o saldo acabou, a instância caiu depois do agendamento. Aí a falha
-- só aparece no envio, uma por mensagem, para sempre.
--
-- COMO FUNCIONA
--
-- Cada falha DE CANAL incrementa `consecutive_failures`. Falha com código
-- diferente da anterior reinicia a contagem em 1. Envio bem-sucedido zera.
-- Na segunda falha igual seguida, `active` vai a falso e `disabled_at` marca
-- que quem desligou foi o sistema, não a pessoa — a diferença importa, porque
-- as duas telas precisam dizer coisas diferentes.
--
-- FALHA DE CANAL, E NÃO QUALQUER FALHA
--
-- Esta é a parte que, feita errada, transforma a proteção em estrago. Um
-- número que não tem WhatsApp (`sem_whatsapp`), um e-mail que não existe
-- (`destino_invalido`), alguém que bloqueou a banca (`bloqueado_pelo_destino`)
-- são fatos DAQUELE CONTATO. Contá-los aqui faria dois cadastros com telefone
-- errado derrubarem o WhatsApp da banca inteira — o oposto do que se quer.
--
-- Só contam os códigos que valem para todo mundo igualmente e que uma pessoa
-- precisa ir consertar: `sem_credencial`, `credencial_recusada`,
-- `instancia_desconectada`, `provedor_indisponivel`, `servidor_indisponivel`,
-- `limite_provedor`, `resposta_inesperada`, `rede`. A lista mora em
-- `src/lib/delivery/disjuntor.ts`, junto com a regra.
ALTER TABLE channel_configs
  ADD COLUMN IF NOT EXISTS consecutive_failures smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason text;

COMMENT ON COLUMN channel_configs.consecutive_failures IS
  'Falhas de canal seguidas com o mesmo código. Zera no primeiro envio que sai.';

COMMENT ON COLUMN channel_configs.last_error_code IS
  'Código da última falha de canal — é o que define se a próxima conta como "igual".';

COMMENT ON COLUMN channel_configs.disabled_at IS
  'Quando o disjuntor desligou o canal. Nulo = se está desligado, foi alguém que desligou.';

COMMENT ON COLUMN channel_configs.disabled_reason IS
  'O que o provedor respondeu na falha que derrubou o canal, para a tela poder explicar.';
