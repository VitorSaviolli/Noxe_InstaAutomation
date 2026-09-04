-- Painel administrativo: codigos de recuperacao e o codigo unico de parada.
--
-- Regra de ouro: NENHUMA tabela do painel recebe escrita provocada por uma
-- requisicao NAO autenticada. A cota gratuita do D1 e 100.000 escritas/dia e e
-- COMPARTILHADA com a automacao: um bot que consegue gravar aqui derruba o
-- webhook junto.
--
-- Guardamos HMAC-SHA256(k_codigos, tipo|versao|codigo), nunca o codigo. E HMAC
-- e nao SHA-256 puro porque a "pimenta" impede ataque OFFLINE contra um dump:
-- sem o PANEL_SESSION_KEY nao da nem para testar candidatos.
CREATE TABLE IF NOT EXISTS painel_codigos (
  hash          TEXT PRIMARY KEY,
  tipo          TEXT    NOT NULL,             -- 'recuperacao' | 'parada'
  versao_hash   INTEGER NOT NULL DEFAULT 1,
  criado_em     INTEGER NOT NULL,
  usado_em      INTEGER,
  invalidado_em INTEGER
);

CREATE INDEX IF NOT EXISTS idx_painel_codigos_tipo
  ON painel_codigos (tipo, usado_em);
