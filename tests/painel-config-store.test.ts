import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  type AutomationConfig,
  automationConfig,
  isDestinationUrlConfigured,
  type MediaAutomation,
  resolveConfigForMedia,
} from '../src/config'
import { processEvents, runScheduledTasks } from '../src/index'
import { CommentsRepository } from '../src/repositories/comments-repository'
import { evaluateComment, processComment } from '../src/services/automation'
import {
  carregarConfigEfetiva,
  invalidarCacheDeConfig,
  type SnapshotConfig,
  sobreposicoesDaFabrica,
  TTL_DESLIGADO_MS,
  TTL_LIGADO_MS,
} from '../src/services/config-store'
import { validarConfig } from '../src/services/config-validation'
import type { Env } from '../src/types/env'
import type { CommentEvent } from '../src/types/meta'
import {
  gravarConfig,
  gravarMidia,
  LINHA_DE_CONFIG_VALIDA as LINHA_VALIDA,
  type LinhaDeConfig,
  ligarConta,
  limparBanco,
} from './fixtures/banco'
import {
  AGORA,
  comoApi,
  configDeTeste,
  D1BatchQuebrado,
  D1Contador,
  IG_USER_ID,
  MetaFalsa,
  TETO_DE_SUBREQUESTS,
  USERNAME_CONTA,
} from './fixtures/dubles'

/**
 * CFG, configuracao no D1 e falha segura (18 garantias).
 *
 * A afirmacao que esta suite existe para provar: **erro nunca alarga, e erro
 * nunca inventa um valor que o dono nao viu na tela.** Configuracao corrompida
 * faz a automacao PARAR, nunca "consertar".
 *
 * Nada aqui depende dos VALORES de `src/config.ts`: este repositorio e um
 * template publico e cada pessoa clona com a propria palavra-gatilho e o
 * proprio link. O que se congela e o comportamento dada uma linha conhecida.
 */

const MEDIA_A = '17900000000000001'
const MEDIA_B = '17900000000000002'

/** Apaga a linha de configuracao. E o "caminho de volta" documentado em §9.11. */
const SQL_APAGA_CONFIG = 'DELETE FROM painel_config'

