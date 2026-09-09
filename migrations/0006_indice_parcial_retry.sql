-- O indice da varredura do cron vira PARCIAL.
--
-- `idx_comments_retry` era `(status, next_retry_at)`, com `status` na frente.
-- Um indice composto por `status` e tocado por TODA escrita que mexe em
-- `status` — e no caminho feliz sao tres, uma atras da outra:
--
--   claimComment    -> 'processing'
--   markPrivateSent -> 'private_sent'
--   markCompleted   -> 'completed'
--
-- Nenhum desses estados interessa a quem varre a fila. A unica pergunta que o
-- indice existe para responder e a de `findRetryPending`: "quais estao em
-- retry_pending com next_retry_at vencido?". Um comentario que deu certo
-- entrava e saia do indice tres vezes sem nunca ter sido resposta dela.
--
-- No D1, escrita de indice conta na cota de linhas escritas igual a escrita de
-- tabela. Com o indice parcial, o caminho feliz passa a custar ZERO escrita
-- nele: 'processing', 'private_sent' e 'completed' estao todos fora do
-- predicado, entao a linha nunca entra. So paga quem realmente falhou e foi
-- reagendado.
--
-- `status` sai das colunas indexadas porque virou constante do predicado:
-- dentro do indice toda linha tem `status = 'retry_pending'`, e repetir a
-- coluna so aumentaria a entrada sem ordenar nada. Sobra `next_retry_at`, que
-- e o que a consulta filtra por intervalo e usa no `ORDER BY`.
--
-- O SQLite so escolhe um indice parcial quando o `WHERE` da consulta implica o
-- predicado dele. `findRetryPending` compara `status = 'retry_pending'` com o
-- literal, que e a forma que ele reconhece — mudar aquele literal para um `?`
-- ligado em tempo de execucao faria o planejador voltar ao scan de tabela sem
-- erro nenhum, em silencio. E o unico jeito de perder este indice sem quebrar
-- teste.
--
-- `idx_comments_commenter` NAO e tocado: ele atende o cooldown por autor, e as
-- colunas dele (`commenter_scoped_id_hash`, `created_at`) nunca mudam depois
-- do INSERT.

CREATE INDEX IF NOT EXISTS idx_comments_retry_pendentes
  ON processed_comments (next_retry_at)
  WHERE status = 'retry_pending';

-- Depois do novo, e nunca antes: entre o DROP e o CREATE a varredura do cron
-- nao tem indice, e um tique que caia nessa janela varreria a tabela inteira.
DROP INDEX IF EXISTS idx_comments_retry;
