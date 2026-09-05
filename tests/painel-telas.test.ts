import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { handleAtividade } from '../src/routes/painel/atividade'
import {
  ESCOPO_DE_MIDIAS,
  FRASE_DO_AJUSTE,
  MODO_DE_COMPARACAO,
  NOME_DO_CAMPO,
  ORIGEM_DOS_AJUSTES,
  PALAVRAS_PROIBIDAS,
  traduzirAviso,
} from '../src/routes/painel/dicionario'
import { cabecalhos } from '../src/routes/painel/html'
import { handleInicio, panorama } from '../src/routes/painel/inicio'
import { handleMensagem } from '../src/routes/painel/mensagem'
import { handlePalavras } from '../src/routes/painel/palavras'
import {
  ROTA_AJUSTES,
  ROTA_ATIVIDADE,
  ROTA_INICIO,
  ROTA_MENSAGEM,
  ROTA_PALAVRAS,
  ROTAS,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import {
  carregarConfigEfetiva,
  invalidarCacheDeConfig,
  type SnapshotConfig,
} from '../src/services/config-store'
import { emitirSessao, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import { matchKeyword, normalizeOptionsFrom } from '../src/utils/normalize'
import { renderTemplate } from '../src/utils/templates'
import { gravarConfig, gravarMidia, ligarConta, limparBanco } from './fixtures/banco'
import { AGORA, capturarConsole, comoD1, configDeTeste, D1Contador, pedir } from './fixtures/dubles'

/**
 * TELA · DIC · HDR — as cinco telas de leitura, o dicionario e o escape.
 *
 * `now` e sempre injetado e os handlers sao chamados por `despachar`, que e a
 * MESMA funcao que o roteador usa: um teste que chamasse o handler direto
 * pularia a escada de §11.3 e afirmaria menos do que parece.
 *
 * **HDR-07 e HDR-08 nao estao aqui, e a ausencia e declarada.** As duas sao
 * sobre o campo `corpo.painel` de `GET /health` (§11.9), que nasce na etapa
 * dos portoes de publicacao. Escrever aqui um teste que fingisse cobri-las
 * seria pior que a ausencia (§13.1).
 */

/** O vetor de injecao. Ele PASSA no validador, e por isso chega mesmo a tela. */
const VETOR = '<script>alert(1)</script>'

/** Uma linha de configuracao inteira envenenada, campo a campo. */
const CONFIG_ENVENENADA = {
  trigger_keywords: JSON.stringify([VETOR, 'quero o link']),
  public_reply_text: VETOR,
  private_reply_text: `${VETOR} {link}`,
}

/** As cinco telas desta etapa, com o handler de cada uma. */
const TELAS: readonly { rota: RotaDoPainel; handler: HandlerDoPainel }[] = [
  { rota: ROTA_INICIO, handler: handleInicio },
  { rota: ROTA_PALAVRAS, handler: handlePalavras },
  { rota: ROTA_MENSAGEM, handler: handleMensagem },
  { rota: ROTA_AJUSTES, handler: handleAjustes },
  { rota: ROTA_ATIVIDADE, handler: handleAtividade },
]

/**
 * Caminhos que uma tela pode citar sem estarem na tabela de rotas.
 *
 * Sao os assets de §11.2, que o Worker nao despacha. Qualquer outro `href`
 * fora da tabela e um link para um `404`.
 */
const ASSETS = ['/painel/parar', '/painel/painel.css', '/painel/painel.js']

/** O teto de HTML por tela de §12.9, em bytes. */
const TETO_DE_HTML = 15 * 1024

/** O que §13.2 proibe em qualquer corpo: rastro, nome de coluna, "payload". */
const VAZAMENTO = /Error|at \w+ \(|SQLITE|D1_|undefined|payload/

function ambienteCom(mudanca: Record<string, unknown>): Env {
  return { ...env, ...mudanca } as unknown as Env
}

async function abrirSessao(): Promise<Record<string, string>> {
  const sessao = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, 'cred', ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      sessao.sidHash,
      env.PANEL_RP_ID,
      AGORA,
      sessao.expiraEm,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      AGORA,
    )
    .run()

  return { cookie: `__Host-painel_sessao=${sessao.valor}` }
}

/** Abre uma tela com sessao viva, pela mesma escada que o roteador usa. */
async function abrirTela(
  tela: { rota: RotaDoPainel; handler: HandlerDoPainel },
  cookie: Record<string, string>,
  ambiente: Env = env,
): Promise<Response> {
  return await despachar(pedir(tela.rota.caminho, cookie), ambiente, AGORA, tela.rota, tela.handler)
}

/** Todo `href` que a pagina cita. */
function linksDe(corpo: string): string[] {
  return [...corpo.matchAll(/href="([^"]*)"/g)].map((achado) => achado[1] ?? '')
}

/**
 * Quantos subrequests ao D1 aquela tela gastou.
 *
 * Um `db.batch()` inteiro vale UM subrequest, e o unico lote das telas de
 * leitura e o da configuracao — que leva exatamente dois statements. Por isso
 * `prepares - batches` e a conta: os dois statements do lote viram um.
 */
function subrequests(contador: D1Contador): number {
  return contador.prepares - contador.batches
}

/**
 * Um snapshot montado a mao, para exercitar `panorama` como a funcao PURA que
 * ela e.
 *
 * Os valores vem de `configDeTeste`, e nao de `src/config.ts`, pelo motivo que
 * o fixture ja escreve: este repositorio e um template publico e cada
 * instalacao clona com o proprio link. Um teste preso ao link do arquivo
 * ficaria vermelho na maquina de quem usa o produto como ele foi feito.
 */
function snapshotDeTeste(
  patch: Partial<AutomationConfig> = {},
  extra: Partial<SnapshotConfig> = {},
): SnapshotConfig {
  return {
    global: configDeTeste(patch),
    overrides: [],
    origem: 'banco',
    versao: 1,
    avisos: [],
    ...extra,
  }
}

async function snapshotDoBanco(): Promise<SnapshotConfig> {
  invalidarCacheDeConfig()
  return await carregarConfigEfetiva(env, AGORA, { ignorarCache: true })
}

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
})