/** A mensagem literal do erro, sem depender do formato do objeto de erro. */
async function erroDe(acao: () => Promise<unknown>): Promise<string> {
  try {
    await acao()
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/**
 * D1 que devolve LINHAS escritas no teste, sem passar pelo banco.
 *
 * Existe para exercitar o que o schema nao deixa gravar: um `match_mode`
 * fora do `CHECK`, um cooldown `NaN`, uma coluna que este codigo nao conhece.
 * Sao exatamente os estados que uma migration futura com defeito, ou um
 * `wrangler d1 execute` bem intencionado, podem produzir.
 */
class D1DeLinhasFabricadas {
  constructor(
    private readonly config: Record<string, unknown> | null,
    private readonly midias: Record<string, unknown>[] = [],
  ) {}

  prepare(_sql: string): D1PreparedStatement {
    return { bind: () => this } as unknown as D1PreparedStatement
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.resolve([
      { results: this.config === null ? [] : [this.config], success: true },
      { results: this.midias, success: true },
    ] as unknown as D1Result<T>[])
  }
}

/** D1 cujo `batch` responde SEM rejeitar, mas reportando falha. */
class D1QueNaoReportaSucesso {
  prepare(_sql: string): D1PreparedStatement {
    return { bind: () => this } as unknown as D1PreparedStatement
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.resolve([
      { results: [], success: false },
      { results: [], success: false },
    ] as unknown as D1Result<T>[])
  }
}

/** D1 cujas tabelas do painel ainda nao existem: a migration nao foi aplicada. */
class D1SemAsTabelasDoPainel {
  prepare(_sql: string): D1PreparedStatement {
    return { bind: () => this } as unknown as D1PreparedStatement
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.reject(new Error('D1_ERROR: no such table: painel_config: SQLITE_ERROR'))
  }
}

/** Entrega qualquer duble onde o codigo de producao espera um `Env`. */
function comBanco(duble: object): Env {
  return { ...env, DB: duble as unknown as D1Database }
}

function evento(patch: Partial<CommentEvent> = {}): CommentEvent {
  return {
    commentId: 'comment-cfg-1',
    mediaId: MEDIA_A,
    fromId: 'igsid-visitante',
    fromUsername: 'visitante',
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
    ...patch,
  }
}

function loteDe(quantos: number): CommentEvent[] {
  return Array.from({ length: quantos }, (_, i) =>
    evento({
      commentId: `comment-cfg-${i}`,
      fromId: `igsid-cfg-${i}`,
      fromUsername: `visitante-${i}`,
    }),
  )
}

beforeEach(async () => {
  await limparBanco(env.DB)
  // Sem isto, um teste que usa AGORA deixa um cache "valido ate o futuro"
  // que contamina o teste seguinte.
  invalidarCacheDeConfig()
})

// ---------------------------------------------------------------------------

describe('CFG: o estado inicial e o caminho normal', () => {
  test('CFG-01: linha ausente usa o padrao de fabrica com origem "arquivo"', async () => {
    const snapshot = await carregarConfigEfetiva(env, AGORA)

    expect(snapshot.origem).toBe('arquivo')
    expect(snapshot.global).toEqual(automationConfig)
    expect(snapshot.overrides).toEqual([])
    expect(snapshot.avisos).toEqual([])
    // Nao e conserto de invalido: e o estado "o painel ainda nao existe", e e
    // o que torna a atualizacao de quem ja usa o projeto identica ao hoje.
    expect(snapshot.versao).toBe(0)
  })

  test('CFG-01: linha presente e valida vem do banco, e nao do arquivo', async () => {
    // A verificacao do dono desta etapa, encenada: o comportamento ANTES da
    // linha e DEPOIS dela, sem nenhum redeploy no meio.
    const semLinha = await carregarConfigEfetiva(env, AGORA)

    invalidarCacheDeConfig()
    await gravarConfig(env.DB, { user_cooldown_hours: 7, versao: 3 })
    const comLinha = await carregarConfigEfetiva(env, AGORA)

    expect({ origem: comLinha.origem, versao: comLinha.versao }).toEqual({
      origem: 'banco',
      versao: 3,
    })
    expect(comLinha.global.userCooldownHours).toBe(7)
    expect(comLinha.global.destinationUrl).toBe(LINHA_VALIDA.destination_url)

    // A comparacao e entre os DOIS snapshots, e nao contra um valor lido de
    // `src/config.ts`: num template publico cada clone tem o proprio link, e
    // um teste preso a esse valor fica vermelho na maquina de quem instala.
    expect(comLinha.global.destinationUrl).not.toBe(semLinha.global.destinationUrl)
    expect(semLinha.origem).toBe('arquivo')
  })
})

describe('CFG: configuracao corrompida para a automacao', () => {
  /** Cada linha aqui e um jeito diferente de a configuracao estar errada. */
  const CORROMPIDAS: { nome: string; patch: Partial<LinhaDeConfig> }[] = [
    { nome: 'link que nao e URL', patch: { destination_url: 'nao-e-uma-url' } },
    { nome: 'link em http', patch: { destination_url: 'http://exemplo.com' } },
    { nome: 'link com credencial', patch: { destination_url: 'https://exemplo.com@evil.com' } },
    { nome: 'link com porta', patch: { destination_url: 'https://exemplo.com:8443/x' } },
    { nome: 'cooldown fracionario', patch: { user_cooldown_hours: 1.5 } },
    { nome: 'lista de gatilhos vazia com a automacao ligada', patch: { trigger_keywords: '[]' } },
    { nome: 'gatilho que normaliza para vazio', patch: { trigger_keywords: '["!!!"]' } },
    {
      nome: 'gatilho duplicado depois da normalizacao',
      patch: { trigger_keywords: '["Eu Quero","eu quero"]' },
    },
    { nome: 'placeholder desconhecido no Direct', patch: { private_reply_text: 'Toma: {url}' } },
    { nome: 'Direct sem {link}', patch: { private_reply_text: 'Ola, {username}!' } },
    { nome: 'placeholder na resposta publica', patch: { public_reply_text: 'Veja {link}' } },
    {
      nome: 'gatilho curto demais em contains',
      patch: { match_mode: 'contains', trigger_keywords: '["eu"]' },
    },
  ]

  for (const caso of CORROMPIDAS) {
    test(`CFG-02: ${caso.nome} deixa a automacao parada`, async () => {
      await gravarConfig(env.DB, caso.patch)

      const snapshot = await carregarConfigEfetiva(env, AGORA)

      expect({ origem: snapshot.origem, enabled: snapshot.global.enabled }).toEqual({
        origem: 'parado_por_erro',
        enabled: false,
      })
      // O aviso NOMEIA o campo: e o que a tela precisa mostrar.
      expect(snapshot.avisos.length).toBeGreaterThan(0)
    })
  }

  test('CFG-03: tipo errado numa coluna deixa parado, e nao vira `false` em silencio', async () => {
    // `enabled` chega como 2. Um `row.enabled === 1` solto transformaria isso
    // em `false`, um conserto silencioso, e na direcao que ninguem pediu.
    const banco = new D1DeLinhasFabricadas({ ...LINHA_VALIDA, id: 1, enabled: 2 })

    const snapshot = await carregarConfigEfetiva(comBanco(banco), AGORA)

    expect(snapshot.origem).toBe('parado_por_erro')
    expect(snapshot.avisos.join(' ')).toContain('enabled')
  })

  test('CFG-08: matchMode invalido e recusado pelo schema E pelo validador', async () => {
    // Primeira barreira: o CHECK da migration nao deixa a linha entrar.
    const erro = await erroDe(() => gravarConfig(env.DB, { match_mode: 'regex' }))
    expect(erro).toContain('CHECK constraint failed')

    // Segunda barreira, para o dia em que a primeira nao existir: mesmo que a
    // linha chegue com `regex`, a automacao para.
    const banco = new D1DeLinhasFabricadas({ ...LINHA_VALIDA, id: 1, match_mode: 'regex' })
    const snapshot = await carregarConfigEfetiva(comBanco(banco), AGORA)

    expect(snapshot.origem).toBe('parado_por_erro')
    expect(snapshot.avisos.join(' ')).toContain('matchMode')
  })

  test('CFG-09: cooldown negativo ou acima de 8760 e recusado pelo schema', async () => {
    // Cooldown negativo joga `now - horas * 3600000` para o FUTURO: a
    // comparacao vira sempre falsa e o freio some sem erro nenhum.
    expect(await erroDe(() => gravarConfig(env.DB, { user_cooldown_hours: -1 }))).toContain(
      'CHECK constraint failed',
    )
    await limparBanco(env.DB)
    expect(await erroDe(() => gravarConfig(env.DB, { user_cooldown_hours: 8761 }))).toContain(
      'CHECK constraint failed',
    )
  })

  test('CFG-09: cooldown NaN, negativo ou fracionario que passe do schema deixa parado', async () => {
    for (const horas of [Number.NaN, Number.POSITIVE_INFINITY, -5, 1.5, 99999]) {
      invalidarCacheDeConfig()
      const banco = new D1DeLinhasFabricadas({
        ...LINHA_VALIDA,
        id: 1,
        user_cooldown_hours: horas,
      })

      const snapshot = await carregarConfigEfetiva(comBanco(banco), AGORA)

      expect({ horas, origem: snapshot.origem }).toEqual({ horas, origem: 'parado_por_erro' })
    }
  })

  test('CFG-14: nenhum campo invalido e substituido por valor de fabrica com a automacao rodando', async () => {
    await gravarConfig(env.DB, { destination_url: 'http://exemplo.com', user_cooldown_hours: 99 })

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    // O que NAO pode acontecer: servir a config do banco com o link trocado
    // pelo do arquivo. A tela mostraria um link e o Direct entregaria outro.
    expect(snapshot.origem).not.toBe('banco')
    expect(snapshot.global.enabled).toBe(false)

    // E o efeito visivel: nada e entregue, em vez de ser entregue "consertado".
    expect(evaluateComment(evento(), snapshot.global, IG_USER_ID, USERNAME_CONTA)).toEqual({
      process: false,
      reason: 'automacao_desligada',
    })
    // O valor de 99 h da linha tambem nao vaza: a linha inteira foi recusada.
    expect(snapshot.global.userCooldownHours).toBe(automationConfig.userCooldownHours)
  })

  test('CFG-07: processComment continua sem lancar com a config corrompida', async () => {
    await ligarConta(env, AGORA)
    await gravarConfig(env.DB, { destination_url: 'nao-e-uma-url' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)
    const api = new MetaFalsa()

    const resultado = await processComment(evento(), {
      api: comoApi(api),
      repo: new CommentsRepository(env.DB),
      igUserId: IG_USER_ID,
      accountUsername: USERNAME_CONTA,
      config: resolveConfigForMedia(MEDIA_A, snapshot.global, snapshot.overrides),
      now: AGORA,
    })

    expect(resultado).toEqual({ kind: 'skipped', reason: 'automacao_desligada' })
    // E nada saiu pela rede.
    expect(api.chamadas).toEqual([])
  })
})

describe('CFG: o parser: NULL e chave ausente, nunca undefined', () => {
  test('CFG-05: sobreposicao so com NULL nao produz nenhuma chave com undefined', async () => {
    await gravarConfig(env.DB)
    await gravarMidia(env.DB, MEDIA_A)

    const snapshot = await carregarConfigEfetiva(env, AGORA)
    const [sobreposicao] = snapshot.overrides
    if (sobreposicao === undefined) throw new Error('a sobreposicao deveria existir')

    // `toBeUndefined()` passaria nos DOIS casos e e exatamente o teste que
    // deixaria o bug passar. A afirmacao precisa ser sobre a CHAVE.
    expect('destinationUrl' in sobreposicao).toBe(false)
    expect('privateReplyText' in sobreposicao).toBe(false)
    expect('enabled' in sobreposicao).toBe(false)
    expect(Object.keys(sobreposicao)).toEqual(['mediaIds'])
    expect(Object.values(sobreposicao).every((valor) => valor !== undefined)).toBe(true)
  })

  test('CFG-06: sobreposicao com campo ausente NAO zera o campo global', async () => {
    await gravarConfig(env.DB)
    await gravarMidia(env.DB, MEDIA_A, { public_reply_text: 'Texto so deste Reel.' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)
    const efetiva = resolveConfigForMedia(MEDIA_A, snapshot.global, snapshot.overrides)

    expect(efetiva.publicReplyText).toBe('Texto so deste Reel.')
    expect(efetiva.destinationUrl).toBe(LINHA_VALIDA.destination_url)
    // O sintoma real de um `undefined` no spread: `isDestinationUrlConfigured`
    // lancaria `TypeError` dentro de `processComment`, documentada como funcao
    // que nunca lanca.
    expect(isDestinationUrlConfigured(efetiva)).toBe(true)
  })

  test('CFG-04: coluna que o codigo nao conhece e descartada em silencio', async () => {
    const banco = new D1DeLinhasFabricadas({
      ...LINHA_VALIDA,
      id: 1,
      criado_em: AGORA,
      atualizado_em: AGORA,
      // Uma migration futura acrescentou coluna; este Worker ainda nao sabe
      // dela e nao pode cair por causa disso.
      coluna_do_futuro: 'valor que este codigo nunca viu',
    })

    const snapshot = await carregarConfigEfetiva(comBanco(banco), AGORA)

    expect(snapshot.origem).toBe('banco')
    expect('coluna_do_futuro' in snapshot.global).toBe(false)
    expect(Object.keys(snapshot.global).sort()).toEqual(Object.keys(automationConfig).sort())
  })
})

describe('CFG: sobreposicoes por midia', () => {
  test('CFG-16: linha de midia invalida recebe { enabled: false } e as outras seguem', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, MEDIA_A, { destination_url: 'http://inseguro.example' })
    await gravarMidia(env.DB, MEDIA_B, { public_reply_text: 'Texto do Reel B.' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    expect(snapshot.origem).toBe('banco')
    // Descartar a linha ALARGARIA: ela podia ser justamente o que estreitava.
    expect(snapshot.overrides).toEqual([
      { mediaIds: [MEDIA_A], enabled: false },
      { mediaIds: [MEDIA_B], publicReplyText: 'Texto do Reel B.' },
    ])

    const naRuim = resolveConfigForMedia(MEDIA_A, snapshot.global, snapshot.overrides)
    expect(evaluateComment(evento(), naRuim, IG_USER_ID, USERNAME_CONTA)).toEqual({
      process: false,
      reason: 'automacao_desligada',
    })

    const naBoa = resolveConfigForMedia(MEDIA_B, snapshot.global, snapshot.overrides)
    expect(
      evaluateComment(evento({ mediaId: MEDIA_B }), naBoa, IG_USER_ID, USERNAME_CONTA),
    ).toEqual({ process: true, keyword: 'eu quero' })
  })

  test('CFG-16: media_id fora do formato tambem pausa so aquela midia', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, 'nao-e-um-id', {})
    await gravarMidia(env.DB, MEDIA_B, {})

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    // A ordem e a do `ORDER BY media_id` do repositorio.
    expect(snapshot.overrides).toEqual([
      { mediaIds: [MEDIA_B] },
      { mediaIds: ['nao-e-um-id'], enabled: false },
    ])
  })

  test('CFG-16: sobreposicao que so faz sentido mesclada e julgada JA mesclada', async () => {
    // Sozinho, `matchMode: 'contains'` e valido. Mesclado sobre uma global com
    // gatilho de 8 caracteres continua valido; com um gatilho de 2, nao.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, MEDIA_A, { match_mode: 'contains', trigger_keywords: '["eu"]' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    expect(snapshot.overrides).toEqual([{ mediaIds: [MEDIA_A], enabled: false }])
  })

  test('CFG-10: duas midias com o mesmo media_id sao recusadas na gravacao', async () => {
    await gravarConfig(env.DB)
    await gravarMidia(env.DB, MEDIA_A)

    // `media_id` e PRIMARY KEY: "duas entradas citando o mesmo Reel, a
    // primeira vence em silencio" deixa de ser representavel.
    expect(await erroDe(() => gravarMidia(env.DB, MEDIA_A))).toContain('UNIQUE constraint failed')
  })

  test('CFG-17: linhas de midia sem linha global sao ignoradas, com aviso', async () => {
    await gravarMidia(env.DB, MEDIA_A, { destination_url: 'https://exemplo.com/orfa' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    // Misturar global-do-arquivo com sobreposicao-do-banco ALARGA.
    expect(snapshot.origem).toBe('arquivo')
    expect(snapshot.global).toEqual(automationConfig)
    expect(snapshot.overrides).toEqual([])
    expect(snapshot.avisos.join(' ')).toContain('painel_midias')
  })

  test('§9.4: allowedMediaIds e DERIVADO de media_scope e das linhas ativas', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, MEDIA_A)
    await gravarMidia(env.DB, MEDIA_B)
    // Linha inativa nao entra nem na lista nem nas sobreposicoes.
    await gravarMidia(env.DB, '17900000000000003', {}, 0)

    const selecionadas = await carregarConfigEfetiva(env, AGORA)
    expect(selecionadas.global.allowedMediaIds).toEqual([MEDIA_A, MEDIA_B])

    // O invariante que isto compra: existe sobreposicao(X) => isMediaAllowed(X),
    // sem nenhuma checagem. Nao existe sobreposicao que nunca dispara.
    for (const sobreposicao of selecionadas.overrides) {
      expect(selecionadas.global.allowedMediaIds).toContain(sobreposicao.mediaIds[0])
    }
  })

  test('§9.4: media_scope "todas" vira o curinga, e nao a lista', async () => {
    await gravarConfig(env.DB, { media_scope: 'todas' })
    await gravarMidia(env.DB, MEDIA_A)

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    expect(snapshot.global.allowedMediaIds).toEqual(['*'])
    // O alargamento se chama `mediaScope: 'todas'`, nunca "allowedMediaIds
    // para *". O campo nao e gravavel, e por isso nao aparece no schema.
    expect(snapshot.overrides).toEqual([{ mediaIds: [MEDIA_A] }])
  })
})

describe('CFG: o banco fora do ar e a migration atrasada', () => {
  test('CFG-15: tabela inexistente usa a fabrica e sinaliza', async () => {
    const snapshot = await carregarConfigEfetiva(comBanco(new D1SemAsTabelasDoPainel()), AGORA)

    // Migration nao aplicada e um estado ESPERADO num deploy fora de ordem: a
    // automacao segue exatamente como antes de o painel existir.
    expect(snapshot.origem).toBe('arquivo')
    expect(snapshot.global).toEqual(automationConfig)
    expect(snapshot.avisos.join(' ')).toContain('tabelas do painel')
  })

  test('CFG-18: erro de D1 vira parado_por_erro', async () => {
    const snapshot = await carregarConfigEfetiva(comBanco(new D1BatchQuebrado(env.DB)), AGORA)

    expect({ origem: snapshot.origem, enabled: snapshot.global.enabled }).toEqual({
      origem: 'parado_por_erro',
      enabled: false,
    })
  })

  test('CFG-18: o snapshot de falha e cacheado com o TTL longo', async () => {
    await carregarConfigEfetiva(comBanco(new D1BatchQuebrado(env.DB)), AGORA)

    // Um banco que ja esta caindo nao pode ser martelado a cada invocacao.
    const dentroDaJanela = await carregarConfigEfetiva(env, AGORA + TTL_DESLIGADO_MS - 1)
    expect(dentroDaJanela.origem).toBe('parado_por_erro')

    const depois = await carregarConfigEfetiva(env, AGORA + TTL_DESLIGADO_MS + 1)
    expect(depois.origem).toBe('arquivo')
  })
})

describe('§9.6: o cache por isolate', () => {
  test('§9.6: ligado vive 10 s; a mudanca aparece assim que a janela fecha', async () => {
    await gravarConfig(env.DB)
    expect((await carregarConfigEfetiva(env, AGORA)).origem).toBe('banco')

    await env.DB.prepare('DELETE FROM painel_config').run()

    // Servir "ligado" desatualizado e a direcao perigosa: a janela e curta.
    expect((await carregarConfigEfetiva(env, AGORA + TTL_LIGADO_MS - 1)).origem).toBe('banco')
    expect((await carregarConfigEfetiva(env, AGORA + TTL_LIGADO_MS + 1)).origem).toBe('arquivo')
  })

  test('§9.6: desligado vive 60 s: servir "parado" velho nunca causa dano', async () => {
    await gravarConfig(env.DB, { enabled: 0, trigger_keywords: '[]' })
    expect((await carregarConfigEfetiva(env, AGORA)).global.enabled).toBe(false)

    await env.DB.prepare('DELETE FROM painel_config').run()

    expect((await carregarConfigEfetiva(env, AGORA + TTL_LIGADO_MS + 1)).origem).toBe('banco')
    expect((await carregarConfigEfetiva(env, AGORA + TTL_DESLIGADO_MS + 1)).origem).toBe('arquivo')
  })

  test('§9.6: o painel nao usa o cache: ignorarCache rele do banco', async () => {
    await gravarConfig(env.DB)
    await carregarConfigEfetiva(env, AGORA)

    await env.DB.prepare('DELETE FROM painel_config').run()

    expect((await carregarConfigEfetiva(env, AGORA)).origem).toBe('banco')
    const doPainel = await carregarConfigEfetiva(env, AGORA, { ignorarCache: true })
    expect(doPainel.origem).toBe('arquivo')
  })

  test('§9.6: o snapshot e congelado em profundidade antes de entrar no cache', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, MEDIA_A, { trigger_keywords: '["so deste reel"]' })

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    // `{ ...global }` de `resolveConfigForMedia` e copia RASA: sem congelar os
    // arrays, um `config.triggerKeywords.push(...)` envenenaria o isolate.
    expect(Object.isFrozen(snapshot.global)).toBe(true)
    expect(Object.isFrozen(snapshot.global.triggerKeywords)).toBe(true)
    expect(Object.isFrozen(snapshot.global.allowedMediaIds)).toBe(true)
    expect(Object.isFrozen(snapshot.overrides)).toBe(true)
    for (const sobreposicao of snapshot.overrides) {
      expect(Object.isFrozen(sobreposicao)).toBe(true)
      expect(Object.isFrozen(sobreposicao.mediaIds)).toBe(true)
    }

    // E o congelamento nao alcancou `src/config.ts`, que a spec manda deixar
    // intacto: o snapshot copia os arrays da fabrica.
    expect(Object.isFrozen(automationConfig.triggerKeywords)).toBe(false)
  })
})

