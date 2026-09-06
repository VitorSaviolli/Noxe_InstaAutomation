import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { escapeHtml } from '../src/routes/legal'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { handleAtividade } from '../src/routes/painel/atividade'
import {
  type CampoDeComparacao,
  ESCOPO_DE_MIDIAS,
  FRASE_DO_AJUSTE,
  fraseDoAjuste,
  MODO_DE_COMPARACAO,
  NOME_DO_CAMPO,
  ORIGEM_DOS_AJUSTES,
  PALAVRAS_PROIBIDAS,
  RECUSA_SEM_VALOR,
  traduzirAviso,
} from '../src/routes/painel/dicionario'
import { cabecalhos } from '../src/routes/painel/html'
import { contaConectada, handleInicio, panorama } from '../src/routes/painel/inicio'
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
import { matchKeyword, normalizeOptionsFrom, normalizeText } from '../src/utils/normalize'
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
 * **Um ID por garantia.** Um mesmo ID em duas afirmacoes diferentes quebra o
 * mapeamento no dia em que alguem procura o que caiu — que e justamente o dia
 * em que o ID precisa servir para alguma coisa.
 *
 * **HDR-07 e HDR-08 nao estao aqui, e a ausencia e declarada.** As duas sao
 * sobre o campo `corpo.painel` de `GET /health` (§11.9), que nasce na etapa
 * dos portoes de publicacao. Escrever aqui um teste que fingisse cobri-las
 * seria pior que a ausencia (§13.1).
 *
 * **Nenhum valor da instalacao do dono entra neste arquivo.** Dominio, link e
 * palavra-gatilho sao ficticios, pelo mesmo motivo que `configDeTeste` existe:
 * este repositorio e um template publico, e um teste preso ao valor de quem o
 * escreveu fica vermelho na maquina de todo mundo que o instala.
 */

/** O vetor de injecao. Ele PASSA no validador, e por isso chega mesmo a tela. */
const VETOR = '<script>alert(1)</script>'

/** Dominio FICTICIO, nunca o da instalacao de quem escreveu o teste. */
const DOMINIO_DE_TESTE = 'exemplo.com.br'

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

const TELA_INICIO = TELAS[0] as (typeof TELAS)[number]
const TELA_PALAVRAS = TELAS[1] as (typeof TELAS)[number]
const TELA_MENSAGEM = TELAS[2] as (typeof TELAS)[number]
const TELA_AJUSTES = TELAS[3] as (typeof TELAS)[number]
const TELA_ATIVIDADE = TELAS[4] as (typeof TELAS)[number]

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

/**
 * D1 em que SO a pergunta sobre a conta estoura.
 *
 * Duble local injetado por parametro, como todo duble deste projeto. Ele
 * precisa deixar a configuracao passar: um D1 que estourasse inteiro provaria
 * outra coisa — que a tela de erro funciona —, e nao que a leitura da conta
 * falha SOZINHA e mesmo assim nao inventa um fato na tela.
 */
class D1ComContaQuebrada {
  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    if (!sql.includes('account_tokens')) return this.real.prepare(sql)
    return {
      first: () => Promise.reject(new Error('D1_ERROR: leitura da conta indisponivel')),
    } as unknown as D1PreparedStatement
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

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

/** O corpo da tela, ja lido. */
async function corpoDa(
  tela: { rota: RotaDoPainel; handler: HandlerDoPainel },
  cookie: Record<string, string>,
  ambiente: Env = env,
): Promise<string> {
  return await (await abrirTela(tela, cookie, ambiente)).text()
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
 * `prepares - batches` e a conta: os dois statements do lote viram um. Quem
 * chama confere `batches` tambem, porque essa premissa e o que torna a conta
 * valida — um lote com tres statements a quebraria em silencio.
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

/**
 * As chaves de sim/nao que a tela de Ajustes GRAVA.
 *
 * Elas viraram par de radios quando a escrita nasceu, e por isso as DUAS frases
 * de cada uma aparecem na pagina. A afirmacao de TELA-11 e TELA-12 nao mudou de
 * sentido — a tela nao pode mentir sobre o que esta valendo —, mudou de forma:
 * o que prova o valor agora e qual das duas esta MARCADA.
 *
 * `processOnlyReels` entrou na etapa do step-up (Ruling 65): ir para "responde
 * em qualquer publicacao" alarga o alcance, e com o step-up existindo essa
 * direcao passou a ser gravavel em vez de recusada.
 */
const CHAVES_EDITAVEIS: readonly CampoDeComparacao[] = [
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'processOnlyReels',
]

/**
 * Aquela frase e a opcao MARCADA?
 *
 * O `checked>` colado na frase e o que separa "a tela mostra as duas opcoes",
 * que e o que um formulario faz, de "a tela diz que este e o valor", que e a
 * afirmacao. Um teste de `includes` solto passaria com o radio errado marcado.
 */
function estaMarcada(corpo: string, frase: string): boolean {
  return corpo.includes(`checked> ${escapeHtml(frase)}`)
}

/** A palavra aparece com fronteira de palavra? Substring nao conta (§12.7). */
function contemPalavra(texto: string, palavra: string): boolean {
  const escapada = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\x2d')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapada}([^\\p{L}\\p{N}]|$)`, 'iu').test(texto)
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

    const resposta = await abrirTela(TELA_PALAVRAS, cookie)
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    // O valor CHEGOU a tela — sem isto o teste passaria com uma tela vazia.
    expect(corpo).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(corpo).not.toContain(VETOR)
  })