// ---------------------------------------------------------------------------
// HDR — escape, `<script>` e cabecalhos
// ---------------------------------------------------------------------------

describe('HDR — o valor do banco na tela', () => {
  test('HDR-06: uma palavra-gatilho com `<script>` sai escapada na tela de Palavras', async () => {
    await gravarConfig(env.DB, { trigger_keywords: JSON.stringify([VETOR, 'quero o link']) })
    const cookie = await abrirSessao()

    const resposta = await abrirTela(TELAS[1] as (typeof TELAS)[number], cookie)
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    // O valor CHEGOU a tela — sem isto o teste passaria com uma tela vazia.
    expect(corpo).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(corpo).not.toContain(VETOR)
  })

  test('HDR-06: o texto do Direct e o texto publico saem escapados na tela da Mensagem', async () => {
    await gravarConfig(env.DB, CONFIG_ENVENENADA)
    const cookie = await abrirSessao()

    const corpo = await (await abrirTela(TELAS[2] as (typeof TELAS)[number], cookie)).text()

    expect(corpo).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(corpo).not.toContain(VETOR)
  })

  test('HDR-09: as cinco telas com um `<script>` vindo do banco, e nenhuma o devolve', async () => {
    // O laco vem da lista de telas, e nao de cinco casos escritos a mao: uma
    // tela nova entra nele sozinha. E ele percorre TODAS, e nao so as que
    // interpolam texto hoje, porque a tela que hoje nao interpola e
    // exatamente a que amanha vai passar a interpolar sem ninguem lembrar.
    await gravarConfig(env.DB, CONFIG_ENVENENADA)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await (await abrirTela(tela, cookie)).text()

      expect({ [tela.rota.caminho]: corpo.includes('<script') }).toEqual({
        [tela.rota.caminho]: false,
      })
      expect({ [tela.rota.caminho]: corpo.includes('javascript:') }).toEqual({
        [tela.rota.caminho]: false,
      })
      expect({ [tela.rota.caminho]: /onclick=|onerror=|onload=/.test(corpo) }).toEqual({
        [tela.rota.caminho]: false,
      })
      // Nenhum `<style>` inline: a CSP nao tem `unsafe-inline` e um bloco de
      // estilo na pagina simplesmente nao pintaria nada.
      expect({ [tela.rota.caminho]: corpo.includes('<style') }).toEqual({
        [tela.rota.caminho]: false,
      })
    }
  })

  test('HDR-01 a HDR-04 e HDR-10: as cinco telas saem com o mapa de cabecalhos de pagina', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const esperado = cabecalhos('pagina')

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const resposta = await abrirTela(tela, cookie)
      const mapa = Object.fromEntries(resposta.headers)

      // O mapa INTEIRO, e nao um cabecalho de cada vez: assim um `Access-
      // Control-Allow-Origin` que alguem acrescentasse reprovaria aqui, e nao
      // so numa afirmacao que ninguem lembrou de escrever.
      expect({ [tela.rota.caminho]: mapa }).toEqual({ [tela.rota.caminho]: esperado })
    }
  })

  test('HDR-10: `OPTIONS` nas telas novas responde 405, e nunca CORS', async () => {
    for (const tela of TELAS) {
      const resposta = await despachar(
        new Request(`https://exemplo.workers.dev${tela.rota.caminho}`, { method: 'OPTIONS' }),
        env,
        AGORA,
        tela.rota,
        tela.handler,
      )

      expect({ [tela.rota.caminho]: resposta.status }).toEqual({ [tela.rota.caminho]: 405 })
      for (const [nome] of resposta.headers) {
        expect({ [nome]: nome.startsWith('access-control-') }).toEqual({ [nome]: false })
      }
    }
  })

  test('HDR-05: a tela de configuracao recusada nao vaza rastro, coluna nem "payload"', async () => {
    // O caminho mais perigoso da etapa: o validador reprovou, a frase tecnica
    // do achado existe, e ela NAO pode chegar a tela.
    await gravarConfig(env.DB, { destination_url: '[coloque-seu-link-aqui]' })
    const cookie = await abrirSessao()

    // `config-store.ts` publica o achado no `console` a cada leitura, e e la
    // que ele deve ficar. A captura existe para o log da suite continuar limpo
    // e, de quebra, para a linha ser CONFERIDA em vez de so ignorada.
    const console = capturarConsole()
    try {
      for (const tela of TELAS) {
        invalidarCacheDeConfig()
        const corpo = await (await abrirTela(tela, cookie)).text()

        expect({ [tela.rota.caminho]: VAZAMENTO.test(corpo) }).toEqual({
          [tela.rota.caminho]: false,
        })
        expect({ [tela.rota.caminho]: corpo.includes('destinationUrl') }).toEqual({
          [tela.rota.caminho]: false,
        })
        // A frase tecnica do achado — a que fala em "endereco completo" — fica
        // no `console`, onde `config-store.ts` ja a publica, e nunca na tela.
        expect({ [tela.rota.caminho]: corpo.includes('endereco completo') }).toEqual({
          [tela.rota.caminho]: false,
        })
      }
    } finally {
      console.parar()
    }

    expect(console.linhas.join(' ')).toContain('destinationUrl/link_invalido')
  })
})