describe('CFG: uma carga por lote, nunca por comentario', () => {
  beforeEach(async () => {
    await ligarConta(env, AGORA)
    await gravarConfig(env.DB)
  })

  test('CFG-11: um lote de 3 comentarios carrega a config UMA vez', async () => {
    const contador = new D1Contador(env.DB)

    await processEvents(loteDe(3), comBanco(contador), AGORA, {
      createApi: () => comoApi(new MetaFalsa()),
    })

    // A conta fechada, para a folga ficar visivel em vez de implicita:
    // 2 do lote (token da conta e credencial) + 2 da config (as duas consultas
    // viajam num `db.batch()` unico) + 3 x 5 da entrega = 19.
    // Uma carga por COMENTARIO daria 2 + 3 x 2 + 15 = 23.
    expect({ prepares: contador.prepares, batches: contador.batches }).toEqual({
      prepares: 19,
      batches: 1,
    })
  })

  test('CFG-11: a config vem do cache na segunda invocacao do mesmo isolate', async () => {
    await processEvents(loteDe(1), env, AGORA, { createApi: () => comoApi(new MetaFalsa()) })

    const contador = new D1Contador(env.DB)
    await processEvents(
      [evento({ commentId: 'comment-cfg-segundo', fromId: 'igsid-cfg-segundo' })],
      comBanco(contador),
      AGORA + 1,
      { createApi: () => comoApi(new MetaFalsa()) },
    )

    // 2 do lote + 5 da entrega. Nenhuma consulta de config: o cache respondeu.
    expect({ prepares: contador.prepares, batches: contador.batches }).toEqual({
      prepares: 7,
      batches: 0,
    })
  })

  test('CFG-12: um lote de 10 comentarios executa menos de 50 consultas', async () => {
    const contador = new D1Contador(env.DB)
    const api = new MetaFalsa()

    await processEvents(loteDe(10), comBanco(contador), AGORA, { createApi: () => comoApi(api) })

    // Consultas ao D1 e chamadas a Meta dividem os mesmos 50 subrequests.
    expect(contador.prepares + api.total).toBeLessThan(TETO_DE_SUBREQUESTS)

    // 2 do lote + 2 da config + 5 entregues x 5 + 5 reagendados = 34.
    expect(contador.prepares).toBe(34)
  })

  test('CFG-12: o lote entrega mesmo com a config vindo do banco', async () => {
    const api = new MetaFalsa()

    await processEvents(loteDe(3), env, AGORA, { createApi: () => comoApi(api) })

    expect(api.chamadas.filter((c) => c === 'private')).toHaveLength(3)
    // E o texto entregue e o do BANCO, nao o do arquivo.
    expect(api.textosEnviados[0]).toContain(LINHA_VALIDA.destination_url)
  })
})

