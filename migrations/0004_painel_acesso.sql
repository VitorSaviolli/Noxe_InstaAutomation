-- Painel administrativo: credenciais WebAuthn, sessoes e convites consumidos.
-- Mesma regra de ouro do 0003.

-- Estado singleton do painel. Existe para guardar o user.id do WebAuthn: ele
-- precisa ser ESTAVEL, senao cada registro cria uma entrada separada no
-- gerenciador de senhas do celular em vez de agrupar as passkeys do dono.
-- NAO guarda estado de configuracao: parado_por_codigo_em mora em painel_config.
CREATE TABLE IF NOT EXISTS painel_estado (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  usuario_handle    TEXT    NOT NULL,
  criado_em         INTEGER NOT NULL,
  atualizado_em     INTEGER NOT NULL
);

-- Passkeys registradas. O rp_id fica gravado em CADA linha porque ele e
-- imutavel dentro da credencial: se o endereco do painel mudar, estas linhas
-- nao "migram", elas viram inuteis. Guardando o rp_id conseguimos IGNORAR as
-- antigas e explicar na tela, em vez de devolver um erro incompreensivel.
CREATE TABLE IF NOT EXISTS painel_credenciais (
  credential_id     TEXT PRIMARY KEY,          -- base64url, como o navegador mandou
  rp_id             TEXT    NOT NULL,
  usuario_handle    TEXT    NOT NULL,
  chave_publica_jwk TEXT    NOT NULL,          -- JWK em JSON. Chave PUBLICA: sem cifra
  algoritmo         INTEGER NOT NULL,          -- COSE alg: -7 (ES256) ou -257 (RS256)
  transportes       TEXT,                      -- JSON array; so dica de UI, nunca decisao
  sign_count        INTEGER NOT NULL DEFAULT 0,
  backup_eligible   INTEGER NOT NULL DEFAULT 0,
  backup_state      INTEGER NOT NULL DEFAULT 0,
  apelido           TEXT    NOT NULL,
  origem_registro   TEXT    NOT NULL,          -- 'convite' | 'sessao' | 'recuperacao'
  criado_em         INTEGER NOT NULL,
  usado_em          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_painel_credenciais_rp
  ON painel_credenciais (rp_id);

-- Sessoes ativas. O cookie carrega um identificador aleatorio; aqui fica so o
-- SHA-256 dele. Um dump do D1 nao entrega cookie utilizavel, do mesmo jeito que
-- a tabela de comentarios guarda hash do IGSID e nao o IGSID.
CREATE TABLE IF NOT EXISTS painel_sessoes (
  sid_hash        TEXT PRIMARY KEY,
  credential_id   TEXT    NOT NULL,
  rp_id           TEXT    NOT NULL,           -- copiado da credencial: evita JOIN
  criada_em       INTEGER NOT NULL,
  expira_em       INTEGER NOT NULL,           -- teto absoluto, nunca estendido
  ociosa_ate      INTEGER NOT NULL,           -- janela deslizante
  vista_em        INTEGER NOT NULL,
  falhas_stepup   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_painel_sessoes_cred
  ON painel_sessoes (credential_id);

-- Nonces de convite JA CONSUMIDOS. So entra linha aqui DEPOIS que a assinatura
-- HMAC do convite foi conferida: quem nao tem o SETUP_ADMIN_TOKEN nao consegue
-- provocar nem uma escrita nesta tabela.
CREATE TABLE IF NOT EXISTS painel_convites_usados (
  nonce         TEXT PRIMARY KEY,
  consumido_em  INTEGER NOT NULL,
  expira_em     INTEGER NOT NULL              -- so para a faxina do cron
);
