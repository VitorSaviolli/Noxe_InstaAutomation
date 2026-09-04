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
import { AGORA, IG_USER_ID, USERNAME_CONTA } from './dubles'

/**
 * Tabelas do schema, na ordem em que devem ser esvaziadas.
 *
 * A ordem importa quando houver chave estrangeira: filha antes de mae.
 * Hoje nao ha nenhuma, mas a lista ja nasce ordenada para nao virar uma
 * armadilha na primeira tabela que tiver.
 */
export const TABELAS_DO_SCHEMA = [
  'processed_comments',
  'account_tokens',
  // `painel_midias` antes de `painel_config`: nao ha chave estrangeira entre
  // elas, mas a relacao conceitual e essa — midia sem linha global e orfa.
  'painel_midias',
  'painel_auditoria',
  'painel_codigos',
  'painel_config',
] as const

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

/**
 * Uma linha de `painel_config` valida, campo a campo.
 *
 * Mora aqui, e nao dentro de uma suite, porque duas suites ja precisavam da
 * mesma linha e a copia comecou a divergir: uma delas perdeu
 * `parado_por_codigo_em` e passou a fixar `NULL` no proprio SQL, o que
 * silenciosamente tornava a parada de emergencia inalcancavel por ali.
 *
 * Os VALORES nao vem de `src/config.ts` de proposito: este repositorio e um
 * template publico e cada instalacao clona com a propria palavra-gatilho e o
 * proprio link. O que se congela e o comportamento dada uma linha conhecida.
 */
export const LINHA_DE_CONFIG_VALIDA = {
  enabled: 1,
  trigger_keywords: '["eu quero","quero o link"]',
  match_mode: 'exact',
  case_sensitive: 0,
  normalize_accents: 1,
  ignore_punctuation: 1,
  process_only_reels: 1,
  media_scope: 'todas',
  public_reply_enabled: 1,
  public_reply_text: 'Enviei as informacoes no seu Direct.',
  private_reply_enabled: 1,
  private_reply_text: 'Ola, {username}! Aqui esta o link: {link}',
  destination_url: 'https://exemplo.com/do-banco',
  user_cooldown_hours: 24,
  versao: 1,
  parado_por_codigo_em: null as number | null,
}

export type LinhaDeConfig = typeof LINHA_DE_CONFIG_VALIDA

/** Grava a linha unica de configuracao, com os campos trocados que vierem. */
export async function gravarConfig(
  db: D1Database,
  patch: Partial<LinhaDeConfig> = {},
): Promise<void> {
  const linha = { ...LINHA_DE_CONFIG_VALIDA, ...patch }

  await db
    .prepare(
      `INSERT INTO painel_config
       (id, enabled, trigger_keywords, match_mode, case_sensitive, normalize_accents,
        ignore_punctuation, process_only_reels, media_scope, public_reply_enabled,
        public_reply_text, private_reply_enabled, private_reply_text, destination_url,
        user_cooldown_hours, versao, parado_por_codigo_em, criado_em, atualizado_em)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      linha.enabled,
      linha.trigger_keywords,
      linha.match_mode,
      linha.case_sensitive,
      linha.normalize_accents,
      linha.ignore_punctuation,
      linha.process_only_reels,
      linha.media_scope,
      linha.public_reply_enabled,
      linha.public_reply_text,
      linha.private_reply_enabled,
      linha.private_reply_text,
      linha.destination_url,
      linha.user_cooldown_hours,
      linha.versao,
      linha.parado_por_codigo_em,
      AGORA,
      AGORA,
    )
    .run()
}

/** Grava uma linha de `painel_midias`. As colunas ausentes ficam `NULL`. */
export async function gravarMidia(
  db: D1Database,
  mediaId: string,
  sobreposicao: Record<string, string | number | null> = {},
  ativo = 1,
): Promise<void> {
  const colunas = Object.keys(sobreposicao)
  const nomes = ['media_id', 'ativo', 'criado_em', 'atualizado_em', ...colunas].join(', ')
  const marcas = new Array(4 + colunas.length).fill('?').join(', ')

  await db
    .prepare(`INSERT INTO painel_midias (${nomes}) VALUES (${marcas})`)
    .bind(mediaId, ativo, AGORA, AGORA, ...colunas.map((coluna) => sobreposicao[coluna] ?? null))
    .run()
}
