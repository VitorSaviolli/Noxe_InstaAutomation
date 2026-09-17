import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { PainelAuditoriaRepository } from '../src/repositories/painel-auditoria-repository'
import { escapeHtml } from '../src/routes/legal'
import { handleAjustes, RESTAURAR } from '../src/routes/painel/ajustes'
import { handleAparelhos } from '../src/routes/painel/aparelhos'
import { CAMPO_DA_CONFIRMACAO } from '../src/routes/painel/campos'
import {
  CONFIRMACOES,
  fraseDeConfirmacao,
  MOTIVO_DA_RECUSA,
  NOME_DO_CAMPO,
  PALAVRAS_PROIBIDAS,
  RECUSA_SEM_VALOR,
} from '../src/routes/painel/dicionario'
import { CAMPOS_DA_RESTAURACAO, CAMPOS_DE_COMPORTAMENTO } from '../src/routes/painel/formulario'
import { codigoDaRecusaDeValidacao } from '../src/routes/painel/gravar'
import { handleSair } from '../src/routes/painel/guardas'
import { handleChave, handleInicio } from '../src/routes/painel/inicio'
import { handleMensagem } from '../src/routes/painel/mensagem'
import { esquecerAListagem } from '../src/routes/painel/midias'
import { handlePalavras } from '../src/routes/painel/palavras'
import { handleReel } from '../src/routes/painel/reel'
import { handleReels } from '../src/routes/painel/reels'
import { erro } from '../src/routes/painel/resposta'
import {
  ROTA_AJUSTES,
  ROTA_APARELHOS,
  ROTA_CHAVE,
  ROTA_INICIO,
  ROTA_MENSAGEM,
  ROTA_PALAVRAS,
  ROTA_REEL,
  ROTA_REELS,
  ROTA_SAIR,
  ROTAS,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../src/services/config-store'
import { emitirSessao, fichaCsrf, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import { prefixoDeCredencial } from '../src/services/webauthn/verificar'
import {
  gravarConfig,
  gravarMidia,
  LINHA_DE_CONFIG_VALIDA,
  ligarConta,
  limparBanco,
} from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  contemPalavra,
  D1Contador,
  D1SegundoBatchQuebrado,
  pedir,
  RAIZ,
} from './fixtures/dubles'

/**
 * AUD · GRAV, a escrita dos campos de risco baixo e a auditoria de §9.9.
 *
 * As rotas sao chamadas por `despachar`, a MESMA funcao que o roteador usa: um
 * teste que chamasse o handler direto pularia a escada de §11.3, origem,
 * `content-type`, teto de corpo, sessao e ficha, e afirmaria menos do que
 * parece.
 *
 * **Um ID por garantia.** AUD-01 a AUD-05 sao as cinco de §13.2; AUD-06 e
 * AUD-07 sao as duas metades de §10.10 sobre a chave liga/desliga. GRAV cobre a
 * forma de §7.1, a atomicidade de §8.8 e a classificacao de risco de §10.10.
 *
 * **AUD-04 tem um vizinho declarado.** A mecanica da poda, quanto ela le,
 * quanto ela escreve, e que ela entra no cron, mora em `painel-parada.test.ts`,
 * no bloco "AUDITORIA". O que se afirma AQUI e outra coisa: que a linha que a
 * gravacao do painel acabou de escrever esta sujeita ao mesmo teto, e que quem
 * sai e a mais antiga.
 *
 * **Nenhum valor da instalacao do dono entra neste arquivo.** Palavra-gatilho,
 * link e dominio sao ficticios, pelo mesmo motivo que `configDeTeste` existe:
 * este repositorio e um template publico, e um teste preso ao valor de quem o
 * escreveu fica vermelho na maquina de todo mundo que o instala.
 */

/** Palavra FICTICIA. Nunca a da instalacao de quem escreveu o teste. */
const PALAVRA_NOVA = 'quero o cardapio'

/** Dominio FICTICIO, e o mesmo que a linha de config de teste usa. */
const DOMINIO_DE_TESTE = 'exemplo.com'

/**
 * O ambiente com a allowlist CONFIGURADA, para os tres testes que gravam link.
 *
 * O `env` do `vitest.config.ts` traz `ALLOWED_LINK_DOMAINS: ''`, e lista vazia
 * nao "passa tudo": ela recusa qualquer mudanca de endereco (§9.8, §12.7,
 * LNK-12). Ate a etapa 12b isso passava despercebido nesta suite porque o
 * step-up respondia PRIMEIRO, os tres testes que mexem no link recebiam
 * `stepup_recusado` e nunca chegavam ao validador. Quer dizer: eles ofereciam a
 * cerimonia para uma gravacao que a allowlist deste ambiente jamais aceitaria,
 * que e a patologia do Ruling 73 dentro do proprio teste que a mede.
 *
 * Com a ordem de §9.7 no lugar, a lista precisa existir para que a operacao
 * seja de verdade possivel e a recusa medida seja mesmo a do step-up. Esta
 * constante e o que separa "o teste afirma o que o titulo diz" de "o teste
 * ficou verde".
 */
const COM_ALLOWLIST = { ...env, ALLOWED_LINK_DOMAINS: DOMINIO_DE_TESTE } as unknown as typeof env

const FORMULARIO = 'application/x-www-form-urlencoded'

/**
 * O `antes` que a auditoria guardaria para a linha de config do fixture.
 *
 * DERIVADO de `LINHA_DE_CONFIG_VALIDA`, campo a campo, e nao copiado: um objeto
 * escrito a mao aqui divergiria da linha no dia em que ela mudasse, e o botao
 * "Voltar a esta versao" some sem alarde quando o `antes` guardado difere do
 * estado de hoje em campo que ninguem grava (§12.4, R-6), o teste ficaria
 * verde afirmando uma tela sem botao.
 */
const ESTADO_GUARDADO_DA_LINHA_VALIDA: Record<string, unknown> = {
  enabled: LINHA_DE_CONFIG_VALIDA.enabled === 1,
  triggerKeywords: JSON.parse(LINHA_DE_CONFIG_VALIDA.trigger_keywords) as string[],
  matchMode: LINHA_DE_CONFIG_VALIDA.match_mode,
  caseSensitive: LINHA_DE_CONFIG_VALIDA.case_sensitive === 1,
  normalizeAccents: LINHA_DE_CONFIG_VALIDA.normalize_accents === 1,
  ignorePunctuation: LINHA_DE_CONFIG_VALIDA.ignore_punctuation === 1,
  processOnlyReels: LINHA_DE_CONFIG_VALIDA.process_only_reels === 1,
  // `mediaScope` e DERIVADO de `allowedMediaIds` (§9.4): `todas` no fixture
  // porque a lista de ids fica em `["*"]`.
  mediaScope: LINHA_DE_CONFIG_VALIDA.media_scope,
  publicReplyEnabled: LINHA_DE_CONFIG_VALIDA.public_reply_enabled === 1,
  publicReplyText: LINHA_DE_CONFIG_VALIDA.public_reply_text,
  privateReplyEnabled: LINHA_DE_CONFIG_VALIDA.private_reply_enabled === 1,
  privateReplyText: LINHA_DE_CONFIG_VALIDA.private_reply_text,
  destinationUrl: LINHA_DE_CONFIG_VALIDA.destination_url,
  userCooldownHours: LINHA_DE_CONFIG_VALIDA.user_cooldown_hours,
}

/**
 * O campo do corpo que declara QUAL operacao aquele POST e (§7.1).
 *
 * `ligar`/`desligar` em `/painel/chave`, `restaurar` em `/painel/ajustes`. O
 * nome e estrutural, nunca um campo de configuracao, e por isso entra em
 * `estruturais` de cada rota, e nao em `CAMPOS_DE_COMPORTAMENTO`.
 */
const CAMPO_DA_ACAO = 'acao'

interface Sessao {
  readonly cookie: string
  readonly ficha: string
  readonly credencial: string
}

/** Uma sessao viva de verdade: cookie assinado E linha em `painel_sessoes`. */
async function abrirSessao(credencial = 'credencial-de-teste'): Promise<Sessao> {
  const emitida = await emitirSessao(env, AGORA)
  await env.DB.prepare(
    `INSERT INTO painel_sessoes
       (sid_hash, credential_id, rp_id, criada_em, expira_em, ociosa_ate, vista_em, falhas_stepup)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(
      emitida.sidHash,
      credencial,
      env.PANEL_RP_ID,
      AGORA,
      emitida.expiraEm,
      AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
      AGORA,
    )
    .run()

  return {
    cookie: `__Host-painel_sessao=${emitida.valor}`,
    ficha: await fichaCsrf(env, emitida.sidHash),
    credencial,
  }
}

/**
 * A rota e o handler de cada uma das que gravam.
 *
 * `/painel/mensagem` entrou na etapa do step-up, que e quando ela passou a ter
 * `POST`. Ela vai no FIM, e nao na ordem de `ROTAS`, para nao mexer nos indices
 * que o resto desta suite ja usa; GRAV-01 compara os dois conjuntos ordenados.
 */
const GRAVADORAS: readonly { rota: RotaDoPainel; handler: HandlerDoPainel }[] = [
  { rota: ROTA_CHAVE, handler: handleChave },
  { rota: ROTA_PALAVRAS, handler: handlePalavras },
  { rota: ROTA_AJUSTES, handler: handleAjustes },
  { rota: ROTA_MENSAGEM, handler: handleMensagem },
  // **As duas telas de Reels entraram na Etapa 12**, e elas entram no FIM pela
  // mesma razao que `/painel/mensagem`: os indices que o resto desta suite ja
  // usa nao podem andar. GRAV-01 compara os dois conjuntos ordenados, entao a
  // ordem daqui nao afrouxa a conferencia, e e ele quem obriga toda rota nova
  // de pagina que grava a aparecer nesta lista.
  { rota: ROTA_REELS, handler: handleReels },
  { rota: ROTA_REEL, handler: handleReel },
  // **`/painel/aparelhos` entrou na Etapa 13**, e ela entra aqui pela regra que
  // o comentario acima ja escrevia: GRAV-01 compara os dois conjuntos
  // ordenados, entao toda rota nova de PAGINA que grava e obrigada a aparecer
  // nesta lista. Ela e a primeira gravadora que NAO grava configuracao
  // (`gravaConfig: false`, e o nome dela esta na lista `SEM_CONFIGURACAO` do
  // META-15 desde antes de existir): o que ela grava e quem entra.
  { rota: ROTA_APARELHOS, handler: handleAparelhos },
  // **`POST /painel/sair` entrou na rodada de revisao da Etapa 13**, pela mesma
  // regra: §7.1 sempre a declarou, o handler nasceu agora, e o conjunto
  // ordenado logo abaixo obriga toda rota de PAGINA que grava a aparecer aqui.
  // Ela e a segunda gravadora sem configuracao, o que ela grava e o `DELETE`
  // da propria linha de sessao, com a auditoria no mesmo lote.
  { rota: ROTA_SAIR, handler: handleSair },
]

/** O Reel FICTICIO das duas telas novas. Dezoito digitos, como os de verdade. */
const REEL_DE_TESTE = '178414000000000001'

/** O link da linha GLOBAL, e o link PRIVADO de um Reel. Os dois ficticios. */
const LINK_GLOBAL = 'https://exemplo.com/de-todos'
const LINK_SO_DESTE_REEL = 'https://exemplo.com/so-deste-reel'

/**
 * Um corpo valido para cada rota que grava, para os lacos da tabela.
 *
 * O de `/painel/mensagem` e VAZIO de proposito: os tres campos daquela tela
 * exigem step-up sempre, entao o unico `303` que ela produz sem digital e o
 * `?ok=sem_mudanca` de um reenvio que nao muda nada, que e exatamente a regra
 * de forma que GRAV-01 afirma. As duas metades do step-up dela vivem em
 * `tests/painel-stepup.test.ts`.
 */
const CORPO_VALIDO: Record<string, string> = {
  [ROTA_CHAVE.caminho]: 'acao=desligar',
  [ROTA_PALAVRAS.caminho]: `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
  [ROTA_AJUSTES.caminho]: 'userCooldownHours=48',
  [ROTA_MENSAGEM.caminho]: '',
  // O de `/painel/reels` e VAZIO pela razao gemea da mensagem: sem nenhum Reel
  // marcado e sem escopo novo, o unico `303` que ela produz e o
  // `?ok=sem_mudanca`, que e exatamente a regra de forma que GRAV-01 afirma, e
  // ele nao gasta nenhuma chamada a Meta. A metade que grava de verdade vive em
  // `tests/painel-midias.test.ts`, que e a suite dona do assunto (§13.1).
  [ROTA_REELS.caminho]: '',
  [ROTA_REEL.caminho]: `acao=pausar&midia=${REEL_DE_TESTE}`,
  // A UNICA das tres acoes de `/painel/aparelhos` que nao pede step-up, e a
  // escolha e a propria garantia de §10.13: "sair de todos os aparelhos" e a
  // direcao segura, e um `303` sem digital nenhuma e o que ela promete. As duas
  // protegidas (`remover_passkey` e `gerar_codigos`) vivem em
  // `tests/painel-recuperacao.test.ts`, que e a suite dona do assunto (§13.1).
  [ROTA_APARELHOS.caminho]: 'acao=sair_de_tudo',
  // Vazio, e nao por economia: `POST /painel/sair` nao tem campo nenhum alem
  // da ficha CSRF (§10.13). Quem ela apaga e a sessao do cookie que veio, e um
  // identificador no corpo seria um jeito de mandar embora a sessao de outro.
  [ROTA_SAIR.caminho]: '',
}

function postar(
  caminho: string,
  corpo: string,
  sessao: Sessao,
  cabecalhos: Record<string, string> = {},
): Request {
  return new Request(`${RAIZ}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie, ...cabecalhos },
    body: corpo,
  })
}

/** Um POST completo, ficha, versao e o corpo da rota, pela escada de §11.3. */
async function gravar(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  campos: string,
  sessao: Sessao,
  opcoes: { versao?: number; ambiente?: typeof env } = {},
): Promise<Response> {
  const versao = opcoes.versao ?? 1
  const corpo = `csrf=${sessao.ficha}&versao=${versao}${campos === '' ? '' : `&${campos}`}`

  return await despachar(
    postar(alvo.rota.caminho, corpo, sessao),
    (opcoes.ambiente ?? env) as typeof env,
    AGORA,
    alvo.rota,
    alvo.handler,
  )
}

interface LinhaDeAuditoria {
  ocorrido_em: number
  versao: number
  origem: string
  ator: string
  step_up: number
  acao: string
  alvo: string | null
  campos: string
  antes: string | null
  depois: string | null
}

async function auditoria(): Promise<LinhaDeAuditoria[]> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM painel_auditoria ORDER BY id',
  ).all<LinhaDeAuditoria>()
  return results ?? []
}

async function unicaLinha(): Promise<LinhaDeAuditoria> {
  const linhas = await auditoria()
  expect(linhas.length).toBe(1)
  return linhas[0] as LinhaDeAuditoria
}

async function linhaDeConfig(): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('SELECT * FROM painel_config WHERE id = 1').first<
    Record<string, unknown>
  >()
}

/**
 * D1 que grava POR CIMA entre a leitura da versao e o lote da rota.
 *
 * Duble local injetado por parametro, como todo duble deste projeto. Ele existe
 * para produzir o unico caso que a trava otimista de §8.8 cobre e que nenhum
 * teste consegue provocar de fora: a corrida entre `carregarConfigEfetiva` e o
 * `db.batch()` da gravacao.
 */
class D1QueCorreNaFrente {
  private lotes = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.real.prepare(sql)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.lotes++
    // O primeiro lote e a LEITURA da configuracao; o segundo e a gravacao. A
    // versao anda entre os dois, que e exatamente a janela da corrida.
    if (this.lotes === 2) {
      await this.real.prepare('UPDATE painel_config SET versao = versao + 1 WHERE id = 1').run()
    }
    return await this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

/**
 * O primeiro `<form method="post">` da pagina, ja lido em campos.
 *
 * Existe para o unico teste que fecha o elo entre a tela e o funil: todos os
 * outros montam o corpo a mao, e um campo escondido apagado do formulario
 * passaria despercebido por todos eles.
 *
 * A extracao e boba de proposito, os formularios do painel nao tem `<select>`,
 * nem `textarea` fora do de palavras, nem campo repetido. Um parser esperto aqui
 * seria uma segunda implementacao de navegador para manter.
 */
function primeiroFormularioDeGravacao(corpo: string): {
  action: string
  campos: URLSearchParams
} {
  const pedaco = corpo.split('<form').find((parte) => parte.includes('method="post"')) ?? ''
  const action = /action="([^"]*)"/.exec(pedaco)?.[1] ?? ''
  const campos = new URLSearchParams()

  for (const [, nome, valor] of pedaco.matchAll(/name="([a-zA-Z]+)" value="([^"]*)"/g)) {
    campos.set(nome ?? '', desescapar(valor ?? ''))
  }

  // O que o navegador manda de um `<textarea>` e o conteudo dele.
  const area = /<textarea[^>]*name="([a-zA-Z]+)"[^>]*>([\s\S]*?)<\/textarea>/.exec(pedaco)
  if (area !== null) campos.set(area[1] ?? '', desescapar(area[2] ?? ''))

  // E de um grupo de radios, o valor do que estiver marcado.
  for (const [, nome, valor] of pedaco.matchAll(/name="([a-zA-Z]+)" value="([^"]*)" checked/g)) {
    campos.set(nome ?? '', valor ?? '')
  }

  // E de um `<input type="number">`, o `value` dele.
  const numero = /<input type="number"[^>]*name="([a-zA-Z]+)"[^>]*\nvalue="([^"]*)"/.exec(pedaco)
  if (numero !== null) campos.set(numero[1] ?? '', numero[2] ?? '')

  return { action, campos }
}

/** A tela de Ajustes, ja lida, com a sessao viva. */
async function telaDeAjustes(sessao: Sessao): Promise<string> {
  return await (
    await despachar(
      pedir(ROTA_AJUSTES.caminho, { cookie: sessao.cookie }),
      env,
      AGORA,
      ROTA_AJUSTES,
      handleAjustes,
    )
  ).text()
}

/**
 * O corpo que o botao "Voltar a esta versao" enviaria, extraido da tela.
 *
 * O recorte e o formulario DO BOTAO, e nao a pagina toda: o formulario de cima
 * usa os mesmos nomes de campo, e uma extracao solta juntaria os dois. A
 * `versao` e a ficha entram por `gravar`, como em qualquer outro POST.
 *
 * **O botao passou a declarar a operacao, e a contagem passou de catorze para
 * onze** (Ruling 74). A restauracao e `acao=restaurar`, como `acao=ligar|
 * desligar` de §7.1, e o escopo dela e a UNIAO gravavel, os onze de
 * `CAMPOS_DA_RESTAURACAO`. Os tres que sobram (`mediaScope` e os dois
 * interruptores de canal) nao sao escritos por rota nenhuma nesta etapa: manda-
 * los faria a gravacao ser recusada justamente por eles. Quem confere que os
 * onze mais os tres dao os catorze e META-11.
 */
function camposDoBotaoDeVoltar(corpo: string): string {
  const doBotao = corpo.split('<form').find((pedaco) => pedaco.includes('Voltar a esta vers'))
  expect(doBotao).toBeDefined()

  const enviaveis = [...CAMPOS_DA_RESTAURACAO, CAMPO_DA_ACAO] as readonly string[]
  const escondidos = [...(doBotao ?? '').matchAll(/name="([a-zA-Z]+)" value="([^"]*)"/g)]
    .filter(([, nome]) => enviaveis.includes(nome ?? ''))
    .map(([, nome, valor]) => `${nome}=${encodeURIComponent(desescapar(valor ?? ''))}`)

  // O `antes` e reenviado INTEIRO: um campo a menos significaria "nao mexe
  // nisso", e a restauracao ficaria pela metade sem ninguem perceber. O `+ 1` e
  // o proprio `acao=restaurar`, sem o qual a rota escreveria com o escopo do
  // formulario de Ajustes e recusaria os campos das outras telas.
  expect(escondidos.length).toBe(CAMPOS_DA_RESTAURACAO.length + 1)
  expect(escondidos).toContain(`${CAMPO_DA_ACAO}=${RESTAURAR}`)
  return escondidos.join('&')
}

/** O que o navegador faz com o valor de um atributo antes de enviar de volta. */
function desescapar(valor: string): string {
  return valor
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * Os campos escondidos do `<form id="confirmar">` que o servidor renderizou.
 *
 * O recorte e o FORMULARIO, e nao a pagina: a tela de conferencia e servida
 * dentro da mesma pagina que ja tinha formularios, e uma extracao solta juntaria
 * os campos dos dois. Se o bloco nao existir, isto estoura, uma leitura vazia
 * faria toda afirmacao de ausencia passar sem ter olhado nada.
 */
function escondidosDaConferencia(corpo: string): URLSearchParams {
  const bloco = /<form method="post" action="([^"]*)" id="confirmar"[\s\S]*?<\/form>/.exec(corpo)
  if (bloco === null) throw new Error('a tela de conferencia nao trouxe o formulario')

  const campos = new URLSearchParams()
  for (const [, nome, valor] of (bloco[0] as string).matchAll(
    /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
  )) {
    campos.set(desescapar(nome ?? ''), desescapar(valor ?? ''))
  }
  return campos
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
// AUD, a auditoria de §9.9 e §13.2
// ---------------------------------------------------------------------------

describe('AUD: a auditoria da gravacao', () => {
  test('AUD-01: toda gravacao registra data, credencial usada e campos alterados', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-do-dono')

    await gravar(GRAVADORAS[1] as (typeof GRAVADORAS)[number], 'triggerKeywords=um%0Adois', sessao)

    const linha = await unicaLinha()
    expect({
      ocorrido_em: linha.ocorrido_em,
      versao: linha.versao,
      origem: linha.origem,
      acao: linha.acao,
      step_up: linha.step_up,
      alvo: linha.alvo,
      campos: linha.campos,
    }).toEqual({
      ocorrido_em: AGORA,
      // A versao RESULTANTE (§8.8, terceira funcao da versao).
      versao: 2,
      origem: 'painel',
      acao: 'config_alterada',
      step_up: 0,
      alvo: null,
      campos: '["triggerKeywords"]',
    })

    // A CREDENCIAL usada, e nunca o `credential_id` cru: 8 hex do sha256 dele.
    expect(linha.ator).toBe(`passkey:${await prefixoDeCredencial('credencial-do-dono')}`)
  })

  test('AUD-02: o registro nao guarda cookie, credencial inteira, IP nem User-Agent', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-longa-do-dono')

    await despachar(
      postar(
        ROTA_PALAVRAS.caminho,
        `csrf=${sessao.ficha}&versao=1&triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
        { 'user-agent': 'Mozilla/5.0 (Teste)', 'cf-connecting-ip': '203.0.113.7' },
      ),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )

    const inteira = JSON.stringify(await unicaLinha())

    for (const proibido of [
      'credencial-longa-do-dono',
      sessao.cookie,
      sessao.ficha,
      'Mozilla/5.0 (Teste)',
      '203.0.113.7',
    ]) {
      expect({ [proibido.slice(0, 24)]: inteira.includes(proibido) }).toEqual({
        [proibido.slice(0, 24)]: false,
      })
    }

    // Contrapositivo: o prefixo de 8 hex ESTA la, sem ele o teste passaria com
    // uma linha vazia, que nao prova nada sobre o que ela nao guarda.
    expect(inteira).toContain(await prefixoDeCredencial('credencial-longa-do-dono'))
  })

  test('AUD-03: tentativa recusada tambem registra, com antes = depois = NULL', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    // Baixar o intervalo ALARGA o alcance, e alargar exige step-up (§10.10).
    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=1',
      sessao,
    )

    expect(resposta.status).toBe(403)

    const linha = await unicaLinha()
    expect({
      acao: linha.acao,
      antes: linha.antes,
      depois: linha.depois,
      campos: linha.campos,
      versao: linha.versao,
    }).toEqual({
      acao: 'stepup_recusado',
      antes: null,
      depois: null,
      campos: '["userCooldownHours"]',
      // A versao continua a mesma: nada mudou.
      versao: 1,
    })

    // E a configuracao nao andou.
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(24)
  })

  test('AUD-04: o teto de 500 alcanca a linha que a gravacao acabou de escrever', async () => {
    // A mecanica da poda mora em `painel-parada.test.ts`. O que se afirma aqui e
    // que a linha do painel entra no MESMO teto, e que quem sai e a mais antiga.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    for (let inicio = 0; inicio < 500; inicio += 100) {
      await env.DB.batch(
        Array.from({ length: 100 }, (_, i) =>
          env.DB.prepare(
            `INSERT INTO painel_auditoria
               (id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
             VALUES (?, ?, 1, 'painel', 'migracao', 0, 'login', NULL, '[]', NULL, NULL)`,
          ).bind(inicio + i + 1, AGORA),
        ),
      )
    }

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    expect(await new PainelAuditoriaRepository(env.DB).podar()).toBe(1)

    const restantes = await env.DB.prepare(
      "SELECT COUNT(*) AS total, MIN(id) AS menor, SUM(acao = 'config_alterada') AS mudancas FROM painel_auditoria",
    ).first<{ total: number; menor: number; mudancas: number }>()

    expect(restantes).toEqual({ total: 500, menor: 2, mudancas: 1 })
  })

  test('AUD-05: NENHUM valor de configuracao vai para o console, nem gravando nem recusando', async () => {
    // §9.9: os dois destinos tem regras OPOSTAS. O D1 do dono guarda o estado
    // completo em `antes`/`depois`; o `console` recebe metodo, caminho, status e
    // codigo, nenhum valor, nunca.
    await gravarConfig(env.DB, { destination_url: `https://${DOMINIO_DE_TESTE}/pagina-secreta` })
    const sessao = await abrirSessao()

    const registrado = capturarConsole()
    try {
      await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
      )
      // E o caminho de recusa, que e onde a tentacao de logar o valor e maior.
      await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/outra`)}`,
        sessao,
        { versao: 2 },
      )
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    for (const valor of [
      PALAVRA_NOVA,
      'pagina-secreta',
      DOMINIO_DE_TESTE,
      'eu quero',
      'quero o link',
    ]) {
      expect({ [valor]: tudo.includes(valor) }).toEqual({ [valor]: false })
    }

    // Contrapositivo: o D1 guardou os mesmos valores que o console nao pode ter.
    const linhas = await auditoria()
    expect(JSON.stringify(linhas)).toContain(PALAVRA_NOVA)
  })

  test('AUD-08: a linha de uma recusa carrega os SEIS campos de §9.9, nao so a acao', async () => {
    // AUD-01 afirma origem, ator, step_up e alvo no caminho de sucesso; o
    // caminho de RECUSA ficava com quatro deles descobertos, e trocar
    // `origem: painel` por `assistente` passava na suite inteira.
    //
    // **O veiculo mudou de `/painel/ajustes` para `/painel/mensagem`, e a
    // expectativa continua a mesma** (Ruling 74). A recusa que este teste mede e
    // a de STEP-UP, `stepup_recusado`; depois que o link saiu do escopo de
    // Ajustes, aquela rota passa a recusar por ESCOPO, `mudanca_recusada`,
    // outra linha, outro caminho, e o teste mediria a recusa errada. O link e
    // de `/painel/mensagem`, que e quem o declara, e la a recusa e a de sempre.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao('credencial-da-recusa')

    // **O ambiente traz a allowlist, e isso e da etapa 12b.** A recusa que este
    // teste mede e a de STEP-UP; sem a lista, a ordem de §9.7 faz o validador
    // responder antes com `mudanca_recusada`, e com razao, porque um link que
    // a allowlist nao permite nao tinha o que confirmar.
    await gravar(
      GRAVADORAS[3] as (typeof GRAVADORAS)[number],
      `destinationUrl=${encodeURIComponent(`https://${DOMINIO_DE_TESTE}/outro`)}`,
      sessao,
      { ambiente: COM_ALLOWLIST },
    )

    const linha = await unicaLinha()
    expect({
      ocorrido_em: linha.ocorrido_em,
      versao: linha.versao,
      origem: linha.origem,
      ator: linha.ator,
      step_up: linha.step_up,
      acao: linha.acao,
      alvo: linha.alvo,
      campos: linha.campos,
      antes: linha.antes,
      depois: linha.depois,
    }).toEqual({
      ocorrido_em: AGORA,
      // A versao NAO anda numa recusa: nada mudou.
      versao: 1,
      origem: 'painel',
      ator: `passkey:${await prefixoDeCredencial('credencial-da-recusa')}`,
      // `step_up: 0` porque nao houve reautenticacao nenhuma, e este e o campo
      // que responde "essa troca foi autorizada com a passkey presente?" numa
      // investigacao (§9.9).
      step_up: 0,
      acao: 'stepup_recusado',
      // `alvo` e `NULL` na configuracao global: ele nomeia a MIDIA, e so ela.
      alvo: null,
      campos: '["destinationUrl"]',
      antes: null,
      depois: null,
    })
  })

  test('AUD-09: nem o corpo malformado leva valor de configuracao para o console', async () => {
    // O caminho que AUD-05 nao cobria. Ele e o mais tentador de todos: o corpo
    // inteiro esta na mao, e `motivoInterno` vai direto para o `console.warn`.
    // §9.9 nao abre excecao, nenhum valor, nunca, nos Workers Logs.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const segredos = [
      'quero o cardapio secreto',
      `https://${DOMINIO_DE_TESTE}/promocao-que-ninguem-viu`,
      'Ola! Aqui esta o link que voce pediu',
    ]

    const registrado = capturarConsole()
    try {
      await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        [
          `triggerKeywords=${encodeURIComponent(segredos[0] as string)}`,
          `destinationUrl=${encodeURIComponent(segredos[1] as string)}`,
          `privateReplyText=${encodeURIComponent(segredos[2] as string)}`,
          'campoInventado=1',
        ].join('&'),
        sessao,
      )
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    for (const segredo of segredos) {
      expect({ [segredo.slice(0, 20)]: tudo.includes(segredo) }).toEqual({
        [segredo.slice(0, 20)]: false,
      })
    }

    // Contrapositivo: a linha do log EXISTE, com o codigo e o motivo em
    // snake_case. Sem ela o teste passaria com um `console` mudo, que nao prova
    // nada sobre o que ele nao escreve.
    expect(tudo).toContain('400 dados_invalidos campo_desconhecido')
  })

  test('AUD-06: desligar a automacao NAO exige step-up', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe(`${ROTA_INICIO.caminho}?ok=desligada`)

    const linha = await linhaDeConfig()
    expect({ enabled: linha?.enabled, versao: linha?.versao }).toEqual({ enabled: 0, versao: 2 })
    expect((await unicaLinha()).acao).toBe('config_alterada')
  })

  test('AUD-07: religar tambem NAO exige step-up, e pede a confirmacao explicita', async () => {
    // §10.10: religar nao muda nenhum valor, so devolve a chave ao estado
    // anterior. Exigir biometria puniria quem acabou de usar o freio.
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    const semConfirmar = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar',
      sessao,
    )
    expect(semConfirmar.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    // A confirmacao ausente e uma mudanca JULGADA e recusada: a linha existe,
    // com `antes = depois = NULL` e o campo que ela tentou mexer.
    const recusada = await unicaLinha()
    expect({ acao: recusada.acao, campos: recusada.campos, antes: recusada.antes }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["enabled"]',
      antes: null,
    })
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    const comConfirmar = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar&confirmar=sim',
      sessao,
    )
    expect(comConfirmar.status).toBe(303)
    expect(comConfirmar.headers.get('location')).toBe(`${ROTA_INICIO.caminho}?ok=ligada`)
    expect((await linhaDeConfig())?.enabled).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// GRAV, a forma de §7.1, a atomicidade de §8.8 e a classificacao de §10.10
