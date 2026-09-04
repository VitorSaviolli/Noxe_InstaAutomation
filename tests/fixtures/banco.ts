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
import { storeAccessToken } from '../../src/services/token-manager'
import { IG_USER_ID, USERNAME_CONTA } from './dubles'

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

/**
 * Liga uma conta do Instagram no banco de teste.
 *
 * Sem isto `processEvents` e `runScheduledTasks` param na primeira linha —
 * toda suite que exercita o caminho de entrega precisa do mesmo cenario.
 */
export async function ligarConta(
  env: { DB: D1Database; TOKEN_ENCRYPTION_KEY: string },
  now: number,
): Promise<void> {
  await storeAccessToken(env as Parameters<typeof storeAccessToken>[0], {
    igUserId: IG_USER_ID,
    username: USERNAME_CONTA,
    accessToken: 'token-de-teste',
    expiresInSeconds: 60 * 24 * 60 * 60,
    now,
  })
}
