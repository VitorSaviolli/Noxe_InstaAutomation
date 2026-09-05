import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { ROTAS } from '../src/routes/painel/rotas'
import { painelHabilitado } from '../src/services/panel-session'
import { limparBanco, TABELAS_DO_SCHEMA } from './fixtures/banco'
import { pedir, responder } from './fixtures/dubles'

/**
 * META — metatestes.
 *
 * Nao testam uma funcionalidade: testam que o proprio conjunto de testes
 * continua cobrindo o que promete. Faltam META-06 (classificacao de step-up por
 * campo), que chega com a etapa do step-up.
 *
 * META-01: toda rota registrada exige sessao, salvo a allowlist escrita AQUI.
 * META-02: todo POST autenticado exige ficha CSRF, salvo as excecoes daqui.
 * META-03: toda tabela do schema aparece em `limparBanco()`.
 * META-04: todo binding do wrangler.jsonc existe no ambiente de teste.
 * META-05: `PANEL_SESSION_KEY` e diferente das outras chaves.
 * META-07: o painel entra pelo `default:` e nao engole `/painelzinho` nem o 404.
 * META-08: `PRAGMA table_info` confere o conjunto EXATO de colunas.
 * META-09: todo caminho da tabela e string exata, sob `/painel`, sem variavel.
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
  painel_config: [
    'atualizado_em',
    'case_sensitive',
    'criado_em',
    'destination_url',
    'enabled',
    'id',
    'ignore_punctuation',
    'match_mode',
    'media_scope',
    'normalize_accents',
    'parado_por_codigo_em',
    'private_reply_enabled',
    'private_reply_text',
    'process_only_reels',
    'public_reply_enabled',
    'public_reply_text',
    'trigger_keywords',
    'user_cooldown_hours',
    'versao',
  ],
  painel_midias: [
    'ativo',
    'atualizado_em',
    'case_sensitive',
    'criado_em',
    'destination_url',
    'enabled',
    'ignore_punctuation',
    'indisponivel_desde',
    'legenda_curta',
    'match_mode',
    'media_id',
    'media_product_type',
    'normalize_accents',
    'permalink',
    'postado_em',
    'private_reply_enabled',
    'private_reply_text',
    'process_only_reels',
    'public_reply_enabled',
    'public_reply_text',
    'trigger_keywords',
    'user_cooldown_hours',
    'visto_em',
  ],
  painel_codigos: ['criado_em', 'hash', 'invalidado_em', 'tipo', 'usado_em', 'versao_hash'],
  painel_auditoria: [
    'acao',
    'alvo',
    'antes',
    'ator',
    'campos',
    'depois',
    'id',
    'ocorrido_em',
    'origem',
    'step_up',
    'versao',
  ],
  painel_estado: ['atualizado_em', 'criado_em', 'id', 'usuario_handle'],
  painel_credenciais: [
    'algoritmo',
    'apelido',
    'backup_eligible',
    'backup_state',
    'chave_publica_jwk',
    'credential_id',
    'criado_em',
    'origem_registro',
    'rp_id',
    'sign_count',
    'transportes',
    'usado_em',
    'usuario_handle',
  ],
  painel_sessoes: [
    'credential_id',
    'criada_em',
    'expira_em',
    'falhas_stepup',
    'ociosa_ate',
    'rp_id',
    'sid_hash',
    'vista_em',
  ],
  painel_convites_usados: ['consumido_em', 'expira_em', 'nonce'],
}

/**
 * Toda tabela do painel comeca com este prefixo (§7.3), e e por ele que o
 * metateste as descobre — nunca por uma lista escrita a mao, que envelhece em
 * silencio na primeira tabela que alguem esquecer de acrescentar.
 */
