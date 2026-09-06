-- Teto de `antes` e `depois` em `painel_auditoria`: 4000 -> 8000.
--
-- POR QUE. O CHECK de 4000 da migration 0002 e ALCANCAVEL por uma configuracao
-- inteiramente LEGAL, e quando ele estoura o `db.batch()` inteiro falha — a
-- gravacao vira 500 e o dono nao consegue mais salvar nem uma palavra. A conta,
-- com os limites de `src/services/config-validation.ts`:
--
--   triggerKeywords   20 itens x 40 caracteres + aspas e virgulas ...  886
--   privateReplyText  MAX_CARACTERES_DO_TEXTO ............ 500 + aspas 502
--   publicReplyText   MAX_CARACTERES_DO_TEXTO ............ 500 + aspas 502
--   destinationUrl    MAX_CARACTERES_DO_LINK ............ 2048 + aspas 2050
--   os 10 campos restantes, com as chaves e a pontuacao do JSON .....  290
--                                                            total  ~4230
--
-- 4230 > 4000: a linha de auditoria nao cabe, e o CHECK derruba a mudanca que
-- ela deveria registrar. E "sem log, sem mudanca" virando "sem mudanca
-- nenhuma".
--
-- POR QUE 8000, E NAO 4300. A etapa das midias grava `antes`/`depois` de uma
-- linha de `painel_midias`, que carrega as PROPRIAS sobreposicoes de texto e de
-- link alem dos campos de comportamento. Um teto colado no maximo de hoje
-- estouraria de novo na primeira sobreposicao cheia, e cada aumento custa uma
-- migration. 8000 e o dobro do pior caso conhecido e continua sendo um teto —
-- a coluna nao vira campo livre.
--
-- POR QUE UMA MIGRATION NOVA, E NAO UMA EDICAO DA 0002. Migration entregue
-- nunca e editada (`CHECKSUMS.txt`): quem ja aplicou a 0002 nao receberia a
-- mudanca, e `CREATE TABLE IF NOT EXISTS` transformaria a diferenca num no-op
-- silencioso que so aparece la na frente.
--
-- POR QUE UM REBUILD, E NAO UM `ALTER TABLE`. O SQLite nao sabe alterar um
-- CHECK: `ALTER TABLE ... ALTER COLUMN` nao existe. O rebuild abaixo e o
-- procedimento padrao do proprio SQLite — tabela nova, copia, DROP, RENAME —
-- e ele e barato aqui porque §8.9 fixa a tabela em no maximo 500 linhas.
--
-- A tabela nova repete o CHECK de `origem` e os tetos de `ator`, `acao`, `alvo`
-- e `campos` da 0002, sem mudar nenhum deles: o unico valor diferente e o de
-- `antes` e `depois`.

CREATE TABLE IF NOT EXISTS painel_auditoria_nova (
  id            INTEGER PRIMARY KEY,
  ocorrido_em   INTEGER NOT NULL,
  versao        INTEGER NOT NULL,
  origem        TEXT    NOT NULL CHECK (origem IN ('painel', 'parada', 'assistente', 'migracao')),
  ator          TEXT    NOT NULL CHECK (length(ator) <= 64),
  step_up       INTEGER NOT NULL CHECK (step_up IN (0, 1)),
  acao          TEXT    NOT NULL CHECK (length(acao) <= 40),
  alvo          TEXT    CHECK (alvo IS NULL OR length(alvo) <= 32),
  campos        TEXT    NOT NULL CHECK (length(campos) <= 500),
  antes         TEXT    CHECK (antes IS NULL OR length(antes) <= 8000),
  depois        TEXT    CHECK (depois IS NULL OR length(depois) <= 8000)
);

-- O `id` viaja junto: ele E o rowid e e o indice cronologico de que a poda de
-- §8.9 depende. Renumerar aqui embaralharia o historico do dono.
INSERT INTO painel_auditoria_nova
  (id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
SELECT id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois
  FROM painel_auditoria;

DROP TABLE painel_auditoria;

ALTER TABLE painel_auditoria_nova RENAME TO painel_auditoria;
