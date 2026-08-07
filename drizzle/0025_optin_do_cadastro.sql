-- O consentimento do cadastro nunca era registrado, e a base inteira ficou muda (§14.1, §5.3).
--
-- SINTOMA: todo envio promocional parava na guarda com `sem_optin`. O histórico
-- mostrava contato após contato pulado pelo mesmo motivo — "sem consentimento
-- para mensagem promocional" — para gente que tinha, sim, aceitado receber:
-- o aceite acontece no cadastro da plataforma de sorteio, ANTES de o webhook
-- chegar aqui.
--
-- CAUSA: `upsertContact` gravava nome, telefone e e-mail e deixava `optin_at`
-- nulo. A guarda de base legal exige data de consentimento para as categorias
-- `recuperacao` e `relacionamento`, então nenhuma das duas saía. Só a
-- importação por planilha registrava o aceite (`optin_source = 'import'`);
-- quem entrava pelo webhook — que é a maioria — não registrava nada.
--
-- A ingestão passa a gravar `optin_source = 'checkout'` com a data do evento.
-- Esta migration faz o mesmo pelo que já está no banco: sem ela, a correção
-- valeria apenas para cadastro novo, e toda a base acumulada continuaria
-- barrada até que a plataforma mandasse um evento novo de cada pessoa.
--
-- A GUARDA CONTINUA DE PÉ, E É DE PROPÓSITO
--
-- O que estava errado era o registro do consentimento, não a verificação dele.
-- Apagar a regra deixaria de proteger quem pediu para sair no dia em que
-- alguém importar uma lista sem base legal. Por isso o preenchimento é
-- deliberadamente conservador:
--
--   * `opted_out_at IS NULL` — quem pediu para sair não é reativado por
--     nenhuma migration. Essa linha não se cruza.
--   * `optin_at IS NULL` — quem já tinha consentimento registrado mantém a
--     data original, que é a que vale numa auditoria.
--
-- A data usada é `first_seen_at`: o momento em que a pessoa apareceu pela
-- primeira vez, que é quando o cadastro aconteceu. Carimbar `now()` diria que
-- todo mundo consentiu no dia do deploy — uma data que não corresponde a fato
-- nenhum e que não se sustenta se alguém perguntar.
UPDATE contacts
SET optin_at = first_seen_at,
    optin_source = COALESCE(optin_source, 'checkout'),
    updated_at = now()
WHERE optin_at IS NULL
  AND opted_out_at IS NULL;

COMMENT ON COLUMN contacts.optin_at IS
  'Quando a pessoa consentiu. Vem do cadastro na plataforma (checkout), da planilha (import) ou da API. Nulo bloqueia envio promocional na guarda de §5.3.';