  test('HDR-06: o texto do Direct e o texto publico saem escapados na tela da Mensagem', async () => {
    await gravarConfig(env.DB, CONFIG_ENVENENADA)
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_MENSAGEM, cookie)

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
      const corpo = await corpoDa(tela, cookie)

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
        const corpo = await corpoDa(tela, cookie)

        expect({ [tela.rota.caminho]: VAZAMENTO.test(corpo) }).toEqual({
          [tela.rota.caminho]: false,
        })
        // O nome da coluna nao pode aparecer como TEXTO. Desde a etapa do
        // step-up, `/painel/mensagem` grava o link, e `name=`/`id=`/`for=` sao
        // o nome do campo do formulario — do mesmo jeito que `/painel/ajustes`
        // ja carrega `name="userCooldownHours"`. O que continua proibido e a
        // coluna vazando em qualquer outro lugar do corpo.
        const semNomesDeCampo = corpo.replace(/(?:name|id|for)="[^"]*"/g, '')
        expect({ [tela.rota.caminho]: semNomesDeCampo.includes('destinationUrl') }).toEqual({
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
  test('DIC-01: todo campo gravavel da configuracao tem traducao, e nenhuma sobra', () => {
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
      ...Object.values(FRASE_DO_AJUSTE).flatMap((par) => [par.verdadeiro, par.falso]),
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

  test('DIC-04: cada prefixo que nao e campo tem a frase ESCRITA para ele', () => {
    // Afirmar so a AUSENCIA do texto cru deixaria as duas frases especificas
    // apagaveis sem custo: uma frase generica passaria igual. O que a tela
    // promete e dizer O QUE aconteceu, e as duas causas sao diferentes.
    const daTabela = traduzirAviso(
      'painel_midias: ha midias selecionadas sem configuracao global; elas foram ignoradas.',
    )
    const doBanco = traduzirAviso('banco: nao foi possivel ler a configuracao.')

    expect(daTabela).toContain('Encontramos escolhas de Reels sem ajustes salvos')
    expect(daTabela).not.toContain('painel_midias')

    expect(doBanco).toContain('Não conseguimos ler os seus ajustes salvos agora')
    expect(doBanco).not.toContain('configuracao')

    // As duas sao DIFERENTES: uma frase so para as duas causas seria a mesma
    // coisa que a generica.
    expect(daTabela).not.toBe(doBanco)
  })

  test('DIC-05: prefixo desconhecido cai na frase generica, e nao no texto cru', () => {
    const desconhecido = traduzirAviso('coisa_nova: alguma frase tecnica.')

    // E a diferenca entre a tela envelhecer e a tela vazar.
    expect(desconhecido).not.toContain('coisa_nova')
    expect(desconhecido).not.toContain('tecnica')
    expect(desconhecido).toContain('não dá para entender')
  })

  test('DIC-06: a frase de cada chave de comparacao concorda com o que `normalizeText` faz', () => {
    // A prova de que `verdadeiro` e `falso` nao estao invertidos, e ela nao
    // olha o dicionario contra ele mesmo: olha contra a funcao de PRODUCAO.
    // A primeira grafia deste dicionario tinha `sim`/`nao` com significado
    // trocado em dois dos quatro campos, e as telas compensavam com um
    // ternario invertido — a saida saia certa e a forma mentia.
    const sondas: Record<Exclude<CampoDeComparacao, 'processOnlyReels'>, [string, string]> = {
      caseSensitive: ['EU QUERO', 'eu quero'],
      normalizeAccents: ['querô', 'quero'],
      ignorePunctuation: ['eu quero!', 'eu quero'],
    }

    // A frase que significa "os dois textos contam como iguais", por campo.
    //
    // **Escritas a mao, e nao lidas de `FRASE_DO_AJUSTE`.** Ler do dicionario
    // faria o teste comparar o dicionario com ele mesmo: trocar as duas
    // entradas de um campo trocaria tambem a expectativa, e a inversao — que e
    // exatamente o defeito que este teste existe para pegar — passaria verde.
    const frasesDeEquivalencia: Record<Exclude<CampoDeComparacao, 'processOnlyReels'>, string> = {
      caseSensitive: 'Tanto faz escrever com maiúscula ou com minúscula.',
      normalizeAccents: 'Escrever sem acento conta igual: “querô” vale por “quero”.',
      ignorePunctuation: 'Pontuação e emojis são ignorados na comparação.',
    }

    // Contrapositivo do proprio teste: uma frase escrita aqui que nao exista
    // mais no dicionario faria o laco abaixo comparar contra nada e passar.
    for (const frase of Object.values(frasesDeEquivalencia)) {
      expect({
        [frase]: Object.values(FRASE_DO_AJUSTE).some(
          (par) => par.verdadeiro === frase || par.falso === frase,
        ),
      }).toEqual({ [frase]: true })
    }

    for (const campo of Object.keys(sondas) as (keyof typeof sondas)[]) {
      for (const valor of [true, false]) {
        const config = configDeTeste({ [campo]: valor })
        const opcoes = normalizeOptionsFrom(config)
        const [a, b] = sondas[campo]
        const contamComoIguais = normalizeText(a, opcoes) === normalizeText(b, opcoes)

        expect({
          [`${campo}=${valor}`]: fraseDoAjuste(campo, config) === frasesDeEquivalencia[campo],
        }).toEqual({ [`${campo}=${valor}`]: contamComoIguais })
      }
    }

    // `processOnlyReels` nao passa por `normalizeText`; a frase dele e conferida
    // contra o que ele significa em `evaluateComment`: `true` restringe.
    expect(fraseDoAjuste('processOnlyReels', configDeTeste({ processOnlyReels: true }))).toContain(
      'só nos Reels',
    )
    expect(fraseDoAjuste('processOnlyReels', configDeTeste({ processOnlyReels: false }))).toContain(
      'qualquer publicação',
    )
  })
})

// ---------------------------------------------------------------------------
// TELA — os estados grandes e as pendencias
// ---------------------------------------------------------------------------

describe('TELA — os quatro estados grandes', () => {
  test('TELA-01: tudo resolvido e conta ligada dao "Ligada e respondendo"', () => {
    const visao = panorama(snapshotDeTeste(), true)

    expect(visao.estado.chave).toBe('ligada')
    expect(visao.pendencias).toEqual([])
  })

  test('TELA-02: ligada com o link de fabrica da o ambar, e nao o verde', () => {
    // E o estado que §12.1 regra 3 existe para tornar visivel: hoje a
    // automacao recusa disparar por seguranca e ninguem fica sabendo. O link
    // entre colchetes e o do template recem-instalado.
    const visao = panorama(snapshotDeTeste({ destinationUrl: '[coloque o seu link]' }), true)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.map((p) => p.acao?.para)).toContain('/painel/mensagem')
  })

  test('TELA-03: sem nenhuma palavra o ambar aponta para a tela de Palavras', () => {
    const visao = panorama(snapshotDeTeste({ triggerKeywords: [] }), true)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.map((p) => p.acao?.para)).toContain('/painel/palavras')
  })

  test('TELA-04: conta desconectada tambem da o ambar, mesmo com tudo salvo', () => {
    const visao = panorama(snapshotDeTeste(), false)

    expect(visao.estado.chave).toBe('nada_sera_enviado')
    expect(visao.pendencias.some((p) => p.texto.includes('não está conectada'))).toBe(true)
  })

  test('TELA-05: `selecionadas` sem nenhuma midia ativa vira pendencia', async () => {
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const semNenhuma = panorama(await snapshotDoBanco(), true)

    expect(semNenhuma.estado.chave).toBe('nada_sera_enviado')
    expect(semNenhuma.pendencias.some((p) => p.texto.includes('não marcou nenhum'))).toBe(true)

    // O contrapositivo: com uma midia ativa a pendencia some.
    await gravarMidia(env.DB, '17912345678901234')
    const comUma = panorama(await snapshotDoBanco(), true)

    expect(comUma.estado.chave).toBe('ligada')
  })

  test('TELA-06: `enabled = 0` da cinza, e o cinza ganha do ambar', () => {
    // Quem desligou de proposito nao precisa ouvir que faltam coisas.
    const visao = panorama(
      snapshotDeTeste({ enabled: false, destinationUrl: '[ainda nao]' }),
      false,
    )

    expect(visao.estado.chave).toBe('desligada')
  })

  test('TELA-07: configuracao recusada da "Parada por seguranca" e NOMEIA o campo', async () => {
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

  test('TELA-23: a parada por erro diz TAMBEM que o conserto e fora do painel', async () => {
    // TELA-07 afirma que o campo e nomeado. Falta a outra metade, e ela e a que
    // impede o dono de ficar tentando: com a configuracao salva ilegivel o
    // painel RECUSA toda gravacao — nao pode escrever valores de fabrica por
    // cima do que ele salvou (§9.2, §12.6) —, entao a tela precisa dizer para
    // onde ir. Frase de tela sem asseracao ja mordeu esta branch antes.
    await gravarConfig(env.DB, { destination_url: '[coloque-seu-link-aqui]' })
    const cookie = await abrirSessao()

    const registrado = capturarConsole()
    let corpo: string
    try {
      corpo = await corpoDa(TELA_INICIO, cookie)
    } finally {
      registrado.parar()
    }

    expect(corpo).toContain(escapeHtml('O campo link'))
    expect(corpo).toContain(escapeHtml(RECUSA_SEM_VALOR.configIlegivel))
    // E a frase continua sendo do dicionario, e nao um literal na tela: sem
    // isto, mudar o dicionario deixaria a tela para tras em silencio.
    expect(RECUSA_SEM_VALOR.configIlegivel).toContain('nada pode ser gravado por aqui')
  })

  test('TELA-08: o cinza de parada por erro ganha do cinza de desligada', () => {
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
})

// ---------------------------------------------------------------------------
// TELA — o que a tela IMPRIME
// ---------------------------------------------------------------------------

describe('TELA — o que a tela imprime', () => {
  test('TELA-09: sem linha no banco, a TELA imprime a frase dos ajustes de fabrica', async () => {
    // A frase de §12.6, no HTML e nao so na estrutura: a estrutura pode estar
    // certa e o bloco nao ser renderizado, que e como o `blocoDeFabrica`
    // conseguia sumir sem nenhum teste reclamar.
    const cookie = await abrirSessao()

    const semLinha = await corpoDa(TELA_INICIO, cookie)
    expect(semLinha).toContain('Seus ajustes ainda s&atilde;o os que vieram no programa')

    // O contrapositivo: com a linha salva, a frase some. Sem ele, um bloco
    // impresso SEMPRE passaria neste teste e mentiria para quem ja salvou.
    await gravarConfig(env.DB)
    invalidarCacheDeConfig()
    const comLinha = await corpoDa(TELA_INICIO, cookie)
    expect(comLinha).not.toContain('Seus ajustes ainda s&atilde;o os que vieram no programa')
  })

  test('TELA-10: os avisos do validador chegam TRADUZIDOS a tela', async () => {
    // Os `avisos` sao o material que a Task 3 produziu e que ninguem tinha
    // exibido: mostra-los E o entregavel desta etapa. Cenario real: linhas de
    // midia orfas, sem linha global.
    await gravarMidia(env.DB, '17912345678901234')
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_INICIO, cookie)

    expect(corpo).toContain('Encontramos escolhas de Reels sem ajustes salvos')
    // E o prefixo tecnico do aviso nao aparece junto.
    expect(corpo).not.toContain('painel_midias')

    // Contrapositivo: sem a linha orfa nao ha aviso nenhum na tela.
    await limparBanco(env.DB)
    await gravarConfig(env.DB)
    invalidarCacheDeConfig()
    expect(await corpoDa(TELA_INICIO, cookie)).not.toContain(
      'Encontramos escolhas de Reels sem ajustes salvos',
    )
  })

  test('TELA-11: Ajustes imprime a configuracao que o dono salvou', async () => {
    // A verificacao do dono desta etapa, inteira: "ve, do celular, a
    // configuracao que hoje so existe em TypeScript". Valores DISTINTOS dos de
    // fabrica em todos os campos, para que um texto fixo na tela nao passe.
    await gravarConfig(env.DB, {
      media_scope: 'selecionadas',
      user_cooldown_hours: 5,
      match_mode: 'contains',
      case_sensitive: 1,
      normalize_accents: 0,
      ignore_punctuation: 0,
      process_only_reels: 0,
      public_reply_enabled: 0,
      private_reply_enabled: 1,
    })
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_AJUSTES, cookie)
    const config = (await snapshotDoBanco()).global

    for (const esperado of [
      ESCOPO_DE_MIDIAS.selecionadas,
      'A mesma pessoa só aciona de novo depois de 5 horas.',
      MODO_DE_COMPARACAO.contains,
      fraseDoAjuste('processOnlyReels', config),
      'Desligada: nada é escrito embaixo do Reel.',
      'Ligado: quem comenta recebe o Direct com o link.',
    ]) {
      expect({ [esperado]: corpo.includes(escapeHtml(esperado)) }).toEqual({ [esperado]: true })
    }

    // E o oposto de cada um NAO aparece. `processOnlyReels` saiu desta lista na
    // etapa do step-up: Ruling 65 o tornou editavel, entao as DUAS frases dele
    // aparecem — como as das outras chaves — e o que se afirma sobre ele e qual
    // opcao esta MARCADA, no laco de `CHAVES_EDITAVEIS` abaixo.
    for (const proibido of [ESCOPO_DE_MIDIAS.todas, MODO_DE_COMPARACAO.exact]) {
      expect({ [proibido]: corpo.includes(escapeHtml(proibido)) }).toEqual({ [proibido]: false })
    }

    // As tres chaves editaveis: a frase do valor que esta valendo e a MARCADA,
    // e a oposta aparece so como a outra opcao — nunca marcada.
    for (const campo of CHAVES_EDITAVEIS) {
      expect({
        [campo]: {
          atual: estaMarcada(corpo, fraseDoAjuste(campo, config)),
          oposta: estaMarcada(
            corpo,
            config[campo] ? FRASE_DO_AJUSTE[campo].falso : FRASE_DO_AJUSTE[campo].verdadeiro,
          ),
        },
      }).toEqual({ [campo]: { atual: true, oposta: false } })
    }
  })

  test('TELA-12: com os valores opostos, Ajustes imprime exatamente o oposto', async () => {
    // O contrapositivo de TELA-11. Sem ele, uma tela que imprimisse SEMPRE as
    // frases do primeiro cenario passaria por lá e mentiria aqui.
    await gravarConfig(env.DB, {
      media_scope: 'todas',
      user_cooldown_hours: 0,
      match_mode: 'exact',
      case_sensitive: 0,
      normalize_accents: 1,
      ignore_punctuation: 1,
      process_only_reels: 1,
      public_reply_enabled: 1,
      private_reply_enabled: 0,
    })
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_AJUSTES, cookie)
    const config = (await snapshotDoBanco()).global

    for (const esperado of [
      ESCOPO_DE_MIDIAS.todas,
      'A mesma pessoa pode acionar quantas vezes quiser, sem espera.',
      MODO_DE_COMPARACAO.exact,
      FRASE_DO_AJUSTE.processOnlyReels.verdadeiro,
      'Ligada: a automação responde embaixo do Reel.',
      'Desligado: ninguém recebe Direct.',
    ]) {
      expect({ [esperado]: corpo.includes(escapeHtml(esperado)) }).toEqual({ [esperado]: true })
    }

    for (const proibido of [ESCOPO_DE_MIDIAS.selecionadas, MODO_DE_COMPARACAO.contains]) {
      expect({ [proibido]: corpo.includes(escapeHtml(proibido)) }).toEqual({ [proibido]: false })
    }

    // O contrapositivo das tres chaves editaveis: aqui a MARCADA e a outra.
    for (const campo of CHAVES_EDITAVEIS) {
      expect({
        [campo]: {
          atual: estaMarcada(corpo, fraseDoAjuste(campo, config)),
          oposta: estaMarcada(
            corpo,
            config[campo] ? FRASE_DO_AJUSTE[campo].falso : FRASE_DO_AJUSTE[campo].verdadeiro,
          ),
        },
      }).toEqual({ [campo]: { atual: true, oposta: false } })
    }
  })

  test('TELA-13: os tres sinais de §12.3 acompanham os tres campos protegidos', async () => {
    // "Sempre juntos, nunca so cor": cadeado, a palavra "protegido" e a borda
    // ambar do grupo. Um deles sozinho e uma surpresa biometrica esperando
    // acontecer na etapa que salva.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_MENSAGEM, cookie)

    // Um selo por campo protegido, e sao tres (§3: texto, link e resposta).
    expect(corpo.match(/&#128274;/g)).toHaveLength(3)
    expect(corpo.match(/> protegido<\/span>/g)).toHaveLength(3)
    // A borda ambar do grupo, que e o terceiro sinal.
    expect(corpo).toContain('class="protegidos"')
    // E o botao nunca promete "Salvar" e surpreende com a digital: a tela diz
    // o que vai acontecer antes.
    expect(corpo).toContain('vai pedir a sua digital ou o seu rosto')
  })

  test('TELA-14: "O que aconteceu" imprime o aviso obrigatorio de §12.6', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_ATIVIDADE, cookie)

    // Sem esta frase a tela entrega menos do que §3 promete: ela e o que
    // impede o dono de concluir que a automacao deixou de responder alguem.
    expect(corpo).toContain('atendeu')
    expect(corpo).toContain('n&atilde;o deixam registro')
  })

  test('TELA-15: os exemplos de Palavras concordam com `matchKeyword` de producao', async () => {
    // §12.1 regra 4: o que a tela mostra e o que o Worker vai fazer. A prova e
    // rodar a funcao de producao aqui e comparar o veredito com o simbolo
    // impresso, em cada um dos dois modos.
    for (const modo of ['exact', 'contains'] as const) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB, { match_mode: modo, trigger_keywords: '["eu quero"]' })
      const cookie = await abrirSessao()

      const corpo = await corpoDa(TELA_PALAVRAS, cookie)
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

  test('TELA-16: a previa da Mensagem sai de `renderTemplate` de producao', async () => {
    await gravarConfig(env.DB, {
      private_reply_text: 'Oi {username}, o link é {link}',
      destination_url: 'https://exemplo.com/do-banco',
    })
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_MENSAGEM, cookie)
    const esperado = renderTemplate('Oi {username}, o link é {link}', {
      username: 'quem comentou',
      link: 'https://exemplo.com/do-banco',
    })

    expect(corpo).toContain(esperado)
    // O apelido cru nao sobra na previa: quem le tem que ver a mensagem
    // pronta, e nao o modelo dela.
    expect(corpo).toContain('Oi quem comentou, o link')
  })

  test('TELA-17: a lista de enderecos liberados sai da variavel, e vazia nao promete nada', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const semLista = await corpoDa(TELA_MENSAGEM, cookie)
    expect(semLista).toContain('Nenhum endere&ccedil;o foi liberado')

    invalidarCacheDeConfig()
    const comLista = await corpoDa(
      TELA_MENSAGEM,
      cookie,
      ambienteCom({ ALLOWED_LINK_DOMAINS: DOMINIO_DE_TESTE }),
    )
    expect(comLista).toContain(DOMINIO_DE_TESTE)
    expect(comLista).not.toContain('Nenhum endere&ccedil;o foi liberado')
  })
})

// ---------------------------------------------------------------------------
// TELA — o portao, o custo e o que a tela promete
// ---------------------------------------------------------------------------

describe('TELA — o portao e o custo', () => {
  test('TELA-18: sem cookie, as cinco telas respondem 303 e custam ZERO consulta', async () => {
    // O portao, afirmado nas telas que servem a configuracao do dono — e nao
    // so na linha `sessao: true` da tabela. As duas metades importam: a recusa
    // acontece E ela acontece antes do D1 (passo 6 da escada, §11.3).
    await gravarConfig(env.DB)

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      const resposta = await despachar(
        pedir(tela.rota.caminho),
        ambienteCom({ DB: comoD1(contador) }),
        AGORA,
        tela.rota,
        tela.handler,
      )

      expect({
        [tela.rota.caminho]: {
          status: resposta.status,
          para: resposta.headers.get('location'),
          consultas: contador.prepares,
        },
      }).toEqual({
        [tela.rota.caminho]: { status: 303, para: '/painel/entrar', consultas: 0 },
      })
    }
  })

  test('TELA-19: as cinco telas escrevem ZERO vezes no D1', async () => {
    // §6: o painel le, nao age.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      expect({ [tela.rota.caminho]: contador.escritas }).toEqual({ [tela.rota.caminho]: 0 })
    }
  })

  test('TELA-20: o orcamento de subrequests de cada tela, num unico lote', async () => {
    // §12.10 orca 3 para o Inicio e 5 para "O que aconteceu". Quatro telas pagam
    // 3, e o terceiro e a pergunta sobre a conta: sem ela a barra do topo — que
    // §12.1 exige IGUAL em toda tela — diria "Ligada e respondendo" numa
    // instalacao que nao consegue enviar nada.
    //
    // **Ajustes paga 4**, e o quarto e o bloco de historico que a Etapa 10 exige
    // em letras. O numero fica travado AQUI de proposito: a condicao para subir
    // um subrequest e o custo ficar visivel, e nao escondido dentro do handler.
    //
    // `batches === 1` nao e detalhe: e a PREMISSA de `subrequests()`. A conta
    // `prepares - batches` so vale enquanto existe um unico lote de dois
    // statements; um lote a mais, ou um lote de tres, a quebraria em silencio
    // e o orcamento passaria a ser afirmado por engano.
    const ORCAMENTO: Record<string, number> = {
      [ROTA_INICIO.caminho]: 3,
      [ROTA_PALAVRAS.caminho]: 3,
      [ROTA_MENSAGEM.caminho]: 3,
      [ROTA_AJUSTES.caminho]: 4,
      [ROTA_ATIVIDADE.caminho]: 3,
    }

    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      expect({
        [tela.rota.caminho]: { subrequests: subrequests(contador), lotes: contador.batches },
      }).toEqual({
        [tela.rota.caminho]: { subrequests: ORCAMENTO[tela.rota.caminho], lotes: 1 },
      })
    }
  })