// ---------------------------------------------------------------------------
// DIC — o dicionario de traducao
// ---------------------------------------------------------------------------

describe('DIC — o dicionario de traducao', () => {
  test('DIC-01: todo campo gravavel da configuracao tem traducao, e nenhuma sobra', async () => {
    // A trava forte deste dicionario e de TIPO — `Record<CampoDaConfig,
    // string>` nao compila com um campo faltando. Este teste e a metade
    // runtime: ele prova que o conjunto de chaves e exatamente o esperado, e
    // que ninguem traduziu `allowedMediaIds`, que nao e campo gravavel.
    const daFabrica = Object.keys(automationConfig).filter((campo) => campo !== 'allowedMediaIds')

    expect(new Set(Object.keys(NOME_DO_CAMPO))).toEqual(new Set([...daFabrica, 'mediaScope']))
    expect(Object.keys(NOME_DO_CAMPO)).not.toContain('allowedMediaIds')
  })

  test('DIC-02: nenhuma frase do dicionario escreve uma palavra proibida (§12.7)', () => {
    const frases = [
      ...Object.values(NOME_DO_CAMPO),
      ...Object.values(MODO_DE_COMPARACAO),
      ...Object.values(ESCOPO_DE_MIDIAS),
      ...Object.values(ORIGEM_DOS_AJUSTES),
      ...Object.values(FRASE_DO_AJUSTE).flatMap((par) => [par.sim, par.nao]),
    ]

    // Contrapositivo: uma lista vazia de frases faria o laco passar sem provar
    // nada.
    expect(frases.length).toBeGreaterThan(20)

    for (const frase of frases) {
      for (const proibida of PALAVRAS_PROIBIDAS) {
        expect({ [`${proibida} em "${frase}"`]: contemPalavra(frase, proibida) }).toEqual({
          [`${proibida} em "${frase}"`]: false,
        })
      }
    }
  })

  test('DIC-03: `traduzirAviso` NOMEIA o campo e nunca devolve a frase tecnica', () => {
    const traduzido = traduzirAviso(
      'userCooldownHours: A janela precisa ser um numero inteiro de horas entre 0 e 8760.',
    )

    expect(traduzido).toContain('intervalo por pessoa')
    expect(traduzido).not.toContain('userCooldownHours')
    expect(traduzido).not.toContain('janela')
  })

  test('DIC-03: aviso que nao e de campo nao vaza o nome da tabela nem o prefixo', () => {
    const daTabela = traduzirAviso(
      'painel_midias: ha midias selecionadas sem configuracao global; elas foram ignoradas.',
    )
    const doBanco = traduzirAviso('banco: nao foi possivel ler a configuracao.')
    const desconhecido = traduzirAviso('coisa_nova: alguma frase tecnica.')

    expect(daTabela).not.toContain('painel_midias')
    expect(doBanco).not.toContain('configuracao')
    // Um prefixo que o dicionario nao conhece cai numa frase generica, e nao
    // no texto cru: e a diferenca entre a tela envelhecer e a tela vazar.
    expect(desconhecido).not.toContain('coisa_nova')
    expect(desconhecido).not.toContain('tecnica')
  })
})

