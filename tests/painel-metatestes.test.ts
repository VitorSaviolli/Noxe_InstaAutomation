import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { CAMPOS_DE_AJUSTES } from '../src/routes/painel/ajustes'
import {
  type CampoDaConfig,
  motivoDeCampoForaDaTela,
  RECUSA_SEM_VALOR,
} from '../src/routes/painel/dicionario'
import {
  CAMPOS_DA_RESTAURACAO,
  CAMPOS_DE_COMPORTAMENTO,
  CAMPOS_FORA_DA_RESTAURACAO,
  type EstadoDeComportamento,
} from '../src/routes/painel/formulario'
import { CAMPOS_DA_CHAVE } from '../src/routes/painel/inicio'
import { CAMPOS_DA_MENSAGEM } from '../src/routes/painel/mensagem'
import { CAMPOS_DE_PALAVRAS } from '../src/routes/painel/palavras'
import { CAMPOS_DO_REEL } from '../src/routes/painel/reel'
import { CAMPOS_DOS_REELS } from '../src/routes/painel/reels'
import {
  PREFIXO_DA_API,
  ROTA_AJUSTES,
  ROTA_CHAVE,
  ROTA_MENSAGEM,
  ROTA_PALAVRAS,
  ROTA_REEL,
  ROTA_REELS,
  ROTAS,
} from '../src/routes/painel/rotas'
import { camposProtegidos, jsonCanonico } from '../src/routes/painel/stepup'
import { painelHabilitado } from '../src/services/panel-session'
import { limparBanco, TABELAS_DO_SCHEMA } from './fixtures/banco'
import { pedir, responder } from './fixtures/dubles'
import esteArquivo from './painel-metatestes.test.ts?raw'

/**
 * META, metatestes.
 *
 * Nao testam uma funcionalidade: testam que o proprio conjunto de testes
 * continua cobrindo o que promete.
 *
 * META-01: toda rota registrada exige sessao, salvo a allowlist escrita AQUI.
 * META-02: todo POST autenticado exige ficha CSRF, salvo as excecoes daqui.
 * META-03: toda tabela do schema aparece em `limparBanco()`.
 * META-04: todo binding do wrangler.jsonc existe no ambiente de teste.
 * META-05: `PANEL_SESSION_KEY` e diferente das outras chaves.
 * META-06: a tabela de §10.10 inteira, afirmada no CLASSIFICADOR (Ruling 77).
 * META-07: o painel entra pelo `default:` e nao engole `/painelzinho` nem o 404.
 * META-08: `PRAGMA table_info` confere o conjunto EXATO de colunas.
 * META-09: todo caminho da tabela e string exata, sob `/painel`, sem variavel.
 * META-10: rota de pagina so com GET declara `csrf: false` e `escreve: false`.
 * META-11: a UNIAO das listas de campo por rota e o conjunto gravavel da etapa.
 * META-12: todo campo tem UMA frase de recusa, e a frase certa (Ruling 82).
 * META-13: esperar a recusa de step-up num campo de endereco exige allowlist.
 * META-14: a varredura de META-13 nao se deixa enganar por comentario.
 * META-15: as rotas que gravam CONFIGURACAO sao exatamente as declaradas aqui.
 *
 * META-06 estava reservado desde a Task 10 com a nota "chega com a etapa do
 * step-up", chegou, e chegou como a spec o descreve: uma tabela, nao um
 * caminho HTTP. META-11 leva o numero seguinte livre porque META-10 ja estava
 * ocupado quando o Ruling 72 batizou o metateste da uniao.
 *
 * **META-15 nasceu na Etapa 12 desfazendo uma colisao de numeracao**: ate ela,
 * o metateste das rotas de gravacao tambem se chamava META-11, herdado do mesmo
 * batismo errado do Ruling 72. Dois testes com o mesmo nome fazem qualquer
 * documento que os cite apontar para o errado. Ele leva o proximo numero livre,
 * e nada do que ele afirma mudou por causa do nome.
 *
 * META-13 e META-14 chegaram na etapa 12c, e sao de uma familia diferente das
 * doze anteriores: elas nao medem `src/`, medem `tests/`. §13.2 lista os nove
 * metatestes que guardam o CODIGO; estes dois guardam o proprio conjunto de
 * testes contra o defeito que a etapa 12b encontrou nele, um teste que oferece
 * a cerimonia de step-up para uma gravacao que aquele ambiente jamais aceitaria.
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
 * metateste as descobre, nunca por uma lista escrita a mao, que envelhece em
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

describe('META: tabelas', () => {
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
 * Todo binding que o `wrangler.jsonc` declara, `vars`, segredos, D1, KV, R2,
 * Durable Objects, filas, servicos e o que vier depois.
 *
 * A lista NAO e escrita aqui: ela e derivada do proprio `wrangler.jsonc` pelo
 * `vitest.config.ts` e entregue por binding, porque o teste roda dentro do
 * workerd e la nao ha sistema de arquivos. Uma lista escrita a mao envelhece
 * em silencio, foi exatamente o que aconteceu quando o `vitest.config.ts`
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
 * a excecao declarada, e nao um esquecimento.
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

describe('META: bindings', () => {
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
    // `env`. Se a derivacao parasse de ler uma delas, foi o que aconteceu com
    // tudo o que nao e `var`, o teste acima passaria cobrindo menos.
    const declarados = env.TEST_BINDINGS_DO_WRANGLER

    expect(declarados).toContain('ALLOWED_LINK_DOMAINS') // vars
    expect(declarados).toContain('PANEL_SESSION_KEY') // secrets.required
    expect(declarados).toContain('DB') // d1_databases[].binding
    expect(declarados).toContain('PANEL_LIMITER_STOP') // ratelimits[].name
  })

  test('META-04: com os bindings de teste o portao de sanidade abre', () => {
    // Prova que os valores ficticios respeitam os pisos de §10.2, 32
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
// META, as rotas do painel
// ---------------------------------------------------------------------------

/**
 * As rotas que NAO exigem sessao. Escrita AQUI, e copiada de §13.2 palavra por
 * palavra, e a allowlist do metateste, e o ponto dela e obrigar quem
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

describe('META: rotas', () => {
  test('META-01: toda rota registrada exige sessao, salvo a allowlist escrita no teste', () => {
    const semSessaoENaoListadas = ROTAS.filter(
      (rota) => !rota.sessao && !ROTAS_SEM_SESSAO.includes(rota.caminho),
    )

    expect(semSessaoENaoListadas.map((rota) => rota.caminho)).toEqual([])

    // Contrapositivo, sem o qual a afirmacao acima passaria com uma tabela em
    // que TODA rota esta na allowlist, que e uma tabela sem portao nenhum.
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

  test('META-10: rota de PAGINA so com GET declara `csrf: false` e `escreve: false`', () => {
    // Os dois campos sao DECLARATIVOS: nada no roteador confere se eles batem
    // com o que o handler faz. Um `escreve: true` errado e pior que inofensivo
    // ele REMOVE a rota do laco de "toda rota com `escreve: false` executa
    // zero escritas no D1". Um rotulo errado desligaria uma garantia em vez de
    // derrubar um teste, que e a forma mais silenciosa de perder cobertura.
    //
    // A regra so vale para rota de PAGINA sem `POST`: `GET` nao muda estado e
    // nao carrega ficha (um link nao tem como calcular uma), e sem `POST` nao
    // ha caminho de gravacao. As rotas com `POST` continuam sob META-02.
    const soDeLeitura = ROTAS.filter(
      (rota) =>
        !rota.caminho.startsWith(PREFIXO_DA_API) &&
        rota.metodos.length === 1 &&
        rota.metodos[0] === 'GET',
    )

    // Contrapositivo: uma tabela sem rota de leitura faria o laco passar calado.
    expect(soDeLeitura.length).toBeGreaterThan(0)

    expect(
      soDeLeitura.filter((rota) => rota.csrf || rota.escreve).map((rota) => rota.caminho),
    ).toEqual([])
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

describe('META: o painel entra pelo default:', () => {
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
    // `Not Found` do `default:`, e o painel que atendeu, e ele atendeu pela
    // tabela canonica. O CODIGO fica no `console.warn` e nunca no corpo.
    expect(corpo).toContain('Página não encontrada.')
    expect(corpo).not.toContain('rota_desconhecida')
    expect(corpo).not.toBe('Not Found')
  })
})

// ---------------------------------------------------------------------------
// META, a classificacao de risco e o escopo de escrita por rota
// ---------------------------------------------------------------------------

/**
 * Um estado de comportamento inteiro, com valores FICTICIOS.
 *
 * Nao vem de `src/config.ts` nem do banco: a classificacao de §10.10 e uma
 * funcao pura de `(campo, antes, depois)`, e um estado montado aqui e o unico
 * que nao muda quando a instalacao de quem roda o teste muda.
 */