const PREFIXO_DO_PAINEL = /^painel_/

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

  test('META-03: toda tabela painel_* do schema e limpa por limparBanco()', async () => {
    // A afirmacao mais estreita, e a que importa quando uma etapa futura cria
    // tabela: o conjunto vem do BANCO, entao criar `painel_algo` numa
    // migration nova e esquecer de `limparBanco()` deixa este teste vermelho
    // sozinho, sem ninguem precisar lembrar de vir aqui.
    const doBanco = (await tabelasAplicadas()).filter((nome) => PREFIXO_DO_PAINEL.test(nome))
    const naLimpeza = TABELAS_DO_SCHEMA.filter((nome) => PREFIXO_DO_PAINEL.test(nome))

    expect(doBanco.sort()).toEqual([...naLimpeza].sort())
    // E o contrapositivo do proprio teste: se um dia nenhuma tabela do painel
    // existir, a comparacao acima passaria comparando duas listas vazias.
    expect(doBanco.length).toBeGreaterThan(0)
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
    await env.DB.prepare(
      `INSERT INTO painel_config
         (id, enabled, trigger_keywords, match_mode, case_sensitive,
          normalize_accents, ignore_punctuation, process_only_reels, media_scope,
          public_reply_enabled, public_reply_text, private_reply_enabled,
          private_reply_text, destination_url, user_cooldown_hours, versao,
          parado_por_codigo_em, criado_em, atualizado_em)
       VALUES (1, 1, '["eu quero"]', 'exact', 0, 1, 1, 1, 'todas',
               1, 'texto publico', 1, 'texto {link}', 'https://exemplo.com', 24, 1,
               NULL, 1, 1)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_midias (media_id, ativo, criado_em, atualizado_em)
       VALUES ('17900000000000001', 1, 1, 1)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (1, 1, 1, 'migracao', 'sistema', 0, 'criou', NULL, '[]', NULL, NULL)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_codigos (hash, tipo, versao_hash, criado_em, usado_em, invalidado_em)
       VALUES ('hash-meta', 'parada', 1, 1, NULL, NULL)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_estado (id, usuario_handle, criado_em, atualizado_em)
       VALUES (1, 'handle-meta', 1, 1)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_credenciais
         (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
          sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
       VALUES ('cred-meta', 'exemplo.workers.dev', 'handle-meta', '{}', -7, NULL,
               0, 0, 0, 'aparelho', 'convite', 1, NULL)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_sessoes
         (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
       VALUES ('sid-meta', 'cred-meta', 'exemplo.workers.dev', 1, 2, 2, 1, 0)`,
    ).run()
    await env.DB.prepare(
      `INSERT INTO painel_convites_usados (nonce, consumido_em, expira_em)
       VALUES ('nonce-meta', 1, 2)`,
    ).run()

    // Uma linha em CADA tabela: sem isto, uma tabela nova entraria na lista e
    // o teste passaria por ela estar vazia desde o inicio.
    for (const tabela of TABELAS_DO_SCHEMA) {
      const antes = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).first<{
        total: number
      }>()
      expect(`${tabela}=${antes?.total}`).toBe(`${tabela}=1`)
    }

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
 * Todo binding que o `wrangler.jsonc` declara — `vars`, segredos, D1, KV, R2,
 * Durable Objects, filas, servicos e o que vier depois.
 *
 * A lista NAO e escrita aqui: ela e derivada do proprio `wrangler.jsonc` pelo
 * `vitest.config.ts` e entregue por binding, porque o teste roda dentro do
 * workerd e la nao ha sistema de arquivos. Uma lista escrita a mao envelhece
 * em silencio — foi exatamente o que aconteceu quando o `vitest.config.ts`
 * passou a ler o arquivo campo a campo: as `vars` continuaram herdadas e todo
 * o resto parou de derivar, sem nenhum teste ficar vermelho.
 *
 * O TypeScript nao cobre isto: ele some em tempo de execucao, e um binding
 * declarado em `src/types/env.ts` que nunca chegou ao ambiente de teste passa
 * pelo typecheck sem uma palavra.
 */
/**
 * Os tres limitadores sao OPCIONAIS e a ausencia aqui e proposital (§7.4).
 *
 * Nada do desenho pode depender deles para estar correto; se um dia entrarem
 * nos bindings de teste, a suite passaria a provar menos do que promete. Sao
 * tambem a unica subtracao permitida do conjunto declarado no `wrangler.jsonc`
 * — a excecao declarada, e nao um esquecimento.
 */
const LIMITADORES_QUE_FICAM_DE_FORA: readonly string[] = [
  'PANEL_LIMITER_LOGIN',
  'PANEL_LIMITER_CODIGO',
  'PANEL_LIMITER_STOP',
]

/** O conjunto esperado: o que o arquivo declara, menos a excecao declarada. */
function bindingsEsperados(): string[] {
  return env.TEST_BINDINGS_DO_WRANGLER.filter(
    (nome) => !LIMITADORES_QUE_FICAM_DE_FORA.includes(nome),
  )
}

describe('META — bindings', () => {
  test('META-04: todo binding do wrangler.jsonc existe no ambiente de teste', () => {
    const ambiente = env as unknown as Record<string, unknown>
    const esperados = bindingsEsperados()

    // Contrapositivo do proprio teste: uma derivacao quebrada devolveria lista
    // vazia e o `filter` abaixo passaria comparando nada com nada.
    expect(esperados).toContain('DB')
    expect(esperados.length).toBeGreaterThan(LIMITADORES_QUE_FICAM_DE_FORA.length)

    const ausentes = esperados.filter((nome) => ambiente[nome] === undefined)

    expect(ausentes).toEqual([])
  })

  test('META-04: o conjunto declarado cobre var, segredo e binding de recurso', () => {
    // As tres formas que o `wrangler.jsonc` usa para nomear o que chega ao
    // `env`. Se a derivacao parasse de ler uma delas — foi o que aconteceu com
    // tudo o que nao e `var` —, o teste acima passaria cobrindo menos.
    const declarados = env.TEST_BINDINGS_DO_WRANGLER

    expect(declarados).toContain('ALLOWED_LINK_DOMAINS') // vars
    expect(declarados).toContain('PANEL_SESSION_KEY') // secrets.required
    expect(declarados).toContain('DB') // d1_databases[].binding
    expect(declarados).toContain('PANEL_LIMITER_STOP') // ratelimits[].name
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

// ---------------------------------------------------------------------------
// META — as rotas do painel
// ---------------------------------------------------------------------------

/**
 * As rotas que NAO exigem sessao. Escrita AQUI, e copiada de §13.2 palavra por
 * palavra — e a allowlist do metateste, e o ponto dela e obrigar quem
 * acrescentar uma rota nova a vir editar este arquivo para pular o portao.
 *
 * `/painel/entrar/codigo` e `/painel/parada` estao na lista da spec e ainda nao
 * estao na tabela: a primeira nasce com a etapa da recuperacao, e a segunda e
 * desviada ANTES do roteador (§11.1) e por isso nunca entra em `rotas.ts`. Uma
 * allowlist maior que a tabela e inofensiva; o contrario e que seria buraco.
 */
const ROTAS_SEM_SESSAO: readonly string[] = [
  '/painel/entrar',
  '/painel/entrar/codigo',
  '/painel/convite',
  '/painel/parada',
  '/painel/api/entrar/opcoes',
  '/painel/api/entrar/verificar',
  '/painel/api/registrar/opcoes',
  '/painel/api/registrar/verificar',
]

/**
 * Os POSTs autenticados que NAO carregam ficha CSRF, com o motivo escrito.
 *
 * Vazia hoje, e essa e a afirmacao: nao existe POST autenticado sem ficha. O
 * dia em que alguem precisar de um, ele passa por aqui e por uma revisao.
 */
const POSTS_AUTENTICADOS_SEM_FICHA: readonly string[] = []

/** Caractere de segmento variavel em qualquer notacao de roteador conhecida. */
const SEGMENTO_VARIAVEL = /[:{}*?[\]]|\/\.\.?(?:\/|$)/

describe('META — rotas', () => {
  test('META-01: toda rota registrada exige sessao, salvo a allowlist escrita no teste', () => {
    const semSessaoENaoListadas = ROTAS.filter(
      (rota) => !rota.sessao && !ROTAS_SEM_SESSAO.includes(rota.caminho),
    )

    expect(semSessaoENaoListadas.map((rota) => rota.caminho)).toEqual([])

    // Contrapositivo, sem o qual a afirmacao acima passaria com uma tabela em
    // que TODA rota esta na allowlist — que e uma tabela sem portao nenhum.
    expect(ROTAS.filter((rota) => rota.sessao).length).toBeGreaterThan(0)
  })

  test('META-02: todo POST autenticado exige ficha CSRF, salvo as excecoes escritas no teste', () => {
    const autenticadosSemFicha = ROTAS.filter(
      (rota) =>
        rota.sessao &&
        rota.metodos.includes('POST') &&
        !rota.csrf &&
        !POSTS_AUTENTICADOS_SEM_FICHA.includes(rota.caminho),
    )

    expect(autenticadosSemFicha.map((rota) => rota.caminho)).toEqual([])

    // A outra metade, e a que pega o erro oposto: ficha exigida onde nao ha
    // sessao seria uma ficha que ninguem consegue calcular, e a rota morreria.
    expect(ROTAS.filter((rota) => rota.csrf && !rota.sessao)).toEqual([])

    // A MESMA proibicao para o step-up, e ela e a metade de tabela da trava que
    // `despachar` faz em tempo de requisicao. Step-up e reautenticacao presa a
    // uma mudanca: sem sessao nao existe o que reautenticar, e uma linha
    // `stepUp: true, sessao: false` so pode ser erro de quem escreveu a tabela.
    expect(ROTAS.filter((rota) => rota.stepUp && !rota.sessao)).toEqual([])
  })

  test('META-09: todo caminho da tabela e string exata, comeca por /painel e nao tem segmento variavel', () => {
    expect(ROTAS.length).toBeGreaterThan(0)

    for (const rota of ROTAS) {
      expect({
        [rota.caminho]: rota.caminho === '/painel' || rota.caminho.startsWith('/painel/'),
      }).toEqual({ [rota.caminho]: true })
      expect({ [rota.caminho]: SEGMENTO_VARIAVEL.test(rota.caminho) }).toEqual({
        [rota.caminho]: false,
      })
      // Sem barra final: `/painel/reels/` e `/painel/reels` seriam duas grafias
      // do mesmo lugar, e um `switch` de string exata atende so uma delas.
      expect({ [rota.caminho]: rota.caminho.endsWith('/') }).toEqual({ [rota.caminho]: false })
    }

    // Um caminho por tela: nenhuma grafia repetida na tabela.
    expect(new Set(ROTAS.map((rota) => rota.caminho)).size).toBe(ROTAS.length)
  })

  test('META-09: metodo declarado e sempre GET ou POST, e OPTIONS nunca aparece', () => {
    for (const rota of ROTAS) {
      expect({ [rota.caminho]: rota.metodos.length }).not.toEqual({ [rota.caminho]: 0 })
      for (const metodo of rota.metodos) {
        expect({ [`${rota.caminho} ${metodo}`]: metodo === 'GET' || metodo === 'POST' }).toEqual({
          [`${rota.caminho} ${metodo}`]: true,
        })
      }
    }
  })
})

describe('META — o painel entra pelo default:', () => {
  test('META-07: /painelzinho continua caindo no 404 do Worker, e nao no painel', async () => {
    const resposta = await responder(pedir('/painelzinho'), env)

    expect(resposta.status).toBe(404)
    // O corpo do `default:` de hoje, e nao o `rota_desconhecida` do painel: o
    // painel nao pode capturar um caminho que apenas comeca com as letras dele.
    expect(await resposta.text()).toBe('Not Found')
  })

  test('META-07: o painel nao engole o 404 de quem nao e do painel', async () => {
    for (const caminho of ['/qualquer-coisa', '/', '/setup', '/painel-admin']) {
      const resposta = await responder(pedir(caminho), env)

      expect({ [caminho]: resposta.status }).toEqual({ [caminho]: 404 })
      expect({ [caminho]: await resposta.text() }).toEqual({ [caminho]: 'Not Found' })
    }
  })

  test('META-07: um caminho /painel/** desconhecido responde a tabela de erros, nao o 404 cru', async () => {
    const resposta = await responder(pedir('/painel/nao-existe'), env)
    const corpo = await resposta.text()

    expect(resposta.status).toBe(404)
    // A `mensagem` de `rota_desconhecida` na tabela de §11.4, e nao o corpo
    // `Not Found` do `default:` — e o painel que atendeu, e ele atendeu pela
    // tabela canonica. O CODIGO fica no `console.warn` e nunca no corpo.
    expect(corpo).toContain('Página não encontrada.')
    expect(corpo).not.toContain('rota_desconhecida')
    expect(corpo).not.toBe('Not Found')
  })
})
