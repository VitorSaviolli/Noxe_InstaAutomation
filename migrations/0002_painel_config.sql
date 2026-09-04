-- Configuracao global da automacao, agora editavel pelo painel.
--
-- Linha unica (id = 1), mesmo padrao de account_tokens: o projeto atende UMA
-- conta profissional. Colunas tipadas em vez de um JSON unico porque o banco e
-- fronteira: o CHECK e a segunda barreira depois do validador em TypeScript.
--
-- Os CHECK aqui sao tetos grosseiros de proposito: a rota de parada de
-- emergencia materializa esta linha a partir do padrao de fabrica, e nenhuma
-- restricao de schema pode ser o motivo de a parada falhar.
CREATE TABLE IF NOT EXISTS painel_config (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  enabled                INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trigger_keywords       TEXT    NOT NULL CHECK (
                           json_valid(trigger_keywords)
                           AND json_type(trigger_keywords) = 'array'
                           AND json_array_length(trigger_keywords) <= 20
                           AND length(trigger_keywords) <= 2000
                         ),
  match_mode             TEXT    NOT NULL CHECK (match_mode IN ('exact', 'contains')),
  case_sensitive         INTEGER NOT NULL CHECK (case_sensitive IN (0, 1)),
  normalize_accents      INTEGER NOT NULL CHECK (normalize_accents IN (0, 1)),
  ignore_punctuation     INTEGER NOT NULL CHECK (ignore_punctuation IN (0, 1)),
  process_only_reels     INTEGER NOT NULL CHECK (process_only_reels IN (0, 1)),

  -- Substitui allowedMediaIds. 'todas' vira ['*'] em memoria; 'selecionadas'
  -- vira a uniao dos media_id ativos de painel_midias. NAO guardamos a lista
  -- aqui de proposito: e o que impede uma automacao por Reel que nunca dispara
  -- porque o Reel ficou de fora da lista global.
  media_scope            TEXT    NOT NULL CHECK (media_scope IN ('todas', 'selecionadas')),

  public_reply_enabled   INTEGER NOT NULL CHECK (public_reply_enabled IN (0, 1)),
  public_reply_text      TEXT    NOT NULL CHECK (length(public_reply_text) <= 2000),
  private_reply_enabled  INTEGER NOT NULL CHECK (private_reply_enabled IN (0, 1)),
  private_reply_text     TEXT    NOT NULL CHECK (length(private_reply_text) <= 2000),

  -- O teto de 2048 acompanha MAX_LINK_LENGTH de src/utils/templates.ts.
  destination_url        TEXT    NOT NULL CHECK (length(destination_url) <= 2048),

  -- Horas inteiras. O piso 0 existe porque um valor negativo joga o cooldown
  -- para o futuro e desliga o freio EM SILENCIO, sem erro nenhum.
  user_cooldown_hours    INTEGER NOT NULL CHECK (user_cooldown_hours BETWEEN 0 AND 8760),

  -- Contador monotonico de TODA a configuracao (global + midias). Serve de
  -- carimbo do cache, de trava otimista na gravacao e de chave do log.
  versao                 INTEGER NOT NULL CHECK (versao >= 1),

  -- Epoch ms do ultimo acionamento bem-sucedido da parada de emergencia, ou
  -- NULL. Existe para o painel poder dizer "a automacao foi parada pelo codigo
  -- em <data>". NAO participa de nenhuma decisao do caminho quente.
  parado_por_codigo_em   INTEGER,

  criado_em              INTEGER NOT NULL,
  atualizado_em          INTEGER NOT NULL
);
-- Sem indice: uma linha so, busca sempre por id = 1, que ja e a chave primaria.