const ESTADO_BASE: EstadoDeComportamento = {
  enabled: true,
  triggerKeywords: ['eu quero'],
  matchMode: 'exact',
  caseSensitive: false,
  normalizeAccents: true,
  ignorePunctuation: true,
  processOnlyReels: true,
  mediaScope: 'selecionadas',
  publicReplyEnabled: true,
  publicReplyText: 'Mandei no seu Direct.',
  privateReplyEnabled: true,
  privateReplyText: 'Ola, {username}! O link: {link}',
  destinationUrl: 'https://exemplo.com/antigo',
  userCooldownHours: 24,
}

/** Uma entrada da tabela de §10.10: uma direcao de um campo, e o veredito. */
interface CasoDeRisco {
  readonly campo: CampoDaConfig
  /** O que muda no `antes`, sobre o estado base. */
  readonly antes: Partial<EstadoDeComportamento>
  /** O que muda no `depois`. Tem de ser diferente do `antes`. */
  readonly depois: Partial<EstadoDeComportamento>
  /** Aquela direcao pede a digital? */
  readonly exige: boolean
}

/**
 * A tabela de §10.10 INTEIRA: os catorze campos, cada um nas duas direcoes.
 *
 * **Por que aqui e nao por HTTP** (Ruling 77). Ate a rodada 2 esta tabela so era
 * exercida atraves de `POST /painel/ajustes`, que naquele momento escrevia todo
 * campo de comportamento. Quando o Ruling 73 moveu a recusa de escopo para antes
 * da cerimonia e o Ruling 74 encolheu a lista daquela rota, seis das sete
 * entradas passaram a ser recusadas por ESCOPO, `400 dados_invalidos`, e o
 * teste que dizia medir a classificacao passou a medir outra coisa. Uma tabela
 * afirmada sobre a funcao nao tem esse jeito de esvaziar sem ninguem ver.
 *
 * E e o unico lugar honesto para `mediaScope` ate a Task 13: a tela dona dele
 * nao existe (Ruling 68), entao por rota nao ha como afirmar nem a metade
 * positiva (que nao grava) nem a negativa, o `403` que a suite media vinha do
 * escopo, e nao do risco.
 *
 * As quatro linhas de ALARGAMENTO sao as quatro que §10.10 enumera, palavra por
 * palavra: `matchMode` para `contains`, cooldown ABAIXO do atual, `mediaScope`
 * para `todas`, `processOnlyReels` para `false`. Os tres sempre-protegidos
 * pedem nas duas direcoes. Todo o resto, `enabled` inclusive, e a ausencia
 * dele e decisao escrita de §10.10, nao pede em direcao nenhuma.
 */
