/**
 * ATV, "O que aconteceu": a lista, o @ ao vivo e o que a tela promete (§12.6).
 *
 * As onze garantias ATV de §13.2, mais o dicionario de `CommentStatus` como
 * funcao pura e o par que sustenta a frase honesta da tela: a automacao **nao
 * grava linha para comentario ignorado**, e a tela **renderiza o aviso de "so os
 * atendidos aparecem" sempre**, inclusive com a lista vazia.
 *
 * As regras de sempre valem aqui:
 *
 *   - **nada de `vi.mock`**: o duble da Graph API e uma classe local passada por
 *     parametro (`handleAtividade(entrada, comArrobas(falsa))`), e nenhum teste
 *     deste arquivo toca a rede;
 *   - **a rota e chamada por `despachar`**, a mesma funcao do roteador: chamar o
 *     handler direto pularia a escada de §11.3 e afirmaria menos do que parece;
 *   - **`now` e sempre injetado** (`AGORA`), sem fake timers;
 *   - **um ID por garantia**, e nenhum valor da instalacao de quem escreveu.
 *
 * O duble conta a ORDEM e a SIMULTANEIDADE das chamadas, e o que transforma
 * "em blocos de no maximo 6" numa afirmacao sobre o codigo, e nao sobre a
 * intencao de quem o escreveu.
 */
import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import type { CommentStatus } from '../src/repositories/comments-repository'
import { CommentsRepository } from '../src/repositories/comments-repository'
import {
  ARROBAS_POR_BLOCO,
  type ArrobaDaLinha,
  ATUALIZAR,
  CAMPO_DO_CURSOR,
  CAMPO_DO_DESEMPATE,
  CONSULTAS_DA_TELA,
  type DependenciasDaAtividade,
  handleAtividade,
  LINHAS_POR_PAGINA,
  orcamentoDeArrobas,
} from '../src/routes/painel/atividade'
import {
  dataEmPortugues,
  PALAVRAS_PROIBIDAS,
  RESULTADO_DESCONHECIDO,
  RESULTADO_DO_COMENTARIO,
  resultadoNaTela,
} from '../src/routes/painel/dicionario'
import { ROTA_ATIVIDADE } from '../src/routes/painel/rotas'
import { despachar } from '../src/routes/painel/router'
import { type ProcessDeps, processComment } from '../src/services/automation'
import { invalidarCacheDeConfig } from '../src/services/config-store'
import type { MetaApiClient } from '../src/services/meta-api'
import { emitirSessao, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import type { CommentEvent } from '../src/types/meta'
import { sha256Hex } from '../src/utils/hash'
import { gravarConfig, ligarConta, limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoApi,
  comoD1,
  configDeTeste,
  contemPalavra,
  D1Contador,
  IG_USER_ID,
  MetaFalsa,
  pedir,
  TETO_DE_SUBREQUESTS,
  USERNAME_CONTA,
} from './fixtures/dubles'

/** A midia ficticia das linhas de `processed_comments`. Nunca a de ninguem. */
const MIDIA_DE_TESTE = '17900000000000001'

// ---------------------------------------------------------------------------
// O duble da Graph API
// ---------------------------------------------------------------------------

/** O que o duble responde para um `comment_id`. */
type RespostaDoDuble = ArrobaDaLinha

/**
 * Duble do no de comentario da Graph API.
 *
 * Ele guarda tres coisas, e a terceira e a que nenhum outro duble do projeto
 * media: quantas chamadas estavam **em voo ao mesmo tempo**. Sem esse numero,
 * "em blocos de no maximo 6" seria uma afirmacao sobre a leitura do codigo, e
 * um `Promise.all` sobre as 20 de uma vez passaria verde.
 */
class MetaDosArrobas {
  readonly consultados: string[] = []
  emVoo = 0
  maximoEmVoo = 0

  constructor(private readonly resposta: (commentId: string) => RespostaDoDuble) {}

  async buscar(_env: Env, _token: string, commentId: string): Promise<ArrobaDaLinha> {
    this.consultados.push(commentId)
    this.emVoo++
    this.maximoEmVoo = Math.max(this.maximoEmVoo, this.emVoo)
    // Cede o microtask: sem isto o bloco inteiro terminaria antes de a segunda
    // chamada comecar, e a simultaneidade medida seria sempre 1.
    await Promise.resolve()
    this.emVoo--
    return this.resposta(commentId)
  }
}

function comArrobas(falsa: MetaDosArrobas): DependenciasDaAtividade {
  return { buscarArroba: (ambiente, token, id) => falsa.buscar(ambiente, token, id) }
}

/** O duble que sempre devolve um @ derivado do proprio id. */
function sempreArroba(): MetaDosArrobas {
  return new MetaDosArrobas((commentId) => ({ tipo: 'arroba', username: `pessoa_${commentId}` }))
}

// ---------------------------------------------------------------------------
// O cenario
// ---------------------------------------------------------------------------

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

/**
 * Uma linha de `processed_comments`, escrita direto no D1 **real**.
 *
 * Nunca no `D1Contador`: contar a preparacao do cenario como gasto da tela
 * transformaria o orcamento de ATV-06 numa afirmacao falsa, que e a mesma
 * armadilha que `abrirTela` desarma em `painel-telas`.
 */
async function gravarLinha(
  commentId: string,
  criadoEm: number,
  extras: { status?: string; proximaTentativaEm?: number | null; ultimoErro?: string | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO processed_comments
       (comment_id, media_id, commenter_scoped_id_hash, status, attempt_count,
        last_error_code, next_retry_at, created_at, updated_at)
     VALUES (?, ?, 'hash-ficticio-do-autor', ?, 0, ?, ?, ?, ?)`,
  )
    .bind(
      commentId,
      MIDIA_DE_TESTE,
      extras.status ?? 'completed',
      extras.ultimoErro ?? null,
      extras.proximaTentativaEm ?? null,
      criadoEm,
      criadoEm,
    )
    .run()
}

/** N linhas atendidas, da mais nova para a mais velha. */
async function gravarLinhas(quantas: number): Promise<void> {
  for (let i = 0; i < quantas; i++) {
    await gravarLinha(`c${String(i).padStart(3, '0')}`, AGORA - i * 1000)
  }
}

/** A busca da tela: `?acao=atualizar` e o toque explicito de §2.3. */
function comToque(extra: Record<string, string> = {}): string {
  const busca = new URLSearchParams({ acao: ATUALIZAR, ...extra })
  return `${ROTA_ATIVIDADE.caminho}?${busca.toString()}`
}

async function abrir(
  caminho: string,
  cookie: Record<string, string>,
  opcoes: { deps?: DependenciasDaAtividade; ambiente?: Env } = {},
): Promise<Response> {
  return await despachar(
    pedir(caminho, cookie),
    opcoes.ambiente ?? env,
    AGORA,
    ROTA_ATIVIDADE,
    (entrada) => handleAtividade(entrada, opcoes.deps),
  )
}

async function corpoDe(
  caminho: string,
  cookie: Record<string, string>,
  opcoes: { deps?: DependenciasDaAtividade; ambiente?: Env } = {},
): Promise<string> {
  return await (await abrir(caminho, cookie, opcoes)).text()
}

/** So o `<body>`: o `<head>` carrega atributos, e nao texto que alguem le. */
function soOCorpo(html: string): string {
  return html.split('<body>')[1] ?? ''
}

/**
 * O `href` do link daquele texto, ja com as entidades desfeitas.
 *
 * Os testes de paginacao SEGUEM o link que a tela desenhou, em vez de montar a
 * query string a mao. A diferenca nao e de estilo: um cursor montado pelo teste
 * afirma que o BANCO pagina certo, e um cursor lido da tela afirma que a pessoa
 * que toca em "Ver mais" chega na pagina seguinte, que e a garantia de §12.6.
 * Foi exatamente essa distancia que deixou o cursor sem desempate passar verde.
 */
function hrefDaAcao(corpo: string, texto: string): string {
  const casamento = corpo.match(new RegExp(`href="([^"]*)">${texto}`))
  const bruto = casamento?.[1]
  if (bruto === undefined) throw new Error(`o link "${texto}" nao esta nesta tela`)
  return bruto.replace(/&amp;/g, '&')
}