-- Midias escolhidas na tela, com sobreposicao opcional por midia.
--
-- media_id como PRIMARY KEY resolve no schema a ambiguidade do .find() de
-- resolveConfigForMedia: nao existe "duas entradas citando o mesmo Reel, a
-- primeira vence em silencio".
--
-- Toda coluna de sobreposicao e NULL-avel, e NULL significa CHAVE AUSENTE no
-- patch, nunca `undefined`: {...global, ...patch} com undefined explicito ZERA
-- o campo global e faz isDestinationUrlConfigured lancar TypeError dentro de
-- processComment, documentada como funcao que nunca lanca.
CREATE TABLE IF NOT EXISTS painel_midias (
  -- String opaca de 17-18 digitos. TEXT SEMPRE: converter para numero perde
  -- precisao acima de 2^53 e casa o Reel errado, sem erro nenhum.
  media_id               TEXT PRIMARY KEY,
  ativo                  INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),

  -- Metadados so para a tela. thumbnail_url e media_url NUNCA entram aqui:
  -- sao URLs assinadas que expiram.
  legenda_curta          TEXT    CHECK (legenda_curta IS NULL OR length(legenda_curta) <= 200),
  permalink              TEXT    CHECK (permalink IS NULL OR length(permalink) <= 512),
  media_product_type     TEXT    CHECK (media_product_type IS NULL OR length(media_product_type) <= 16),
  postado_em             INTEGER,
  visto_em               INTEGER,
  indisponivel_desde     INTEGER,

  -- --- Sobreposicoes. NULL = nao sobrepoe. ---
  -- enabled so aceita 0: uma midia pode PAUSAR, nunca ligar contra a chave
  -- geral. Um enabled = 1 aqui derrotaria a parada de emergencia, porque o
  -- patch e aplicado POR CIMA da global.
  enabled                INTEGER CHECK (enabled IS NULL OR enabled = 0),
  trigger_keywords       TEXT    CHECK (
                           trigger_keywords IS NULL OR (
                             json_valid(trigger_keywords)
                             AND json_type(trigger_keywords) = 'array'
                             AND json_array_length(trigger_keywords) <= 20
                             AND length(trigger_keywords) <= 2000
                           )
                         ),
  match_mode             TEXT    CHECK (match_mode IS NULL OR match_mode IN ('exact', 'contains')),
  case_sensitive         INTEGER CHECK (case_sensitive IS NULL OR case_sensitive IN (0, 1)),
  normalize_accents      INTEGER CHECK (normalize_accents IS NULL OR normalize_accents IN (0, 1)),
  ignore_punctuation     INTEGER CHECK (ignore_punctuation IS NULL OR ignore_punctuation IN (0, 1)),
  process_only_reels     INTEGER CHECK (process_only_reels IS NULL OR process_only_reels IN (0, 1)),
  public_reply_enabled   INTEGER CHECK (public_reply_enabled IS NULL OR public_reply_enabled IN (0, 1)),
  public_reply_text      TEXT    CHECK (public_reply_text IS NULL OR length(public_reply_text) <= 2000),
  private_reply_enabled  INTEGER CHECK (private_reply_enabled IS NULL OR private_reply_enabled IN (0, 1)),
  private_reply_text     TEXT    CHECK (private_reply_text IS NULL OR length(private_reply_text) <= 2000),
  destination_url        TEXT    CHECK (destination_url IS NULL OR length(destination_url) <= 2048),
  user_cooldown_hours    INTEGER CHECK (user_cooldown_hours IS NULL OR user_cooldown_hours BETWEEN 0 AND 8760),

  criado_em              INTEGER NOT NULL,
  atualizado_em          INTEGER NOT NULL
);
-- Sem indice secundario DE PROPOSITO. A unica consulta do caminho quente e
-- "todas as linhas ativas", que varre a tabela inteira — e a tabela tem teto de
-- 200 linhas. Um indice em `ativo` teria cardinalidade 2 (inutil) e faria cada
-- gravacao custar o dobro: um write na tabela e um no indice.


-- Log de auditoria das mudancas de configuracao. E a UNICA tabela de auditoria
-- do painel: nenhuma outra migration declara painel_auditoria.
--
-- id INTEGER PRIMARY KEY e o proprio rowid: ele JA e o indice cronologico. Sem
-- AUTOINCREMENT de proposito: AUTOINCREMENT obriga uma escrita extra em
-- sqlite_sequence a cada insert. A poda so apaga do lado ANTIGO (id <= X),
-- entao o maior id nunca e removido e a sequencia continua monotonica.
CREATE TABLE IF NOT EXISTS painel_auditoria (
  id            INTEGER PRIMARY KEY,
  ocorrido_em   INTEGER NOT NULL,
  versao        INTEGER NOT NULL,
  origem        TEXT    NOT NULL CHECK (origem IN ('painel', 'parada', 'assistente', 'migracao')),
  -- Passkey vira 'passkey:<8 hex do sha256 do credential_id>'; nunca o
  -- credential_id cru, para o log nao virar uma segunda copia do identificador.
  ator          TEXT    NOT NULL CHECK (length(ator) <= 64),
  step_up       INTEGER NOT NULL CHECK (step_up IN (0, 1)),
  acao          TEXT    NOT NULL CHECK (length(acao) <= 40),
  alvo          TEXT    CHECK (alvo IS NULL OR length(alvo) <= 32),
  campos        TEXT    NOT NULL CHECK (length(campos) <= 500),
  -- Estado COMPLETO da entidade afetada antes e depois, restrito aos campos de
  -- comportamento. NULL nos dois quando a mudanca foi RECUSADA ou quando o
  -- evento nao muda configuracao (login, parada, passkey).
  antes         TEXT    CHECK (antes IS NULL OR length(antes) <= 4000),
  depois        TEXT    CHECK (depois IS NULL OR length(depois) <= 4000)
);
