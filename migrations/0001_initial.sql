-- Registro dos comentarios processados.
-- O comment_id e UNIQUE: e o que impede processar duas vezes o mesmo evento
-- quando a Meta reenvia o webhook.
CREATE TABLE IF NOT EXISTS processed_comments (
  comment_id                TEXT PRIMARY KEY,
  media_id                  TEXT NOT NULL,
  -- SHA-256 do IGSID do autor. Guardamos o hash, nao o ID, para minimizar
  -- dado pessoal: serve para cooldown sem permitir reidentificar a pessoa.
  commenter_scoped_id_hash  TEXT NOT NULL,
  status                    TEXT NOT NULL,
  private_message_id        TEXT,
  public_reply_id           TEXT,
  attempt_count             INTEGER NOT NULL DEFAULT 0,
  last_error_code           TEXT,
  next_retry_at             INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

-- Varredura do cron: busca registros prontos para nova tentativa.
CREATE INDEX IF NOT EXISTS idx_comments_retry
  ON processed_comments (status, next_retry_at);

-- Cooldown por usuario: "esta pessoa ja acionou nas ultimas N horas?"
CREATE INDEX IF NOT EXISTS idx_comments_commenter
  ON processed_comments (commenter_scoped_id_hash, created_at);

-- Access token da conta, cifrado com AES-GCM.
-- Tabela de linha unica: id sempre 1.
CREATE TABLE IF NOT EXISTS account_tokens (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  ig_user_id            TEXT NOT NULL,
  username              TEXT,
  encrypted_token       TEXT NOT NULL,
  -- Epoch ms em que o token expira, para o cron renovar antes.
  expires_at            INTEGER NOT NULL,
  last_refreshed_at     INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