const TABELA_DE_RISCO: readonly CasoDeRisco[] = [
  // Os quatro alargamentos nomeados por §10.10, e a volta de cada um.
  {
    campo: 'matchMode',
    antes: { matchMode: 'exact' },
    depois: { matchMode: 'contains' },
    exige: true,
  },
  {
    campo: 'matchMode',
    antes: { matchMode: 'contains' },
    depois: { matchMode: 'exact' },
    exige: false,
  },
  {
    campo: 'userCooldownHours',
    antes: { userCooldownHours: 24 },
    depois: { userCooldownHours: 1 },
    exige: true,
  },
  {
    campo: 'userCooldownHours',
    antes: { userCooldownHours: 24 },
    depois: { userCooldownHours: 48 },
    exige: false,
  },
  {
    campo: 'mediaScope',
    antes: { mediaScope: 'selecionadas' },
    depois: { mediaScope: 'todas' },
    exige: true,
  },
  {
    campo: 'mediaScope',
    antes: { mediaScope: 'todas' },
    depois: { mediaScope: 'selecionadas' },
    exige: false,
  },
  {
    campo: 'processOnlyReels',
    antes: { processOnlyReels: true },
    depois: { processOnlyReels: false },
    exige: true,
  },
  {
    campo: 'processOnlyReels',
    antes: { processOnlyReels: false },
    depois: { processOnlyReels: true },
    exige: false,
  },

  // Os tres sempre-protegidos: as DUAS direcoes pedem, porque nao existe
  // direcao segura em trocar o que a pessoa recebe.
  {
    campo: 'destinationUrl',
    antes: { destinationUrl: 'https://exemplo.com/a' },
    depois: { destinationUrl: 'https://exemplo.com/b' },
    exige: true,
  },
  {
    campo: 'destinationUrl',
    antes: { destinationUrl: 'https://exemplo.com/b' },
    depois: { destinationUrl: 'https://exemplo.com/a' },
    exige: true,
  },
  {
    campo: 'privateReplyText',
    antes: { privateReplyText: 'Um {link}' },
    depois: { privateReplyText: 'Outro {link}' },
    exige: true,
  },
  {
    campo: 'privateReplyText',
    antes: { privateReplyText: 'Outro {link}' },
    depois: { privateReplyText: 'Um {link}' },
    exige: true,
  },
  {
    campo: 'publicReplyText',
    antes: { publicReplyText: 'Um texto.' },
    depois: { publicReplyText: 'Outro texto.' },
    exige: true,
  },
  {
    campo: 'publicReplyText',
    antes: { publicReplyText: 'Outro texto.' },
    depois: { publicReplyText: 'Um texto.' },
    exige: true,
  },

  // `enabled` NAO alarga em direcao nenhuma (§10.10): religar nao muda valor,
  // e desligar e o freio de emergencia, que tem de ser barato.
  { campo: 'enabled', antes: { enabled: false }, depois: { enabled: true }, exige: false },
  { campo: 'enabled', antes: { enabled: true }, depois: { enabled: false }, exige: false },

  // Os sete restantes, nas duas direcoes, e nenhum pede.
  {
    campo: 'triggerKeywords',
    antes: { triggerKeywords: ['eu quero'] },
    depois: { triggerKeywords: ['eu quero', 'quero o link'] },
    exige: false,
  },
  {
    campo: 'triggerKeywords',
    antes: { triggerKeywords: ['eu quero', 'quero o link'] },
    depois: { triggerKeywords: ['eu quero'] },
    exige: false,
  },
  {
    campo: 'caseSensitive',
    antes: { caseSensitive: false },
    depois: { caseSensitive: true },
    exige: false,
  },
  {
    campo: 'caseSensitive',
    antes: { caseSensitive: true },
    depois: { caseSensitive: false },
    exige: false,
  },
  {
    campo: 'normalizeAccents',
    antes: { normalizeAccents: false },
    depois: { normalizeAccents: true },
    exige: false,
  },
  {
    campo: 'normalizeAccents',
    antes: { normalizeAccents: true },
    depois: { normalizeAccents: false },
    exige: false,
  },
  {
    campo: 'ignorePunctuation',
    antes: { ignorePunctuation: false },
    depois: { ignorePunctuation: true },
    exige: false,
  },
  {
    campo: 'ignorePunctuation',
    antes: { ignorePunctuation: true },
    depois: { ignorePunctuation: false },
    exige: false,
  },
  {
    campo: 'publicReplyEnabled',
    antes: { publicReplyEnabled: false },
    depois: { publicReplyEnabled: true },
    exige: false,
  },
  {
    campo: 'publicReplyEnabled',
    antes: { publicReplyEnabled: true },
    depois: { publicReplyEnabled: false },
    exige: false,
  },
  {
    campo: 'privateReplyEnabled',
    antes: { privateReplyEnabled: false },
    depois: { privateReplyEnabled: true },
    exige: false,
  },
  {
    campo: 'privateReplyEnabled',
    antes: { privateReplyEnabled: true },
    depois: { privateReplyEnabled: false },
    exige: false,
  },
]

/** As quatro rotas que gravam configuracao, cada uma com o escopo que declara. */
const ESCOPO_POR_ROTA: readonly {
  readonly caminho: string
  readonly campos: readonly CampoDaConfig[]
}[] = [
  { caminho: ROTA_CHAVE.caminho, campos: CAMPOS_DA_CHAVE },
  { caminho: ROTA_PALAVRAS.caminho, campos: CAMPOS_DE_PALAVRAS },
  { caminho: ROTA_AJUSTES.caminho, campos: CAMPOS_DE_AJUSTES },
  { caminho: ROTA_MENSAGEM.caminho, campos: CAMPOS_DA_MENSAGEM },
  { caminho: ROTA_REELS.caminho, campos: CAMPOS_DOS_REELS },
  { caminho: ROTA_REEL.caminho, campos: CAMPOS_DO_REEL },
]

/**
 * Os campos que NENHUMA rota pode escrever nesta etapa.
 *
 * **A lista encolheu na Etapa 12, e a mudanca e a tarefa inteira do lado do
 * metateste** (Ruling 68): `mediaScope` saiu porque `/painel/reels` nasceu como
 * a tela dona dele. Sobraram os dois interruptores de canal, que esperam um
 * formulario que os emita, §3 os poe em "Ajustes finos", tela que ja os mostra
 * em leitura, e nenhuma etapa de §14 nomeia o interruptor.
 *
 * Escrito AQUI, e nao derivado do codigo: uma lista derivada concordaria com
 * qualquer coisa que o codigo dissesse, que e exatamente o buraco que o Ruling
 * 72 mandou fechar.
 */
const FORA_DO_GRAVAVEL: readonly CampoDaConfig[] = ['publicReplyEnabled', 'privateReplyEnabled']