  test('TELA-22: o Inicio paga 1 subrequest a mais so quando a automacao esta desligada', async () => {
    // A data da ultima parada por codigo (§10.12) e o quarto, e ela so e lida no
    // estado em que a tela oferece religar. Perguntar por ela sempre custaria uma
    // leitura por visita para um dado que a tela ligada nao mostra.
    await gravarConfig(env.DB, { enabled: 0 })
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()

    invalidarCacheDeConfig()
    const contador = new D1Contador(env.DB)
    await abrirTela(TELA_INICIO, cookie, ambienteCom({ DB: comoD1(contador) }))

    expect({ subrequests: subrequests(contador), lotes: contador.batches }).toEqual({
      subrequests: 4,
      lotes: 1,
    })
  })

  test('TELA-21: nenhuma tela consulta `processed_comments`', async () => {
    // §6 e §16.6: o painel nunca escreve la, e nesta etapa nem le. A afirmacao
    // e sobre QUAIS statements passaram, e nao sobre quantos — contar nao diz
    // nada sobre a tabela tocada.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      // Contrapositivo: uma lista vazia de SQL passaria calada.
      expect({ [tela.rota.caminho]: contador.sqls.length }).not.toEqual({ [tela.rota.caminho]: 0 })
      expect({
        [tela.rota.caminho]: contador.sqls.filter((sql) => sql.includes('processed_comments')),
      }).toEqual({ [tela.rota.caminho]: [] })
    }
  })

  test('TELA-22: a conta indisponivel nao vira fato na tela, e deixa rastro no console', async () => {
    // A direcao segura e "nao conectada". O que nao pode e o SILENCIO: um D1
    // fora do ar viraria uma afirmacao ao dono, sem nada em lugar nenhum, e ele
    // passaria a tarde reconectando uma conta que nunca desconectou (§12.7:
    // detalhe tecnico vai para o `console`, nunca para a tela).
    await ligarConta(env, AGORA)

    // Primeiro o contrapositivo, com o D1 inteiro: a conta ESTA ligada.
    expect(await contaConectada(env.DB)).toBe(true)

    const console = capturarConsole()
    let respondeu: boolean
    try {
      respondeu = await contaConectada(new D1ComContaQuebrada(env.DB) as unknown as D1Database)
    } finally {
      console.parar()
    }

    expect(respondeu).toBe(false)
    expect(console.linhas.join(' ')).toContain('conta_nao_verificada')

    // E a tela: a frase segura aparece, e o detalhe tecnico nao.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const outro = capturarConsole()
    let corpo: string
    try {
      corpo = await corpoDa(
        TELA_ATIVIDADE,
        cookie,
        ambienteCom({ DB: new D1ComContaQuebrada(env.DB) }),
      )
    } finally {
      outro.parar()
    }

    expect(corpo).toContain('Não está conectada')
    expect(VAZAMENTO.test(corpo)).toBe(false)
    expect(outro.linhas.join(' ')).toContain('conta_nao_verificada')
  })

  test('TELA-23: nenhum link das cinco telas aponta para fora da tabela de rotas', async () => {
    // A garantia que impede a tela de prometer o que nao existe. Ela vale
    // tambem para as telas que ainda nao nasceram: no dia em que alguem
    // escrever um `href="/painel/reels"` antes de a rota existir, este laco
    // fica vermelho.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const conhecidos = new Set([...ROTAS.map((rota) => rota.caminho), ...ASSETS])

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const links = linksDe(await corpoDa(tela, cookie))

      // Contrapositivo: uma tela sem link nenhum passaria calada.
      expect({ [tela.rota.caminho]: links.length }).not.toEqual({ [tela.rota.caminho]: 0 })

      for (const link of links) {
        expect({ [`${tela.rota.caminho} -> ${link}`]: conhecidos.has(link) }).toEqual({
          [`${tela.rota.caminho} -> ${link}`]: true,
        })
      }
    }
  })

  test('TELA-24: nenhuma palavra proibida do glossario aparece nas cinco telas', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      // So o `<body>`: o `<head>` carrega `stylesheet` e `viewport`, que sao
      // atributos de HTML e nao texto que alguem le na tela.
      const corpo = (await corpoDa(tela, cookie)).split('<body>')[1] ?? ''

      for (const proibida of PALAVRAS_PROIBIDAS) {
        expect({ [`${tela.rota.caminho}: ${proibida}`]: contemPalavra(corpo, proibida) }).toEqual({
          [`${tela.rota.caminho}: ${proibida}`]: false,
        })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// TELA — celular e acessibilidade (§12.9)
// ---------------------------------------------------------------------------

describe('TELA — celular e acessibilidade', () => {
  test('TELA-25: toda tela sai com `lang="pt-BR"` e o viewport de `initial-scale=1`', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await corpoDa(tela, cookie)

      expect({ [tela.rota.caminho]: corpo.includes('<html lang="pt-BR">') }).toEqual({
        [tela.rota.caminho]: true,
      })
      expect({
        [tela.rota.caminho]: corpo.includes('width=device-width, initial-scale=1'),
      }).toEqual({ [tela.rota.caminho]: true })
    }
  })

  test('TELA-26: a barra de baixo tem cinco itens, cada um com icone E palavra', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_INICIO, cookie)
    const itens = [...corpo.matchAll(/<a href="[^"]*" class="item[^"]*"[^>]*>(.*?)<\/a>/g)]

    expect(itens).toHaveLength(5)
    for (const item of itens) {
      const dentro = item[1] ?? ''
      expect(dentro).toContain('class="icone" aria-hidden="true"')
      // A palavra, e nao so o icone: §12.1 proibe navegacao so por icone.
      expect(/<span class="palavra">[^<]+<\/span>/.test(dentro)).toBe(true)
    }
  })

  test('TELA-27: a tela aberta e a unica com `aria-current="page"`', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await corpoDa(tela, cookie)
      const marcados = [...corpo.matchAll(/<a href="([^"]*)"[^>]*aria-current="page"/g)]

      expect({ [tela.rota.caminho]: marcados.map((achado) => achado[1]) }).toEqual({
        [tela.rota.caminho]: [tela.rota.caminho],
      })
    }
  })

  test('TELA-28: o freio aparece na barra do topo de TODA tela', async () => {
    // §12.1: a barra do topo e o unico elemento repetido do painel, e a
    // repeticao e proposital — a pessoa nunca precisa procurar como parar.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const corpo = await corpoDa(tela, cookie)

      expect({
        [tela.rota.caminho]: corpo.includes('<a class="parar" href="/painel/parar">'),
      }).toEqual({ [tela.rota.caminho]: true })
    }
  })

  test('TELA-29: nenhuma tela passa do orcamento de HTML de §12.9', async () => {
    // "Conexao ruim e o caso normal, nao o excepcional": §12.9 orca ~15 KB de
    // HTML por tela. O teto esta escrito aqui, e nao adivinhado, porque a
    // tela que estoura o orcamento estoura devagar — um bloco por etapa — e
    // ninguem percebe pelo olho.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const bytes = new TextEncoder().encode(await corpoDa(tela, cookie)).length

      expect({ [tela.rota.caminho]: bytes <= TETO_DE_HTML }).toEqual({
        [tela.rota.caminho]: true,
      })
    }
  })

  // **A trava do `painel.css` NAO mora aqui, e a ausencia foi medida.**
  //
  // Uma primeira versao deste arquivo importava `painel.css?raw` e afirmava o
  // teto sobre o texto lido. Ela passava, e passava por nada: sob
  // `vitest-pool-workers` o `?raw` de um `.css` devolve **string vazia** —
  // conferido nos dois caminhos, o `import` direto e o `import.meta.glob` que o
  // Lema 1 de §10.6 usa para os `.ts`. Com a string vazia, o teto passava, o
  // `@import` "nao existia", e duas mutacoes que faziam a folha crescer 2 KB e
  // buscar uma fonte de fora SOBREVIVIAM verdes.
  //
  // E exatamente o que §13.5 preve ao explicar por que a checagem 19 e script e
  // nao teste: "uma garantia que pode nascer quebrada por detalhe de bundler
  // ensina a equipe a ignora-la". A trava mora em
  // `scripts/verificar-antes-de-publicar.mjs`, que le arquivo de verdade.
})