/** A palavra aparece com fronteira de palavra? Substring nao conta (§12.7). */
function contemPalavra(texto: string, palavra: string): boolean {
  const escapada = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\x2d')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapada}([^\\p{L}\\p{N}]|$)`, 'iu').test(texto)
}

// ---------------------------------------------------------------------------
// TELA — os estados, as pendencias e o que a tela promete
// ---------------------------------------------------------------------------

describe('TELA — os quatro estados grandes', () => {
  test('TELA-01: tudo resolvido e conta ligada dao "Ligada e respondendo"', () => {
    const visao = panorama(snapshotDeTeste(), true)

    expect(visao.estado.chave).toBe('ligada')
    expect(visao.pendencias).toEqual([])
  })

  test('TELA-01: ligada com o link de fabrica da o ambar, e nao o verde', () => {
    // E o estado que §12.1 regra 3 existe para tornar visivel: hoje a
    // automacao recusa disparar por seguranca e ninguem fica sabendo. O link
    // entre colchetes e o do template recem-instalado.
    const visao = panorama(snapshotDeTeste({ destinationUrl: '[coloque o seu link]' }), true)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.map((p) => p.acao?.para)).toContain('/painel/mensagem')
  })

  test('TELA-01: sem nenhuma palavra o ambar aponta para a tela de Palavras', () => {
    const visao = panorama(snapshotDeTeste({ triggerKeywords: [] }), true)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.map((p) => p.acao?.para)).toContain('/painel/palavras')
  })

  test('TELA-01: conta desconectada tambem da o ambar, mesmo com tudo salvo', () => {
    const visao = panorama(snapshotDeTeste(), false)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.some((p) => p.texto.includes('não está conectada'))).toBe(true)
  })

  test('TELA-01: `enabled = 0` da cinza, e o cinza ganha do ambar', () => {
    // Quem desligou de proposito nao precisa ouvir que faltam coisas.
    const visao = panorama(
      snapshotDeTeste({ enabled: false, destinationUrl: '[ainda nao]' }),
      false,
    )

    expect(visao.estado.chave).toBe('desligada')
  })

  test('TELA-02: configuracao recusada da "Parada por seguranca" e NOMEIA o campo', async () => {
    // Caminho REAL: o link entre colchetes passa no `CHECK` do banco e e
    // recusado pelo validador, que e exatamente o estado `parado_por_erro`.
    await gravarConfig(env.DB, { destination_url: '[coloque-seu-link-aqui]' })
    const console = capturarConsole()
    let visao: ReturnType<typeof panorama>
    try {
      visao = panorama(await snapshotDoBanco(), true)
    } finally {
      console.parar()
    }

    expect(visao.estado.chave).toBe('parada_por_erro')
    expect(visao.estado.explicacao).toContain('O campo link')
    // Erro nunca inventa um valor que o dono nao viu na tela: a explicacao nao
    // propoe substituto nenhum, e nao repete a frase tecnica do achado.
    expect(visao.estado.explicacao).not.toContain('https://')
  })

  test('TELA-02: o cinza de parada por erro ganha do cinza de desligada', () => {
    // As duas tem `enabled: false`. So uma delas tem conserto, e a tela
    // precisa dizer qual campo consertar.
    const visao = panorama(
      snapshotDeTeste(
        { enabled: false },
        { origem: 'parado_por_erro', avisos: ['userCooldownHours: frase tecnica.'] },
      ),
      true,
    )

    expect(visao.estado.chave).toBe('parada_por_erro')
    expect(visao.estado.explicacao).toContain('intervalo por pessoa')
    expect(visao.estado.explicacao).not.toContain('frase tecnica')
  })

  test('TELA-02: `selecionadas` sem nenhuma midia ativa vira pendencia', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const semNenhuma = panorama(await snapshotDoBanco(), true)

    expect(semNenhuma.estado.chave).toBe('nada_sera_enviado')
    expect(semNenhuma.pendencias.some((p) => p.texto.includes('não marcou nenhum'))).toBe(true)

    // O contrapositivo: com uma midia ativa a pendencia some.
    await gravarMidia(env.DB, '17912345678901234')
    const comUma = panorama(await snapshotDoBanco(), true)

    expect(comUma.estado.chave).toBe('ligada')
  })

  test('TELA-03: sem linha no banco a tela diz que os ajustes sao os de fabrica', async () => {
    const visao = panorama(await snapshotDoBanco(), true)

    expect(visao.aindaDeFabrica).toBe(true)
  })
})