describe('META: a classificacao de risco e o escopo por rota', () => {
  test('META-06: a tabela de §10.10 inteira, afirmada no classificador', () => {
    for (const caso of TABELA_DE_RISCO) {
      const antes: EstadoDeComportamento = { ...ESTADO_BASE, ...caso.antes }
      const depois: EstadoDeComportamento = { ...ESTADO_BASE, ...caso.depois }
      const rotulo = `${caso.campo} ${JSON.stringify(antes[caso.campo])}->${JSON.stringify(
        depois[caso.campo],
      )}`

      // Contrapositivo por CASO: um `depois` igual ao `antes` nao muda nada, e
      // a linha passaria afirmando o vazio contra o vazio.
      expect({ [rotulo]: JSON.stringify(antes[caso.campo]) }).not.toEqual({
        [rotulo]: JSON.stringify(depois[caso.campo]),
      })

      expect({ [rotulo]: [...camposProtegidos([caso.campo], antes, depois)] }).toEqual({
        [rotulo]: caso.exige ? [caso.campo] : [],
      })
    }
  })

  test('META-06: a tabela cobre TODOS os campos de comportamento, nas duas direcoes', () => {
    // A metade que faz de META-06 um metateste: um campo novo em
    // `src/config.ts` entra em `CAMPOS_DE_COMPORTAMENTO` sozinho, e a partir
    // daqui alguem e OBRIGADO a declarar se ele alarga. Sem esta afirmacao, a
    // tabela acima poderia ficar para tras em silencio, que e como a garantia
    // se perdeu da primeira vez.
    expect([...new Set(TABELA_DE_RISCO.map((caso) => caso.campo))].sort()).toEqual(
      [...CAMPOS_DE_COMPORTAMENTO].sort(),
    )

    for (const campo of CAMPOS_DE_COMPORTAMENTO) {
      const casos = TABELA_DE_RISCO.filter((caso) => caso.campo === campo)
      expect({ [campo]: casos.length }).toEqual({ [campo]: 2 })
    }

    // E a tabela nao pode ser de um veredito so: quatro alargamentos e tres
    // sempre-protegidos dao dez casos que EXIGEM, e os outros dezoito nao.
    expect(TABELA_DE_RISCO.filter((caso) => caso.exige).length).toBe(10)
    expect(TABELA_DE_RISCO.filter((caso) => !caso.exige).length).toBe(18)

    // A disjuncao entre os dois espacos de nomes `acao`, que ate aqui so
    // existia em comentario. `jsonCanonico` monta o objeto assinado como
    // `{ ...campos, acao }`, com a operacao POR ULTIMO: um campo de
    // configuracao chamado `acao` seria sobrescrito e sumiria do hash EM
    // SILENCIO, o autenticador assinaria um objeto que nao contem o valor que
    // a tela mostrou, e §10.10 diz que a amarracao ao conteudo e a coisa toda.
    // Nenhum campo se chama assim hoje, e o mesmo `src/config.ts` que faz um
    // campo novo entrar sozinho em `CAMPOS_DE_COMPORTAMENTO` e o que faria este
    // esbarrao entrar sozinho tambem. A primeira linha ancora o nome no hash
    // para que a segunda nao vire uma comparacao contra uma string morta.
    expect(JSON.parse(jsonCanonico({ acao: 'config', campos: {} }))).toEqual({ acao: 'config' })
    expect(CAMPOS_DE_COMPORTAMENTO).not.toContain('acao')
  })

  test('META-06: um lote misto tranca inteiro, e o classificador nomeia so o protegido', () => {
    // §10.10 e o Ruling 66: se QUALQUER campo do lote exige, o lote inteiro
    // exige. Quem decide isso e o funil, olhando se a lista voltou vazia, e
    // por isso ela nao pode vir vazia quando so um dos dois e protegido.
    const antes: EstadoDeComportamento = { ...ESTADO_BASE, matchMode: 'exact' }
    const depois: EstadoDeComportamento = {
      ...ESTADO_BASE,
      matchMode: 'contains',
      triggerKeywords: ['eu quero', 'quero o link'],
    }

    expect([...camposProtegidos(['triggerKeywords', 'matchMode'], antes, depois)]).toEqual([
      'matchMode',
    ])
  })

  test('META-11: a uniao das listas por rota e EXATAMENTE o conjunto gravavel da etapa', () => {
    // O ponto unico de guarda que o Ruling 70 destruiu ao apagar a
    // `CAMPOS_GRAVAVEIS` global, devolvido pelo Ruling 72. O re-revisor provou
    // o buraco: acrescentar `mediaScope` a lista de `/painel/palavras` deixava
    // a suite INTEIRA verde, porque so a lista de `/painel/ajustes` estava sob
    // teste. Daqui em diante, mexer em qualquer uma das quatro passa por aqui.
    const uniao = [...new Set(ESCOPO_POR_ROTA.flatMap((rota) => [...rota.campos]))].sort()

    expect(uniao).toEqual([...CAMPOS_DA_RESTAURACAO].sort())

    // A igualdade acima sozinha nao basta: acrescentar um campo a uma lista de
    // rota E a da restauracao a manteria verde. Os que ninguem grava sao
    // nomeados, um a um, contra a uniao E contra a restauracao.
    for (const campo of FORA_DO_GRAVAVEL) {
      expect({ [campo]: uniao.includes(campo) }).toEqual({ [campo]: false })
      expect({ [campo]: CAMPOS_DA_RESTAURACAO.includes(campo) }).toEqual({ [campo]: false })
    }

    // E o complemento fecha a conta: os catorze campos sao os doze da uniao
    // mais estes dois, sem sobra.
    expect([...CAMPOS_FORA_DA_RESTAURACAO].sort()).toEqual([...FORA_DO_GRAVAVEL].sort())
    expect(uniao.length + FORA_DO_GRAVAVEL.length).toBe(CAMPOS_DE_COMPORTAMENTO.length)

    // Contrapositivo: nenhuma das listas pode estar vazia, listas vazias
    // fariam a uniao vazia bater com uma restauracao vazia.
    for (const rota of ESCOPO_POR_ROTA) {
      expect({ [rota.caminho]: rota.campos.length }).not.toEqual({ [rota.caminho]: 0 })
    }
  })

  test('META-12: cada campo recebe a frase de recusa que diz a verdade sobre ele', () => {
    // A recusa de escopo e a unica coisa que a pessoa le quando o painel diz
    // "nao": ela precisa dizer ONDE se muda aquilo, ou admitir que nao da para
    // mudar em lugar nenhum. Sao TRES situacoes, e ate o Ruling 82 havia duas
    // frases para elas, `publicReplyEnabled` e `privateReplyEnabled` caiam na
    // frase que promete "a tela que cuida dele chega em uma proxima parte", e
    // essa tela ja existe: §3 os poe em "Ajustes finos", que ja os MOSTRA. O que
    // falta neles e o interruptor, e nenhuma etapa de §14 o nomeia.
    //
    // O metateste prende a divisao a uma fonte que nao e ela mesma: **quem e
    // gravavel por alguma rota TEM de saber dizer a tela dele**. Um campo novo
    // que entre na uniao sem entrar no mapa cai aqui, e nao numa tela de recusa.
    // **A clausula que DISCRIMINA e afirmada literal** (Ruling 89). A primeira
    // grafia media as tres frases por regex com `.*` e `.+` no meio das
    // palavras, entao uma reescrita que mantivesse so a FORMA, trocar "e
    // mudado" por "e alterado", trocar o fim de "so para leitura", passava, e o
    // metateste continuaria verde afirmando uma promessa que ninguem faz mais.
    //
    // O que fica literal e so o pedaco que CARREGA a promessa: a frase do
    // caminho promete que existe outro lugar onde mexer, e a do so-leitura
    // promete o contrario, que ali nao da. O nome da tela continua livre, ele
    // e o que muda por campo, e congela-lo seria congelar o portugues inteiro,
    // que nao e o que este teste existe para guardar.
    const CAMINHO_ABRE = 'Este ajuste é mudado '
    const CAMINHO_FECHA = ', e não por aqui.'
    const SO_LEITURA_ABRE = 'Este ajuste aparece '
    const SO_LEITURA_FECHA =
      ', mas por enquanto só para leitura: ainda não dá para ligá-lo ou desligá-lo pelo painel.'

    /** O `(.+)` do meio continua exigido: sem o nome da tela a frase nao serve. */
    const entre = (frase: string, abre: string, fecha: string): boolean =>
      frase.startsWith(abre) && frase.endsWith(fecha) && frase.length > abre.length + fecha.length

    const ehCaminho = (frase: string): boolean => entre(frase, CAMINHO_ABRE, CAMINHO_FECHA)
    const ehSoLeitura = (frase: string): boolean => entre(frase, SO_LEITURA_ABRE, SO_LEITURA_FECHA)

    for (const campo of CAMPOS_DA_RESTAURACAO) {
      expect({ [campo]: ehCaminho(motivoDeCampoForaDaTela(campo)) }).toEqual({ [campo]: true })
    }

    // Os dois que uma tela ja mostra sem deixar mudar. Eles NAO podem cair na
    // frase do caminho, prometeria um botao que nao existe, nem na do "ainda
    // nao da", que manda esperar por uma tela pronta.
    for (const campo of ['publicReplyEnabled', 'privateReplyEnabled'] as const) {
      const frase = motivoDeCampoForaDaTela(campo)
      expect({ [campo]: ehSoLeitura(frase) }).toEqual({ [campo]: true })
      expect({ [campo]: ehCaminho(frase) }).toEqual({ [campo]: false })
    }

    // **O campo que a promessa antiga cobria era `mediaScope`, e a Etapa 12 a
    // quitou.** Ate ela, "a tela que cuida dele chega em uma proxima parte" era
    // verdade, a Etapa 12 de §14 era o futuro. Agora `/painel/reels` existe, e
    // a mesma frase passou a MENTIR: ela mandaria a pessoa esperar por uma tela
    // que ja esta pronta e a um toque de distancia. Mesma familia dos Rulings 75
    // e 82, e o conserto e o mesmo, o campo mudou de mapa, e a frase que sobra
    // e a do CAMINHO.
    expect(motivoDeCampoForaDaTela('mediaScope')).not.toBe(RECUSA_SEM_VALOR.naoGravavel)
    expect(ehCaminho(motivoDeCampoForaDaTela('mediaScope'))).toBe(true)

    // Contrapositivo de cobertura: os catorze campos estao repartidos entre as
    // frases, sem sobra e sem um campo em duas. `ainda_nao` cai a ZERO nesta
    // etapa, e a queda e a garantia: enquanto ela era 1, havia um campo que o
    // painel mandava esperar. Ela volta a ser diferente de zero no dia em que
    // `AutomationConfig` ganhar um campo que nenhuma tela mostra, e ai o
    // laco de `CAMPOS_DA_RESTAURACAO` acima e quem cobra o mapa.
    const porFrase = CAMPOS_DE_COMPORTAMENTO.map((campo) => {
      const frase = motivoDeCampoForaDaTela(campo)
      if (ehCaminho(frase)) return 'caminho'
      if (ehSoLeitura(frase)) return 'so_leitura'
      return frase === RECUSA_SEM_VALOR.naoGravavel ? 'ainda_nao' : 'nenhuma'
    })

    expect({
      caminho: porFrase.filter((qual) => qual === 'caminho').length,
      so_leitura: porFrase.filter((qual) => qual === 'so_leitura').length,
      ainda_nao: porFrase.filter((qual) => qual === 'ainda_nao').length,
      nenhuma: porFrase.filter((qual) => qual === 'nenhuma').length,
    }).toEqual({ caminho: CAMPOS_DA_RESTAURACAO.length, so_leitura: 2, ainda_nao: 0, nenhuma: 0 })
  })

  test('META-15: as rotas que gravam configuracao sao exatamente as declaradas aqui', () => {
    // **O nome mudou na Etapa 12, e a mudanca e um conserto de batismo.** Ate
    // ela existiam DOIS testes chamados META-11, heranca do Ruling 72, que
    // batizou o segundo com o numero do primeiro. Dois testes com o mesmo nome
    // fazem qualquer documento que os cite apontar para o errado, e o custo
    // aparece no dia em que alguem for procurar "o META-11" e achar o outro.
    // META-15 e o proximo numero livre; nada do que ele afirma mudou por causa
    // do nome.
    //
    // Sem isto, a uniao acima seria a uniao das rotas que ALGUEM LEMBROU de
    // listar. A Etapa 12 acrescentou `/painel/reels` e `/painel/reel` a tabela
    // de rotas, e este teste e quem obrigou as duas a vir declarar o escopo
    // delas, que e exatamente o momento em que se quer ser obrigado a olhar.
    //
    // **O predicado pergunta `gravaConfig`, e nao `escreve`** (Ruling 84). A
    // primeira grafia media a coisa errada: `rotas.ts` define `escreve` como
    // "grava no D1 no caminho de sucesso", que e outra pergunta. §7.1 ja declara
    // `/painel/aparelhos` e `/painel/sair` como POST, e as duas vao gravar no D1
    // sem gravar CONFIGURACAO; quando a Task 13 as registrar, este teste
    // exigiria que elas aparecessem em `ESCOPO_POR_ROTA`, e o contrapositivo do
    // teste acima, nenhuma lista de rota pode estar vazia, tornaria isso
    // insatisfazivel. O nome do teste passou a medir o que ele promete.
    const gravadorasDeConfig = ROTAS.filter((rota) => rota.gravaConfig)

    // E as duas afirmacoes que impedem `gravaConfig` de virar um rotulo solto:
    // toda gravadora de configuracao e uma rota de PAGINA (o funil responde
    // `303`, e §10.7 passo 13 reserva o JSON para `/painel/api/*`), grava no D1
    // e recebe POST. Sem elas, um `gravaConfig: true` num GET de leitura passaria
    // por aqui e so seria descoberto pelo escopo que ninguem declarou.
    for (const rota of gravadorasDeConfig) {
      expect({
        [rota.caminho]: {
          api: rota.caminho.startsWith(PREFIXO_DA_API),
          escreve: rota.escreve,
          post: rota.metodos.includes('POST'),
        },
      }).toEqual({ [rota.caminho]: { api: false, escreve: true, post: true } })
    }

    expect(gravadorasDeConfig.map((rota) => rota.caminho).sort()).toEqual(
      ESCOPO_POR_ROTA.map((rota) => rota.caminho).sort(),
    )

    // **O CONTRAPOSITIVO, que fecha o furo M-2 da re-revisao da Task 12.**
    //
    // Tudo acima parte de `gravaConfig`, e `gravaConfig` e DECLARACAO, nao
    // medicao: uma rota que chamasse `gravarConfiguracao` com
    // `gravaConfig: false` saia do laco e escapava do metateste da uniao,
    // exatamente a omissao silenciosa que este teste existe para impedir. A
    // Etapa 12 foi a primeira que podia explorar o furo, entao e ela quem o
    // fecha.
    //
    // A guarda barata, e sem ler fonte nenhuma: **toda rota de pagina com
    // `escreve: true` e `POST` tem de declarar `gravaConfig: true`, ou estar
    // nesta lista curta e NOMEADA**. Ela nao prova que a rota nao chama o funil
    // prova que ninguem consegue acrescentar uma rota de escrita de pagina
    // sem passar por aqui, que e o portao que faltava. E ela erra para o lado de
    // EXIGIR: uma rota nova que grave outra coisa tem de ser escrita nesta lista
    // por quem a criou, com o nome dela a vista de quem revisa.
    //
    // §7.1 declara as duas excecoes de hoje como POST, e as Tasks 14 e 15 as
    // registram: `/painel/aparelhos` grava passkey e `/painel/sair` apaga
    // sessao. Nenhuma das duas tem campo de configuracao para declarar, e o
    // contrapositivo do teste acima, nenhuma lista de rota pode estar vazia,
    // tornaria insatisfazivel exigir escopo delas.
    const SEM_CONFIGURACAO: readonly string[] = ['/painel/aparelhos', '/painel/sair']

    const dePaginaQueEscrevem = ROTAS.filter(
      (rota) =>
        rota.escreve && rota.metodos.includes('POST') && !rota.caminho.startsWith(PREFIXO_DA_API),
    )

    for (const rota of dePaginaQueEscrevem) {
      expect({
        [rota.caminho]: rota.gravaConfig || SEM_CONFIGURACAO.includes(rota.caminho),
      }).toEqual({ [rota.caminho]: true })
    }

    // E a lista de excecoes nao pode virar despejo: cada nome dela so vale
    // enquanto for uma rota de verdade OU ainda nao existir. Um nome que sobre
    // depois de a rota virar gravadora de configuracao a tiraria do laco de
    // cima em silencio.
    for (const nome of SEM_CONFIGURACAO) {
      const rota = ROTAS.find((candidata) => candidata.caminho === nome)
      expect({ [nome]: rota?.gravaConfig ?? false }).toEqual({ [nome]: false })
    }
  })
})