describe('CFG: o validador unico', () => {
  test('CFG-13: recusar uma config invalida nao custa consulta nenhuma', async () => {
    const contador = new D1Contador(env.DB)

    // O mesmo validador da leitura e o da escrita (§9.7). Ele e sincrono e
    // puro: nao recebe `Env`, nao recebe D1, nao tem como tocar o banco antes
    // de recusar. A ordem completa da rota de gravacao chega com a etapa 10.
    const resultado = validarConfig(configDeTeste({ destinationUrl: 'http://inseguro.example' }))

    expect(resultado.ok).toBe(false)
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 0,
      escritas: 0,
    })
  })

  test('CFG-13: o achado NOMEIA o campo, para a tela poder mostrar qual e', () => {
    const resultado = validarConfig(
      configDeTeste({ destinationUrl: 'http://x.com', userCooldownHours: -1 }),
    )

    if (resultado.ok) throw new Error('a config invalida deveria ter sido recusada')
    expect(resultado.achados.map((achado) => achado.campo).sort()).toEqual([
      'destinationUrl',
      'userCooldownHours',
    ])
  })

  test('CFG-13: o validador NUNCA conserta: ele devolve o valor que chegou', () => {
    const original = configDeTeste()
    const resultado = validarConfig(original)

    if (!resultado.ok) throw new Error('a config de teste deveria ser valida')
    expect(resultado.valor).toEqual(original)
  })

  test('CFG-13: lista de gatilhos vazia so passa com a automacao desligada', () => {
    const ligada = validarConfig(configDeTeste({ triggerKeywords: [], enabled: true }))
    const desligada = validarConfig(configDeTeste({ triggerKeywords: [], enabled: false }))

    expect({ ligada: ligada.ok, desligada: desligada.ok }).toEqual({
      ligada: false,
      desligada: true,
    })
  })

  test('CFG-13: o tamanho do gatilho e medido no texto NORMALIZADO', () => {
    // "eu!" tem 3 caracteres crus e normaliza para "eu": dois. Medir no cru
    // deixaria passar um gatilho de 2 letras em modo `contains`.
    const cru = validarConfig(
      configDeTeste({ matchMode: 'contains', triggerKeywords: ['eu!'], ignorePunctuation: true }),
    )

    expect(cru.ok).toBe(false)
  })
})