describe('TELA — o que a tela promete', () => {
  test('TELA-04: nenhum link das cinco telas aponta para fora da tabela de rotas', async () => {
    // A garantia que impede a tela de prometer o que nao existe. Ela vale
    // tambem para as telas que ainda nao nasceram: no dia em que alguem
    // escrever um `href="/painel/reels"` antes de a rota existir, este laco
    // fica vermelho.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const conhecidos = new Set([...ROTAS.map((rota) => rota.caminho), ...ASSETS])

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const links = linksDe(await (await abrirTela(tela, cookie)).text())

      // Contrapositivo: uma tela sem link nenhum passaria calada.
      expect({ [tela.rota.caminho]: links.length }).not.toEqual({ [tela.rota.caminho]: 0 })

      for (const link of links) {
        expect({ [`${tela.rota.caminho} -> ${link}`]: conhecidos.has(link) }).toEqual({
          [`${tela.rota.caminho} -> ${link}`]: true,
        })
      }
    }
  })

  test('TELA-05: nenhuma palavra proibida do glossario aparece nas cinco telas', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      // So o `<body>`: o `<head>` carrega `stylesheet` e `viewport`, que sao
      // atributos de HTML e nao texto que alguem le na tela.
      const corpo = (await (await abrirTela(tela, cookie)).text()).split('<body>')[1] ?? ''

      for (const proibida of PALAVRAS_PROIBIDAS) {
        expect({ [`${tela.rota.caminho}: ${proibida}`]: contemPalavra(corpo, proibida) }).toEqual({
          [`${tela.rota.caminho}: ${proibida}`]: false,
        })
      }
    }
  })

  test('TELA-06: as cinco telas escrevem ZERO vezes no D1', async () => {
    // §6: o painel le, nao age. E ele NUNCA escreve em `processed_comments`.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      expect({ [tela.rota.caminho]: contador.escritas }).toEqual({ [tela.rota.caminho]: 0 })
    }
  })

  test('TELA-06: cada tela custa 3 subrequests ao D1, e nenhuma toca `processed_comments`', async () => {
    // §12.10 orca 3 para o Inicio e 5 para "O que aconteceu". As tres telas do
    // meio pagam os mesmos 3, e o terceiro e a pergunta sobre a conta: sem ela
    // a barra do topo — que §12.1 exige IGUAL em toda tela — diria "Ligada e
    // respondendo" numa instalacao que nao consegue enviar nada.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      expect({ [tela.rota.caminho]: subrequests(contador) }).toEqual({ [tela.rota.caminho]: 3 })
    }
  })

  test('TELA-07: os exemplos de Palavras concordam com `matchKeyword` de producao', async () => {
    // §12.1 regra 4: o que a tela mostra e o que o Worker vai fazer. A prova e
    // rodar a funcao de producao aqui e comparar o veredito com o simbolo
    // impresso, em cada um dos dois modos.
    for (const modo of ['exact', 'contains'] as const) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB, { match_mode: modo, trigger_keywords: '["eu quero"]' })
      const cookie = await abrirSessao()

      const corpo = await (await abrirTela(TELAS[1] as (typeof TELAS)[number], cookie)).text()
      const snapshot = await snapshotDoBanco()
      const exemplo = 'eu quero e mais alguma coisa'
      const acionaDeVerdade =
        matchKeyword(
          exemplo,
          snapshot.global.triggerKeywords,
          snapshot.global.matchMode,
          normalizeOptionsFrom(snapshot.global),
        ) !== null

      expect({ [modo]: corpo.includes(`${exemplo}&rdquo; &mdash; aciona`) }).toEqual({
        [modo]: acionaDeVerdade,
      })
    }
  })

  test('TELA-08: a previa da Mensagem sai de `renderTemplate` de producao', async () => {
    await gravarConfig(env.DB, {
      private_reply_text: 'Oi {username}, o link é {link}',
      destination_url: 'https://exemplo.com/do-banco',
    })
    const cookie = await abrirSessao()

    const corpo = await (await abrirTela(TELAS[2] as (typeof TELAS)[number], cookie)).text()
    const esperado = renderTemplate('Oi {username}, o link é {link}', {
      username: 'quem comentou',
      link: 'https://exemplo.com/do-banco',
    })

    expect(corpo).toContain(esperado)
    // O apelido cru nao sobra na previa: quem le tem que ver a mensagem
    // pronta, e nao o modelo dela.
    expect(corpo).toContain('Oi quem comentou, o link')
  })

  test('TELA-09: a lista de enderecos liberados sai da variavel, e vazia nao promete nada', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const semLista = await (await abrirTela(TELAS[2] as (typeof TELAS)[number], cookie)).text()
    expect(semLista).toContain('Nenhum endere&ccedil;o foi liberado')

    invalidarCacheDeConfig()
    const comLista = await (
      await abrirTela(
        TELAS[2] as (typeof TELAS)[number],
        cookie,
        ambienteCom({ ALLOWED_LINK_DOMAINS: 'noxelora.com.br' }),
      )
    ).text()
    expect(comLista).toContain('noxelora.com.br')
    expect(comLista).not.toContain('Nenhum endere&ccedil;o foi liberado')
  })

  test('TELA-10: "O que aconteceu" imprime o aviso obrigatorio de §12.6', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await (await abrirTela(TELAS[4] as (typeof TELAS)[number], cookie)).text()

    // Sem esta frase a tela entrega menos do que §3 promete: ela e o que
    // impede o dono de concluir que a automacao deixou de responder alguem.
    expect(corpo).toContain('atendeu')
    expect(corpo).toContain('n&atilde;o deixam registro')
  })
})