/**
 * A marca que META-13 procura: a acao de auditoria, com as aspas dela.
 *
 * A guarda le as fontes de `tests/` como TEXTO, e este arquivo e UMA DELAS,
 * de proposito, porque uma guarda cega para si mesma e o buraco mais facil de
 * nao notar. Isso impoe uma regra a este arquivo: as suites sinteticas de
 * META-13 e META-14 montam a marca a partir desta constante em vez de escrever
 * a acao dentro do bloco. Nao e estilo, um bloco daqui que a escrevesse
 * inteira, ao lado de um nome de campo protegido, satisfaria o predicado e
 * apareceria em `desprotegidos`, porque este arquivo nao declara allowlist
 * nenhuma. Quer dizer: a regra e AFIRMADA pela propria varredura, e nao
 * confiada a quem lembrar dela.
 */
const MARCA_DE_RECUSA = "'stepup_recusado'"

/** Os tres campos que §10.10 protege SEMPRE e que a allowlist tambem julga. */
const CAMPOS_DE_ENDERECO = ['destinationUrl', 'privateReplyText', 'publicReplyText'] as const

/** Uma linha que so tem comentario: `//`, a abertura `/*` ou a continuacao `*`. */
const LINHA_SO_DE_COMENTARIO = /^\s*(?:\/\/|\/\*|\*)/