/** Os @ que aquela pagina mostrou, na ordem em que sairam. */
function arrobasDe(corpo: string): string[] {
  return corpo.match(/@pessoa_[a-z0-9]+/g) ?? []
}

/** Quantas linhas aquela pagina desenhou. */
function quantasLinhas(corpo: string): number {
  return (corpo.match(/class="linha-de-ajuste"/g) ?? []).length
}

/**
 * As formas de ESCREVER naquele nome, as que transformam uma tabela `const`
 * num cache de isolate sem que o `tsc` tenha o que dizer.
 */
function mutacoesDe(nome: string): RegExp[] {
  return [
    new RegExp(`\\b${nome}\\s*\\.(set|add|push|unshift|splice)\\s*\\(`),
    new RegExp(`\\b${nome}\\s*\\[[^\\]]*\\]\\s*=[^=]`),
    new RegExp(`\\b${nome}\\s*\\.[A-Za-z_$][\\w$]*\\s*=[^=]`),
  ]
}

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
})

// ---------------------------------------------------------------------------
// A consulta ao banco (§12.6, §16.6)
// ---------------------------------------------------------------------------

describe('ATV: a consulta a `processed_comments`', () => {
  test('ATV-01: o painel NUNCA executa escrita em `processed_comments`', async () => {
    // §6: o painel le, nao age. E §16.6 fecha a outra metade: nem indice novo,
    // nem escrita, o caminho quente do webhook e quem paga a conta daquela
    // tabela, e uma escrita por abertura de tela sairia do mesmo orcamento.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(3)

    const contador = new D1Contador(env.DB)
    await abrir(comToque(), cookie, {
      deps: comArrobas(sempreArroba()),
      ambiente: ambienteCom({ DB: comoD1(contador) }),
    })

    // Contrapositivo: uma tela que nao tocasse o banco passaria calada.
    expect(contador.sqls.some((sql) => sql.includes('processed_comments'))).toBe(true)

    // **`escritas === 0` vale porque `abrirSessao()` deixa `vista_em = AGORA`.**
    // Nesse estado a escrituracao de sessao de §10.8 nao grava, o intervalo de
    // 15 min nao venceu. Numa sessao RETOMADA a guarda comum grava uma vez, e
    // este numero seria 1 sem que nada desta tela tivesse mudado; quem afirma
    // aquele estado e TELA-19, que separa escrita de CONTEUDO de escrituracao de
    // SESSAO. A garantia que o NOME deste teste promete nao depende desta linha:
    // ela esta na afirmacao seguinte, que filtra por tabela e vale em qualquer
    // estado da sessao.
    expect(contador.escritas).toBe(0)
    expect(
      contador.sqls.filter((sql) => sql.includes('processed_comments') && !/^\s*SELECT/i.test(sql)),
    ).toEqual([])
  })

  test('ATV-02: nenhuma consulta do painel retorna `commenter_scoped_id_hash`', async () => {
    // O hash do autor existe para o intervalo por pessoa. Um `SELECT *` o
    // traria para a memoria da tela, e dali seria uma linha de distancia de ele
    // entrar num log de depuracao, que e o unico jeito de esta tela vazar um
    // dado que ela promete nunca ter tido.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(2)

    const contador = new D1Contador(env.DB)
    const corpo = await corpoDe(comToque(), cookie, {
      deps: comArrobas(sempreArroba()),
      ambiente: ambienteCom({ DB: comoD1(contador) }),
    })

    expect(contador.sqls.filter((sql) => sql.includes('commenter_scoped_id_hash'))).toEqual([])
    // O `SELECT *` proibido e o DESTA tabela: `painel_config` e `painel_midias`
    // trazem a linha inteira porque a linha inteira e o que elas significam, e
    // nenhuma das duas tem coluna de dado pessoal de terceiro.
    expect(
      contador.sqls.filter((sql) => sql.includes('processed_comments') && /SELECT\s+\*/i.test(sql)),
    ).toEqual([])
    expect(corpo).not.toContain('hash-ficticio-do-autor')
  })

  test('ATV-03: a consulta usa colunas nomeadas e `LIMIT 20`', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarLinhas(1)

    const contador = new D1Contador(env.DB)
    await abrir(ROTA_ATIVIDADE.caminho, cookie, {
      ambiente: ambienteCom({ DB: comoD1(contador) }),
    })

    const consulta = contador.sqls.find((sql) => sql.includes('processed_comments'))
    expect(consulta).toBeDefined()
    for (const coluna of [
      'comment_id',
      'media_id',
      'status',
      'created_at',
      'next_retry_at',
      'last_error_code',
    ]) {
      expect({ [coluna]: consulta?.includes(coluna) }).toEqual({ [coluna]: true })
    }
    expect(consulta).toContain(`LIMIT ${LINHAS_POR_PAGINA}`)
    expect(consulta).toContain('LIMIT 20')
    expect(consulta).toContain('ORDER BY created_at DESC')
  })
})

// ---------------------------------------------------------------------------
// O orcamento (§12.6)
// ---------------------------------------------------------------------------

