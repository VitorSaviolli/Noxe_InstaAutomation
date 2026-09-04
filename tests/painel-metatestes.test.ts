import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { painelHabilitado } from '../src/services/panel-session'
import { limparBanco, TABELAS_DO_SCHEMA } from './fixtures/banco'

/**
 * META — metatestes.
 *
 * Nao testam uma funcionalidade: testam que o proprio conjunto de testes
 * continua cobrindo o que promete. Nesta etapa entram os dois que falam de
 * tabela; os outros sete chegam com as etapas que criam rota, campo e sessao.
 *
 * META-03: toda tabela do schema aparece em `limparBanco()`.
 * META-04: todo binding obrigatorio existe no ambiente de teste.
 * META-05: `PANEL_SESSION_KEY` e diferente das outras chaves.
 * META-08: `PRAGMA table_info` confere o conjunto EXATO de colunas.
 */

/** Tabelas de infraestrutura do D1/Miniflare, que nao sao do projeto. */
const NAO_E_DO_PROJETO = /^(sqlite_|_cf_|d1_)/

/**
 * As colunas que cada tabela tem que ter, exatamente estas.
 *
 * `CREATE TABLE IF NOT EXISTS` transforma "a tabela ja existe com outra
 * forma" num no-op silencioso que so quebra em producao, com `no such
 * column`. Este e o teste que faz a falha aparecer aqui.
 */
const COLUNAS_ESPERADAS: Record<string, readonly string[]> = {
  processed_comments: [
    'attempt_count',
    'comment_id',
    'commenter_scoped_id_hash',
    'created_at',
    'last_error_code',
    'media_id',
    'next_retry_at',
    'private_message_id',
    'public_reply_id',
    'status',
    'updated_at',
  ],
  account_tokens: [
    'created_at',
    'encrypted_token',
    'expires_at',
    'id',
    'ig_user_id',
    'last_refreshed_at',
    'updated_at',
    'username',
  ],
}

/** Nomes das tabelas que o D1 de teste realmente tem, ja aplicadas as migrations. */
async function tabelasAplicadas(): Promise<string[]> {
  const resultado = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>()

  return (resultado.results ?? [])
    .map((linha) => linha.name)
    .filter((nome) => !NAO_E_DO_PROJETO.test(nome))
}

async function colunasDe(tabela: string): Promise<string[]> {
  const resultado = await env.DB.prepare(`PRAGMA table_info(${tabela})`).all<{ name: string }>()
  return (resultado.results ?? []).map((coluna) => coluna.name).sort()
}

describe('META — tabelas', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('META-03: toda tabela do schema aparece em limparBanco()', async () => {
    expect([...TABELAS_DO_SCHEMA].sort()).toEqual((await tabelasAplicadas()).sort())
  })

  test('META-03: limparBanco() realmente esvazia todas elas', async () => {
    await env.DB.prepare(
      `INSERT INTO processed_comments
         (comment_id, media_id, commenter_scoped_id_hash, status,
          attempt_count, created_at, updated_at)
       VALUES ('c-meta', 'm-meta', 'hash-meta', 'completed', 0, 1, 1)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO account_tokens
         (id, ig_user_id, username, encrypted_token, expires_at,
          last_refreshed_at, created_at, updated_at)
       VALUES (1, 'ig-meta', 'conta', 'cifrado', 2, NULL, 1, 1)`,
    ).run()

    await limparBanco(env.DB)

    for (const tabela of TABELAS_DO_SCHEMA) {
      const linha = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).first<{
        total: number
      }>()
      expect(`${tabela}=${linha?.total}`).toBe(`${tabela}=0`)
    }
  })

  test('META-08: PRAGMA table_info confere o conjunto exato de colunas', async () => {
    // Nenhuma tabela aplicada pode ficar de fora da lista esperada.
    expect(Object.keys(COLUNAS_ESPERADAS).sort()).toEqual((await tabelasAplicadas()).sort())

    for (const [tabela, esperadas] of Object.entries(COLUNAS_ESPERADAS)) {
      expect({ [tabela]: await colunasDe(tabela) }).toEqual({ [tabela]: [...esperadas].sort() })
    }
  })
})

/**
 * Todo binding que `src/types/env.ts` declara obrigatorio.
 *
 * Escrita aqui de proposito: o TypeScript some em tempo de execucao, entao
 * quem esquecer de propagar um binding novo para o `vitest.config.ts` descobre
 * por este teste. A conferencia no nivel do ARQUIVO — o binding existe mesmo
 * em `wrangler.jsonc` e no `.dev.vars.example` — nao cabe num teste do
 * workerd e mora no `scripts/verificar-antes-de-publicar.mjs` (§13.1).
 */
const BINDINGS_OBRIGATORIOS = [
  'DB',
  'META_APP_ID',
  'META_API_VERSION',
  'META_IG_USER_ID',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'TOKEN_ENCRYPTION_KEY',
  'SETUP_ADMIN_TOKEN',
  'PANEL_RP_ID',
  'PANEL_SESSION_KEY',
] as const

/**
 * Os tres limitadores sao OPCIONAIS e a ausencia aqui e proposital (§7.4).
 *
 * Nada do desenho pode depender deles para estar correto; se um dia entrarem
 * nos bindings de teste, a suite passaria a provar menos do que promete.
 */
const LIMITADORES_QUE_FICAM_DE_FORA = [
  'PANEL_LIMITER_LOGIN',
  'PANEL_LIMITER_CODIGO',
  'PANEL_LIMITER_STOP',
] as const

describe('META — bindings', () => {
  test('META-04: todo binding obrigatorio existe no ambiente de teste', () => {
    const ambiente = env as unknown as Record<string, unknown>
    const ausentes = BINDINGS_OBRIGATORIOS.filter((nome) => ambiente[nome] === undefined)

    expect(ausentes).toEqual([])
  })

  test('META-04: com os bindings de teste o portao de sanidade abre', () => {
    // Prova que os valores ficticios respeitam os pisos de §10.2 — 32
    // caracteres na chave de sessao, 20 no admin token, endereco preenchido.
    expect(painelHabilitado(env)).toEqual({ ok: true })
  })

  test('META-04: os tres limitadores continuam fora dos bindings de teste', () => {
    const ambiente = env as unknown as Record<string, unknown>
    const presentes = LIMITADORES_QUE_FICAM_DE_FORA.filter((nome) => ambiente[nome] !== undefined)

    expect(presentes).toEqual([])
  })

  test('META-05: PANEL_SESSION_KEY e diferente de TOKEN_ENCRYPTION_KEY e de SETUP_ADMIN_TOKEN', () => {
    expect(env.PANEL_SESSION_KEY).not.toBe(env.TOKEN_ENCRYPTION_KEY)
    expect(env.PANEL_SESSION_KEY).not.toBe(env.SETUP_ADMIN_TOKEN)

    // Nenhum segredo repete outro: rotacionar um nao pode derrubar o que o
    // outro protege.
    const segredos = [
      env.META_APP_SECRET,
      env.META_WEBHOOK_VERIFY_TOKEN,
      env.TOKEN_ENCRYPTION_KEY,
      env.SETUP_ADMIN_TOKEN,
      env.PANEL_SESSION_KEY,
    ]
    expect(new Set(segredos).size).toBe(segredos.length)
  })
})