/**
 * O snapshot e o contrato que as etapas seguintes consomem. Se a forma dele
 * mudar sem que alguem repare, a tela e o webhook passam a discordar.
 */
describe('§9.2: a forma do snapshot', () => {
  test('§9.2: o snapshot tem exatamente os seis campos declarados', async () => {
    // **O sexto campo nasceu para o ORCAMENTO de §12.10, e nao para o
    // comportamento.** `linhasDeMidia` carrega `painel_midias` INTEIRA, com as
    // inativas, quando quem le pede por ela, para que as duas telas de Reels
    // parem de gastar uma consulta propria com o que §12.5 manda elas
    // mostrarem. Ele viaja no `db.batch()` que ja existia, entao custa zero
    // subrequest, e o caminho quente NUNCA pede: para o webhook ele e sempre
    // `null`, que e o que a linha abaixo afirma.
    //
    // A afirmacao de forma continua sendo a mesma, e e por isso que ela nao foi
    // afrouxada para "pelo menos estes": quem acrescentar um sexto de verdade
    // um campo que MUDE comportamento, passa por aqui antes.
    const snapshot: SnapshotConfig = await carregarConfigEfetiva(env, AGORA)

    expect(Object.keys(snapshot).sort()).toEqual([
      'avisos',
      'global',
      'linhasDeMidia',
      'origem',
      'overrides',
      'versao',
    ])
    expect(snapshot.linhasDeMidia).toBeNull()
  })

  test('§9.2: `linhasDeMidia` so vem quando quem le pede, e traz as INATIVAS', async () => {
    // O contrapositivo do teste acima, e a trava do conserto de §12.10: sem
    // ele, um `comAsInativas` que nunca chegasse ao SQL passaria calado e as
    // telas de Reels voltariam a mostrar so as linhas ativas, o Reel apagado
    // sumiria em silencio, que e o que §3 proibe.
    await gravarConfig(env.DB)
    await gravarMidia(env.DB, '17912345678901234')
    await gravarMidia(env.DB, '17912345678901235', {}, 0)

    invalidarCacheDeConfig()
    const semPedir = await carregarConfigEfetiva(env, AGORA, { ignorarCache: true })
    expect(semPedir.linhasDeMidia).toBeNull()

    invalidarCacheDeConfig()
    const pedindo = await carregarConfigEfetiva(env, AGORA, {
      ignorarCache: true,
      comAsInativas: true,
    })

    expect(
      pedindo.linhasDeMidia?.map((linha) => `${linha.media_id}:${String(linha.ativo)}`),
    ).toEqual(['17912345678901234:1', '17912345678901235:0'])
    // E o que resolve COMPORTAMENTO nao mudou: `overrides` sai das linhas
    // ATIVAS nos dois casos, a inativa entra em `linhasDeMidia` e em lugar
    // nenhum mais. Se o filtro tivesse sumido junto com o `WHERE`, o Reel
    // desmarcado voltaria a responder, que e o alargamento silencioso que esta
    // linha existe para impedir.
    expect(pedindo.overrides).toHaveLength(1)
    expect(semPedir.overrides).toHaveLength(1)
    expect(pedindo.overrides[0]?.mediaIds).toEqual(['17912345678901234'])
  })

  test('§9.2: `global` tem a mesma forma de AutomationConfig, campo a campo', async () => {
    await gravarConfig(env.DB)
    const snapshot = await carregarConfigEfetiva(env, AGORA)

    const forma = (valor: unknown): string => (Array.isArray(valor) ? 'array' : typeof valor)
    for (const chave of Object.keys(automationConfig) as (keyof AutomationConfig)[]) {
      expect({ [chave]: forma(snapshot.global[chave]) }).toEqual({
        [chave]: forma(automationConfig[chave]),
      })
    }
  })
})