describe('ATV: o orcamento de chamadas a Meta', () => {
  test('ATV-04: a tela nao emite mais de 20 chamadas a Meta por invocacao', async () => {
    // 35 linhas no banco, e a pagina continua sendo de 20: o teto e de PROJETO
    // e existe para respeitar a cota de 24 h da Meta, que e a mesma que a
    // automacao usa para responder.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(35)

    const falsa = sempreArroba()
    await abrir(comToque(), cookie, { deps: comArrobas(falsa) })

    expect(falsa.consultados.length).toBeLessThanOrEqual(LINHAS_POR_PAGINA)
    expect(falsa.consultados.length).toBe(LINHAS_POR_PAGINA)
    // Contrapositivo: cada id e consultado UMA vez, e sao os 20 mais novos.
    expect(new Set(falsa.consultados).size).toBe(LINHAS_POR_PAGINA)
    expect(falsa.consultados[0]).toBe('c000')
  })

  test('ATV-05: as chamadas saem em blocos de no maximo 6 simultaneas', async () => {
    // Seis e o limite de conexoes simultaneas do runtime. Um `Promise.all` sobre
    // as 20 de uma vez nao aceleraria nada e mediria 20 aqui.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(LINHAS_POR_PAGINA)

    const falsa = sempreArroba()
    await abrir(comToque(), cookie, { deps: comArrobas(falsa) })

    expect(falsa.maximoEmVoo).toBeLessThanOrEqual(ARROBAS_POR_BLOCO)
    // Contrapositivo: sequencial mediria 1, e a tela levaria mais de 10 s.
    expect(falsa.maximoEmVoo).toBe(ARROBAS_POR_BLOCO)
  })

  test('ATV-06: o orcamento e conferido ANTES de disparar, e o total fica <= 46', async () => {
    // A funcao e pura de proposito: com o teto de 20 linhas por pagina o ramo do
    // clamp nao e alcancavel por HTTP hoje, e um teste que fingisse alcanca-lo
    // estaria medindo outra coisa (§13.1).
    expect(orcamentoDeArrobas(CONSULTAS_DA_TELA)).toBe(46 - CONSULTAS_DA_TELA)
    expect(CONSULTAS_DA_TELA + orcamentoDeArrobas(CONSULTAS_DA_TELA)).toBe(46)
    expect(orcamentoDeArrobas(46)).toBe(0)
    expect(orcamentoDeArrobas(200)).toBe(0)

    // E a metade medida: com a pagina cheia, o gasto real da invocacao inteira
    // consultas ao D1 mais chamadas a Meta, fica abaixo do teto da
    // plataforma, que o Miniflare nao impoe.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(LINHAS_POR_PAGINA)

    const contador = new D1Contador(env.DB)
    const falsa = sempreArroba()
    await abrir(comToque(), cookie, {
      deps: comArrobas(falsa),
      ambiente: ambienteCom({ DB: comoD1(contador) }),
    })

    const gasto = contador.prepares - contador.batches + falsa.consultados.length
    expect(gasto).toBeLessThanOrEqual(46)
    expect(gasto).toBeLessThan(TETO_DE_SUBREQUESTS)
    // Contrapositivo: um gasto de zero significaria que nada foi medido.
    expect(gasto).toBeGreaterThan(LINHAS_POR_PAGINA)
  })

  test('ATV-11: sem toque em "Atualizar" nenhuma chamada a Meta e feita', async () => {
    // §2.3: sem auto-refresh, sem polling. Buscar os @ a cada render
    // transformaria abrir a tela num custo de envio, na mesma cota de 24 h.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(5)

    const falsa = sempreArroba()
    const corpo = await corpoDe(ROTA_ATIVIDADE.caminho, cookie, { deps: comArrobas(falsa) })

    expect(falsa.consultados).toEqual([])
    // A lista continua inteira, e o botao que gasta a cota esta oferecido.
    expect(corpo).toContain('Ver quem comentou')
    expect(corpo).toContain(`acao=${ATUALIZAR}`)

    // Contrapositivo: com o toque, as chamadas saem.
    const comOToque = sempreArroba()
    await abrir(comToque(), cookie, { deps: comArrobas(comOToque) })
    expect(comOToque.consultados.length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// A degradacao (§12.6)
// ---------------------------------------------------------------------------

describe('ATV: quando o @ nao vem', () => {
  test('ATV-07: comentario apagado mantem a linha, com "@ indisponivel"', async () => {
    // §12.6: nunca sumir com a linha. O mesmo texto cobre perfil apagado e conta
    // que bloqueou, do lado de ca as tres sao indistinguiveis, e inventar a
    // diferenca seria afirmar sobre o Instagram de outra pessoa.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinha('c-vivo', AGORA)
    await gravarLinha('c-apagado', AGORA - 1000)

    const falsa = new MetaDosArrobas((id) =>
      id === 'c-apagado' ? { tipo: 'apagado' } : { tipo: 'arroba', username: 'quem_comentou' },
    )
    const corpo = await corpoDe(comToque(), cookie, { deps: comArrobas(falsa) })

    expect(corpo).toContain('@quem_comentou')
    expect(corpo).toContain('@ indisponível, o comentário foi apagado')
    // A linha CONTINUA: o resultado dela esta na tela, inteiro.
    expect(corpo.match(/Direct enviado e coment/g)?.length).toBe(2)
    // E a consequencia honesta de §12.6 esta escrita na propria tela.
    expect(corpo).toContain('Quanto mais antiga a linha')
  })

  test('ATV-08: falha geral da Graph API degrada para a lista sem @, com faixa', async () => {
    // A tela nao pode quebrar: os tres estados grandes e as pendencias continuam
    // respondendo a pergunta de §3 mesmo sem um @ sequer.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(4)

    const muda = new MetaDosArrobas(() => ({ tipo: 'falhou' }))
    const resposta = await abrir(comToque(), cookie, { deps: comArrobas(muda) })
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    expect(corpo).toContain('falar com o Instagram agora')
    expect(corpo).toContain('@ indisponível')
    // A lista sobe com a data e o resultado de cada linha, intactos.
    expect(corpo.match(/Direct enviado e coment/g)?.length).toBe(4)
    expect(corpo).toContain('Em 14/11/2023')
  })

  test('ATV-08b: sem conta ligada a tela abre, com a faixa e sem chamada nenhuma', async () => {
    // Nao ha ligacao para perguntar: a tela degrada pelo mesmo caminho, e o
    // duble prova que nenhuma chamada foi tentada as cegas.
    //
    // A FRASE e a da ligacao caida, e nao a da Graph API muda: sem conta ligada
    // nada e enviado, e escrever "a sua automacao continua funcionando
    // normalmente" seria afirmar na faixa o contrario do que a secao "A conta do
    // Instagram", nesta mesma pagina, acabou de dizer (§12.1 regra 3).
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarLinhas(2)

    const falsa = sempreArroba()
    const resposta = await abrir(comToque(), cookie, { deps: comArrobas(falsa) })
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    expect(falsa.consultados).toEqual([])
    expect(corpo).toContain('liga&ccedil;&atilde;o com o Instagram caiu')
    expect(corpo).not.toContain('continua funcionando normalmente')
    expect(corpo.match(/Direct enviado e coment/g)?.length).toBe(2)
  })

  test('ATV-08c: com o token vencido a tela NAO gasta chamada nenhuma, e nao afirma normalidade', async () => {
    // `loadAccessToken` devolve `{token, igUserId, expiresAt}` sem olhar a
    // validade, ele so devolve `null` quando nao existe linha nenhuma. Sem
    // conferir o `expiresAt` a tela disparava ate 20 chamadas com um Bearer
    // morto, todas respondidas 401/190, todas viradas em `falhou`: 20
    // subrequests e 20 chamadas queimadas da cota de 24 h que a AUTOMACAO usa
    // para enviar, a cota que o botao explicito de §2.3 existe para racionar,
    // e no fim a faixa afirmando que "a sua automacao continua funcionando
    // normalmente" na mesma pagina que dizia "nada e enviado".
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    // A conta existe, mas a ligacao venceu ontem. A Meta nao renova token
    // expirado: nao ha desfecho em que essas chamadas dariam certo.
    await env.DB.prepare('UPDATE account_tokens SET expires_at = ? WHERE id = 1')
      .bind(AGORA - 1)
      .run()
    const cookie = await abrirSessao()
    await gravarLinhas(LINHAS_POR_PAGINA)

    const falsa = sempreArroba()
    const resposta = await abrir(comToque(), cookie, { deps: comArrobas(falsa) })
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    // Nenhuma chamada: a tela SABIA que elas iam falhar.
    expect(falsa.consultados).toEqual([])
    expect(corpo).toContain('liga&ccedil;&atilde;o com o Instagram caiu')
    expect(corpo).not.toContain('continua funcionando normalmente')
    // A lista continua inteira, que e a metade de §12.6 que nao muda.
    expect(quantasLinhas(corpo)).toBe(LINHAS_POR_PAGINA)
  })

  test('ATV-08d: no caminho feliz a faixa NAO sobe, e uma falha sozinha a liga', async () => {
    // O contrapositivo que faltava. Sem ele, `let mudo = false` trocado por
    // `let mudo = true` deixava a suite inteira verde e a tela passava a exibir
    // "nao conseguimos falar com o Instagram" com os 20 @ chegando perfeitos,
    // o dono conclui que a integracao quebrou, e nenhum teste fica vermelho.
    // A garantia ATV de §13.2 valia, na pratica, "a faixa existe no HTML".
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(4)

    const feliz = await corpoDe(comToque(), cookie, { deps: comArrobas(sempreArroba()) })
    expect(arrobasDe(feliz).length).toBe(4)
    expect(feliz).not.toContain('falar com o Instagram agora')
    expect(feliz).not.toContain('liga&ccedil;&atilde;o com o Instagram caiu')

    // E o outro lado, que fixa o comportamento decidido: UMA falha entre as
    // quatro ja levanta a faixa. A tela nao esconde que parte dos @ nao veio.
    const umaFalhou = new MetaDosArrobas((id) =>
      id === 'c002' ? { tipo: 'falhou' } : { tipo: 'arroba', username: `pessoa_${id}` },
    )
    const parcial = await corpoDe(comToque(), cookie, { deps: comArrobas(umaFalhou) })
    expect(parcial).toContain('falar com o Instagram agora')
    expect(parcial).toContain('continua funcionando normalmente')
    // A linha da falha continua na tela, com o resultado dela intacto.
    expect(quantasLinhas(parcial)).toBe(4)
  })

  test('ATV-08e: comentario apagado NAO e falha, e sozinho nao levanta faixa nenhuma', async () => {
    // `apagado` e um desfecho conhecido e explicado na propria linha ("o
    // comentario foi apagado"). Trata-lo como falha faria a tela avisar que o
    // Instagram esta mudo toda vez que uma linha envelhecesse, que e o estado
    // NORMAL desta lista, segundo a frase de §12.6 que ela mesma escreve.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(3)

    const apagados = new MetaDosArrobas(() => ({ tipo: 'apagado' }))
    const corpo = await corpoDe(comToque(), cookie, { deps: comArrobas(apagados) })

    expect(corpo).toContain('@ indisponível, o comentário foi apagado')
    expect(corpo).not.toContain('falar com o Instagram agora')
    expect(corpo).not.toContain('liga&ccedil;&atilde;o com o Instagram caiu')
    expect(quantasLinhas(corpo)).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// O username nao sobrevive (§2.3)
// ---------------------------------------------------------------------------

describe('ATV: o @ nao e armazenado em lugar nenhum', () => {
  test('ATV-09: o @ nao vai ao `console`, nao vai a auditoria e nao sobrevive a requisicao', async () => {
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(3)

    const arroba = 'pessoa_que_nao_pode_ficar'
    const falsa = new MetaDosArrobas(() => ({ tipo: 'arroba', username: arroba }))

    const console = capturarConsole()
    let corpo: string
    try {
      corpo = await corpoDe(comToque(), cookie, { deps: comArrobas(falsa) })
    } finally {
      console.parar()
    }

    // Contrapositivo: o @ ESTA na tela desta resposta, e so nela.
    expect(corpo).toContain(`@${arroba}`)

    expect(console.linhas.join(' ')).not.toContain(arroba)

    const auditoria = await env.DB.prepare('SELECT * FROM painel_auditoria').all()
    expect(auditoria.results ?? []).toEqual([])

    // Nenhuma tabela guardou o @: uma segunda abertura SEM o toque volta sem
    // arroba nenhum. (Esta linha sozinha NAO prova ausencia de cache, sem o
    // toque `arrobaDaLinha` devolve string vazia para toda linha, e mostrar um
    // cache aqui violaria ATV-11. Quem prova e o par abaixo.)
    const segunda = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)
    expect(segunda).not.toContain(arroba)

    // **A prova de que nada foi reaproveitado**: o segundo toque busca de novo
    // as tres linhas E o que a tela mostra e a resposta NOVA. Um cache de
    // isolate lido no lugar da chamada devolveria o @ da primeira requisicao,
    // e o teste anterior, que so contava chamadas, ficaria verde do mesmo jeito.
    const outroArroba = 'pessoa_de_agora'
    const outra = new MetaDosArrobas(() => ({ tipo: 'arroba', username: outroArroba }))
    const terceira = await corpoDe(comToque(), cookie, { deps: comArrobas(outra) })
    expect(outra.consultados.length).toBe(3)
    expect(terceira).toContain(`@${outroArroba}`)
    expect(terceira).not.toContain(arroba)
  })

  test('ATV-09b: o arquivo da tela nao tem variavel de modulo onde um @ caberia', async () => {
    // **Um cache so de ESCRITA nao aparece em nenhuma resposta HTTP.** A
    // mutacao que motivou este teste, `const CACHE = new Map()` no topo do
    // modulo, alimentado dentro do laco de `buscarArrobas`, passa verde em
    // todos os testes de comportamento deste arquivo, porque nada nunca le esse
    // `Map`. O isolate acumula o @ de cada terceiro que comentou, indefinidamente
    // e por toda a vida do isolate, e o cabecalho de `src/index.ts` mais a
    // politica de §11.7 viram promessa falsa, com ATV-09 verde ao lado.
    //
    // A promessa de §2.3 e ESTRUTURAL ("nao entra em cache de isolate"), entao a
    // afirmacao tambem e, e ela tem tres partes, as tres formas que um
    // acumulador de modulo tem: um `Map`/`Set` declarado no topo, um `let`/`var`
    // no topo, e a MUTACAO de qualquer nome do topo (uma tabela `const` como
    // `MOTIVO_DA_FALHA` vira cache com um `[id] =` e nada no tipo reclama).
    // O mesmo recurso do Lema 1 de §10.6, que ja le `src/` como texto.
    const fontes = import.meta.glob('../src/routes/painel/*.ts', {
      query: '?raw',
      eager: true,
      import: 'default',
    }) as Record<string, string>

    const fonte = fontes['../src/routes/painel/atividade.ts']
    // Contrapositivo do proprio teste: uma varredura que nao achou o arquivo
    // afirmaria o vazio sobre o nada.
    expect(typeof fonte).toBe('string')
    expect(fonte ?? '').toContain('async function buscarArrobas(')

    /** Uma declaracao no escopo de MODULO comeca na coluna zero. */
    const DECLARACAO_DE_MODULO = /^(?:export\s+)?(const|let|var)\b[^\n]*$/gm
    // Sem `\b` no fim, e nunca `\s*\(`: `new Map<string, string>()` tem o
    // parametro de tipo no meio, e uma expressao que exigisse o parentese colado
    // deixaria passar exatamente a forma que o TypeScript escreve.
    const ACUMULADOR = /new\s+(?:Weak)?(?:Map|Set)\b/

    const declaracoes = (fonte ?? '').match(DECLARACAO_DE_MODULO) ?? []
    expect(declaracoes.length).toBeGreaterThan(5)

    expect(declaracoes.filter((linha) => ACUMULADOR.test(linha))).toEqual([])
    expect(declaracoes.filter((linha) => /^(?:export\s+)?(?:let|var)\b/.test(linha))).toEqual([])

    // A terceira parte: nenhum nome do escopo de modulo e MUTADO em lugar
    // nenhum do arquivo. Sem ela, `MOTIVO_DA_FALHA[commentId] = username` seria
    // um cache de isolate perfeito, escrito com um `const` e um `Record` que o
    // `tsc` aprova sem uma palavra.
    const nomes = declaracoes
      .map((linha) => linha.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)?.[1])
      .filter((nome): nome is string => nome !== undefined)
    expect(nomes.length).toBeGreaterThan(5)

    const mutados = nomes.filter((nome) => mutacoesDe(nome).some((r) => r.test(fonte ?? '')))
    expect(mutados).toEqual([])

    // Contrapositivo das tres regras: elas PEGAM o que dizem pegar. Sem isto,
    // uma expressao regular quebrada devolveria lista vazia para sempre.
    const mutacao = 'const CACHE_DE_ISOLATE = new Map<string, string>()\nlet ultimo = null\n'
    const pegas = mutacao.match(DECLARACAO_DE_MODULO) ?? []
    expect(pegas.filter((linha) => ACUMULADOR.test(linha)).length).toBe(1)
    expect(pegas.filter((linha) => /^(?:export\s+)?(?:let|var)\b/.test(linha)).length).toBe(1)
    const escritas = 'MOTIVO_DA_FALHA[id] = arroba\nSEM_ARROBA.set(id, arroba)\n'
    expect(mutacoesDe('MOTIVO_DA_FALHA').some((r) => r.test(escritas))).toBe(true)
    expect(mutacoesDe('SEM_ARROBA').some((r) => r.test(escritas))).toBe(true)
    expect(mutacoesDe('LINHAS_POR_PAGINA').some((r) => r.test(escritas))).toBe(false)
  })

  test('ATV-10: um @ contendo `<script>` sai escapado', async () => {
    // O username atravessa o HTML e e escapado AUTOMATICAMENTE pela tag `html`
    // (§12.6). O `@` e escrito por nos; o resto e valor de fora.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinha('c-vetor', AGORA)

    const vetor = '<script>alert(1)</script>'
    const falsa = new MetaDosArrobas(() => ({ tipo: 'arroba', username: vetor }))
    const corpo = soOCorpo(await corpoDe(comToque(), cookie, { deps: comArrobas(falsa) }))

    expect(corpo).not.toContain('<script>')
    expect(corpo).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

// ---------------------------------------------------------------------------
// O dicionario de `CommentStatus` (§12.6, §15.3 decisao 7)
// ---------------------------------------------------------------------------

/**
 * Os oito membros de `CommentStatus`, escritos a mao.
 *
 * O tipo nao existe em runtime, entao a lista precisa ser escrita, e e por
 * isso que ela e anotada como `readonly CommentStatus[]`: um membro novo no
 * enum sem entrada aqui nao quebra nada, mas o `Record<CommentStatus, …>` do
 * dicionario quebra o `tsc` primeiro, que e a trava que importa. Um membro
 * REMOVIDO do enum quebra esta lista.
 */
const TODOS_OS_STATUS: readonly CommentStatus[] = [
  'received',
  'ignored',
  'processing',
  'private_sent',
  'completed',
  'retry_pending',
  'failed',
  'uncertain',
]

describe('ATV: o dicionario de `CommentStatus`', () => {
  test('ATV-12: todo valor do enum tem frase propria, e nenhuma e a generica', () => {
    // A funcao e PURA: ela nao consulta banco, nao conhece a tela e nao muda de
    // resposta com o relogio. E o que permite afirmar o dicionario inteiro sem
    // montar oito cenarios.
    const frases = new Set<string>()

    for (const status of TODOS_OS_STATUS) {
      const traduzido = resultadoNaTela(status)
      expect({ [status]: traduzido.frase }).not.toEqual({ [status]: RESULTADO_DESCONHECIDO.frase })
      expect({ [status]: traduzido.frase.length > 0 }).toEqual({ [status]: true })
      // §12.9: icone sozinho nao e estado. Os dois vem sempre juntos.
      expect({ [status]: traduzido.icone.length > 0 }).toEqual({ [status]: true })
      frases.add(traduzido.frase)
    }

    // Oito frases DIFERENTES: uma frase repetida em dois status diria a mesma
    // coisa sobre dois desfechos diferentes, que e o que a tabela existe para
    // nao fazer.
    expect(frases.size).toBe(TODOS_OS_STATUS.length)
    expect(new Set(Object.keys(RESULTADO_DO_COMENTARIO))).toEqual(new Set(TODOS_OS_STATUS))
  })

  test('ATV-12b: um `status` que a tabela nao conhece cai na frase generica', () => {
    // A coluna e TEXT e a tela le o que estiver la. Um valor gravado por uma
    // versao futura, ou corrompido, nao pode virar o nome tecnico impresso.
    const desconhecido = resultadoNaTela('status_que_ninguem_escreveu')

    expect(desconhecido).toEqual(RESULTADO_DESCONHECIDO)
    expect(desconhecido.frase).not.toContain('status_que_ninguem_escreveu')
  })

  test('ATV-12c: nenhuma frase do dicionario de resultado escreve palavra proibida', () => {
    for (const [status, resultado] of Object.entries(RESULTADO_DO_COMENTARIO)) {
      for (const proibida of PALAVRAS_PROIBIDAS) {
        const onde = `${proibida} em ${status}`
        expect({ [onde]: contemPalavra(resultado.frase, proibida) }).toEqual({ [onde]: false })
      }
    }
  })

  test('ATV-12d: cada frase traduzida aparece na tela quando a linha tem aquele status', async () => {
    // O par que fecha o dicionario: a traducao existe E chega a tela. Os oito
    // valores sao renderizados aqui a partir de linhas escritas a mao, o que
    // este teste NAO afirma, e nao pode afirmar sem virar promessa falsa, e que
    // todos os oito acontecem em producao (§12.6, §13.1).
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    for (const [indice, status] of TODOS_OS_STATUS.entries()) {
      await gravarLinha(`c-${status}`, AGORA - indice * 1000, { status })
    }

    const corpo = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)

    for (const status of TODOS_OS_STATUS) {
      const frase = RESULTADO_DO_COMENTARIO[status].frase
      expect({ [status]: corpo.includes(frase) }).toEqual({ [status]: true })
    }
  })

  test('ATV-12e: `failed` diz o motivo em portugues, e nunca o codigo cru', async () => {
    // §12.7: detalhe tecnico vai para o `console`, nunca para a tela. Um codigo
    // que a tabela nao conhece some, a linha fica so com "Não conseguimos
    // enviar", que continua sendo verdade.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarLinha('c-conhecido', AGORA, { status: 'failed', ultimoErro: 'RATE_LIMIT' })
    await gravarLinha('c-novo', AGORA - 1000, { status: 'failed', ultimoErro: 'CODIGO_INEDITO' })

    const corpo = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)

    expect(corpo).toContain('o Instagram pediu para esperar um pouco')
    expect(corpo).not.toContain('RATE_LIMIT')
    expect(corpo).not.toContain('CODIGO_INEDITO')
    expect(corpo.match(/Não conseguimos enviar/g)?.length).toBe(2)
  })

  test('ATV-12f: `retry_pending` mostra a DATA da proxima tentativa, e nao a hora', async () => {
    // §12.6 escreve "as 14:35", e a hora nao pode ser escrita: o Worker roda em
    // UTC e o fuso da instalacao nao esta no contrato de ambiente. O docblock de
    // `dataEmPortugues` ja fixou essa decisao, e esta tela e a que ele cita.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const amanha = AGORA + 24 * 60 * 60 * 1000
    await gravarLinha('c-retry', AGORA, { status: 'retry_pending', proximaTentativaEm: amanha })

    const corpo = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)

    expect(corpo).toContain('Vamos tentar de novo')
    expect(corpo).toContain('A próxima tentativa é a partir de 15/11/2023')
    expect(corpo).not.toMatch(/\d{2}:\d{2}/)
  })
})

// ---------------------------------------------------------------------------
// O aviso obrigatorio, e o par que o sustenta (§12.6)
// ---------------------------------------------------------------------------

/** Um evento de comentario ficticio, com o que cada cenario precisar trocado. */
function evento(patch: Partial<CommentEvent> = {}): CommentEvent {
  return {
    commentId: 'comentario-ficticio-1',
    mediaId: MIDIA_DE_TESTE,
    fromId: 'igsid-de-quem-comentou',
    fromUsername: 'quem_comentou',
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
    ...patch,
  }
}

describe('ATV: a frase honesta da tela, e o que a sustenta', () => {
  test('ATV-13: a automacao nao grava linha para comentario IGNORADO', async () => {
    // Este e o par que torna a frase da tela verdadeira. Todo `skipped` de
    // `processComment` acontece ANTES do unico `INSERT` da tabela, e a decisao
    // de §12.6 e nao passar a gravar: um Reel que viraliza com 5.000
    // comentarios fora da regra custaria 5.000 escritas por nada, na cota de
    // 100.000/dia que §5.2 protege e que e COMPARTILHADA com a entrega.
    const seteDias = 8 * 24 * 60 * 60 * 1000

    const casos: readonly {
      readonly motivo: string
      readonly evento: CommentEvent
      readonly config: ProcessDeps['config']
      readonly commentCreatedAt?: number
      readonly preparar?: () => Promise<void>
    }[] = [
      {
        motivo: 'automacao_desligada',
        evento: evento(),
        config: configDeTeste({ enabled: false }),
      },
      {
        motivo: 'comentario_proprio',
        evento: evento({ fromId: IG_USER_ID }),
        config: configDeTeste(),
      },
      {
        motivo: 'resposta_a_comentario',
        evento: evento({ parentId: 'outro-comentario' }),
        config: configDeTeste(),
      },
      {
        motivo: 'midia_nao_permitida',
        evento: evento(),
        config: configDeTeste({ allowedMediaIds: ['17900000000000009'] }),
      },
      {
        motivo: 'nao_e_reel',
        evento: evento({ mediaProductType: 'FEED' }),
        config: configDeTeste(),
      },
      {
        motivo: 'sem_correspondencia',
        evento: evento({ text: 'que legal esse video' }),
        config: configDeTeste(),
      },
      {
        motivo: 'link_nao_configurado',
        evento: evento(),
        config: configDeTeste({ destinationUrl: '' }),
      },
      {
        motivo: 'fora_da_janela',
        evento: evento(),
        config: configDeTeste(),
        commentCreatedAt: AGORA - seteDias,
      },
      {
        motivo: 'ja_processado',
        evento: evento({ commentId: 'c-ja-existe' }),
        config: configDeTeste(),
        preparar: async () => await gravarLinha('c-ja-existe', AGORA - 1000),
      },
      {
        motivo: 'usuario_em_cooldown',
        evento: evento({ commentId: 'c-novo-do-mesmo' }),
        config: configDeTeste(),
        // O hash daquele autor, com uma linha recente: o portao do intervalo
        // por pessoa e uma LEITURA, e ele impede a escrita seguinte.
        preparar: async () => {
          // O hash REAL daquele autor: `processComment` compara
          // `sha256Hex(event.fromId)`, e um hash inventado aqui nao casaria,
          // o cenario cairia no caminho de entrega e o teste mediria outra coisa.
          await env.DB.prepare(
            `INSERT INTO processed_comments
               (comment_id, media_id, commenter_scoped_id_hash, status, attempt_count,
                created_at, updated_at)
             VALUES ('c-anterior', ?, ?, 'completed', 0, ?, ?)`,
          )
            .bind(
              MIDIA_DE_TESTE,
              await sha256Hex('igsid-de-quem-comentou'),
              AGORA - 1000,
              AGORA - 1000,
            )
            .run()
        },
      },
    ]

    for (const caso of casos) {
      await limparBanco(env.DB)
      await caso.preparar?.()

      const contador = new D1Contador(env.DB)
      const api = comoApi(new MetaFalsa())
      const deps: ProcessDeps = {
        api: api as MetaApiClient,
        repo: new CommentsRepository(comoD1(contador)),
        igUserId: IG_USER_ID,
        accountUsername: USERNAME_CONTA,
        config: caso.config,
        now: AGORA,
        ...(caso.commentCreatedAt === undefined ? {} : { commentCreatedAt: caso.commentCreatedAt }),
      }

      const resultado = await processComment(caso.evento, deps)

      // O caso PRECISA ter caido em `skipped`: um cenario mal montado que
      // entregasse o Direct passaria no contador de escritas do lado errado.
      expect({ [caso.motivo]: resultado.kind }).toEqual({ [caso.motivo]: 'skipped' })
      expect({ [caso.motivo]: contador.escritas }).toEqual({ [caso.motivo]: 0 })
    }

    // Contrapositivo: o caminho que NAO e ignorado grava, sem isto, um
    // `processComment` quebrado devolveria zero escritas em tudo e o laco acima
    // ficaria verde sem afirmar nada.
    await limparBanco(env.DB)
    const contador = new D1Contador(env.DB)
    const atendido = await processComment(evento(), {
      api: comoApi(new MetaFalsa()) as MetaApiClient,
      repo: new CommentsRepository(comoD1(contador)),
      igUserId: IG_USER_ID,
      accountUsername: USERNAME_CONTA,
      config: configDeTeste(),
      now: AGORA,
    })
    expect(atendido.kind).not.toBe('skipped')
    expect(contador.escritas).toBeGreaterThan(0)
  })

  test('ATV-14: o aviso de "so os atendidos aparecem" sobe SEMPRE, ate com a lista vazia', async () => {
    // Sem ela, quem abre esta tela conclui que a automacao deixou de responder
    // alguem, e a etapa entregaria menos do que §3 promete.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()

    const trechos = [
      'Sobre o que aparece aqui',
      'a automa&ccedil;&atilde;o <strong>atendeu</strong>',
      'n&atilde;o deixam registro, e por isso n&atilde;o aparecem aqui',
    ]

    // 1) Lista vazia.
    const vazia = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)
    expect(vazia).toContain('Ainda n&atilde;o h&aacute; nenhum coment')
    for (const trecho of trechos) {
      expect({ [`vazia: ${trecho}`]: vazia.includes(trecho) }).toEqual({
        [`vazia: ${trecho}`]: true,
      })
    }

    // 2) Lista cheia, com os @ buscados.
    await ligarConta(env, AGORA)
    await gravarLinhas(3)
    invalidarCacheDeConfig()
    const cheia = await corpoDe(comToque(), cookie, { deps: comArrobas(sempreArroba()) })
    for (const trecho of trechos) {
      expect({ [`cheia: ${trecho}`]: cheia.includes(trecho) }).toEqual({
        [`cheia: ${trecho}`]: true,
      })
    }
  })

  test('ATV-15: nenhuma palavra proibida do glossario aparece nesta tela', async () => {
    // A tela com tudo ligado ao mesmo tempo: os @, a faixa de degradacao, o
    // motivo de uma falha e o "Ver mais". E a combinacao que o laco de
    // `painel-telas` nunca monta, porque la a tela abre vazia.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarLinhas(LINHAS_POR_PAGINA)
    await gravarLinha('c-falhou', AGORA - 999_000, {
      status: 'failed',
      ultimoErro: 'TOKEN_INVALIDO',
    })

    const falsa = new MetaDosArrobas((id) =>
      id === 'c000' ? { tipo: 'falhou' } : { tipo: 'arroba', username: `pessoa_${id}` },
    )
    const corpo = soOCorpo(await corpoDe(comToque(), cookie, { deps: comArrobas(falsa) }))

    for (const proibida of PALAVRAS_PROIBIDAS) {
      expect({ [proibida]: contemPalavra(corpo, proibida) }).toEqual({ [proibida]: false })
    }
  })
})

// ---------------------------------------------------------------------------
// A paginacao (§12.6)
// ---------------------------------------------------------------------------

describe('ATV: "Ver mais"', () => {
  /**
   * Uma linha por DIA, da mais nova para a mais velha.
   *
   * As paginas sao distinguidas pela DATA de cada linha, e nao pelo
   * `comment_id`: **o id do comentario nao vai para a tela**, e nao pode ir. Ele
   * e o identificador de um comentario de terceiro no Instagram, e §2.3 fixa que
   * esta tela mostra o @ e o resultado, nada que sirva para procurar a pessoa
   * depois. Um teste que se apoiasse no id pediria a tela a imprimi-lo.
   */
  async function gravarUmaPorDia(quantas: number): Promise<number[]> {
    const instantes: number[] = []
    for (let i = 0; i < quantas; i++) {
      const criadoEm = AGORA - i * 24 * 60 * 60 * 1000
      instantes.push(criadoEm)
      await gravarLinha(`c${String(i).padStart(3, '0')}`, criadoEm)
    }
    return instantes
  }

  test('ATV-16: "Ver mais" leva o `created_at` da ultima linha, e a pagina seguinte continua', async () => {
    // §12.6: outra invocacao, com outro orcamento. O cursor viaja na query
    // string porque a rota e `GET` unico e nenhum caminho ganha segmento
    // variavel, o mesmo desenho de `/painel/reel?midia=`.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    const instantes = await gravarUmaPorDia(LINHAS_POR_PAGINA + 3)

    const primeira = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)
    const ultimaDaPrimeira = instantes[LINHAS_POR_PAGINA - 1] ?? 0

    expect(primeira).toContain('Ver mais')
    expect(primeira).toContain(`${CAMPO_DO_CURSOR}=${ultimaDaPrimeira}`)
    // O cursor tem DUAS metades, e a segunda e o desempate: sem ela um lote
    // gravado no mesmo milissegundo perde linha na pagina seguinte (ATV-17).
    const idDaUltima = `c${String(LINHAS_POR_PAGINA - 1).padStart(3, '0')}`
    expect(primeira).toContain(`${CAMPO_DO_DESEMPATE}=${idDaUltima}`)
    expect(primeira).toContain(dataEmPortugues(instantes[0] ?? 0))
    expect(primeira).not.toContain(dataEmPortugues(instantes[LINHAS_POR_PAGINA] ?? 0))
    expect(quantasLinhas(primeira)).toBe(LINHAS_POR_PAGINA)

    // A pagina seguinte e a que o LINK da tela abre, e nao uma query string
    // montada aqui: e o toque da pessoa que precisa levar ao lugar certo.
    const segunda = await corpoDe(hrefDaAcao(primeira, 'Ver mais'), cookie)
    expect(segunda).toContain(dataEmPortugues(instantes[LINHAS_POR_PAGINA] ?? 0))
    expect(segunda).toContain(dataEmPortugues(instantes[LINHAS_POR_PAGINA + 2] ?? 0))
    expect(segunda).not.toContain(dataEmPortugues(instantes[0] ?? 0))
    expect(quantasLinhas(segunda)).toBe(3)
    // A segunda pagina veio com 3 linhas: nao ha "Ver mais" nela.
    expect(segunda).not.toContain('Ver mais')
    // E o botao que busca os @ CARREGA o cursor inteiro: sem ele, tocar em "Ver
    // quem comentou" na pagina 2 devolveria a pagina 1, e a pessoa perderia o
    // lugar. Com meio cursor, a rota recusaria (ATV-17c).
    expect(segunda).toContain(`${CAMPO_DO_CURSOR}=${ultimaDaPrimeira}&amp;${CAMPO_DO_DESEMPATE}=`)
    expect(segunda).toContain(`&amp;acao=${ATUALIZAR}`)
  })

  test('ATV-16b: uma pagina que nao encheu nao oferece "Ver mais"', async () => {
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarUmaPorDia(2)

    const corpo = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)
    expect((corpo.match(/class="linha-de-ajuste"/g) ?? []).length).toBe(2)
    expect(corpo).not.toContain('Ver mais')
    expect(corpo).not.toContain(`${CAMPO_DO_CURSOR}=`)
  })

  test('ATV-16c: um cursor que nao presta e RECUSADO, e nunca consertado', async () => {
    // §9.2: um valor que nao casa e cliente adulterado ou endereco truncado, e
    // consertar em silencio mostraria uma pagina que a pessoa nao pediu.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarLinhas(2)

    for (const cursor of ['abacaxi', '-1', '1e9', "1' OR '1'='1", '99999999999999999999']) {
      const resposta = await abrir(
        `${ROTA_ATIVIDADE.caminho}?${CAMPO_DO_CURSOR}=${encodeURIComponent(cursor)}`,
        cookie,
      )
      expect({ [cursor]: resposta.status }).toEqual({ [cursor]: 400 })
      const corpo = await resposta.text()
      // §11.4: a tela mostra a frase da tabela, e nunca o codigo nem o valor.
      expect({ [cursor]: corpo.includes('Confira os campos destacados.') }).toEqual({
        [cursor]: true,
      })
      expect({ [cursor]: corpo.includes('cursor_invalido') }).toEqual({ [cursor]: false })
    }
  })

  /**
   * N linhas gravadas no MESMO milissegundo, o lote do webhook.
   *
   * Nao e um cenario inventado para o teste: `src/index.ts` calcula
   * `const now = Date.now()` UMA vez por invocacao e passa esse mesmo valor a
   * todo `claimComment` do laco, e `deferForRetry` liga o mesmo `now` ao
   * `created_at` de TODAS as linhas do `db.batch()`. Um Reel que viraliza grava
   * dezenas de linhas com `created_at` identico ao milissegundo.
   */
  async function gravarNoMesmoInstante(quantas: number, instante: number): Promise<void> {
    for (let i = 0; i < quantas; i++) {
      await gravarLinha(`t${String(i).padStart(3, '0')}`, instante)
    }
  }

  test('ATV-17: um lote inteiro no MESMO `created_at` nao perde linha no "Ver mais"', async () => {
    // O defeito que este teste prende: com o cursor sendo so o `created_at` e a
    // consulta usando `created_at < ?`, TODA linha que empatasse com a ultima da
    // pagina ficava estritamente fora da pagina seguinte, e sumia da unica tela
    // que existe para dizer o que aconteceu. Trinta comentarios atendidos, vinte
    // na pagina 1, e os dez restantes invisiveis para sempre, sem aviso nenhum.
    // §12.6 e literal: "nunca sumir com a linha".
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarNoMesmoInstante(LINHAS_POR_PAGINA + 10, AGORA)

    const pagina1 = await corpoDe(comToque(), cookie, { deps: comArrobas(sempreArroba()) })
    expect(quantasLinhas(pagina1)).toBe(LINHAS_POR_PAGINA)

    // A pessoa toca em "Ver mais", e depois em "Ver quem comentou": os dois
    // links sao os que a tela desenhou.
    const pagina2 = await corpoDe(hrefDaAcao(pagina1, 'Ver mais'), cookie)
    const comOsArrobas = await corpoDe(hrefDaAcao(pagina2, 'Ver quem comentou'), cookie, {
      deps: comArrobas(sempreArroba()),
    })

    expect(quantasLinhas(comOsArrobas)).toBe(10)
    // As duas paginas juntas mostram as TRINTA linhas, cada uma uma vez: nem
    // uma sumiu, nem uma apareceu duas vezes.
    const vistas = [...arrobasDe(pagina1), ...arrobasDe(comOsArrobas)]
    expect(vistas.length).toBe(LINHAS_POR_PAGINA + 10)
    expect(new Set(vistas).size).toBe(LINHAS_POR_PAGINA + 10)
    // A pagina 2 nao encheu: nao ha uma terceira.
    expect(comOsArrobas).not.toContain('Ver mais')
  })

  test('ATV-17b: um empate que ATRAVESSA a fronteira da pagina continua na seguinte', async () => {
    // O caso misto, que e o comum: parte do lote empatado cabe na pagina 1, o
    // resto tem de abrir a pagina 2 junto com as linhas mais antigas. Com o
    // cursor sem desempate a pagina 2 pulava direto para o lote anterior e as
    // cinco linhas restantes do empate desapareciam entre as duas.
    await gravarConfig(env.DB)
    await ligarConta(env, AGORA)
    const cookie = await abrirSessao()
    await gravarNoMesmoInstante(LINHAS_POR_PAGINA + 5, AGORA)
    const antigas = 8
    for (let i = 0; i < antigas; i++) await gravarLinha(`v${i}`, AGORA - 1000)

    const pagina1 = await corpoDe(comToque(), cookie, { deps: comArrobas(sempreArroba()) })
    expect(quantasLinhas(pagina1)).toBe(LINHAS_POR_PAGINA)

    const pagina2 = await corpoDe(hrefDaAcao(pagina1, 'Ver mais'), cookie)
    const comOsArrobas = await corpoDe(hrefDaAcao(pagina2, 'Ver quem comentou'), cookie, {
      deps: comArrobas(sempreArroba()),
    })

    // 5 do empate que nao coube + as 8 antigas.
    expect(quantasLinhas(comOsArrobas)).toBe(5 + antigas)
    const vistas = [...arrobasDe(pagina1), ...arrobasDe(comOsArrobas)]
    expect(new Set(vistas).size).toBe(LINHAS_POR_PAGINA + 5 + antigas)
  })

  test('ATV-17c: o cursor viaja INTEIRO, e uma metade sozinha e recusada', async () => {
    // §9.2: um cursor pela metade e cliente adulterado ou endereco truncado. As
    // duas metades identificam UMA linha; sozinha, a primeira volta a ser o
    // cursor sem desempate que este conjunto acabou de proibir, e consertar em
    // silencio mostraria de novo a pagina que pula linhas.
    await gravarConfig(env.DB)
    const cookie = await abrirSessao()
    await gravarNoMesmoInstante(LINHAS_POR_PAGINA + 1, AGORA)

    const pagina1 = await corpoDe(ROTA_ATIVIDADE.caminho, cookie)
    const inteiro = hrefDaAcao(pagina1, 'Ver mais')
    expect(inteiro).toContain(`${CAMPO_DO_CURSOR}=${AGORA}`)
    expect(inteiro).toContain(`${CAMPO_DO_DESEMPATE}=`)

    const metades = [
      `${ROTA_ATIVIDADE.caminho}?${CAMPO_DO_CURSOR}=${AGORA}`,
      `${ROTA_ATIVIDADE.caminho}?${CAMPO_DO_DESEMPATE}=t000`,
      `${ROTA_ATIVIDADE.caminho}?${CAMPO_DO_CURSOR}=${AGORA}&${CAMPO_DO_DESEMPATE}=nao%20presta!`,
    ]
    for (const meio of metades) {
      const resposta = await abrir(meio, cookie)
      expect({ [meio]: resposta.status }).toEqual({ [meio]: 400 })
    }

    // Contrapositivo: o cursor inteiro, o que a tela desenhou, abre a pagina.
    const seguinte = await abrir(inteiro, cookie)
    expect(seguinte.status).toBe(200)
  })
})