// ---------------------------------------------------------------------------

describe('GRAV: a forma da gravacao', () => {
  test('GRAV-01: toda rota de PAGINA com `escreve: true` responde 303 (§7.1)', async () => {
    // A outra metade da regra de forma. O laco vem da TABELA, e nao de tres
    // handlers escritos a mao: uma rota nova entra nele sozinha. O gemeo,
    // "toda rota com `escreve: false` executa zero escritas", mora em
    // `painel-rotas.test.ts`.
    const dePagina = ROTAS.filter(
      (rota) => rota.escreve && !rota.caminho.startsWith('/painel/api/'),
    )

    // Contrapositivo: uma tabela sem rota de pagina que grava faria o laco
    // passar sem provar nada.
    expect([...dePagina.map((rota) => rota.caminho)].sort()).toEqual(
      [...GRAVADORAS.map((gravadora) => gravadora.rota.caminho)].sort(),
    )

    for (const alvo of GRAVADORAS) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB)
      // A linha de Reel existe em TODA volta, e nao so na de `/painel/reel`: um
      // `if` por rota aqui seria a primeira coisa a divergir da lista quando a
      // proxima tela entrasse. Ela e inerte para as outras cinco.
      await gravarMidia(env.DB, REEL_DE_TESTE)
      const sessao = await abrirSessao()

      const resposta = await gravar(alvo, CORPO_VALIDO[alvo.rota.caminho] ?? '', sessao)

      expect({ [alvo.rota.caminho]: resposta.status }).toEqual({ [alvo.rota.caminho]: 303 })
      expect(resposta.headers.get('location')).toMatch(/^\/painel[^?]*\?ok=[a-z_]+$/)
    }
  })

  test('GRAV-02: a faixa verde nasce do `?ok=`, e a query string nunca vira conteudo', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const comOk = await despachar(
      pedir(`${ROTA_PALAVRAS.caminho}?ok=salvo`, { cookie: sessao.cookie }),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    expect(await comOk.text()).toContain(escapeHtml(CONFIRMACOES.salvo))

    // Um `?ok=` que nao esta na tabela nao mostra faixa nenhuma E nao aparece na
    // pagina: a frase vem da lista fechada, nunca da query string.
    const inventado = await despachar(
      pedir(`${ROTA_PALAVRAS.caminho}?ok=%3Cscript%3Ealert(1)%3C/script%3E`, {
        cookie: sessao.cookie,
      }),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    const corpo = await inventado.text()
    expect(corpo).not.toContain('alert(1)')
    expect(corpo).not.toContain('faixa-ok')
  })

  test('GRAV-03: `antes` e `depois` carregam o estado de comportamento COMPLETO, e nada alem', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], 'userCooldownHours=48', sessao)

    const linha = await unicaLinha()
    const antes = JSON.parse(linha.antes ?? 'null') as Record<string, unknown>
    const depois = JSON.parse(linha.depois ?? 'null') as Record<string, unknown>

    // O conjunto EXATO de chaves nos dois, e ele e o de §9.9, **na ordem**.
    // A ordem lexicografica nao e enfeite: e ela que torna `antes` e `depois`
    // dois JSON comparaveis como texto, e e a mesma que §10.10 vai exigir do
    // `json_canonico` do step-up. Comparar so o CONJUNTO deixaria a ordem livre.
    expect(Object.keys(antes)).toEqual([...CAMPOS_DE_COMPORTAMENTO])
    expect(Object.keys(depois)).toEqual([...CAMPOS_DE_COMPORTAMENTO])
    expect([...CAMPOS_DE_COMPORTAMENTO]).toEqual([...CAMPOS_DE_COMPORTAMENTO].sort())

    expect({ antes: antes.userCooldownHours, depois: depois.userCooldownHours }).toEqual({
      antes: 24,
      depois: 48,
    })

    // O que §9.9 mantem FORA: carimbo de linha e todo metadado de exibicao,
    // `legenda_curta` e recorte da `caption` do Reel, que esta na lista de
    // proibidos dos dois destinos (§15.4).
    for (const proibido of [
      'versao',
      'parado_por_codigo_em',
      'criado_em',
      'atualizado_em',
      'allowedMediaIds',
      'legenda_curta',
      'permalink',
      'caption',
      'media_url',
      'thumbnail_url',
    ]) {
      expect({ [proibido]: proibido in antes || proibido in depois }).toEqual({ [proibido]: false })
    }
  })

  test('GRAV-04: a config e a auditoria vao no MESMO lote: sem log, sem mudanca', async () => {
    // §8.8, regra de ouro. "Grava a config, depois tenta logar" passaria verde
    // em qualquer contagem que olhasse so o estado final, porque os dois lotes
    // gravam a mesma coisa. Aqui o SEGUNDO lote de escrita nao existe: o
    // primeiro `batch` e a LEITURA da configuracao, o segundo e a gravacao, e um
    // terceiro derruba a rota.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    // §9.10: salvar uma tela global custa 1 lote e 2 escritas. Os lotes sao dois
    // porque a leitura da configuracao tambem e um.
    expect({ lotes: contador.batches, escritas: contador.escritas }).toEqual({
      lotes: 2,
      escritas: 2,
    })
    expect((await auditoria()).length).toBe(1)
  })

  test('GRAV-05: quando o lote da gravacao falha, NEM a config NEM a auditoria mudam', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const quebrado = new D1SegundoBatchQuebrado(env.DB)
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
        { ambiente: { ...env, DB: quebrado as unknown as D1Database } as typeof env },
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(500)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-06: a linha de auditoria NAO entra sem a mudanca que ela audita', async () => {
    // A metade contraria de "sem log, sem mudanca". Um `UPDATE` que perde a
    // trava otimista e um statement que RODOU sem alterar nada, e `db.batch()`
    // nao rejeita por isso: sem a condicao, a linha de auditoria commitaria
    // sozinha, afirmando um `antes`/`depois` que nunca aconteceu.
    //
    // O teste roda o statement na POSICAO em que ele vive, dentro de um lote,
    // logo depois da escrita que ele audita, porque e so nessa posicao que
    // `changes()` responde sobre a escrita certa.
    await gravarConfig(env.DB, { versao: 7 })
    const repositorio = new PainelAuditoriaRepository(env.DB)

    const evento = {
      ocorridoEm: AGORA,
      versao: 8,
      origem: 'painel' as const,
      ator: 'passkey:00000000',
      stepUp: false,
      acao: 'config_alterada' as const,
      alvo: null,
      campos: '["enabled"]',
      antes: '{}',
      depois: '{}',
    }

    const gravacaoQuePerde = env.DB.prepare(
      'UPDATE painel_config SET versao = 8 WHERE id = 1 AND versao = 6',
    )
    await env.DB.batch([
      gravacaoQuePerde,
      repositorio.statementDeRegistro(evento, { presoAMudanca: true }),
    ])
    expect(await auditoria()).toEqual([])

    // Contrapositivo, sem o qual um `WHERE` sempre falso passaria verde.
    const gravacaoQueGanha = env.DB.prepare(
      'UPDATE painel_config SET versao = 8 WHERE id = 1 AND versao = 7',
    )
    await env.DB.batch([
      gravacaoQueGanha,
      repositorio.statementDeRegistro(evento, { presoAMudanca: true }),
    ])
    expect((await auditoria()).length).toBe(1)
  })

  test('GRAV-19: perdendo a trava DENTRO do lote, nem a config nem a auditoria mudam', async () => {
    // O caso que o `WHERE` de §8.8 existe para cobrir, montado de ponta a ponta:
    // alguem grava entre a leitura da versao e o lote. O `UPDATE` vira um no-op
    // de zero linhas, e `db.batch()` NAO rejeita por isso.
    //
    // Este teste ja encontrou um defeito real: a primeira grafia da condicao da
    // auditoria comparava `versao` e `atualizado_em` da linha de config, e o
    // escritor concorrente satisfazia os dois. A linha de auditoria entrava
    // afirmando uma mudanca que nao aconteceu.
    await gravarConfig(env.DB, { versao: 1 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { ambiente: { ...env, DB: new D1QueCorreNaFrente(env.DB) } as unknown as typeof env },
    )

    expect(resposta.status).toBe(409)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-07: a trava otimista recusa a versao velha com 409 e ZERO escritas', async () => {
    await gravarConfig(env.DB, { versao: 3 })
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
      { versao: 2, ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(409)
    expect(await resposta.text()).toContain('A configuração mudou em outro lugar')
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-08: a primeira gravacao MATERIALIZA a linha, com a versao 0 do arquivo', async () => {
    // Sem linha, `carregarConfigEfetiva` devolve `origem: 'arquivo'` e
    // `versao: 0` (§8.3). O `INSERT` do `upsert` e o unico ramo em que a versao
    // nao vem de `versao + 1`.
    const sessao = await abrirSessao()
    expect(await linhaDeConfig()).toBeNull()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
      {
        versao: 0,
      },
    )

    expect(resposta.status).toBe(303)
    const linha = await linhaDeConfig()
    expect({ enabled: linha?.enabled, versao: linha?.versao }).toEqual({ enabled: 0, versao: 1 })
    expect((await unicaLinha()).versao).toBe(1)
  })

  test('GRAV-09: o corpo com campo desconhecido e recusado, e sem tocar no D1', async () => {
    // §11.3 passo 6: na entrada vinda de humano, estranheza e erro de digitacao
    // ou cliente adulterado. A recusa vem ANTES de qualquer leitura, e por isso
    // ela e a unica que NAO deixa linha: nada do conteudo chegou a ser julgado.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      'triggerKeywords=oi&campoInventado=1',
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(400)
    // Duas consultas: a linha de sessao, que `despachar` ja fez antes de chamar
    // o handler, e a linha de auditoria da recusa (Ruling 59). A LEITURA DA
    // CONFIGURACAO nao aconteceu: o campo desconhecido e recusado antes dela, na
    // cota que o painel divide com o webhook.
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 2,
      escritas: 1,
    })
    expect(contador.sqls.some((sql) => sql.includes('painel_config'))).toBe(false)

    // Ruling 59: numa sessao autenticada, um corpo que nem da para julgar e o
    // sinal mais parecido com sequestro deste conjunto, e §9.9 diz que a linha
    // existe para uma sequencia dessas nao passar sem rastro. `versao: 0` porque
    // nada foi lido, o mesmo `0` de `codigos_gerados`.
    const linha = await unicaLinha()
    expect({ acao: linha.acao, versao: linha.versao, campos: linha.campos }).toEqual({
      acao: 'mudanca_recusada',
      versao: 0,
      campos: '[]',
    })
  })

  test('GRAV-10: campo ainda nao gravavel e recusado com 400 e `mudanca_recusada`', async () => {
    // Estreitar o alcance NAO exige step-up (§10.10), mas `mediaScope` ainda nao
    // e gravavel: a tela dona dele (`/painel/reels`) nao existe (Ruling 68). A
    // recusa e explicita, nunca campo ignorado em silencio, que seria a mudanca
    // que acontece sem a pessoa ver.
    //
    // O campo deste teste era `matchMode` ate a etapa do step-up; Ruling 65 o
    // tornou gravavel em `/painel/palavras`, e a metade positiva dele passou a
    // ser afirmada em `tests/painel-stepup.test.ts`.
    await gravarConfig(env.DB, { media_scope: 'todas', trigger_keywords: '["quero o link"]' })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'mediaScope=selecionadas',
      sessao,
    )

    expect(resposta.status).toBe(400)
    expect({ acao: (await unicaLinha()).acao, campos: (await unicaLinha()).campos }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["mediaScope"]',
    })
    expect((await linhaDeConfig())?.media_scope).toBe('todas')
  })

  test('GRAV-11: campo protegido e recusado com 403, mesmo junto de um campo permitido', async () => {
    // §10.10: se QUALQUER campo do lote exige step-up, o lote inteiro exige, e
    // gravacao parcial e impossivel.
    //
    // **O veiculo mudou para `/painel/palavras`** (Ruling 78). O lote misto
    // precisa de UMA rota que seja dona dos dois campos: depois do Ruling 74,
    // `/painel/ajustes` nao escreve mais o link, e o lote seria recusado por
    // escopo antes de a classificacao rodar, `400`, e nao o `403` que este
    // teste existe para medir. `triggerKeywords` (barato) com `matchMode` para
    // "no meio do comentario" (protegido) e palavra por palavra o exemplo do
    // Ruling 66, e as duas colunas sao de `/painel/palavras`.
    await gravarConfig(env.DB, { match_mode: 'exact' })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}&matchMode=no_meio`,
      sessao,
    )

    expect(resposta.status).toBe(403)
    expect((await unicaLinha()).acao).toBe('stepup_recusado')
    // Nem o campo permitido do mesmo lote foi gravado.
    const linha = await linhaDeConfig()
    expect({ palavras: linha?.trigger_keywords, modo: linha?.match_mode }).toEqual({
      palavras: '["eu quero","quero o link"]',
      modo: 'exact',
    })
  })

  test('GRAV-12: o cooldown sobe; descer e recusado: a direcao decide, nao o campo', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    const subindo = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=48',
      sessao,
    )
    expect(subindo.status).toBe(303)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)

    const descendo = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=24',
      sessao,
      { versao: 2 },
    )
    expect(descendo.status).toBe(403)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)
  })

  test('GRAV-13: reenviar o mesmo valor nao grava nada e diz que nada mudou', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    const contador = new D1Contador(env.DB)
    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=24',
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe(`${ROTA_AJUSTES.caminho}?ok=sem_mudanca`)
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])

    // A mesma coisa com a LISTA de palavras, que e o campo em que "igual"
    // precisa ser comparado item a item: uma comparacao por referencia acharia
    // que toda visita mudou as palavras e gravaria uma versao por reenvio.
    const listaIgual = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('eu quero\nquero o link')}`,
      sessao,
      { ambiente: { ...env, DB: comoD1(contador) } as typeof env },
    )

    expect(listaIgual.headers.get('location')).toBe(`${ROTA_PALAVRAS.caminho}?ok=sem_mudanca`)
    expect(contador.escritas).toBe(0)
    expect(await auditoria()).toEqual([])
  })

  test('GRAV-14: com a configuracao salva ilegivel, a gravacao e recusada e a linha do dono fica', async () => {
    // O snapshot em vigor e a FABRICA desligada, e nao a linha do dono. Gravar
    // aqui escreveria valores de fabrica por cima do que o dono salvou, o
    // "inventar um substituto para o valor recusado" que §12.6 e §9.2 proibem.
    // O `CHECK` da migration cobre `match_mode` e os booleanos; `destination_url`
    // so tem teto de tamanho, e e por isso que ele e o campo que consegue chegar
    // ao banco invalido e reprovar no validador, exatamente o caso que §9.9
    // descreve: uma escrita feita FORA do painel.
    await gravarConfig(env.DB, { destination_url: 'isto-nao-e-um-endereco' })
    const sessao = await abrirSessao()

    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await gravar(
        GRAVADORAS[1] as (typeof GRAVADORAS)[number],
        `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
        sessao,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(400)
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
    // A linha do dono continua exatamente como estava, inclusive a versao, e,
    // principalmente, o valor de fabrica NAO foi escrito por cima dela.
    const linha = await linhaDeConfig()
    expect({ destination_url: linha?.destination_url, versao: linha?.versao }).toEqual({
      destination_url: 'isto-nao-e-um-endereco',
      versao: 1,
    })
  })

  test('GRAV-15: a palavra salva vale na hora, sem redeploy: o cache do isolate cai', async () => {
    // A verificacao do dono desta etapa, inteira: "muda uma palavra-gatilho pelo
    // celular e ve valer sem redeploy".
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // Enche o cache do isolate com o valor ANTIGO, como o webhook faria.
    const antes = await carregarConfigEfetiva(env, AGORA)
    expect(antes.global.triggerKeywords).toEqual(['eu quero', 'quero o link'])

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    // SEM `invalidarCacheDeConfig()` no teste, e SEM `ignorarCache`: e o proprio
    // caminho quente do webhook perguntando de novo, no mesmo instante.
    const depois = await carregarConfigEfetiva(env, AGORA)
    expect(depois.global.triggerKeywords).toEqual([PALAVRA_NOVA])
  })

  test('GRAV-16: o historico mostra o valor anterior, e o botao volta a ele pela rota normal', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    // Duas linhas que o historico da tela de Ajustes NAO pode mostrar: uma de
    // outra entidade (a mudanca de um Reel, que chega na etapa das midias) e uma
    // cujo `antes` esta truncado. A primeira nao e desta tela; a segunda nao da
    // para reenviar, e um botao que posta um corpo pela metade e pior que
    // nenhum botao.
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (?, 2, 'painel', 'passkey:00000000', 0, 'midia_alterada', '17900000000000000',
               '["enabled"]', '{"enabled":false}', '{"enabled":true}')`,
    )
      .bind(AGORA)
      .run()

    const corpo = await telaDeAjustes(sessao)

    expect(corpo).not.toContain('17900000000000000')
    // Nem como linha ilegivel: a de midia nao e desta tela, e nao aparece de
    // jeito nenhum. Sem esta linha, tirar o filtro de `acao` da consulta
    // passaria verde, a linha entraria e so ficaria sem botao.
    expect(corpo).not.toContain('conseguimos ler o que estava salvo')
    // Uma linha so no historico: a de `config_alterada`.
    expect(corpo.split('Voltar a esta vers').length - 1).toBe(1)

    expect(corpo).toContain('Voltar a esta vers')
    // O valor ANTERIOR esta na tela, em campo escondido, pronto para reenvio.
    expect(corpo).toContain(escapeHtml('eu quero\nquero o link'))

    // O botao reenvia o `antes` INTEIRO pela rota normal de gravacao (Ruling 55):
    // nao ha rota de restauracao, ha uma OPERACAO declarada nela, `acao=
    // restaurar` (Ruling 74), e por isso o mesmo validador, a mesma allowlist
    // de hoje e a mesma classificacao de risco valem para ele.
    const volta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      camposDoBotaoDeVoltar(corpo),
      sessao,
      { versao: 2 },
    )

    expect(volta.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
  })

  test('GRAV-41: a linha de um Reel NAO entra no historico de Ajustes (o Critical N-1)', async () => {
    // **A metade que faltava, e ela e o conserto de um Critical.** GRAV-16 ja
    // afirmava que uma linha `midia_alterada` nao aparece no historico, mas com
    // uma linha INSERIDA A MAO, e `lote.ts` nunca emitia essa acao: toda
    // gravacao saia como `config_alterada`, a de um Reel inclusive. O teste
    // afirmava o filtro sobre um valor que a producao nao produzia.
    //
    // Aqui a linha vem da ROTA. E o `antes` dela e a config EFETIVA daquele
    // Reel, a global com a sobreposicao por cima, entao o link e o intervalo
    // PRIVADOS deste Reel sao o que o botao "Voltar a esta versao" reenviaria
    // por cima da configuracao de TODOS. A mutacao que este teste mata e
    // exatamente a de antes: `acao: 'config_alterada'` fixo em `lote.ts`.
    await gravarConfig(env.DB, { destination_url: LINK_GLOBAL, user_cooldown_hours: 24 })
    await gravarMidia(env.DB, REEL_DE_TESTE, {
      destination_url: LINK_SO_DESTE_REEL,
      user_cooldown_hours: 72,
    })
    const sessao = await abrirSessao()

    const pausado = await gravar(
      GRAVADORAS[5] as (typeof GRAVADORAS)[number],
      `acao=pausar&midia=${REEL_DE_TESTE}`,
      sessao,
    )
    expect(pausado.status).toBe(303)

    // A linha existe, e ela nomeia a entidade certa.
    expect((await auditoria()).map((linha) => ({ acao: linha.acao, alvo: linha.alvo }))).toEqual([
      { acao: 'midia_alterada', alvo: REEL_DE_TESTE },
    ])

    // E o historico da tela de Ajustes nao a alcanca: nem o link privado, nem o
    // intervalo privado, nem o botao que os reenviaria.
    const corpo = await telaDeAjustes(sessao)

    expect(corpo).not.toContain(LINK_SO_DESTE_REEL)
    expect(corpo).not.toContain(REEL_DE_TESTE)
    expect(corpo).not.toContain('Voltar a esta vers')

    // Contrapositivo, e sem ele o teste passaria numa tela de Ajustes quebrada:
    // uma gravacao GLOBAL logo em seguida aparece no historico, com botao.
    await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], 'userCooldownHours=48', sessao, {
      versao: 2,
    })
    const depois = await telaDeAjustes(sessao)

    expect(depois).toContain('Voltar a esta vers')
    // E mesmo agora o link privado do Reel continua fora da tela: o `antes` que
    // o botao carrega e o da linha GLOBAL, e nao o daquele Reel.
    expect(depois).not.toContain(LINK_SO_DESTE_REEL)
  })

  test('GRAV-18: a restauracao de uma versao com campo protegido pede a digital', async () => {
    // A consequencia aceita de Ruling 55: o botao passa pelo funil normal, entao
    // uma versao cujo `antes` carregue campo de step-up cai na cerimonia, e o
    // que era `403` terminal virou `403` com a tela de conferencia, sem que o
    // botao mudasse, que e o que aquele comentario prometeu por escrito.
    //
    // O veiculo continua sendo o cooldown, que e de Ajustes. A metade que este
    // teste NAO alcanca, restaurar um campo de OUTRA tela, e GRAV-35, e ela so
    // existe desde o Ruling 74.
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao()

    // Subir o intervalo e a direcao segura, entao esta gravacao passa.
    await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], 'userCooldownHours=48', sessao)

    // Voltar a esta versao DESCE o intervalo de volta para 24, e descer alarga.
    const volta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      camposDoBotaoDeVoltar(await telaDeAjustes(sessao)),
      sessao,
      { versao: 2 },
    )

    expect(volta.status).toBe(403)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'config_alterada',
      'stepup_recusado',
    ])
  })

  test('GRAV-35: restaurar alcanca campo de OUTRA tela: o link (Ruling 74)', async () => {
    // **A consequencia declarada do Ruling 74, e ela e mudanca de
    // comportamento**, entao tem teste (Ruling 76). Enquanto a restauracao usava
    // a lista de campos de `/painel/ajustes`, uma versao que diferisse no link
    // era recusada com `400 dados_invalidos` / `campo_nao_gravavel`, e, pior,
    // toda linha de historico anterior a uma troca de link ficava irrestauravel,
    // inclusive as que eram sobre palavra-gatilho. §9.9 nomeia UMA recusa
    // sancionada para a restauracao, "se a allowlist encolheu", e nao esta.
    //
    // Agora `acao=restaurar` declara a operacao, o escopo dela e a uniao
    // gravavel, e o link volta a ser alcancavel, protegido, como sempre foi:
    // `403` com a tela de conferencia mostrando o valor literal. GRAV-18 nao
    // pegava isto porque restaura `userCooldownHours`, que e da propria tela.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // A versao anterior difere APENAS no link. Ela entra a mao porque grava-la
    // pela rota exigiria a digital, que e a cerimonia inteira, e ela mora em
    // `painel-stepup.test.ts`, onde o autenticador existe.
    const anterior = {
      ...ESTADO_GUARDADO_DA_LINHA_VALIDA,
      destinationUrl: `https://${DOMINIO_DE_TESTE}/antigo`,
    }
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (?, 1, 'painel', 'passkey:00000000', 1, 'config_alterada', NULL,
               '["destinationUrl"]', ?, ?)`,
    )
      .bind(AGORA, JSON.stringify(anterior), JSON.stringify(ESTADO_GUARDADO_DA_LINHA_VALIDA))
      .run()

    const corpo = await telaDeAjustes(sessao)
    // O botao SAI: a versao difere so em campo que alguma rota escreve, entao
    // ela volta inteira. Se ele nao saisse, o resto do teste nao provaria nada.
    expect(corpo).toContain('Voltar a esta vers')
    const doBotao = camposDoBotaoDeVoltar(corpo)

    // A linha montada a mao ja cumpriu o papel dela; o que sobrar na tabela
    // depois da gravacao e o que a gravacao escreveu.
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    // O ambiente traz a allowlist (etapa 12b): a versao anterior aponta para um
    // link do dominio de teste, e com a ordem de §9.7 uma restauracao que a
    // allowlist recusaria morreria no validador antes de chegar a cerimonia, o
    // que este teste NAO quer medir. §9.9 sanciona aquela recusa ("se a
    // allowlist encolheu"); esta aqui e sobre o link ser ALCANCAVEL e protegido.
    const volta = await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], doBotao, sessao, {
      ambiente: COM_ALLOWLIST,
    })

    // Antes do Ruling 74 isto era `400` com `campo_nao_gravavel`.
    expect(volta.status).toBe(403)
    const linha = await unicaLinha()
    expect({ acao: linha.acao, campos: linha.campos }).toEqual({
      acao: 'stepup_recusado',
      campos: '["destinationUrl"]',
    })
    expect((await linhaDeConfig())?.destination_url).toBe('https://exemplo.com/do-banco')

    // E a tela que veio no `403` e a de conferencia, com o valor LITERAL dos
    // dois lados (§10.10): sem ela, o `403` seria so uma recusa com outro numero.
    const tela = await volta.text()
    expect(tela).toContain('Confira o que vai mudar')
    expect(tela).toContain(escapeHtml(`https://${DOMINIO_DE_TESTE}/antigo`))
  })

  test('GRAV-36: a versao que NAO volta inteira nao ganha botao, e a linha diz por que', async () => {
    // O contrapositivo de GRAV-35, e a garantia que faltava: o botao so sai
    // quando a versao guardada difere de hoje apenas em campo que ALGUMA rota
    // escreve.
    //
    // **O campo de exemplo mudou na Etapa 12, e a expectativa nao.** Ate ela,
    // quem representava "campo que ninguem grava" era `mediaScope`; agora
    // `/painel/reels` e a tela dona dele e ele entrou na uniao gravavel (Ruling
    // 68). Sobraram os dois interruptores de canal, que §3 poe em "Ajustes
    // finos" e que nenhuma etapa de §14 nomeia, e e um deles que este teste
    // passa a usar. A garantia afirmada e a mesma: uma versao que difira num
    // campo que ninguem grava voltaria pela metade, e um botao que promete
    // recuperacao e recupera parte dela e a promessa quebrada que §12.4 recusa.
    //
    // A mutacao que este teste mata: fazer `restauracaoPossivel` devolver sempre
    // `true`. Ela sobrevivia a suite inteira, o botao passava a sair para toda
    // linha, e a gravacao seguinte seria recusada pelo campo que ninguem grava,
    // com a pessoa levando a recusa depois do clique em vez de antes.
    await gravarConfig(env.DB, { media_scope: 'todas' })
    const sessao = await abrirSessao()

    // Duas linhas: a de cima difere so no link (volta inteira), a de baixo
    // difere tambem no interruptor do Direct (nao volta). Uma linha so nao
    // provaria a distincao, provaria apenas que a tela as vezes nao tem botao.
    const soOLink = {
      ...ESTADO_GUARDADO_DA_LINHA_VALIDA,
      destinationUrl: `https://${DOMINIO_DE_TESTE}/antigo`,
    }
    const tambemOCanal = { ...soOLink, privateReplyEnabled: false }
    for (const antes of [soOLink, tambemOCanal]) {
      await env.DB.prepare(
        `INSERT INTO painel_auditoria
           (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
         VALUES (?, 1, 'painel', 'passkey:00000000', 1, 'config_alterada', NULL,
                 '["destinationUrl"]', ?, ?)`,
      )
        .bind(AGORA, JSON.stringify(antes), JSON.stringify(ESTADO_GUARDADO_DA_LINHA_VALIDA))
        .run()
    }

    const corpo = await telaDeAjustes(sessao)

    // Duas linhas no historico, e UM botao so.
    expect(corpo.split('Voltar a esta vers').length - 1).toBe(1)
    // E a linha sem botao diz por que, em portugues, sem nomear coluna nenhuma
    // (§12.1): nao e a mesma frase da linha ilegivel, que e outro caso.
    expect(corpo).toContain('ajustes que o painel ainda n&atilde;o sabe mudar')
    expect(corpo).not.toContain('conseguimos ler o que estava salvo')
  })

  test('GRAV-37: sem `acao=restaurar`, o formulario comum de Ajustes so escreve o que e dele', async () => {
    // A SEGUNDA ancora de uma garantia que morria em um teste so, o trecho
    // `semOperacao` do STEP-35, num teste cujo nome fala de outra coisa. Ela e o
    // que sobrou da razao 3 do Ruling 70 depois que o Ruling 74 abriu a
    // restauracao para a uniao gravavel: o escopo por tela continua valendo para
    // o formulario COMUM, e quem o alarga e a operacao declarada, nao o corpo
    // ter carregado o campo.
    //
    // O veiculo aqui e `triggerKeywords`, que e barato, de proposito. Com um
    // campo protegido, um `400` nao distinguiria recusa por escopo de recusa por
    // step-up; com um campo que nao pede digital nenhuma, o unico portao que
    // pode responder e o do escopo.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const intruso = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )
    const tela = await intruso.text()

    expect(intruso.status).toBe(400)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')
    const linha = await unicaLinha()
    expect({ acao: linha.acao, campos: linha.campos }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["triggerKeywords"]',
    })
    // E a recusa diz ONDE se muda a palavra-gatilho, em vez de "ainda nao da"
    // (Ruling 75): a tela existe, e mandar a pessoa esperar por ela seria mentir.
    expect(tela).toContain('na tela de Palavras')

    // O contrapositivo, e ele e o que prende a garantia ao escopo e nao a outra
    // coisa qualquer: o MESMO corpo, com a operacao declarada, grava.
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    const declarado = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `acao=restaurar&triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`,
      sessao,
    )

    expect(declarado.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe(JSON.stringify([PALAVRA_NOVA]))
  })

  test('GRAV-40: a recusa de um campo que a tela SO MOSTRA chega por HTTP (Ruling 89)', async () => {
    // A terceira frase de `motivoDeCampoForaDaTela` nasceu no Ruling 82 e ate
    // esta rodada era exercitada so no nivel da funcao, por META-12, enquanto as
    // outras duas tinham um caminho HTTP cada (STEP-33 e GRAV-37). Uma frase de
    // tela cuja unica prova e uma chamada direta nao demonstra que ela CHEGA a
    // alguem: bastava um portao anterior recusar o campo por outro motivo para a
    // frase nunca ser impressa, e nada quebraria.
    //
    // Ela e alcancavel, e o caminho e curto: `publicReplyEnabled` esta em
    // `NOME_DO_CAMPO`, entao atravessa o passo 6 de §11.3 como campo conhecido,
    // e nenhuma das quatro rotas o declara, a recusa que sobra e a de escopo,
    // que e quem imprime a frase.
    //
    // O veiculo e BARATO de proposito, como em GRAV-37: o interruptor nao pede
    // digital nenhuma, entao o unico portao que pode responder e o do escopo.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const recusado = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'publicReplyEnabled=nao',
      sessao,
    )
    const tela = await recusado.text()

    expect(recusado.status).toBe(400)
    expect((await linhaDeConfig())?.public_reply_enabled).toBe(1)
    const linha = await unicaLinha()
    expect({ acao: linha.acao, campos: linha.campos }).toEqual({
      acao: 'mudanca_recusada',
      campos: '["publicReplyEnabled"]',
    })

    // A frase que a pessoa le nomeia a tela que JA mostra o campo e admite que
    // ali so da para ler. As outras duas mentiriam: a do caminho prometeria um
    // botao que nao existe, e a do "ainda nao" mandaria esperar por uma tela
    // pronta que nenhuma etapa de §14 vai construir.
    expect(tela).toContain('em Ajustes')
    expect(tela).toContain(
      'mas por enquanto só para leitura: ainda não dá para ligá-lo ou desligá-lo pelo painel.',
    )
    expect(tela).not.toContain('e não por aqui.')
    expect(tela).not.toContain(RECUSA_SEM_VALOR.naoGravavel)
  })

  test('GRAV-38: `acao` que nao casa e recusada nas DUAS rotas que a leem (Ruling 85)', async () => {
    // §11.3, passo 6, trata campo que nao casa como erro de digitacao ou cliente
    // adulterado. `/painel/chave` ja recusava com `acao_desconhecida`;
    // `/painel/ajustes` engolia em silencio e seguia como gravacao COMUM, a
    // operacao pedida sumia, e o que era para ser uma restauracao virava uma
    // escrita com outro escopo que ninguem pediu. As duas rotas convergem.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // Em Ajustes a operacao e OPCIONAL (§7.1): o formulario comum nao declara
    // nenhuma, e por isso o teste manda um corpo que gravaria se `acao` nao
    // estivesse la, sem isso, o `400` poderia vir do campo e nao da operacao.
    const errada = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'acao=restaurr&userCooldownHours=48',
      sessao,
    )

    expect(errada.status).toBe(400)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(24)
    // Recusa de FORMA, antes do funil: nao ha linha de auditoria, como em
    // qualquer `400` de corpo malformado.
    expect(await auditoria()).toEqual([])

    // O mesmo corpo sem a operacao errada grava, e e ele que prova que o `400`
    // acima veio do `acao` e nao do cooldown.
    const limpa = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=48',
      sessao,
    )
    expect(limpa.status).toBe(303)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(48)
  })

  test('GRAV-20: a caixa de texto e uma palavra por linha, e linha em branco nao vira palavra', async () => {
    // Descartar a linha vazia e ler o FORMATO da caixa de texto, e o Enter que
    // a pessoa deu antes de escrever a proxima, e nao consertar um valor. O
    // item que fica vazio DEPOIS da normalizacao (so pontuacao, so emoji) chega
    // inteiro ao validador, que o recusa; e esse o contrapositivo do fim.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('  quero o cardapio  \n\n   \nquero a tabela\n')}`,
      sessao,
    )

    expect(resposta.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')

    // E o que NAO e conserto: uma palavra que normaliza para vazio e RECUSADA,
    // nunca descartada em silencio.
    const soPontuacao = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('quero o cardapio\n!!!')}`,
      sessao,
      { versao: 2 },
    )
    expect(soPontuacao.status).toBe(400)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')
  })

  test('GRAV-39: religar + campo protegido e recusado ANTES da digital (Ruling 73)', async () => {
    // A combinacao que nenhum teste cobria, e por isso a ordem errada sobrevivia:
    // restaurar uma versao que RELIGA a automacao **e** difere num campo
    // protegido. Ate esta rodada, o funil mostrava a tela de conferencia com o
    // link literal, colhia a digital e so entao devolvia `400
    // confirmacao_ausente`, o gesto gasto numa operacao que nao podia dar
    // certo, que e a patologia que o Ruling 73 proibiu palavra por palavra.
    //
    // A outra saida seria a tela de conferencia reemitir `confirmar`, e ela e
    // proibida por §10.12: um gesto que o servidor recarrega sozinho no
    // formulario seguinte deixa de ser um gesto. Quem guarda ESSA metade e o
    // fixture `comDigital` de `painel-stepup`, que afirma a ausencia do campo em
    // todo caminho positivo do step-up.
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    // A versao anterior estava LIGADA e com outro link: os dois portoes de uma
    // vez. Se ela diferisse so no `enabled`, o teste viraria o GRAV-21.
    const ligadaComOutroLink = {
      ...ESTADO_GUARDADO_DA_LINHA_VALIDA,
      enabled: true,
      destinationUrl: `https://${DOMINIO_DE_TESTE}/antigo`,
    }
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (?, 1, 'painel', 'passkey:00000000', 1, 'config_alterada', NULL,
               '["destinationUrl","enabled"]', ?, ?)`,
    )
      .bind(
        AGORA,
        JSON.stringify(ligadaComOutroLink),
        JSON.stringify({ ...ESTADO_GUARDADO_DA_LINHA_VALIDA, enabled: false }),
      )
      .run()

    const doBotao = camposDoBotaoDeVoltar(await telaDeAjustes(sessao))
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    // Os dois envios usam o ambiente COM a allowlist (etapa 12b): a versao
    // anterior difere tambem no link, e com a ordem de §9.7 uma lista vazia
    // faria o validador responder antes dos dois portoes que este teste mede.
    const semConfirmar = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      doBotao,
      sessao,
      { ambiente: COM_ALLOWLIST },
    )
    const tela = await semConfirmar.text()

    expect(semConfirmar.status).toBe(400)
    // Nenhuma cerimonia foi oferecida: sem tela de conferencia, sem mudanca
    // canonica para o `painel.js` assinar, e sem linha de step-up recusado.
    expect(tela).not.toContain('Confira o que vai mudar')
    expect(tela).not.toContain('data-mudanca')
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
    expect((await linhaDeConfig())?.enabled).toBe(0)
    expect((await linhaDeConfig())?.destination_url).toBe('https://exemplo.com/do-banco')

    // E com o gesto, a MESMA operacao chega a cerimonia: e o portao de §10.12
    // que respondia primeiro, e nao o link ter deixado de ser protegido.
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    const comConfirmar = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `${doBotao}&confirmar=sim`,
      sessao,
      { ambiente: COM_ALLOWLIST },
    )

    expect(comConfirmar.status).toBe(403)
    expect((await unicaLinha()).acao).toBe('stepup_recusado')
    const conferencia = await comConfirmar.text()
    expect(conferencia).toContain('Confira o que vai mudar')
    expect((await linhaDeConfig())?.enabled).toBe(0)

    // E a outra metade de §10.12, a que ninguem afirmava de verdade: a tela de
    // conferencia NAO reemite `confirmar`. A afirmacao gemea de `painel-stepup`
    // mora no fixture `comDigital` e e VAZIA, nenhum caminho positivo de
    // step-up manda o gesto no corpo, entao ela nega a presenca de um campo que
    // nunca poderia estar ali. Este e o unico ponto do repositorio onde o corpo
    // CARREGA `confirmar` e a conferencia e renderizada, e por isso e o unico
    // lugar de onde ela morde: tirar `CAMPO_DA_CONFIRMACAO` dos estruturais do
    // funil faz o gesto voltar no formulario seguinte, o servidor o recarrega
    // sozinho, e religar a automacao passa a nao exigir que alguem tenha
    // marcado coisa nenhuma, que e o gesto de §10.12 virando carimbo.
    //
    // O `acao` ao lado nao e enfeite: ele e o contrapositivo. Prova que a
    // leitura achou os campos escondidos de verdade, e que a ausencia do outro
    // e uma ausencia medida, e nao um formulario que ninguem conseguiu ler.
    const escondidos = escondidosDaConferencia(conferencia)
    expect(escondidos.get(CAMPO_DA_ACAO)).toBe(RESTAURAR)
    expect(escondidos.has(CAMPO_DA_CONFIRMACAO)).toBe(false)
  })

  test('GRAV-21: religar pela RESTAURACAO tambem precisa da confirmacao de §10.12', async () => {
    // A falha que a rodada 1 de revisao encontrou: `enabled` e campo gravavel,
    // entao a confirmacao conferida so em `handleChave` era contornavel, e
    // alcancavel pela propria UI, porque o botao "Voltar a esta versao" reenvia
    // TODOS os campos, `enabled` incluso. Um clique desfazia a parada de
    // emergencia, sem confirmacao e sem a data.
    //
    // **O nome do teste dizia "por QUALQUER tela", e isso deixou de ser
    // verdade** (Ruling 79). Depois do Ruling 74, `enabled` chega ao funil por
    // dois caminhos nomeados: `POST /painel/chave`, que o declara, e
    // `acao=restaurar`, cujo escopo e a uniao. Um `enabled=sim` solto em
    // `/painel/ajustes` agora e recusado por ESCOPO, antes de §10.12, e um
    // teste que continuasse mandando aquilo mediria o portao errado. O veiculo
    // que ainda prova o que §10.12 quer, que a conferencia mora no FUNIL, e nao
    // no handler da chave, e a restauracao.
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    // A versao anterior, com a automacao LIGADA e nada mais diferente: restaurar
    // essa versao e religar.
    const ligada = { ...ESTADO_GUARDADO_DA_LINHA_VALIDA, enabled: true }
    const desligada = { ...ESTADO_GUARDADO_DA_LINHA_VALIDA, enabled: false }
    await env.DB.prepare(
      `INSERT INTO painel_auditoria
         (ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
       VALUES (?, 1, 'painel', 'passkey:00000000', 0, 'config_alterada', NULL,
               '["enabled"]', ?, ?)`,
    )
      .bind(AGORA, JSON.stringify(ligada), JSON.stringify(desligada))
      .run()

    const doBotao = camposDoBotaoDeVoltar(await telaDeAjustes(sessao))
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    const semConfirmar = await gravar(GRAVADORAS[2] as (typeof GRAVADORAS)[number], doBotao, sessao)

    expect(semConfirmar.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
    await env.DB.prepare('DELETE FROM painel_auditoria').run()

    // E a mesma operacao, com o gesto: liga. A confirmacao e um campo estrutural
    // de TODA rota, e nao um privilegio de `/painel/chave`.
    const comConfirmar = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `${doBotao}&confirmar=sim`,
      sessao,
    )
    expect(comConfirmar.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(1)

    // DESLIGAR pela mesma operacao continua sendo um gesto so: §10.10 e
    // explicito, e a parada de emergencia depende de desligar ser barato.
    const desligando = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      `${doBotao.replace('enabled=sim', 'enabled=nao')}`,
      sessao,
      { versao: 2 },
    )
    expect(desligando.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(0)

    // E o portao da chave, que e o outro veiculo: sem `confirmar`, nao liga.
    await env.DB.prepare('DELETE FROM painel_auditoria').run()
    const pelaChave = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar',
      sessao,
      { versao: 3 },
    )
    expect(pelaChave.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    expect((await unicaLinha()).acao).toBe('mudanca_recusada')
  })

  test('GRAV-22: o formulario que a tela RENDERIZA e aceito pelo funil que o le', async () => {
    // O elo que faltava. Todos os outros testes montam o corpo a mao, entao
    // apagar um campo escondido do formulario deixava a suite verde enquanto em
    // producao toda gravacao de toda tela passava a ser recusada. Aqui o corpo
    // sai do HTML de verdade, campo por campo.
    for (const tela of [
      { rota: ROTA_INICIO, handler: handleInicio, alvo: GRAVADORAS[0] },
      { rota: ROTA_PALAVRAS, handler: handlePalavras, alvo: GRAVADORAS[1] },
      { rota: ROTA_AJUSTES, handler: handleAjustes, alvo: GRAVADORAS[2] },
    ]) {
      // Cada tela parte do mesmo estado: o formulario do Inicio DESLIGA a
      // automacao, e sem o reset a versao andaria por baixo das seguintes.
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB)
      await ligarConta(env, AGORA)
      const sessao = await abrirSessao()

      const corpo = await (
        await despachar(
          pedir(tela.rota.caminho, { cookie: sessao.cookie }),
          env,
          AGORA,
          tela.rota,
          tela.handler,
        )
      ).text()

      const formulario = primeiroFormularioDeGravacao(corpo)
      // O formulario existe e carrega os dois campos escondidos que o funil
      // exige. Sem esta afirmacao, uma tela sem formulario nenhum passaria.
      expect(formulario.action).toBe((tela.alvo as (typeof GRAVADORAS)[number]).rota.caminho)
      expect(formulario.campos.get('csrf')).toBe(sessao.ficha)
      expect(formulario.campos.get('versao')).toBe('1')

      // E o corpo do formulario, EXATAMENTE como o navegador o enviaria, e
      // aceito: nenhum campo escondido a mais, nenhum a menos.
      const resposta = await despachar(
        postar(formulario.action, formulario.campos.toString(), sessao),
        env,
        AGORA,
        (tela.alvo as (typeof GRAVADORAS)[number]).rota,
        (tela.alvo as (typeof GRAVADORAS)[number]).handler,
      )

      expect({ [tela.rota.caminho]: resposta.status }).toEqual({ [tela.rota.caminho]: 303 })
      // E o `303` aponta para a tela com um `?ok=` da lista fechada, nunca uma
      // recusa. O Inicio desliga (o formulario dele e o botao de desligar); as
      // outras duas reenviam o que ja estava salvo.
      const ok = new URL(resposta.headers.get('location') ?? '', RAIZ).searchParams.get('ok')
      expect({ [tela.rota.caminho]: fraseDeConfirmacao(ok) !== null }).toEqual({
        [tela.rota.caminho]: true,
      })
    }
  })

  test('GRAV-23: a recusa NOMEIA o campo e diz por que, na lingua do dono (§12.4)', async () => {
    // "Confira os campos destacados" sem destacar campo nenhum e a frase mais
    // inutil que o painel poderia escrever. §11.4 fixa a frase; §12.4 exige o
    // campo e o motivo, e as duas coisas convivem em camadas diferentes.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('a')}`,
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(400)
    expect(corpo).toContain(escapeHtml('Confira os campos destacados.'))
    // O campo, com o NOME do dicionario, nunca `triggerKeywords` cru.
    expect(corpo).toContain(escapeHtml(NOME_DO_CAMPO.triggerKeywords))
    // O nome tecnico aparece SO como `name=` do rascunho que volta, nunca como
    // texto que a pessoa le. O laco confere cada ocorrencia, e nao a ausencia:
    // a ausencia deixaria de valer no dia em que o rascunho passasse a existir,
    // que e exatamente o que aconteceu.
    for (const posicao of [...corpo.matchAll(/triggerKeywords/g)].map((a) => a.index ?? 0)) {
      expect({ [posicao]: corpo.slice(posicao - 6, posicao) }).toEqual({ [posicao]: 'name="' })
    }
    // E o motivo de §12.4.
    expect(corpo).toContain(escapeHtml(MOTIVO_DA_RECUSA.gatilho_curto as string))

    // A pagina de recusa obedece §12.1 como qualquer outra tela: nenhuma das
    // palavras proibidas. E o motivo de a traducao ser pelo CODIGO do achado, a
    // `mensagem` do validador diz "no modo contains", e `contains` esta na lista.
    for (const proibida of PALAVRAS_PROIBIDAS) {
      expect({ [proibida]: contemPalavra(corpo, proibida) }).toEqual({ [proibida]: false })
    }
  })

  test('GRAV-24: o `409` devolve o rascunho que a pessoa digitou (§8.8)', async () => {
    await gravarConfig(env.DB, { versao: 3 })
    const sessao = await abrirSessao()

    const rascunho = 'quero o cardapio\nquero a tabela'
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(rascunho)}`,
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    expect(corpo).toContain(escapeHtml('A configuração mudou em outro lugar; recarregue a tela.'))
    // O que a pessoa escreveu volta na tela, inteiro.
    expect(corpo).toContain(escapeHtml(rascunho))
    // Com a versao de AGORA, para que reenviar funcione em vez de bater na
    // mesma trava para sempre.
    expect(corpo).toContain('name="versao" value="3"')
    expect(corpo).toContain(`action="${ROTA_PALAVRAS.caminho}"`)

    // E reenviar o rascunho daquela pagina grava mesmo.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_PALAVRAS,
      handlePalavras,
    )
    expect(segunda.status).toBe(303)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["quero o cardapio","quero a tabela"]')
  })

  test('GRAV-31: o `409` da CHAVE posta de volta para /painel/chave, e nao para /painel', async () => {
    // O irmao do GRAV-24, e a rota em que o defeito era visivel. `pedido.para` e
    // a tela para onde o `303` aponta; em Palavras e Ajustes ela coincide com o
    // caminho do POST, e em `/painel/chave` NAO: o `303` dela vai para `/painel`,
    // que e `GET` e so `GET`, para sempre (§7.1). Com o `action` errado, o botao
    // de recuperacao morria em `405`, na rota que desliga a automacao.
    await gravarConfig(env.DB, { enabled: 1, versao: 3 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=desligar',
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    expect(corpo).toContain(`action="${ROTA_CHAVE.caminho}"`)
    expect(corpo).not.toContain(`action="${ROTA_INICIO.caminho}"`)

    // E o botao FUNCIONA: postar o formulario daquela pagina desliga mesmo, em
    // vez de bater no `405 metodo_nao_permitido` de uma rota so de leitura.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_CHAVE,
      handleChave,
    )

    expect(segunda.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('GRAV-32: o rascunho do `409` NAO carrega a confirmacao de §10.12', async () => {
    // §8.8 desenhou o incremento de versao exatamente para o caso da parada de
    // emergencia disparar com o formulario aberto: "obrigado a recarregar e ver,
    // em letras grandes, que a automacao foi parada e desde quando". Carregar a
    // confirmacao pelo `409` seria o unico caminho em que aquele gesto e
    // CARREGADO em vez de FEITO, religar num clique sem ver a parada mais nova.
    await gravarConfig(env.DB, { enabled: 0, versao: 3 })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[0] as (typeof GRAVADORAS)[number],
      'acao=ligar&confirmar=sim',
      sessao,
      { versao: 2 },
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(409)
    // A acao volta, ela e o que a pessoa pediu.
    expect(corpo).toContain('name="acao" value="ligar"')
    // O GESTO nao volta.
    expect(corpo).not.toContain('name="confirmar"')

    // E a prova de que a ausencia MORDE: reenviar o formulario daquela pagina
    // nao liga a automacao.
    const formulario = primeiroFormularioDeGravacao(corpo)
    const segunda = await despachar(
      postar(formulario.action, formulario.campos.toString(), sessao),
      env,
      AGORA,
      ROTA_CHAVE,
      handleChave,
    )

    expect(segunda.status).toBe(400)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('GRAV-33: a recusa de CONTEUDO tambem devolve o rascunho, e sem botao que falha', async () => {
    // Perder vinte palavras digitadas num celular porque uma ficou curta demais
    // e pior do que perde-las por causa de uma aba aberta em outro aparelho. O
    // rascunho volta; o BOTAO nao, porque reenviar o mesmo rascunho bate na
    // mesma recusa, e um botao que sempre falha e a promessa quebrada que o
    // rascunho existe para consertar.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    const rascunho = 'quero o cardapio\nquero a tabela\na'
    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent(rascunho)}`,
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(400)
    expect(corpo).toContain(escapeHtml(rascunho))
    expect(corpo).not.toContain('<button type="submit"')

    // O `409` continua com botao: la reenviar FUNCIONA, porque a trava era de
    // concorrencia e o rascunho volta com a versao de agora.
    await env.DB.prepare('UPDATE painel_config SET versao = 9 WHERE id = 1').run()
    invalidarCacheDeConfig()
    const conflito = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      `triggerKeywords=${encodeURIComponent('quero o cardapio')}`,
      sessao,
      { versao: 8 },
    )
    expect(await conflito.text()).toContain('<button type="submit"')
  })

  test('GRAV-34: a recusa por campo protegido tambem guarda o rascunho', async () => {
    // O `403` de step-up e uma recusa de CONTEUDO como as outras: o que a pessoa
    // digitou no mesmo envio nao pode sumir so porque um dos campos do lote
    // exigia a digital. Vale mais aqui do que em qualquer outro lugar, porque na
    // etapa do step-up este e o caminho que passa a ter continuacao.
    //
    // **O veiculo mudou para `/painel/palavras`** (Ruling 78), pelo mesmo motivo
    // de GRAV-11: o lote misto precisa de uma rota dona dos dois campos, e o
    // link ja nao e de Ajustes. O que se afirma continua sendo o rascunho, o
    // campo BARATO do lote volta na tela, com o valor que a pessoa digitou.
    await gravarConfig(env.DB, { match_mode: 'exact' })
    const sessao = await abrirSessao()

    const resposta = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      [`triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}`, 'matchMode=no_meio'].join('&'),
      sessao,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(403)
    expect(corpo).toContain(`name="triggerKeywords" value="${PALAVRA_NOVA}"`)
    expect(corpo).toContain('name="matchMode" value="no_meio"')
  })

  test('GRAV-25: a tabela de §10.10 chega ao HTTP: um end-to-end por direcao', async () => {
    // **Esta era a tabela inteira, entrada por entrada, e deixou de poder ser**
    // (Ruling 77). Ela era exercida por `POST /painel/ajustes` quando aquela rota
    // escrevia todo campo de comportamento; depois que o Ruling 73 pos a recusa
    // de escopo antes da cerimonia e o Ruling 74 encolheu a lista da rota, seis
    // das sete entradas passaram a ser recusadas por ESCOPO, `400`, e nao o
    // `403` da classificacao. O teste teria continuado verde medindo o portao
    // errado se as duas mudancas nao tivessem chegado juntas.
    //
    // A tabela mudou de endereco: ela e afirmada sobre `camposProtegidos` em
    // META-06, `tests/painel-metatestes.test.ts`, com os catorze campos nas duas
    // direcoes. E estritamente mais forte, cobre `mediaScope`, que nao tem rota
    // dona ate a Task 13, e imune a mudanca de escopo de rota. O que fica AQUI
    // e o que so o HTTP prova: que a classificacao esta LIGADA no funil, e que
    // ela decide o status, a linha de auditoria e a gravacao. Uma direcao cada,
    // na rota que e dona do campo.
    //
    // `matchMode` e o veiculo porque as duas direcoes dele sao gravaveis em
    // `/painel/palavras` (Ruling 65): "no meio do comentario" alarga e pede a
    // digital, "so isso" estreita e grava sem pedir nada.
    await gravarConfig(env.DB, { match_mode: 'exact' })
    const sessao = await abrirSessao()

    const alargando = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      'matchMode=no_meio',
      sessao,
    )

    expect(alargando.status).toBe(403)
    expect((await unicaLinha()).acao).toBe('stepup_recusado')
    // A classificacao decide a GRAVACAO, e nao so o numero da resposta.
    expect((await linhaDeConfig())?.match_mode).toBe('exact')

    // E o contrapositivo, que e a promessa do rodape dos Ajustes: ESTREITAR
    // nunca pede a digital, e, desde o Ruling 65, estreitar GRAVA.
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB, { match_mode: 'contains' })
    const outra = await abrirSessao()

    const estreitando = await gravar(
      GRAVADORAS[1] as (typeof GRAVADORAS)[number],
      'matchMode=so_isso',
      outra,
    )

    expect(estreitando.status).toBe(303)
    expect((await linhaDeConfig())?.match_mode).toBe('exact')
    const linha = await unicaLinha()
    expect({ acao: linha.acao, step_up: linha.step_up }).toEqual({
      acao: 'config_alterada',
      step_up: 0,
    })
  })

  test('GRAV-26: `codigoDaRecusaDeValidacao` separa dominio de campo invalido (§11.4)', async () => {
    // A funcao e testada DIRETO porque o ramo do dominio nao e alcancavel pela
    // rota nesta etapa, os tres campos que produzem esse achado sao sempre
    // protegidos, e um link ja gravado fora da lista derruba a leitura para
    // `parado_por_erro`, recusado antes ainda. Um teste de rota para este ramo
    // dependeria do valor de `src/config.ts`, que muda em cada instalacao.
    expect(
      codigoDaRecusaDeValidacao([
        { campo: 'triggerKeywords', codigo: 'gatilho_curto', mensagem: 'x' },
      ]),
    ).toBe('dados_invalidos')

    expect(
      codigoDaRecusaDeValidacao([
        { campo: 'triggerKeywords', codigo: 'gatilho_curto', mensagem: 'x' },
        { campo: 'destinationUrl', codigo: 'dominio_nao_permitido', mensagem: 'x' },
      ]),
    ).toBe('dominio_nao_permitido')

    expect(codigoDaRecusaDeValidacao([])).toBe('dados_invalidos')
  })

  test('GRAV-27: o historico mostra a mais NOVA primeiro, e no maximo cinco', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao()

    // Seis gravacoes, cada uma com um intervalo diferente: a sexta empurra a
    // primeira para fora da lista, e a ordem diz qual e qual.
    for (let i = 0; i < 6; i++) {
      const resposta = await gravar(
        GRAVADORAS[2] as (typeof GRAVADORAS)[number],
        `userCooldownHours=${25 + i}`,
        sessao,
        { versao: 1 + i },
      )
      expect({ [`salvo ${i}`]: resposta.status }).toEqual({ [`salvo ${i}`]: 303 })
    }

    const corpo = await telaDeAjustes(sessao)
    expect(corpo.split('Voltar a esta vers').length - 1).toBe(5)

    // A ordem: o `antes` da mudanca mais recente e 29, e ele vem PRIMEIRO. Com
    // `ORDER BY id ASC` a lista comecaria em 24, que e o `antes` mais antigo, e
    // ele nem estaria na lista, porque a poda de cinco corta do lado velho.
    const intervalos = [...corpo.matchAll(/name="userCooldownHours" value="(\d+)"/g)].map(
      (achado) => achado[1],
    )
    expect(intervalos).toEqual(['29', '28', '27', '26', '25'])
  })

  test('GRAV-28: uma configuracao no tamanho MAXIMO legal ainda cabe na auditoria', async () => {
    // O `CHECK` de 4000 da migration 0002 era alcancavel por uma configuracao
    // inteiramente legal: 20 gatilhos de 40, dois textos de 500 e um link de
    // 2048 dao ~4230 no JSON de `antes`. O lote inteiro falhava, e o dono nao
    // conseguia mais salvar nem uma palavra. A migration 0005 sobe o teto.
    const gatilhos = Array.from(
      { length: 20 },
      (_, i) => `${String(i).padStart(2, '0')}${'a'.repeat(38)}`,
    )
    const linkLongo = `https://${DOMINIO_DE_TESTE}/${'c'.repeat(2048 - 8 - DOMINIO_DE_TESTE.length - 1)}`

    // O Direct sai DESLIGADO, e isso e o que faz esta ser a configuracao mais
    // longa que o validador aceita: com ele ligado, o texto precisa conter
    // `{link}`, e o link de 2048 renderizado dentro dele estouraria o teto de
    // 1000 do Direct, os dois maximos nao cabem juntos.
    await gravarConfig(env.DB, {
      trigger_keywords: JSON.stringify(gatilhos),
      destination_url: linkLongo,
      private_reply_enabled: 0,
      private_reply_text: 'd'.repeat(500),
      public_reply_text: 'e'.repeat(500),
    })
    const sessao = await abrirSessao()

    // A premissa: a linha e LEGAL, o validador da leitura a aceitou, senao o
    // snapshot viria `parado_por_erro` e a gravacao seria recusada por outro
    // motivo, e o teste passaria sem provar nada sobre o teto.
    expect((await carregarConfigEfetiva(env, AGORA, { ignorarCache: true })).origem).toBe('banco')

    const resposta = await gravar(
      GRAVADORAS[2] as (typeof GRAVADORAS)[number],
      'userCooldownHours=48',
      sessao,
    )

    expect(resposta.status).toBe(303)
    const linha = await unicaLinha()
    // E a prova de que o teste morde: o JSON gravado passa dos 4000 do teto
    // antigo.
    expect((linha.antes ?? '').length).toBeGreaterThan(4000)
    expect((linha.depois ?? '').length).toBeGreaterThan(4000)
  })

  test('GRAV-29: `dados_invalidos` em JSON acompanha `campos` com NOMES (§11.4)', async () => {
    // A tabela de §11.4 e explicita: `dados_invalidos` "acompanha `campos:
    // string[]` com **nomes**, nunca valores". Nenhuma rota de gravacao fala
    // JSON hoje, as tres sao de pagina, entao a afirmacao e sobre `erro()`,
    // que e quem monta o corpo nos dois formatos a partir do mesmo contexto.
    const resposta = erro('dados_invalidos', {
      request: pedir('/painel/api/qualquer'),
      caminho: '/painel/api/qualquer',
      formato: 'json',
      campos: ['triggerKeywords', 'userCooldownHours'],
    })

    expect(resposta.status).toBe(400)
    expect(await resposta.json()).toEqual({
      erro: 'dados_invalidos',
      mensagem: 'Confira os campos destacados.',
      campos: ['triggerKeywords', 'userCooldownHours'],
    })

    // Sem campos, a chave nao aparece: `{erro, mensagem}` continua sendo a forma
    // de toda recusa que nao acusa campo nenhum.
    const semCampos = erro('csrf_invalido', {
      request: pedir('/painel/api/qualquer'),
      caminho: '/painel/api/qualquer',
      formato: 'json',
    })
    expect(await semCampos.json()).toEqual({
      erro: 'csrf_invalido',
      mensagem: 'Bloqueado por segurança. Abra a tela de novo e tente outra vez.',
    })
  })

  test('GRAV-30: `motivoInterno` fora da forma de codigo e DESCARTADO do log', async () => {
    // A trava estrutural que sustenta AUD-05 e AUD-09. `motivoInterno` e o unico
    // campo do contexto de erro que vai para o `console`, e um
    // `motivoInterno: corpo.campos.toString()` escrito por engano publicaria o
    // formulario inteiro nos Workers Logs. A forma e conferida em tempo de
    // execucao, e o que nao casa nao e escrito, nem truncado, nem mascarado.
    const registrado = capturarConsole()
    try {
      erro('dados_invalidos', {
        request: pedir('/painel/palavras'),
        caminho: '/painel/palavras',
        formato: 'pagina',
        motivoInterno: `triggerKeywords=${PALAVRA_NOVA}&destinationUrl=https://${DOMINIO_DE_TESTE}/x`,
      })
      // E o contrapositivo: um codigo bem formado CONTINUA no log, senao a
      // guarda estaria simplesmente apagando o motivo de todo mundo.
      erro('dados_invalidos', {
        request: pedir('/painel/palavras'),
        caminho: '/painel/palavras',
        formato: 'pagina',
        motivoInterno: 'campo_desconhecido',
      })
    } finally {
      registrado.parar()
    }

    const tudo = registrado.linhas.join('\n')
    expect(tudo).not.toContain(PALAVRA_NOVA)
    expect(tudo).not.toContain(DOMINIO_DE_TESTE)
    expect(tudo).toContain('400 dados_invalidos campo_desconhecido')
  })

  test('GRAV-17: o Inicio mostra a chave, e a data da parada quando ela existe', async () => {
    await gravarConfig(env.DB, { enabled: 0, parado_por_codigo_em: AGORA })
    const sessao = await abrirSessao()

    const corpo = await (
      await despachar(
        pedir(ROTA_INICIO.caminho, { cookie: sessao.cookie }),
        env,
        AGORA,
        ROTA_INICIO,
        handleInicio,
      )
    ).text()

    expect(corpo).toContain(`action="${ROTA_CHAVE.caminho}"`)
    expect(corpo).toContain('name="acao" value="ligar"')
    expect(corpo).toContain('14/11/2023')
    // A ficha viaja no campo escondido, nunca na query string (§10.9).
    expect(corpo).toContain(`name="csrf" value="${sessao.ficha}"`)
  })
})