/**
 * O cron e a OUTRA ponta da entrega, e desde §16.1 ele drena todo comentario a
 * partir do sexto de cada lote. Um portao que so exista em `processEvents` nao
 * para a automacao, para metade dela.
 */
describe('CFG: a configuracao parada tambem para o cron', () => {
  /** Um pendente na fila, pronto para a proxima varredura. */
  async function enfileirarPendente(commentId = 'comment-pendente'): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO processed_comments
         (comment_id, media_id, commenter_scoped_id_hash, status,
          attempt_count, next_retry_at, created_at, updated_at)
       VALUES (?, ?, 'hash-pendente', 'retry_pending', 1, ?, ?, ?)`,
    )
      .bind(commentId, MEDIA_A, AGORA, AGORA, AGORA)
      .run()
  }

  async function registroDe(commentId: string): Promise<{ status: string; tentativas: number }> {
    const linha = await env.DB.prepare(
      'SELECT status, attempt_count FROM processed_comments WHERE comment_id = ?',
    )
      .bind(commentId)
      .first<{ status: string; attempt_count: number }>()

    return { status: linha?.status ?? 'sumiu', tentativas: linha?.attempt_count ?? -1 }
  }

  /** O dono conserta a linha a mao, por `wrangler d1 execute`. Sem redeploy. */
  async function apagarConfig(): Promise<void> {
    await env.DB.prepare(SQL_APAGA_CONFIG).run()
  }

  beforeEach(async () => {
    await ligarConta(env, AGORA)
    await enfileirarPendente()
  })

  test('CFG-14: o controle: com a config valida o cron ENTREGA o pendente', async () => {
    // Sem este teste, o de baixo passaria por a fila estar vazia ou por o cron
    // nem chegar no laco.
    await gravarConfig(env.DB)
    const api = new MetaFalsa()

    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(api) })

    expect(api.chamadas).toEqual(['private', 'public'])
    expect(await registroDe('comment-pendente')).toEqual({ status: 'completed', tentativas: 1 })
    // E o link entregue e o do BANCO.
    expect(api.textosEnviados[0]).toContain(LINHA_VALIDA.destination_url)
  })

  test('CFG-14: link corrompido no banco NAO vira Direct com o link de fabrica pelo cron', async () => {
    await gravarConfig(env.DB, { destination_url: 'nao-e-uma-url' })
    const api = new MetaFalsa()

    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(api) })

    // A automacao esta parada: nenhuma das duas metades da restricao pode ser
    // furada aqui. Nem entregar, nem entregar com o valor de fabrica.
    expect(api.chamadas).toEqual([])
    expect(api.textosEnviados).toEqual([])
  })

  test('CFG-14: o pendente barrado fica na fila, sem gastar tentativa', async () => {
    await gravarConfig(env.DB, { destination_url: 'nao-e-uma-url' })

    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(new MetaFalsa()) })

    // Parar e REVERSIVEL: marcar `ignored` apagaria, por um erro nosso, o
    // comentario de quem digitou a palavra-gatilho.
    expect(await registroDe('comment-pendente')).toEqual({
      status: 'retry_pending',
      tentativas: 1,
    })
  })

  test('CFG-14: consertada a config, a varredura seguinte drena a fila', async () => {
    await gravarConfig(env.DB, { destination_url: 'nao-e-uma-url' })
    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(new MetaFalsa()) })

    await apagarConfig()
    await gravarConfig(env.DB)
    invalidarCacheDeConfig()

    const api = new MetaFalsa()
    await runScheduledTasks(env, AGORA + 1, { createApi: () => comoApi(api) })

    expect(api.chamadas).toEqual(['private', 'public'])
    expect((await registroDe('comment-pendente')).status).toBe('completed')
  })

  test('CFG-02: automacao desligada no banco tambem para o cron', async () => {
    await gravarConfig(env.DB, { enabled: 0, trigger_keywords: '[]' })
    const api = new MetaFalsa()

    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(api) })

    expect(api.chamadas).toEqual([])
    expect((await registroDe('comment-pendente')).status).toBe('retry_pending')
  })

  test('CFG-16: uma midia pausada nao para as outras no cron', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    await gravarMidia(env.DB, MEDIA_A, { destination_url: 'http://inseguro.example' })
    await gravarMidia(env.DB, MEDIA_B)
    await enfileirarPendente('comment-pendente-b')
    await env.DB.prepare('UPDATE processed_comments SET media_id = ? WHERE comment_id = ?')
      .bind(MEDIA_B, 'comment-pendente-b')
      .run()

    const api = new MetaFalsa()
    await runScheduledTasks(env, AGORA, { createApi: () => comoApi(api) })

    // So o Reel B foi entregue: o portao e por midia, e nao do lote inteiro.
    expect(api.chamadas).toEqual(['private', 'public'])
    expect((await registroDe('comment-pendente')).status).toBe('retry_pending')
    expect((await registroDe('comment-pendente-b')).status).toBe('completed')
  })
})

/**
 * §9.11 vence a letra de §9.2, ruling do controlador na rodada 1.
 *
 * `mediaAutomations` nasce `[]` neste template, entao o ramo so e distinguivel
 * de um `[]` escrito a mao se o teste puder injetar cartoes. E por isso que
 * `sobreposicoesDaFabrica` recebe a lista por parametro.
 */
describe('§9.11: atualizar o codigo nao pode apagar as automacoes por Reel', () => {
  const CARTAO: MediaAutomation = {
    mediaIds: [MEDIA_A, MEDIA_B],
    triggerKeywords: ['cardapio'],
    destinationUrl: 'https://exemplo.com/cardapio',
  }

  test('§9.11: origem "arquivo" HERDA mediaAutomations, em vez de apagar', () => {
    expect(sobreposicoesDaFabrica('arquivo', [CARTAO])).toEqual([CARTAO])
  })

  test('§9.11: a heranca e copia PROFUNDA: congelar o cache nao congela o arquivo', () => {
    const [copia] = sobreposicoesDaFabrica('arquivo', [CARTAO])
    if (copia === undefined) throw new Error('a copia deveria existir')

    expect(copia).not.toBe(CARTAO)
    expect(copia.mediaIds).not.toBe(CARTAO.mediaIds)
    expect(copia.triggerKeywords).not.toBe(CARTAO.triggerKeywords)

    Object.freeze(copia.mediaIds)
    expect(Object.isFrozen(CARTAO.mediaIds)).toBe(false)
  })

  test('§9.11: a copia nao inventa chave com undefined para campo ausente', () => {
    const [copia] = sobreposicoesDaFabrica('arquivo', [{ mediaIds: [MEDIA_A] }])
    if (copia === undefined) throw new Error('a copia deveria existir')

    // Mesmo defeito que §9.3 mata no parser do banco: `{ triggerKeywords:
    // undefined }` num spread zera o campo global.
    expect('triggerKeywords' in copia).toBe(false)
    expect(Object.values(copia).every((valor) => valor !== undefined)).toBe(true)
  })

  test('§9.11: parado_por_erro NAO herda: no arquivo nada impede enabled: true', () => {
    // O estado de erro tem de parar tudo, e um cartao do arquivo poderia
    // religar a midia por cima da global desligada.
    expect(sobreposicoesDaFabrica('parado_por_erro', [CARTAO])).toEqual([])
    expect(sobreposicoesDaFabrica('banco', [CARTAO])).toEqual([])
  })

  test('§9.11: a linha ausente serve exatamente o que a fabrica manda', async () => {
    const snapshot = await carregarConfigEfetiva(env, AGORA)

    expect(snapshot.origem).toBe('arquivo')
    expect(snapshot.overrides).toEqual(sobreposicoesDaFabrica('arquivo'))
  })
})

