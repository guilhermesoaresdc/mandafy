-- A hora do dia em que um passo sai (§5.1, §7.4).
--
-- O QUE FALTAVA
--
-- Um passo só sabia dizer "quanto tempo depois do anterior". Serve para a
-- cadência de PIX, onde a urgência é medida em minutos a partir do gatilho, e
-- não serve para o resto: "reativação +2 dias" cai exatamente na hora em que a
-- pessoa se cadastrou. Quem cria conta às 3h da manhã recebe a reativação às 3h
-- da manhã, dois dias depois.
--
-- A janela de silêncio (§7.4) empurra a madrugada para as 8h, mas ela é do
-- FLUXO inteiro e é uma barreira, não um horário: resolve "não acorde
-- ninguém", não resolve "esta mensagem rende mais às 10h".
--
-- POR QUE `time` E NÃO `timestamptz`
--
-- É uma hora do relógio, não um instante: "às 10:00" continua sendo 10:00 na
-- semana que vem. O fuso vem da organização (`organizations.timezone`), como em
-- todo o resto do sistema — 10:00 é 10:00 de quem recebe.
--
-- NULO É O PADRÃO, E CONTINUA SENDO O CERTO
--
-- Sem horário, o passo sai no instante calculado pela cascata, como sempre. É
-- o comportamento que a recuperação de PIX precisa: um lembrete de +5 min
-- adiado para as 10h da manhã seguinte não é um lembrete.
ALTER TABLE flow_steps
  ADD COLUMN IF NOT EXISTS send_at_local time;

COMMENT ON COLUMN flow_steps.send_at_local IS
  'Hora local (fuso da organização) em que o passo sai. Nulo = no instante da cascata.';
