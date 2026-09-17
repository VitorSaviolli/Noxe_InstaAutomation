import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { escapeHtml } from '../src/routes/legal'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { handleAtividade } from '../src/routes/painel/atividade'
import * as DICIONARIO from '../src/routes/painel/dicionario'
import {
  type CampoDeComparacao,
  ESCOPO_DE_MIDIAS,
  FRASE_DO_AJUSTE,
  fraseDoAjuste,
  MODO_DE_COMPARACAO,
  NOME_DO_CAMPO,
  PALAVRAS_PROIBIDAS,
  RECUSA_SEM_VALOR,
  traduzirAviso,
} from '../src/routes/painel/dicionario'
import { INTERVALO_DE_VISTA_MS } from '../src/routes/painel/guardas'
import { cabecalhos } from '../src/routes/painel/html'
import { contaConectada, handleInicio, panorama } from '../src/routes/painel/inicio'
import { handleMais } from '../src/routes/painel/mais'
import { handleMensagem } from '../src/routes/painel/mensagem'
import { esquecerAListagem } from '../src/routes/painel/midias'
import { handlePalavras } from '../src/routes/painel/palavras'
import { CAMPO_DO_REEL, handleReel } from '../src/routes/painel/reel'
import { handleReels } from '../src/routes/painel/reels'
import {
  ROTA_AJUSTES,
  ROTA_ATIVIDADE,
  ROTA_INICIO,
  ROTA_MAIS,
  ROTA_MENSAGEM,
  ROTA_PALAVRAS,
  ROTA_REEL,
  ROTA_REELS,
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
import {
  AGORA,
  capturarConsole,
  comApiDeListagem,
  comoD1,
  configDeTeste,
  contemPalavra,
  D1Contador,
  itemDeMidia,
  MetaDeListagem,
  paginaDeMidias,
  pedir,
  TETO_DE_HTML,
  TETO_DE_UMA_PAGINA_DE_REELS,
  TETO_NO_LIMITE_DE_200_REELS,
} from './fixtures/dubles'

/**
 * TELA · DIC · HDR, as cinco telas de leitura, o dicionario e o escape.
 *
 * `now` e sempre injetado e os handlers sao chamados por `despachar`, que e a
 * MESMA funcao que o roteador usa: um teste que chamasse o handler direto
 * pularia a escada de §11.3 e afirmaria menos do que parece.
 *
 * **Um ID por garantia.** Um mesmo ID em duas afirmacoes diferentes quebra o
 * mapeamento no dia em que alguem procura o que caiu, que e justamente o dia
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

/** Um id FICTICIO de dezoito digitos, o tamanho de verdade de um `media_id`. */
const REEL_DA_TELA = '178414000000000001'

/**
 * O que cada laco de garantia precisa saber de uma tela.
 *
 * `busca` e `preparar` nasceram com as duas telas de Reels (Ruling 97). Elas
 * nao sao "telas com um caso especial": sao telas que dependem de um estado que
 * as cinco anteriores nao tinham, `/painel/reel` casa por QUERY STRING
 * (Ruling 93) e recusa um id sem linha, e `/painel/reels` fala com a Meta. Sem
 * os dois campos, as duas ficariam de fora dos catorze lacos, que e exatamente
 * a omissao silenciosa que os lacos existem para impedir.
 */
interface TelaDoPainel {
  readonly rota: RotaDoPainel
  readonly handler: HandlerDoPainel
  /** A query string sem a qual a tela nao existe (Ruling 93). */
  readonly busca?: string
  /**
   * O estado do banco que a tela exige, escrito no D1 **real**.
   *
   * Nunca no `D1Contador` do laco: preparar o cenario nao e custo da tela, e
   * conta-lo transformaria os orcamentos de TELA-19 e TELA-20 em mentira.
   */
  readonly preparar?: () => Promise<void>
  /**
   * O item da barra de baixo que fica com `aria-current` (TELA-27).
   *
   * Ausente, e a propria rota. `/painel/reel` e uma sub-tela de Reels, e
   * Ajustes e Historico moram dentro de "Mais": nenhuma delas tem item proprio
   * na barra, que §12.1 fixa em cinco destinos.
   * Marcar "Reels" e o que orienta quem usa leitor de tela; nao marcar nada
   * deixaria a pessoa sem saber onde esta.
   */
  readonly marcado?: string
}

/**
 * A linha de `painel_midias` que as duas telas de Reels exigem.
 *
 * Idempotente de proposito: um mesmo teste percorre as sete telas e chama isto
 * duas vezes, e um `INSERT` cru estouraria a chave na segunda.
 */
async function prepararOReel(): Promise<void> {
  await env.DB.prepare('DELETE FROM painel_midias WHERE media_id = ?').bind(REEL_DA_TELA).run()
  await gravarMidia(env.DB, REEL_DA_TELA, { user_cooldown_hours: 48 })
}

/** As oito telas de leitura, com o handler de cada uma. */
const TELAS: readonly TelaDoPainel[] = [
  { rota: ROTA_INICIO, handler: handleInicio },
  { rota: ROTA_PALAVRAS, handler: handlePalavras },
  { rota: ROTA_MENSAGEM, handler: handleMensagem },
  { rota: ROTA_AJUSTES, handler: handleAjustes, marcado: ROTA_MAIS.caminho },
  { rota: ROTA_ATIVIDADE, handler: handleAtividade, marcado: ROTA_MAIS.caminho },
  {
    rota: ROTA_REELS,
    // O duble da Meta e uma classe local injetada por parametro, como manda
    // §13.2: nada de `vi.mock`, e nenhum laco daqui toca a rede.
    handler: (entrada) =>
      handleReels(
        entrada,
        comApiDeListagem(new MetaDeListagem([paginaDeMidias([itemDeMidia(REEL_DA_TELA)], null)])),
      ),
    preparar: prepararOReel,
  },
  {
    rota: ROTA_REEL,
    handler: handleReel,
    busca: `?${CAMPO_DO_REEL}=${REEL_DA_TELA}`,
    marcado: ROTA_REELS.caminho,
    preparar: prepararOReel,
  },
  { rota: ROTA_MAIS, handler: handleMais },
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

/** O que §13.2 proibe em qualquer corpo: rastro, nome de coluna, "payload". */
const VAZAMENTO = /Error|at \w+ \(|SQLITE|D1_|undefined|payload/

/**
 * D1 em que SO a pergunta sobre a conta estoura.
 *
 * Duble local injetado por parametro, como todo duble deste projeto. Ele
 * precisa deixar a configuracao passar: um D1 que estourasse inteiro provaria
 * outra coisa, que a tela de erro funciona, e nao que a leitura da conta
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

/**
 * `vista_em` de quem acabou de agir: a janela de §10.8 ainda tem folga.
 *
 * E o estado que TODO laco deste arquivo construia, sozinho, e sem dizer que
 * era uma escolha. Nomear os dois estados e o que impede a proxima pessoa de
 * medir so este e concluir que a tela nao escreve.
 */
const VISTA_FRESCA = AGORA

/**
 * `vista_em` de quem VOLTA ao painel depois do intervalo de §10.8.
 *
 * E o estado real de quem abandona a aba, almoca e volta, e o unico em que a
 * escrituracao de sessao da guarda comum acontece. Um milissegundo passado do
 * intervalo, e nao uma hora: o teste tem de morder a BORDA da condicao
 * (`now - vistaEm < INTERVALO_DE_VISTA_MS`), senao um `<=` trocado por `<`
 * passaria calado.
 */
const VISTA_RETOMADA = AGORA - INTERVALO_DE_VISTA_MS - 1

/**
 * Uma sessao viva no banco, e o cookie dela.
 *
 * **`vistaEm` e parametro, e essa e a correcao de um teste CEGO.** Enquanto ele
 * era fixo em `AGORA`, e `abrirTela` despachava com `now = AGORA`, a condicao
 * `now - vistaEm < INTERVALO_DE_VISTA_MS` de `exigirSessaoViva` era verdadeira
 * em TODAS as voltas de TODOS os lacos: a escrituracao de sessao de §10.8
 * nunca era executada, e nenhum teste deste arquivo conseguia ver o custo nem
 * a escrita dela. Um teste que nao consegue observar o que afirma e pior que
 * nenhum, porque desliga a atencao de quem le o nome dele.
 *
 * A assinatura e a irma da de `tests/painel-sair.test.ts`, que ja nasceu com o
 * parametro, la ele e o proprio eixo das garantias VIS.
 */
async function abrirSessao(vistaEm: number = VISTA_FRESCA): Promise<Record<string, string>> {
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
      // `ociosa_ate` segue contado de AGORA de proposito, mesmo quando
      // `vista_em` e velho: a sessao esta VIVA e ociosa, e o que se quer
      // exercitar e a janela deslizando, nao a recusa do passo 9, que
      // `painel-sessao` ja prende.
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      vistaEm,
    )
    .run()

  return { cookie: `__Host-painel_sessao=${sessao.valor}` }
}

/**
 * Abre uma tela com sessao viva, pela mesma escada que o roteador usa.
 *
 * O `preparar` roda ANTES de `despachar` e escreve no D1 **real**, nunca no
 * `ambiente`, que nos lacos de custo e o `D1Contador`. Contar a preparacao
 * como gasto da tela transformaria TELA-19 e TELA-20 em afirmacoes falsas.
 */
async function abrirTela(
  tela: TelaDoPainel,
  cookie: Record<string, string>,
  ambiente: Env = env,
): Promise<Response> {
  await tela.preparar?.()
  return await despachar(
    pedir(`${tela.rota.caminho}${tela.busca ?? ''}`, cookie),
    ambiente,
    AGORA,
    tela.rota,
    tela.handler,
  )
}

/** O corpo da tela, ja lido. */
async function corpoDa(
  tela: TelaDoPainel,
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
 * leitura e o da configuracao, que leva exatamente dois statements. Por isso
 * `prepares - batches` e a conta: os dois statements do lote viram um. Quem
 * chama confere `batches` tambem, porque essa premissa e o que torna a conta
 * valida, um lote com tres statements a quebraria em silencio.
 */
function subrequests(contador: D1Contador): number {
  return contador.prepares - contador.batches
}

/** `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, o caminho de ESCRITA do D1. */
const ESCRITA_DE_SQL = /^\s*(insert|update|delete|replace)\b/i

/**
 * A UNICA escrita que uma tela de leitura pode executar (§10.8).
 *
 * E a escrituracao de sessao da guarda comum: a linha da PROPRIA sessao de quem
 * esta olhando, e nada do produto. A regex confere o statement INTEIRO,
 * ancorada nas duas pontas, com as tres interrogacoes no lugar, porque uma
 * allowlist frouxa (`/painel_sessoes/`) deixaria passar um `DELETE FROM
 * painel_sessoes` ou um `UPDATE painel_sessoes SET falhas_stepup`, que sao
 * outra decisao inteiramente.
 */
const ESCRITURACAO_DE_SESSAO =
  /^UPDATE painel_sessoes SET vista_em = \?, ociosa_ate = \? WHERE sid_hash = \?$/

/** Os SQLs de escrita que passaram pelo contador, na ordem. */
function escritasDe(contador: D1Contador): string[] {
  return contador.sqls.filter((sql) => ESCRITA_DE_SQL.test(sql))
}

/**
 * Os dois estados da janela de §10.8, para os lacos que medem escrita e custo.
 *
 * Rodar cada tela nos DOIS e o que torna as afirmacoes observaveis: o fresco e
 * o caminho barato, e o retomado e o de quem volta ao painel, e era o retomado
 * que nenhum laco deste arquivo construia.
 */
const ESTADOS_DA_JANELA = [
  { nome: 'janela fresca', vistaEm: VISTA_FRESCA },
  { nome: 'sessao retomada depois de 15 min', vistaEm: VISTA_RETOMADA },
] as const

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
    // `null` e o default honesto: um snapshot montado a mao nao veio de leitura
    // nenhuma, e `panorama`, que e o que estes testes exercitam, nao olha as
    // linhas de midia.
    linhasDeMidia: null,
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
 * sentido, a tela nao pode mentir sobre o que esta valendo, mudou de forma:
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

/**
 * Toda frase de tela que `dicionario.ts` exporta, com o nome da tabela.
 *
 * A leitura e do MODULO INTEIRO, e nao de uma lista escrita a mao: §12.1 regra
 * 1 vale para o dicionario todo, e uma lista de tabelas so cobre as tabelas que
 * existiam no dia em que ela foi escrita. Funcoes, numeros e a propria
 * `PALAVRAS_PROIBIDAS`, que e a lista das proibidas, e nao frase de tela,
 * ficam de fora; objetos aninhados (`FRASE_DO_AJUSTE`) sao percorridos ate a
 * string.
 */
function frasesDoDicionario(): { tabela: string; frase: string }[] {
  const achadas: { tabela: string; frase: string }[] = []

  const guardar = (tabela: string, valor: unknown): void => {
    if (typeof valor === 'string') {
      achadas.push({ tabela, frase: valor })
      return
    }
    if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return
    for (const dentro of Object.values(valor)) guardar(tabela, dentro)
  }

  for (const [nome, valor] of Object.entries(DICIONARIO)) {
    if (nome === 'PALAVRAS_PROIBIDAS') continue
    guardar(nome, valor)
  }

  return achadas
}

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
  // O cache da listagem de §12.5 e por ISOLATE e sobrevive entre testes, como o
  // da configuracao. Esquece-lo aqui e o que impede um teste de herdar a
  // listagem que o anterior guardou, e de afirmar sobre uma Meta que nunca foi
  // chamada.
  esquecerAListagem()
})

// ---------------------------------------------------------------------------
// HDR, escape, `<script>` e cabecalhos
// ---------------------------------------------------------------------------

describe('HDR: o valor do banco na tela', () => {
  test('HDR-06: uma palavra-gatilho com `<script>` sai escapada na tela de Palavras', async () => {
    await gravarConfig(env.DB, { trigger_keywords: JSON.stringify([VETOR, 'quero o link']) })
    const cookie = await abrirSessao()

    const resposta = await abrirTela(TELA_PALAVRAS, cookie)
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    // O valor CHEGOU a tela, sem isto o teste passaria com uma tela vazia.
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
        // o nome do campo do formulario, do mesmo jeito que `/painel/ajustes`
        // ja carrega `name="userCooldownHours"`. O que continua proibido e a
        // coluna vazando em qualquer outro lugar do corpo.
        const semNomesDeCampo = corpo.replace(/(?:name|id|for)="[^"]*"/g, '')
        expect({ [tela.rota.caminho]: semNomesDeCampo.includes('destinationUrl') }).toEqual({
          [tela.rota.caminho]: false,
        })
        // A frase tecnica do achado, a que fala em "endereco completo", fica
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
// DIC, o dicionario de traducao
// ---------------------------------------------------------------------------

describe('DIC: o dicionario de traducao', () => {
  test('DIC-01: todo campo gravavel da configuracao tem traducao, e nenhuma sobra', () => {
    // A trava forte deste dicionario e de TIPO, `Record<CampoDaConfig,
    // string>` nao compila com um campo faltando. Este teste e a metade
    // runtime: ele prova que o conjunto de chaves e exatamente o esperado, e
    // que ninguem traduziu `allowedMediaIds`, que nao e campo gravavel.
    const daFabrica = Object.keys(automationConfig).filter((campo) => campo !== 'allowedMediaIds')

    expect(new Set(Object.keys(NOME_DO_CAMPO))).toEqual(new Set([...daFabrica, 'mediaScope']))
    expect(Object.keys(NOME_DO_CAMPO)).not.toContain('allowedMediaIds')
  })

  test('DIC-02: nenhuma frase do dicionario escreve uma palavra proibida (§12.7)', () => {
    // **A varredura era de CINCO tabelas, e o dicionario tem dez.** A metade nao
    // varrida guardava uma violacao de verdade: `MOTIVO_DA_RECUSA
    // .dominio_nao_permitido` escrevia "na lista liberada no deploy", e "deploy"
    // esta em `PALAVRAS_PROIBIDAS`. Uma lista escrita a mao envelhece na
    // primeira tabela nova, e foi o que aconteceu tres vezes seguidas,
    // `CONFIRMACOES`, `MOTIVO_DA_RECUSA` e `TELA_DOS_REELS` nasceram depois
    // dela e nenhuma entrou.
    //
    // Agora o conjunto vem do MODULO, e nao de uma lista: toda tabela exportada
    // por `dicionario.ts` entra sozinha, e uma tabela nova nasce coberta. E o
    // mesmo desenho dos metatestes de §13.1, a trava que falha quando alguem
    // cria a superficie nova sem proteger.
    const frases = frasesDoDicionario()

    // Contrapositivo de COBERTURA, em duas metades. A primeira: o numero de
    // frases nao pode encolher. A segunda, que e a que importa, e o numero de
    // TABELAS, foi ele que ficou parado em cinco enquanto o dicionario dobrava.
    const tabelas = new Set(frases.map((achada) => achada.tabela))
    expect(frases.length).toBeGreaterThan(60)
    expect(tabelas.size).toBeGreaterThanOrEqual(10)

    for (const { tabela, frase } of frases) {
      for (const proibida of PALAVRAS_PROIBIDAS) {
        const onde = `${proibida} em ${tabela}: "${frase}"`
        expect({ [onde]: contemPalavra(frase, proibida) }).toEqual({ [onde]: false })
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
    // ternario invertido, a saida saia certa e a forma mentia.
    const sondas: Record<Exclude<CampoDeComparacao, 'processOnlyReels'>, [string, string]> = {
      caseSensitive: ['EU QUERO', 'eu quero'],
      normalizeAccents: ['querô', 'quero'],
      ignorePunctuation: ['eu quero!', 'eu quero'],
    }

    // A frase que significa "os dois textos contam como iguais", por campo.
    //
    // **Escritas a mao, e nao lidas de `FRASE_DO_AJUSTE`.** Ler do dicionario
    // faria o teste comparar o dicionario com ele mesmo: trocar as duas
    // entradas de um campo trocaria tambem a expectativa, e a inversao, que e
    // exatamente o defeito que este teste existe para pegar, passaria verde.
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
// TELA, os estados grandes e as pendencias
// ---------------------------------------------------------------------------

describe('TELA: os quatro estados grandes', () => {
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

  test('TELA-05b: os passos vem na ordem certa, e o passo pronto fica com o ✓', () => {
    // A pessoa ve o progresso: o passo resolvido nao some da lista.
    const visao = panorama(snapshotDeTeste({ triggerKeywords: [] }), true)

    expect(visao.passos.map((passo) => [passo.nome, passo.feito])).toEqual([
      ['Conta do Instagram conectada', true],
      ['Mensagem com link', true],
      ['Pelo menos uma palavra', false],
    ])
  })

  test('TELA-05c: no Inicio, o estado vem antes dos passos, e os passos antes da chave', async () => {
    // Sem conta ligada, o passo 1 falta e a lista aparece.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const corpo = await corpoDa(TELA_INICIO, cookie)
    const estado = corpo.indexOf('class="bloco-estado')
    const passos = corpo.indexOf('Falta pouco para funcionar')
    const chave = corpo.indexOf('class="bloco-chave"')

    expect(estado).toBeGreaterThan(-1)
    expect(passos).toBeGreaterThan(estado)
    expect(chave).toBeGreaterThan(passos)
    expect(corpo).toContain('<ol class="passos">')
    expect(corpo).toContain('Peça para quem instalou conectar a conta.')
    expect(corpo).toContain('Mensagem com link (pronto)')
    // O bloco "Onde mexer" repetia a barra de baixo e saiu.
    expect(corpo).not.toContain('Onde mexer')
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
    // painel RECUSA toda gravacao, nao pode escrever valores de fabrica por
    // cima do que ele salvou (§9.2, §12.6), entao a tela precisa dizer para
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
// TELA, o que a tela IMPRIME
// ---------------------------------------------------------------------------

describe('TELA: o que a tela imprime', () => {
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
    // aparecem, como as das outras chaves, e o que se afirma sobre ele e qual
    // opcao esta MARCADA, no laco de `CHAVES_EDITAVEIS` abaixo.
    for (const proibido of [ESCOPO_DE_MIDIAS.todas, MODO_DE_COMPARACAO.exact]) {
      expect({ [proibido]: corpo.includes(escapeHtml(proibido)) }).toEqual({ [proibido]: false })
    }

    // As tres chaves editaveis: a frase do valor que esta valendo e a MARCADA,
    // e a oposta aparece so como a outra opcao, nunca marcada.
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

      expect({ [modo]: corpo.includes(`${exemplo}&rdquo;, aciona`) }).toEqual({
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
// TELA, o portao, o custo e o que a tela promete
// ---------------------------------------------------------------------------

describe('TELA: o portao e o custo', () => {
  test('TELA-18: sem cookie, as cinco telas respondem 303 e custam ZERO consulta', async () => {
    // O portao, afirmado nas telas que servem a configuracao do dono, e nao
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

  test('TELA-19: as sete telas nao gravam CONTEUDO, e a unica escrita e a escrituracao de sessao de §10.8', async () => {
    // §6: o painel le, nao age. A garantia continua sendo essa, o que mudou e
    // que ela agora e PRECISA, e observavel.
    //
    // **O nome antigo era "as cinco telas escrevem ZERO vezes no D1", e ele
    // virou falso.** A correcao de §10.8 pos na guarda COMUM a escrita que
    // desliza a janela ociosa, entao uma tela de leitura escreve, sim: no maximo
    // uma linha, no maximo 1 a cada 15 min, e sempre a da PROPRIA sessao de quem
    // esta olhando. Pior que a frase falsa era a cegueira: `abrirSessao()`
    // gravava `vista_em = AGORA` e `abrirTela` despacha com `now = AGORA`, logo
    // `now - vistaEm === 0` em TODAS as sete voltas e o ramo da escrita nunca era
    // alcancado. O zero passava por acidente de fixture, e um teste que nao
    // consegue observar o que afirma e pior que nenhum: ele desliga a atencao de
    // quem le o nome dele.
    //
    // A distincao que este teste passa a fazer, e que e o conteudo dele:
    //   • escrita de CONTEUDO, `painel_config`, `painel_midias`,
    //     `processed_comments`, `account_tokens`, `painel_auditoria`: ZERO, nos
    //     dois estados da janela. E isto que §6 promete, e continua valendo;
    //   • escrituracao de SESSAO, `UPDATE painel_sessoes SET vista_em`, que
    //     §10.8 orca: nenhuma com a janela fresca, EXATAMENTE UMA na primeira
    //     visita depois dos 15 min.
    //
    // **O contrapositivo e obrigatorio, e sao dois**, um teste que aceitasse
    // "qualquer escrita" nao valeria nada: (1) com a janela fresca a lista de
    // escritas e VAZIA, e nao "pequena"; (2) com a janela vencida ela tem UM
    // item, e o SQL dele e conferido inteiro por `ESCRITURACAO_DE_SESSAO`. Logo
    // uma escrita a mais, uma escrita em outra tabela, ou um `DELETE` em
    // `painel_sessoes` caem aqui.
    //
    // MUTACOES QUE ESTE TESTE MATA (nao enfraqueca sem antes matar as tres):
    //   M-A: acrescentar `UPDATE painel_config SET enabled = enabled` ao ramo de
    //        >15 min de `exigirSessaoViva`, uma tela de LEITURA gravando
    //        conteudo, que e exatamente o que §6 proibe. Medido na versao antiga
    //        deste arquivo: 43/43 VERDES.
    //   M-B: chamar `marcarVista` duas vezes seguidas (escrita duplicada), cai
    //        no `toEqual` de UM item.
    //   M-C: apagar o `if (now - linha.vistaEm < INTERVALO_DE_VISTA_MS)` de
    //        `exigirSessaoViva`, fazendo a guarda escrever a CADA requisicao,
    //        cai na lista vazia do estado fresco, que e a cadencia de §10.8.
    await gravarConfig(env.DB)

    for (const tela of TELAS) {
      for (const estado of ESTADOS_DA_JANELA) {
        // Uma sessao NOVA por volta, e isto e load-bearing: a escrita acontece
        // no D1 REAL (o contador so envolve), entao reaproveitar um cookie faria
        // `vista_em` virar AGORA na primeira volta e todas as seguintes mediriam
        // o estado fresco outra vez, a mesma cegueira, por outro caminho.
        const cookie = await abrirSessao(estado.vistaEm)
        invalidarCacheDeConfig()
        // O cache de listagem de §12.5 e por ISOLATE e atravessa as voltas do
        // laco: sem esquece-lo, a segunda abertura de `/painel/reels` mediria o
        // caminho quente (sem a leitura do token) e as duas voltas nao seriam
        // comparaveis. O `beforeEach` limpa por TESTE, e aqui sao duas medicoes
        // dentro do mesmo teste.
        esquecerAListagem()
        const contador = new D1Contador(env.DB)
        await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

        const chave = `${tela.rota.caminho}, ${estado.nome}`
        const escritas = escritasDe(contador)

        // Quantas: 0 com a janela fresca, 1 depois dos 15 min. O `escritas` do
        // contador entra na conta junto, porque um `prepare` de escrita que
        // `escritasDe` nao reconhecesse ficaria de fora dos dois lados.
        expect({
          [chave]: { pelaLista: escritas.length, peloContador: contador.escritas },
        }).toEqual({
          [chave]: {
            pelaLista: estado.vistaEm === VISTA_FRESCA ? 0 : 1,
            peloContador: estado.vistaEm === VISTA_FRESCA ? 0 : 1,
          },
        })

        // Quais: nada alem da escrituracao de sessao. Com a lista vazia esta
        // assercao passa de gracas, e por isso a de cima existe.
        expect({
          [chave]: escritas.filter((sql) => !ESCRITURACAO_DE_SESSAO.test(sql)),
        }).toEqual({ [chave]: [] })
      }
    }
  })

  test('TELA-20: o orcamento de subrequests de cada tela, nos DOIS estados da janela de sessao', async () => {
    // §12.10 orca 3 para o Inicio e 5 para "O que aconteceu". Quatro telas pagam
    // 3, e o terceiro e a pergunta sobre a conta: sem ela a barra do topo, que
    // §12.1 exige IGUAL em toda tela, diria "Ligada e respondendo" numa
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
    //
    // **Cada tela tem DOIS orcamentos, e ate agora este teste media so um.** A
    // escrituracao de sessao de §10.8 mora na guarda COMUM, entao ela soma +1
    // subrequest a TODA tela autenticada, mas so na primeira visita de cada
    // janela de 15 min. Enquanto o laco construia apenas `vista_em = AGORA`, o
    // segundo numero de cada linha era invisivel: o teste travava o caminho
    // barato e chamava aquilo de "o orcamento da tela".
    //
    // **A tabela de §12.10 precisa de EMENDA, e este teste e a medicao dela.**
    // A tabela de la orca a tela e §10.8 orca a cadencia da escrita, e as duas
    // contas nunca se somaram: com a janela vencida o Inicio mede 4 contra os 3
    // orcados, e "O que aconteceu" mede 5, que por acaso e o numero que §12.10
    // ja escreve, por outra razao. A emenda que falta e uma nota de rodape na
    // tabela ("+1 consulta e +1 escrita em toda tela com sessao, no maximo 1 a
    // cada 15 min, §10.8"), e nao um numero novo por linha, que divergiria em
    // seis lugares. Nao somos donos do arquivo da spec: os valores MEDIDOS ficam
    // aqui, e a emenda fica pendente e nomeada.
    //
    // **O que §12.10 diz hoje, contra o que este laco MEDE** (medido em
    // 2026-09-09, nesta branch; a coluna "spec" e a tabela de §12.10 sem
    // emenda nenhuma):
    //
    //   tela                        spec | fresco | apos 15 min
    //   Inicio                         3 |      3 |      4
    //   Meus Reels                     3 |      3 |      4
    //   Palavras                       2 |      3 |      4
    //   Mensagem                       2 |      3 |      4
    //   Ajustes                        2 |      4 |      5
    //   O que aconteceu (abertura)     5 |      4 |      5
    //   Este Reel (sem linha na spec) , |      3 |      4
    //
    // Tres divergencias, e as tres precisam de emenda na SPEC, nao aqui:
    //   1. a escrituracao de sessao (+1 em toda a coluna `apos15min`), que e o
    //      achado desta rodada;
    //   2. Palavras/Mensagem/Ajustes: a tabela orca 2 e a tela paga 3 e 4 desde
    //      que a barra do topo passou a perguntar sobre a conta (§12.1 exige a
    //      barra IGUAL em toda tela) e desde que Ajustes ganhou o bloco de
    //      historico da Etapa 10. Este numero ja estava desatualizado antes
    //      desta rodada, e o laco antigo o media sem dizer que divergia;
    //   3. "O que aconteceu": a abertura simples paga 4, e o 5 da tabela vale
    //      para o toque em "Atualizar", outra invocacao, e por isso duas linhas.
    //
    // O pior caso do painel continua folgado contra o teto de 50 subrequests por
    // invocacao, e e por isso que a emenda e de TEXTO, e nao de comportamento.
    //
    // MUTACOES QUE ESTE TESTE MATA (as duas medidas VERMELHAS aqui):
    //   M-C: afrouxar o `if (now - linha.vistaEm < INTERVALO_DE_VISTA_MS)` de
    //        `exigirSessaoViva`, fazendo a guarda escrever a cada requisicao,
    //        cai na coluna `fresco`, que e a cadencia de §10.8 sendo respeitada
    //        (medido: TELA-19, TELA-20 e TELA-22 vermelhos juntos).
    //   M-D: baixar qualquer `apos15min` para o valor de `fresco`, e a
    //        "correcao" tentadora, e ela volta a esconder o custo da escrita.
    const ORCAMENTO: Record<string, { fresco: number; apos15min: number }> = {
      [ROTA_INICIO.caminho]: { fresco: 3, apos15min: 4 },
      [ROTA_PALAVRAS.caminho]: { fresco: 3, apos15min: 4 },
      [ROTA_MENSAGEM.caminho]: { fresco: 3, apos15min: 4 },
      [ROTA_AJUSTES.caminho]: { fresco: 4, apos15min: 5 },
      // **"O que aconteceu" paga 4 na abertura simples, e §12.10 sempre orcou 5
      // para ela.** Ate a Etapa 13 esta linha dizia 3 porque a tela ainda nao
      // tinha lista: ela lia so a configuracao, as midias e a conta. Com a lista
      // implementada entra o quarto, a consulta paginada a `processed_comments`
      //, e o quinto so aparece com o toque em "Atualizar", que e outra
      // invocacao. O numero fica travado AQUI, e nao dentro do handler, pelo
      // mesmo motivo dos outros: o custo de uma tela tem de ser visivel.
      [ROTA_ATIVIDADE.caminho]: { fresco: 4, apos15min: 5 },
      // "Mais" so le o estado para a barra do topo: sessao, configuracao e conta.
      [ROTA_MAIS.caminho]: { fresco: 3, apos15min: 4 },
      // **As duas telas de Reels pagam 3, e o DESVIO que a rodada 1 declarou
      // aqui foi removido.** Ele dizia que juntar a leitura de `painel_midias`
      // ao lote da configuracao "acoplaria a falha do `account_tokens` a
      // listagem, virando `500` onde hoje ha tela degradada". A re-revisao
      // mediu duas coisas contra esse argumento: (1) ja era `500`,
      // `buscarPagina` sempre chamou `loadAccessToken`, que nao tem
      // `try/catch`, e a tela degradada e a de `/painel/atividade`; (2) a saida
      // custa ZERO subrequest, porque `PainelConfigRepository.ler()` ja faz um
      // `db.batch()` e um `batch` vale UM subrequest.
      //
      // O que mudou: `configDaTela` pede a variante `comAsInativas`, e o
      // statement de midias do lote deixa de filtrar `ativo = 1` para o painel.
      // §12.5 manda estas telas mostrarem exatamente o que aquele filtro
      // descarta, o Reel apagado que "nao some da lista", o selo de regras
      // proprias num Reel desmarcado, a lista "salvo por voce" quando a Meta
      // nao responde, e agora elas mostram sem pagar consulta nenhuma. O
      // caminho quente do webhook segue com o lote filtrado (CFG-11 e CFG-12
      // travam os numeros dele).
      //
      // Os tres sao os mesmos das outras telas: a sessao, o lote da
      // configuracao e a pergunta sobre a conta, que em `/painel/reels` sai da
      // propria listagem (`loadAccessToken`, dentro de `buscarPagina`) e em
      // `/painel/reel` continua sendo `contaConectada`.
      [ROTA_REELS.caminho]: { fresco: 3, apos15min: 4 },
      // `/painel/reel` nao esta em §12.10, a tabela de la nao tem linha para
      // ela, e ela paga os mesmos 3. A linha daquele Reel vinha de um
      // `lerUma` proprio e agora sai do mesmo lote.
      [ROTA_REEL.caminho]: { fresco: 3, apos15min: 4 },
    }

    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)

    for (const tela of TELAS) {
      for (const estado of ESTADOS_DA_JANELA) {
        // Sessao nova por volta, pelo mesmo motivo de TELA-19: a escrita cai no
        // D1 real e envelheceria o cenario da volta seguinte.
        const cookie = await abrirSessao(estado.vistaEm)
        invalidarCacheDeConfig()
        // Idem TELA-19: o cache de listagem de §12.5 sobrevive as voltas, e o
        // orcamento que §12.10 escreve e o da abertura FRIA, com a leitura do
        // token dentro. Sem esta linha, `/painel/reels` mediria 3 na volta
        // fresca e 3 na retomada (2 leituras + 1 escrita), e a diferenca de +1
        // desapareceria por artefato de fixture, e nao por comportamento.
        esquecerAListagem()
        const contador = new D1Contador(env.DB)
        await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

        const orcado = ORCAMENTO[tela.rota.caminho]
        const chave = `${tela.rota.caminho}, ${estado.nome}`

        // A escrita entra na conta ao lado do subrequest, e nao em vez dele: e
        // ela que explica o +1, e sem ela um `SELECT` novo na guarda passaria
        // por escrituracao de sessao.
        expect({
          [chave]: {
            subrequests: subrequests(contador),
            lotes: contador.batches,
            escritas: contador.escritas,
          },
        }).toEqual({
          [chave]: {
            subrequests: estado.vistaEm === VISTA_FRESCA ? orcado?.fresco : orcado?.apos15min,
            lotes: 1,
            escritas: estado.vistaEm === VISTA_FRESCA ? 0 : 1,
          },
        })
      }
    }
  })

  test('TELA-22: o Inicio paga 1 subrequest a mais so quando a automacao esta desligada', async () => {
    // A data da ultima parada por codigo (§10.12) e o quarto, e ela so e lida no
    // estado em que a tela oferece religar. Perguntar por ela sempre custaria uma
    // leitura por visita para um dado que a tela ligada nao mostra.
    //
    // **Os DOIS estados da janela de §10.8, como em TELA-20**: 4 com a janela
    // fresca e 5 na primeira visita depois dos 15 min. O 5 e o pior caso de
    // custo do Inicio, automacao desligada E janela vencida, e ele estava
    // fora de toda medicao. Continua folgadissimo contra o teto de 50
    // subrequests por invocacao; o que nao podia continuar era invisivel.
    await gravarConfig(env.DB, { enabled: 0 })
    await ligarConta(env, AGORA)

    for (const estado of ESTADOS_DA_JANELA) {
      const cookie = await abrirSessao(estado.vistaEm)
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(TELA_INICIO, cookie, ambienteCom({ DB: comoD1(contador) }))

      expect({
        [estado.nome]: {
          subrequests: subrequests(contador),
          lotes: contador.batches,
          escritas: contador.escritas,
        },
      }).toEqual({
        [estado.nome]: {
          subrequests: estado.vistaEm === VISTA_FRESCA ? 4 : 5,
          lotes: 1,
          escritas: estado.vistaEm === VISTA_FRESCA ? 0 : 1,
        },
      })
    }
  })

  test('TELA-21: nenhuma tela ESCREVE em `processed_comments`, e so uma le', async () => {
    // **A premissa desta garantia mudou na Etapa 13, e a metade que importa
    // continua intacta.** Ate aqui ela dizia "nenhuma tela consulta
    // `processed_comments`", verdade enquanto "O que aconteceu" nao tinha
    // lista. §12.6 mandou a tela ler aquela tabela, e §11.8 regra 6 diz por que
    // isso nao afrouxa nada: **a separacao que importa e a do caminho de
    // ESCRITA**. A leitura pelo painel e permitida somente na forma de §12.6.
    //
    // Entao o laco afirma agora DUAS coisas, e a primeira e a antiga:
    //   1. nenhuma tela executa escrita naquela tabela, nenhuma, nunca;
    //   2. so `/painel/atividade` a le; qualquer outra tela que passe a ler cai
    //      aqui e obriga a decisao a ser escrita, em vez de passar no diff.
    //
    // A afirmacao e sobre QUAIS statements passaram, e nao sobre quantos,
    // contar nao diz nada sobre a tabela tocada.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()

    /** `INSERT`, `UPDATE` e `DELETE`, o caminho de escrita de §11.8 regra 6. */
    const ESCRITA = /\b(insert|update|delete)\b/i

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const contador = new D1Contador(env.DB)
      await abrirTela(tela, cookie, ambienteCom({ DB: comoD1(contador) }))

      // Contrapositivo: uma lista vazia de SQL passaria calada.
      expect({ [tela.rota.caminho]: contador.sqls.length }).not.toEqual({ [tela.rota.caminho]: 0 })

      const tocam = contador.sqls.filter((sql) => sql.includes('processed_comments'))

      // (1) Nenhuma escrita, em tela nenhuma.
      expect({
        [tela.rota.caminho]: tocam.filter((sql) => ESCRITA.test(sql)),
      }).toEqual({ [tela.rota.caminho]: [] })

      // (2) So "O que aconteceu" chega perto da tabela.
      if (tela.rota.caminho !== ROTA_ATIVIDADE.caminho) {
        expect({ [tela.rota.caminho]: tocam }).toEqual({ [tela.rota.caminho]: [] })
      }
    }
  })

  test('TELA-22: a conta indisponivel nao vira fato na tela, e deixa rastro no console', async () => {
    // A direcao segura e "nao conectada". O que nao pode e o SILENCIO: um D1
    // fora do ar viraria uma afirmacao ao dono, sem nada em lugar nenhum, e ele
    // passaria a tarde reconectando uma conta que nunca desconectou (§12.7:
    // detalhe tecnico vai para o `console`, nunca para a tela).
    await ligarConta(env, AGORA)

    // Primeiro o contrapositivo, com o D1 inteiro: a conta ESTA ligada.
    expect(await contaConectada(env.DB, AGORA)).toBe(true)

    const console = capturarConsole()
    let respondeu: boolean
    try {
      respondeu = await contaConectada(
        new D1ComContaQuebrada(env.DB) as unknown as D1Database,
        AGORA,
      )
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

    expect(corpo).toContain('Conta do Instagram não conectada')
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
        // **A comparacao e com o CAMINHO, e a query string fica de fora.** A
        // tabela de rotas casa por caminho exato e NENHUM caminho tem segmento
        // variavel (Ruling 93): `/painel/reel?midia=<id>` e a rota
        // `/painel/reel`, e o Reel viaja na query string justamente porque o
        // roteador nao o entenderia de outro jeito. Comparar a href inteira
        // reprovaria o unico endereco que §12.5 manda a tela oferecer.
        const caminho = link.split('?')[0] ?? ''
        expect({ [`${tela.rota.caminho} -> ${link}`]: conhecidos.has(caminho) }).toEqual({
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
// TELA, celular e acessibilidade (§12.9)
// ---------------------------------------------------------------------------

describe('TELA: celular e acessibilidade', () => {
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
    // **O numero mudou na Etapa 12, e a FORMA que este teste guarda nao.**
    //
    // §12.1 descreve a barra como **Inicio · Reels · Palavras · Mensagem ·
    // Mais**, cinco itens. Historico, Ajustes e Aparelhos moram dentro de Mais.
    //
    // O que este teste existe para guardar continua intacto e e o laco abaixo:
    // **icone E palavra em todo item**, porque §12.1 proibe navegacao so por
    // icone. Nenhum item novo pode entrar sem os dois.
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
        [tela.rota.caminho]: [tela.marcado ?? tela.rota.caminho],
      })
    }
  })

  test('TELA-28: o freio aparece na barra do topo de TODA tela', async () => {
    // §12.1: a barra do topo e o unico elemento repetido do painel, e a
    // repeticao e proposital, a pessoa nunca precisa procurar como parar.
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

  test('TELA-29: nenhuma tela passa do teto de HTML que esta branch se impos', async () => {
    // **A AUTORIDADE deste teste mudou nesta rodada, e o numero nao.** Ele
    // afirmava "conformidade com §12.9", e §12.9 nao e teto: a linha da tabela
    // diz *"Conexao ruim | ... CSS ~6 KB, HTML ~15 KB por tela"*, com til, como
    // diretriz. O que este laco entrega e uma **trava-crescimento desta
    // branch**, a tela que estoura o orcamento estoura devagar, um bloco por
    // etapa, e ninguem percebe pelo olho.
    //
    // A pergunta que §12.9 protege, "abre em conexao ruim?", nao se responde
    // com o numero cru: 39.473 bytes da tela de Reels viram 2.499 comprimidos.
    // Quem a responde e o MID-27, que mede as duas pontas.
    //
    // **Os 15 KB seguem para as cinco telas de TEXTO. As duas de Reels adotam
    // os tetos ja medidos do MID-27**, porque o laco daqui as percorre com UM
    // Reel salvo e UM item listado, o cenario que menos importa, e afirmar
    // 15 KB sobre ele daria a impressao de cobrir o que nao cobre (§13.1).
    const TETO: Record<string, number> = {
      [ROTA_REELS.caminho]: TETO_NO_LIMITE_DE_200_REELS,
      [ROTA_REEL.caminho]: TETO_DE_UMA_PAGINA_DE_REELS,
    }

    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    for (const tela of TELAS) {
      invalidarCacheDeConfig()
      const bytes = new TextEncoder().encode(await corpoDa(tela, cookie)).length
      const teto = TETO[tela.rota.caminho] ?? TETO_DE_HTML

      expect({ [tela.rota.caminho]: bytes <= teto }).toEqual({
        [tela.rota.caminho]: true,
      })
    }
  })

  // **A trava do `painel.css` NAO mora aqui, e a ausencia foi medida.**
  //
  // Uma primeira versao deste arquivo importava `painel.css?raw` e afirmava o
  // teto sobre o texto lido. Ela passava, e passava por nada: sob
  // `vitest-pool-workers` o `?raw` de um `.css` devolve **string vazia**,
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