describe('CFG: invalidarCacheDeConfig()', () => {
  test('CFG-18: invalidarCacheDeConfig() faz a leitura seguinte reler o banco', async () => {
    await gravarConfig(env.DB)
    expect((await carregarConfigEfetiva(env, AGORA)).origem).toBe('banco')

    await env.DB.prepare(SQL_APAGA_CONFIG).run()
    // Dentro da janela dos 10 s o cache ainda responderia "banco"...
    expect((await carregarConfigEfetiva(env, AGORA)).origem).toBe('banco')

    invalidarCacheDeConfig()

    // ...e e exatamente isso que toda rota que grava precisa desfazer, no MESMO
    // instante, sem esperar TTL nenhum.
    expect((await carregarConfigEfetiva(env, AGORA)).origem).toBe('arquivo')
  })

  test('CFG-18: invalidarCacheDeConfig() e segura com o cache ja vazio', async () => {
    // A rota de gravacao chama sem saber se este isolate ja carregou alguma
    // coisa; chamar duas vezes seguidas tambem nao pode explodir.
    invalidarCacheDeConfig()
    invalidarCacheDeConfig()

    await expect(carregarConfigEfetiva(env, AGORA)).resolves.toMatchObject({ origem: 'arquivo' })
  })
})

describe('CFG: o batch que falha sem rejeitar', () => {
  test('CFG-14: batch sem sucesso vira parado_por_erro, e nunca a fabrica LIGADA', async () => {
    const snapshot = await carregarConfigEfetiva(comBanco(new D1QueNaoReportaSucesso()), AGORA)

    // Dois resultados vazios seriam lidos como "linha ausente", a fabrica
    // LIGADA. Seria o unico ponto do modulo em que um erro ALARGA.
    expect({ origem: snapshot.origem, enabled: snapshot.global.enabled }).toEqual({
      origem: 'parado_por_erro',
      enabled: false,
    })
  })
})