// ---------------------------------------------------------------------------
// TELA — celular e acessibilidade (§12.9)
// ---------------------------------------------------------------------------

describe('TELA — celular e acessibilidade', () => {
  test('TELA-11: toda tela sai com `lang="pt-BR"` e o viewport de `initial-scale=1`', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await (await abrirTela(tela, cookie)).text()

      expect({ [tela.rota.caminho]: corpo.includes('<html lang="pt-BR">') }).toEqual({
        [tela.rota.caminho]: true,
      })
      expect({
        [tela.rota.caminho]: corpo.includes('width=device-width, initial-scale=1'),
      }).toEqual({ [tela.rota.caminho]: true })
    }
  })

  test('TELA-11: a barra de baixo tem cinco itens, cada um com icone E palavra', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await (await abrirTela(TELAS[0] as (typeof TELAS)[number], cookie)).text()
    const itens = [...corpo.matchAll(/<a href="[^"]*" class="item[^"]*"[^>]*>(.*?)<\/a>/g)]

    expect(itens).toHaveLength(5)
    for (const item of itens) {
      const dentro = item[1] ?? ''
      expect(dentro).toContain('class="icone" aria-hidden="true"')
      // A palavra, e nao so o icone: §12.1 proibe navegacao so por icone.
      expect(/<span class="palavra">[^<]+<\/span>/.test(dentro)).toBe(true)
    }
  })

  test('TELA-11: a tela aberta e a unica com `aria-current="page"`', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await (await abrirTela(tela, cookie)).text()
      const marcados = [...corpo.matchAll(/<a href="([^"]*)"[^>]*aria-current="page"/g)]

      expect({ [tela.rota.caminho]: marcados.map((achado) => achado[1]) }).toEqual({
        [tela.rota.caminho]: [tela.rota.caminho],
      })
    }
  })

  test('TELA-12: nenhuma tela passa do orcamento de HTML de §12.9', async () => {
    // "Conexao ruim e o caso normal, nao o excepcional": §12.9 orca ~15 KB de
    // HTML por tela. O teto esta escrito aqui, e nao adivinhado, porque a
    // tela que estoura o orcamento estoura devagar — um bloco por etapa — e
    // ninguem percebe pelo olho.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const bytes = new TextEncoder().encode(await (await abrirTela(tela, cookie)).text()).length

      expect({ [tela.rota.caminho]: bytes <= TETO_DE_HTML }).toEqual({
        [tela.rota.caminho]: true,
      })
    }
  })

  test('TELA-11: o freio aparece na barra do topo de TODA tela', async () => {
    // §12.1: a barra do topo e o unico elemento repetido do painel, e a
    // repeticao e proposital — a pessoa nunca precisa procurar como parar.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await (await abrirTela(tela, cookie)).text()

      expect({
        [tela.rota.caminho]: corpo.includes('<a class="parar" href="/painel/parar">'),
      }).toEqual({ [tela.rota.caminho]: true })
    }
  })
})