/** `ALLOWED_LINK_DOMAINS` recebendo texto vazio: lista vazia recusa tudo. */
const ALLOWLIST_VAZIA = /ALLOWED_LINK_DOMAINS:\s*(?:''|""|``)/
/** So espaco entre as aspas, o valor que `vitest.config.ts` entrega. */
const VALOR_VAZIO = /^\s*(?:''|""|``)\s*$/
/** `const NOME = { ...env, ALLOWED_LINK_DOMAINS: <alguma coisa> }`. */
const DECLARACAO_DE_ALLOWLIST =
  /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{[^{}]*\.\.\.env[^{}]*ALLOWED_LINK_DOMAINS\s*:\s*([^,}]+)/g
/** `opcoes.ambiente ?? NOME`, o ambiente que o helper de POST usa por padrao. */
const AMBIENTE_PADRAO = /ambiente\s*\?\?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g
/** `{ ambiente: alguma-coisa }`, o bloco escolhendo o ambiente na mao. */
const AMBIENTE_ESCOLHIDO = /ambiente\s*:/
/** A abertura de um bloco de teste, com a indentacao dela capturada. */
const ABERTURA_DE_BLOCO = /^([ \t]*)(?:test|it)(?:\.[A-Za-z]+)?\(/
/** Um identificador qualquer, para comparar por NOME e nao por substring. */
const IDENTIFICADOR = /[A-Za-z_$][A-Za-z0-9_$]*/g

/**
 * A fonte com as linhas de comentario esvaziadas, e o resto intacto.
 *
 * Nao e cosmetica: sem isto a guarda seria enganada pela PROSA. Tres testes de
 * `painel-stepup.test.ts` explicam em comentario por que NAO esperam a recusa
 * de step-up, e um analisador que casasse texto solto os acusaria, e uma
 * guarda que grita onde nao ha defeito e desligada na terceira vez.
 *
 * **Por LINHA, e nao por token.** A primeira grafia era um tokenizador de
 * verdade, string, comentario de linha e comentario de bloco, e ela se
 * perdia no primeiro regex literal
 * com aspas dentro: em `/(?:''|"")/` o `'` abre uma "string" que nunca fecha
 * onde deveria, e dali para a frente o arquivo inteiro e lido trocado. Este
 * proprio arquivo e cheio desses regexes, e o efeito foi medido: a varredura
 * inventava uma constante de allowlist chamada `NOME`, tirada do JSDoc de
 * `DECLARACAO_DE_ALLOWLIST`, e passava a considerar protegido um bloco que nao
 * e. Um analisador que erra em silencio e pior que nenhum.
 *
 * A regra por linha nao tem esse modo de falha: ela nunca dessincroniza,
 * porque cada linha e decidida sozinha. O preco esta dito: um comentario no
 * FIM de uma linha de codigo continua sendo lido como codigo. Isso so pode
 * gerar acusacao a mais, nunca a menos, e a guarda erra para o lado de
 * exigir, que e o lado seguro.
 *
 * As linhas ficam no lugar, vazias: sao elas que mantem o `^` de
 * `ABERTURA_DE_BLOCO` apontando para a linha certa.
 */
function semComentarios(fonte: string): string {
  return fonte
    .split('\n')
    .map((linha) => (LINHA_SO_DE_COMENTARIO.test(linha) ? '' : linha))
    .join('\n')
}

/** O que um arquivo de teste sabe sobre allowlist, lido da fonte dele. */
interface AllowlistDoArquivo {
  /** Nomes de `const` que carregam uma allowlist NAO vazia. */
  readonly constantes: ReadonlySet<string>
  /** Todo helper de POST do arquivo ja usa uma dessas por padrao. */
  readonly porPadrao: boolean
}

function allowlistDoArquivo(codigo: string): AllowlistDoArquivo {
  const constantes = new Set(
    [...codigo.matchAll(DECLARACAO_DE_ALLOWLIST)]
      .filter((achado) => !VALOR_VAZIO.test(achado[2] ?? ''))
      .map((achado) => achado[1] ?? ''),
  )
  const padroes = [...codigo.matchAll(AMBIENTE_PADRAO)].map((achado) => achado[1] ?? '')

  return {
    constantes,
    porPadrao:
      constantes.size > 0 && padroes.length > 0 && padroes.every((nome) => constantes.has(nome)),
  }
}

/**
 * Cada bloco `test(...)` do arquivo, do titulo ate o `})` que o FECHA.
 *
 * Fechar no `})` da mesma indentacao, e nao na abertura do teste seguinte, e o
 * que impede o ultimo bloco de um `describe` de engolir o codigo de modulo que
 * vem depois dele. Aqui isso nao e teoria: com a regra anterior, o ultimo teste
 * deste proprio arquivo absorvia as constantes do analisador, `MARCA_DE_RECUSA`
 * e `CAMPOS_DE_ENDERECO`, e aparecia como um bloco medido que ninguem escreveu.
 * Um bloco inventado hoje passa; amanha ele vira alarme falso num teste que nao
 * tem nada a ver com step-up.
 */
function blocosDeTeste(codigo: string): string[] {
  const linhas = codigo.split('\n')
  const blocos: string[] = []

  for (let i = 0; i < linhas.length; i++) {
    const abertura = ABERTURA_DE_BLOCO.exec(linhas[i] ?? '')
    if (abertura === null) continue

    const fechamento = `${abertura[1] ?? ''}})`
    let fim = i + 1
    while (fim < linhas.length && !(linhas[fim] ?? '').startsWith(fechamento)) fim++
    blocos.push(linhas.slice(i, fim + 1).join('\n'))
  }

  return blocos
}

/** Um bloco de teste medido pela guarda de META-13. */
interface BlocoMedido {
  /** A primeira linha do bloco, que carrega o titulo. */
  readonly titulo: string
  /** O bloco declara, ou herda, um ambiente com allowlist configurada. */
  readonly protegido: boolean
}

/**
 * O bloco POSTa um campo de endereco esperando a recusa de step-up?
 *
 * As duas metades tem de estar no MESMO bloco: um teste que so nomeia o campo
 * nao esta medindo step-up, e um que so espera a recusa pode estar medindo
 * outra coisa (uma passkey, um lote de palavras) que a allowlist nem julga.
 */
function ehBlocoDeEndereco(bloco: string, identificadores: ReadonlySet<string>): boolean {
  if (!bloco.includes(MARCA_DE_RECUSA)) return false
  return CAMPOS_DE_ENDERECO.some((campo) => identificadores.has(campo))
}

/**
 * "Este bloco roda com a allowlist configurada?", decidido em duas vias:
 *
 * 1. o bloco NOMEIA uma constante de allowlist do arquivo (o jeito de
 *    `painel-auditoria.test.ts`, cujo helper de POST usa o `env` cru);
 * 2. ou o arquivo tem allowlist POR PADRAO e o bloco nao troca o ambiente por
 *    outra coisa (o jeito de `painel-stepup.test.ts`).
 *
 * A via 2 e o que impede a guarda de exigir ruido: um arquivo cujo helper ja
 * aponta para o ambiente certo nao precisa repetir o nome em cada teste.
 */
function rodaComAllowlist(
  bloco: string,
  identificadores: ReadonlySet<string>,
  arquivo: AllowlistDoArquivo,
): boolean {
  const nomeiaConstante = [...arquivo.constantes].some((nome) => identificadores.has(nome))
  const montaNaMao = identificadores.has('ALLOWED_LINK_DOMAINS') && !ALLOWLIST_VAZIA.test(bloco)
  if (nomeiaConstante || montaNaMao) return true
  return arquivo.porPadrao && !AMBIENTE_ESCOLHIDO.test(bloco)
}

/** Os blocos de UM arquivo que caem sob a guarda, e o veredito de cada um. */
function medirArquivo(fonte: string): readonly BlocoMedido[] {
  const codigo = semComentarios(fonte)
  const arquivo = allowlistDoArquivo(codigo)
  const medidos: BlocoMedido[] = []

  for (const bloco of blocosDeTeste(codigo)) {
    const identificadores = new Set(bloco.match(IDENTIFICADOR) ?? [])
    if (!ehBlocoDeEndereco(bloco, identificadores)) continue

    const quebra = bloco.indexOf('\n')
    medidos.push({
      titulo: (quebra === -1 ? bloco : bloco.slice(0, quebra)).trim(),
      protegido: rodaComAllowlist(bloco, identificadores, arquivo),
    })
  }

  return medidos
}

/**
 * Uma suite SINTETICA com o defeito exato que a Task 12b encontrou, e a mesma
 * corrigida. Escrita como linhas soltas de proposito: nenhuma delas comeca a
 * coluna zero com `test(`, entao a varredura deste proprio arquivo nao as
 * confunde com testes de verdade.
 */
function suiteSintetica(comAllowlist: boolean): string {
  const ambiente = comAllowlist ? ', { ambiente: COM_ALLOWLIST }' : ''

  return [
    "const COM_ALLOWLIST = { ...env, ALLOWED_LINK_DOMAINS: 'exemplo.com' }",
    "describe('sintetica', () => {",
    "  test('grava o link e espera a recusa de step-up', async () => {",
    `    const resposta = await gravar(MENSAGEM, 'destinationUrl=' + LINK, sessao${ambiente})`,
    '    expect(resposta.status).toBe(403)',
    `    expect(acoes).toEqual([${MARCA_DE_RECUSA}])`,
    '  })',
    '})',
  ].join('\n')
}

describe('META: a higiene do proprio conjunto de testes', () => {
  test('META-13: esperar a recusa de step-up num campo de endereco exige allowlist', () => {
    // O defeito silencioso que a etapa 12b desenterrou, virado guarda de
    // CLASSE. O `vitest.config.ts` entrega `ALLOWED_LINK_DOMAINS: ''`, e lista
    // vazia nao "passa tudo": ela recusa QUALQUER endereco (§9.8, LNK-12).
    // Enquanto o step-up respondia antes da validacao, tres testes de
    // `painel-auditoria.test.ts`, AUD-08, GRAV-35 e GRAV-39, ofereciam a
    // cerimonia para gravacoes que aquele ambiente jamais aceitaria: a
    // patologia do Ruling 73 DENTRO do teste que a mede. Os tres ja foram
    // consertados; o que faltava era impedir que o proximo nascesse igual.
    //
    // **Por que a guarda le a FONTE.** A forma literal do pedido, "todo teste
    // que POSTa esses campos esperando a recusa de step-up roda com allowlist"
    // fala de OUTROS arquivos de teste, e de dentro do workerd nao existe
    // reflexao sobre o corpo de um teste alheio nem sobre o `env` que ele
    // passou por parametro: quando este arquivo roda, os outros ou ja rodaram
    // ou nem foram carregados, e nenhum `expect` de la fica visivel daqui. Ler
    // as fontes como texto e a aproximacao mais forte que se constroi, e nao e
    // um teste que finge: e o MESMO idioma do Lema 1 de §10.6, que varre `src/`
    // inteiro pelo `import.meta.glob(..., '?raw')`.
    //
    // O que ela nao alcanca fica dito para nao ser descoberto tarde: um teste
    // que monte o ambiente por um caminho que nenhuma das duas vias reconhece
    // um helper importado de `tests/fixtures/`, por exemplo, cai como
    // desprotegido e obriga quem o escreveu a nomear a allowlist no bloco. E
    // uma guarda que erra para o lado de exigir, nunca para o de deixar passar.
    // O  do Vite OMITE o modulo que o chama. Sem a linha
    // seguinte, o unico arquivo de teste fora da guarda seria justamente
    // aquele onde ela mora, e uma guarda cega para si mesma e o buraco mais
    // facil de nao notar. O `?raw` explicito o traz de volta para a varredura.
    const fontes: Record<string, string> = {
      ...(import.meta.glob('../tests/**/*.test.ts', {
        query: '?raw',
        eager: true,
        import: 'default',
      }) as Record<string, string>),
      '../tests/painel-metatestes.test.ts': esteArquivo,
    }

    const arquivos = Object.keys(fontes).sort()

    // Contrapositivo da varredura: um glob quebrado devolveria lista vazia e
    // tudo abaixo passaria comparando nada com nada.
    expect(arquivos.length).toBeGreaterThan(20)
    // E este arquivo esta DENTRO da varredura, uma vez so, e e isso que faz
    // a guarda valer tambem para os blocos sinteticos que moram aqui embaixo.
    expect(arquivos.filter((nome) => nome.endsWith('painel-metatestes.test.ts')).length).toBe(1)

    const medidos = arquivos.flatMap((nome) =>
      medirArquivo(fontes[nome] ?? '').map((bloco) => ({
        ...bloco,
        onde: `${nome} :: ${bloco.titulo}`,
      })),
    )
    const desprotegidos = medidos.filter((bloco) => !bloco.protegido).map((bloco) => bloco.onde)

    // Segundo contrapositivo, e o que importa mais: a guarda tem de estar
    // MEDINDO alguma coisa. Um predicado que nao casa nada ficaria verde para
    // sempre, inclusive no dia em que o teste defeituoso chegasse.
    expect(medidos.length).toBeGreaterThanOrEqual(8)

    expect(desprotegidos).toEqual([])

    // Terceiro contrapositivo: a suite sintetica com o defeito e acusada, e a
    // mesma com `ambiente: COM_ALLOWLIST` passa. Sem este par, "nenhum
    // desprotegido" poderia significar "o analisador nunca acusa".
    expect(medirArquivo(suiteSintetica(false)).map((bloco) => bloco.protegido)).toEqual([false])
    expect(medirArquivo(suiteSintetica(true)).map((bloco) => bloco.protegido)).toEqual([true])
  })

  test('META-14: a varredura de META-13 nao se deixa enganar pela prosa', () => {
    // O analisador tira comentario antes de decidir, e isso e afirmado aqui
    // sozinho porque e a parte que erra em silencio. Tres blocos reais de
    // `painel-stepup.test.ts` CITAM a recusa de step-up em comentario para
    // explicar por que nao a esperam; um analisador ingenuo os acusaria, e a
    // reacao humana a um alarme falso e desligar o alarme.
    const PROSA = '    // Ate a etapa 12b este caminho devolvia '
    const comProsa = [
      "describe('sintetica', () => {",
      "  test('a recusa aqui e do validador, nao do step-up', async () => {",
      `${PROSA}${MARCA_DE_RECUSA} antes de validar.`,
      "    const resposta = await gravar(MENSAGEM, 'destinationUrl=' + LINK, sessao)",
      '    expect(resposta.status).toBe(400)',
      '  })',
      '})',
    ].join('\n')

    // Nenhum bloco medido: a unica ocorrencia da marca esta em comentario.
    expect(medirArquivo(comProsa)).toEqual([])

    // E a contraprova de que o predicado nao morreu: a MESMA marca fora do
    // comentario volta a ser medida.
    expect(medirArquivo(comProsa.replace(PROSA, '    const citada = ')).length).toBe(1)

    // E o modo de falha que derrubou a primeira grafia, afirmado: um regex
    // literal com aspas dentro nao pode dessincronizar a varredura. Um
    // tokenizador ingenuo le o `'` de `(?:''|"")` como abertura de string e
    // passa a ler TROCADO tudo o que vem depois, inclusive JSDoc, de onde ele
    // tirava uma constante de allowlist que nao existe. Decidindo linha a
    // linha, as duas linhas abaixo chegam inteiras do outro lado.
    const comRegex = "const VAZIO = /^(?:''|\"\")$/\nconst LINK = 'https://exemplo.com/promocao'"
    expect(semComentarios(comRegex)).toBe(comRegex)
  })
})
