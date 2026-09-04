/**
 * Isolamento entre testes.
 *
 * `limparBanco()` e a UNICA funcao de limpeza do projeto: nenhuma suite
 * escreve o proprio `DELETE FROM`. Toda tabela que entrar no schema entra
 * tambem em `TABELAS_DO_SCHEMA` — o metateste META-03, em
 * `tests/painel-metatestes.test.ts`, compara esta lista com o que o D1
 * realmente tem e falha se alguem esquecer.
 *
 * Este arquivo mora em `tests/fixtures/`, que nao casa com o `include` do
 * vitest (`tests/**\/*.test.ts`), entao ele nao vira uma suite vazia.
 */

/**
 * Tabelas do schema, na ordem em que devem ser esvaziadas.
 *
 * A ordem importa quando houver chave estrangeira: filha antes de mae.
 * Hoje nao ha nenhuma, mas a lista ja nasce ordenada para nao virar uma
 * armadilha na primeira tabela que tiver.
 */
export const TABELAS_DO_SCHEMA = ['processed_comments', 'account_tokens'] as const

/**
 * Esvazia todas as tabelas do schema.
 *
 * Uma unica ida ao D1 (`db.batch()` roda em transacao implicita), para que
 * chamar isto num `beforeEach` nao distorca os testes que contam consultas.
 */
export async function limparBanco(db: D1Database): Promise<void> {
  await db.batch(TABELAS_DO_SCHEMA.map((tabela) => db.prepare(`DELETE FROM ${tabela}`)))
}
