import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { FALHAS_DE_STEPUP_ATE_APAGAR } from '../src/repositories/painel-sessoes-repository'
import { handleAparelhos, handleZerarAcesso } from '../src/routes/painel/aparelhos'
import { CAMPO_DO_APARELHO } from '../src/routes/painel/aparelhos-tela'
import { CAMPO_DA_DIGITAL, COOKIE_DA_SESSAO } from '../src/routes/painel/campos'
import { PALAVRAS_PROIBIDAS } from '../src/routes/painel/dicionario'
import { handleEntrarPorCodigo } from '../src/routes/painel/entrar'
import { handleGerarCodigos } from '../src/routes/painel/parada'
import {
  CAMINHO_DA_VERIFICACAO,
  CAMINHO_DAS_OPCOES,
  handleOpcoesDeRegistro,
  handleVerificarRegistro,
  TETO_DE_CREDENCIAIS,
} from '../src/routes/painel/registrar'
import {
  ROTA_APARELHOS,
  ROTA_ENTRAR_CODIGO,
  ROTA_OPCOES_DE_STEPUP,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import { handleOpcoesDeStepUp } from '../src/routes/painel/stepup'
import {
  emitirSessao,
  fichaCsrf,
  PRAZO_OCIOSO_DE_SESSAO_MS,
  validarSessao,
} from '../src/services/panel-session'
import { prefixoDeCredencial } from '../src/services/webauthn/verificar'
import type { Env } from '../src/types/env'
import { AutenticadorFalso, cerimonia } from './fixtures/autenticador'
import { limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  contemPalavra,
  D1Contador,
  LimitadorFalso,
  RAIZ,
} from './fixtures/dubles'

/**
 * REC, recuperacao, varios aparelhos e revogacao (§10.11, §10.13, §10.14).
 *
 * A garantia que da nome a etapa e a REC-01: **apagar a linha invalida a sessao
 * emitida.** Ela e o que faz "sair de todos os aparelhos" e "remover este
 * aparelho" serem revogacao de verdade, e nao um botao que promete.
 *
 * **As rotas sao chamadas por `despachar`**, a MESMA funcao do roteador: um
 * teste que chamasse o handler direto pularia a escada de §11.3, origem, teto
 * de corpo, limitador, sessao e ficha, e afirmaria muito menos do que parece.
 * As tres rotas de registro sao a excecao conhecida: elas nao passam por
 * `despachar` porque `portaDaApi` ja consome o corpo (§11.1).
 *
 * **Nada de `vi.mock`**: o `AutenticadorFalso` produz os mesmos bytes que um
 * autenticador real produziria, e o limitador entra por parametro.
 *
 * **Nenhum valor da instalacao de quem escreveu o teste.** Apelido, endereco
 * antigo e codigos sao ficticios ou sorteados pelo proprio Worker.
 */

const FORMULARIO = 'application/x-www-form-urlencoded'
const HANDLE_DO_DONO = 'handle-do-dono-de-teste'

/** O mesmo valor ficticio do `vitest.config.ts`. */
const ADMIN = 'admin-token-de-teste'

/** Um endereco FICTICIO de "antes da mudanca" (§10.14). */
const ENDERECO_ANTIGO = 'endereco-antigo.workers.dev'

const ALVO: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_APARELHOS,
  handler: handleAparelhos,
}

interface Sessao {
  readonly cookie: string
  readonly ficha: string
  readonly sidHash: string
}

/** Uma sessao viva de verdade: cookie assinado E linha em `painel_sessoes`. */
async function abrirSessao(credencial: string): Promise<Sessao> {
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
    sidHash: emitida.sidHash,
  }
}

/** Uma credencial do dono no banco, como o registro a teria deixado. */
async function cadastrarAparelho(
  aparelho: AutenticadorFalso,
  opcoes: { apelido?: string; rpId?: string; backup?: boolean; usadoEm?: number | null } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO painel_estado (id, usuario_handle, criado_em, atualizado_em)
     VALUES (1, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(HANDLE_DO_DONO, AGORA, AGORA)
    .run()

  const backup = opcoes.backup === true ? 1 : 0
  await env.DB.prepare(
    `INSERT INTO painel_credenciais
       (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
        sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, 'convite', ?, ?)`,
  )
    .bind(
      aparelho.credentialId,
      opcoes.rpId ?? env.PANEL_RP_ID,
      HANDLE_DO_DONO,
      JSON.stringify(aparelho.jwkParaOBanco),
      aparelho.algCose,
      backup,
      backup,
      opcoes.apelido ?? 'Celular do dono',
      AGORA,
      opcoes.usadoEm ?? null,
    )
    .run()
}

function pedirTela(caminho: string, cookie: string): Request {
  return new Request(`${RAIZ}${caminho}`, { headers: { cookie } })
}

function postarFormulario(caminho: string, corpo: string, cookie: string | null = null): Request {
  const cabecalhos: Record<string, string> = { 'content-type': FORMULARIO, origin: RAIZ }
  if (cookie !== null) cabecalhos.cookie = cookie

  return new Request(`${RAIZ}${caminho}`, { method: 'POST', headers: cabecalhos, body: corpo })
}

/** Um POST em `/painel/aparelhos`, com a ficha que a sessao deriva. */
async function agir(
  sessao: Sessao,
  corpo: string,
  opcoes: { ambiente?: Env } = {},
): Promise<Response> {
  return await despachar(
    postarFormulario(ROTA_APARELHOS.caminho, `csrf=${sessao.ficha}&${corpo}`, sessao.cookie),
    opcoes.ambiente ?? env,
    AGORA,
    ALVO.rota,
    ALVO.handler,
  )
}

async function abrirAparelhos(sessao: Sessao, busca = ''): Promise<Response> {
  return await despachar(
    pedirTela(`${ROTA_APARELHOS.caminho}${busca}`, sessao.cookie),
    env,
    AGORA,
    ALVO.rota,
    ALVO.handler,
  )
}

// ---------------------------------------------------------------------------
// A cerimonia de step-up desta tela, feita de verdade
// ---------------------------------------------------------------------------

/** A mudanca canonica que a tela de conferencia entrega ao `painel.js`. */
function mudancaDaTela(corpo: string): Record<string, unknown> {
  const achado = /data-mudanca="([^"]*)"/.exec(corpo)
  if (achado === null) throw new Error('a tela de conferencia nao trouxe a mudanca')
  return JSON.parse(desescapar(achado[1] as string)) as Record<string, unknown>
}

/** O `<form id="confirmar">` RENDERIZADO, lido como um navegador o leria. */
function formularioDeConfirmacao(corpo: string): { action: string; campos: URLSearchParams } {
  const bloco = /<form method="post" action="([^"]*)" id="confirmar"[\s\S]*?<\/form>/.exec(corpo)
  if (bloco === null) throw new Error('a tela de conferencia nao trouxe o formulario')

  const campos = new URLSearchParams()
  const escondidos = /<input type="hidden" name="([^"]*)" value="([^"]*)">/g
  let achado = escondidos.exec(bloco[0] as string)
  while (achado !== null) {
    campos.set(desescapar(achado[1] as string), desescapar(achado[2] as string))
    achado = escondidos.exec(bloco[0] as string)
  }

  return { action: desescapar(bloco[1] as string), campos }
}

function desescapar(texto: string): string {
  return texto
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function cookieDoEnvelope(resposta: Response): string {
  const achado = /__Host-painel_stepup=([^;]*)/.exec(resposta.headers.get('set-cookie') ?? '')
  if (achado === null) throw new Error('a cerimonia nao emitiu o cookie de step-up')
  return `__Host-painel_stepup=${achado[1] as string}`
}

/** O passo 2 de §10.10: `POST /painel/api/stepup/opcoes`. */
async function pedirOpcoesDeStepUp(sessao: Sessao, mudanca: unknown): Promise<Response> {
  return await despachar(
    new Request(`${RAIZ}${ROTA_OPCOES_DE_STEPUP.caminho}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: RAIZ,
        cookie: sessao.cookie,
        'x-painel-csrf': sessao.ficha,
      },
      body: JSON.stringify({
        operacao: (mudanca as { acao?: unknown }).acao,
        mudanca,
      }),
    }),
    env,
    AGORA,
    ROTA_OPCOES_DE_STEPUP,
    handleOpcoesDeStepUp,
  )
}

/** A digital, serializada do jeito que o `painel.js` a monta. */
async function digitalPara(aparelho: AutenticadorFalso, desafio: string): Promise<string> {
  const credencial = await aparelho.autenticar(
    cerimonia({
      rpId: env.PANEL_RP_ID,
      origem: `https://${env.PANEL_RP_ID}`,
      desafio,
      tipo: 'webauthn.get',
    }),
    HANDLE_DO_DONO,
  )
  return JSON.stringify({ credencial })
}

/** Uma cerimonia pronta, com o POST final ainda no gatilho. */
interface EnvioPreparado {
  readonly tela: string
  readonly mudanca: Record<string, unknown>
  /** O `__Host-painel_stepup=<envelope>` daquela cerimonia, para reenvio. */
  readonly envelope: string
  readonly campos: URLSearchParams
  /** Dispara o POST final. O cookie de sessao e trocavel para o teste do sid. */
  readonly disparar: (cookieDaSessao?: string) => Promise<Response>
}

/**
 * A cerimonia inteira de uma acao protegida, ATE a vespera do envio.
 *
 * **Ela e separada de `comDigital` por causa de REC-08b.** A regra da ultima e
 * ATOMICA, e provar isso exige duas remocoes VOANDO AO MESMO TEMPO: com os dois
 * envios preparados antes e soltos juntos, uma implementacao que lesse a
 * contagem em JavaScript e so depois apagasse deixaria as duas passarem. Com os
 * envios em sequencia, como REC-08 os fazia, a leitura-e-depois-escrita passa
 * igual a subconsulta dentro do `DELETE`, e o teste que tem "ATOMICA" no nome
 * nao afirma atomicidade nenhuma.
 *
 * **O POST final e dirigido pelo `<form id="confirmar">` RENDERIZADO**, e nao
 * por uma string que o teste guardou (Ruling 81): e o que prende a ficha, o
 * `acao` e o `aparelho` do formulario de uma vez. Reenviar a string do teste
 * deixaria passar uma tela de conferencia que esqueceu um campo escondido, e o
 * envio real morreria em `dados_invalidos` DEPOIS de colher a digital.
 */
async function prepararEnvio(
  sessao: Sessao,
  corpo: string,
  aparelho: AutenticadorFalso,
): Promise<EnvioPreparado & { conferencia: Response }> {
  const conferencia = await agir(sessao, corpo)
  const tela = await conferencia.text()
  const mudanca = mudancaDaTela(tela)
  const formulario = formularioDeConfirmacao(tela)

  expect(formulario.action).toBe(ROTA_APARELHOS.caminho)

  // **O campo `digital` tem de ter sido RENDERIZADO pela tela**, e nao criado
  // aqui. Ele e o UNICO campo que o `painel.js` procura no DOM
  // (`querySelector('input[name="digital"]')`); sem ele o navegador aborta com
  // "Nao foi possivel confirmar" e o painel fica sem revogacao nenhuma, e,
  // enquanto o teste o injetava com `set()` incondicional, apagar a linha do
  // `<input>` de `telaDeConferencia` mantinha a suite inteira verde.
  const trazOCampoDaDigital = formulario.campos.has(CAMPO_DA_DIGITAL)
  expect({ 'input[name=digital] na tela': trazOCampoDaDigital }).toEqual({
    'input[name=digital] na tela': true,
  })

  const cerimoniaResposta = await pedirOpcoesDeStepUp(sessao, mudanca)
  const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
  const envelope = cookieDoEnvelope(cerimoniaResposta)

  formulario.campos.set(CAMPO_DA_DIGITAL, await digitalPara(aparelho, challenge))

  const disparar = async (cookieDaSessao: string = sessao.cookie): Promise<Response> =>
    await despachar(
      postarFormulario(
        formulario.action,
        formulario.campos.toString(),
        `${cookieDaSessao}; ${envelope}`,
      ),
      env,
      AGORA,
      ALVO.rota,
      ALVO.handler,
    )

  return { conferencia, tela, mudanca, envelope, campos: formulario.campos, disparar }
}

/** A cerimonia inteira de uma acao protegida desta tela, do primeiro POST ao ultimo. */
async function comDigital(
  sessao: Sessao,
  corpo: string,
  aparelho: AutenticadorFalso,
): Promise<{
  conferencia: Response
  envio: Response
  mudanca: Record<string, unknown>
  envelope: string
  campos: URLSearchParams
}> {
  const preparado = await prepararEnvio(sessao, corpo, aparelho)
  const envio = await preparado.disparar()

  return {
    conferencia: preparado.conferencia,
    envio,
    mudanca: preparado.mudanca,
    envelope: preparado.envelope,
    campos: preparado.campos,
  }
}

/** Os `Set-Cookie` de uma resposta, um por linha, como o navegador os ve. */
function cookiesDe(resposta: Response): string[] {
  return resposta.headers.getSetCookie()
}

/** O valor do cookie de sessao que uma resposta emitiu, ou `null`. */
function sessaoEmitidaEm(resposta: Response): string | null {
  const achado = cookiesDe(resposta).find((cookie) => cookie.startsWith(`${COOKIE_DA_SESSAO}=`))
  if (achado === undefined) return null

  const valor = achado.slice(`${COOKIE_DA_SESSAO}=`.length).split(';')[0] as string
  return `${COOKIE_DA_SESSAO}=${valor}`
}

/**
 * A sessao DEPOIS da rotacao, lida do `Set-Cookie` como o navegador a guardaria.
 *
 * A ficha CSRF e derivada do `sha256(sid)`, entao rotacionar o `sid` troca
 * tambem a ficha: um teste que continuasse a postar com a ficha antiga levaria
 * `csrf_invalido` e culparia a rota errada.
 */
async function sessaoRotacionada(resposta: Response): Promise<Sessao> {
  const cookie = sessaoEmitidaEm(resposta)
  if (cookie === null) throw new Error('a resposta nao rotacionou o sid')

  const leitura = await validarSessao(env, cookie.slice(`${COOKIE_DA_SESSAO}=`.length), AGORA)
  if (!leitura.valida) throw new Error('o cookie rotacionado nao passa na propria validacao')

  return { cookie, sidHash: leitura.sidHash, ficha: await fichaCsrf(env, leitura.sidHash) }
}

/**
 * A rotacao do `sid` chegou ao BANCO, e nao so ao cabecalho, e devolve a
 * sessao nova, para quem quiser continuar agindo com ela.
 *
 * **Por que um `Set-Cookie` presente nao prova nada.** `validarSessao`
 * (src/services/panel-session.ts) confere assinatura e prazo do envelope e NAO
 * consulta `painel_sessoes`. Entao um cookie recem-assinado passa na propria
 * validacao mesmo que o `sid_hash` dele nunca tenha entrado na tabela. Quem
 * decide se a sessao esta viva e a guarda, no pedido SEGUINTE, quando ela
 * procura a linha. Por isso este auxiliar mede tres coisas em vez de uma:
 *
 *  1. o `sid_hash` novo EXISTE em `painel_sessoes` e o antigo NAO existe mais,
 *     as duas metades da rotacao, lidas do banco;
 *  2. o cookie novo ABRE a requisicao seguinte (`200`), que e o clique que o
 *     dono da logo depois ("Ja anotei, voltar");
 *  3. o cookie antigo NAO abre mais (`303`), que e o que a rotacao existe para
 *     garantir contra quem copiou o valor do envelope de step-up.
 *
 * MUTACOES QUE ESTE AUXILIAR MATA, nao enfraqueca de volta para
 * `expect(sessaoEmitidaEm(envio)).not.toBe(null)`:
 *  • **M8**: apagar `statementDeRotacao(sessao.sidHash, sessaoNova.sidHash)` do
 *    lote de `gerarCodigos` (src/routes/painel/aparelhos.ts) mantendo o
 *    `Set-Cookie`. Medido: a suite ficava VERDE (26/26 aqui, 267 em 9 suites),
 *    e em producao o dono era DESLOGADO pela propria tela dos codigos, a tela
 *    mostra os sete codigos uma vez so, o navegador guarda um cookie cujo
 *    `sid_hash` nao existe na tabela, e o clique seguinte cai em
 *    /painel/entrar. O trancamento que os codigos existem para impedir,
 *    entregue por quem os gera.
 *  • O simetrico, tambem VERIFICADO: rotacionar no banco e perder o
 *    `Set-Cookie` da sessao, trocar o `resposta.headers.append` do fim de
 *    `gerarCodigos` por `set`, que e exatamente o risco que o comentario dele
 *    descreve, faz o cookie de step-up expirado sobrescrever o da sessao. Cai
 *    em `sessaoRotacionada` ("a resposta nao rotacionou o sid"), porque nao ha
 *    cookie novo para o navegador guardar: o dono fica deslogado do outro lado.
 *  • Trocar o `UPDATE ... SET sid_hash` por um `INSERT` que deixe a linha velha
 *    viva, cai em (1) e em (3).
 */
async function esperarRotacaoNoBanco(envio: Response, antiga: Sessao): Promise<Sessao> {
  const nova = await sessaoRotacionada(envio)
  expect(nova.cookie).not.toBe(antiga.cookie)
  expect(nova.sidHash).not.toBe(antiga.sidHash)

  const sids = await sidsDeSessao()
  expect({ 'o sid novo esta em painel_sessoes': sids.includes(nova.sidHash) }).toEqual({
    'o sid novo esta em painel_sessoes': true,
  })
  expect({ 'o sid antigo sobrou em painel_sessoes': sids.includes(antiga.sidHash) }).toEqual({
    'o sid antigo sobrou em painel_sessoes': false,
  })

  // O que o navegador faz em seguida, com cada um dos dois cookies.
  expect((await abrirAparelhos(nova)).status).toBe(200)
  expect((await abrirAparelhos(antiga)).status).toBe(303)

  return nova
}

/** Os `sid_hash` que existem AGORA em `painel_sessoes`. */
async function sidsDeSessao(): Promise<string[]> {
  const resultado = await env.DB.prepare('SELECT sid_hash FROM painel_sessoes').all<{
    sid_hash: string
  }>()
  return (resultado.results ?? []).map((linha) => linha.sid_hash)
}

/** A resposta APAGOU o envelope de step-up (`Max-Age=0`)? (§10.10, passo 4) */
function envelopeExpiradoEm(resposta: Response): boolean {
  return cookiesDe(resposta).some((cookie) => cookie.startsWith('__Host-painel_stepup=;'))
}

/** Quantas falhas de step-up aquela sessao acumulou. */
async function falhasDaSessao(sidHash: string): Promise<number | null> {
  const linha = await env.DB.prepare('SELECT falhas_stepup FROM painel_sessoes WHERE sid_hash = ?')
    .bind(sidHash)
    .first<{ falhas_stepup: number }>()

  return linha?.falhas_stepup ?? null
}

// ---------------------------------------------------------------------------
// Auxiliares de leitura do banco
// ---------------------------------------------------------------------------

async function contarCredenciais(): Promise<number> {
  const linha = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_credenciais').first<{
    n: number
  }>()
  return linha?.n ?? 0
}

async function contarSessoes(): Promise<number> {
  const linha = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_sessoes').first<{
    n: number
  }>()
  return linha?.n ?? 0
}

async function acoesAuditadas(): Promise<string[]> {
  const resultado = await env.DB.prepare('SELECT acao FROM painel_auditoria ORDER BY id ASC').all<{
    acao: string
  }>()
  return (resultado.results ?? []).map((linha) => linha.acao)
}

/**
 * Gera um conjunto de codigos pela rota de PRODUCAO.
 *
 * Um codigo escrito a mao no banco provaria o hash do teste, e nao o do Worker.
 */
async function gerarCodigosPeloAssistente(): Promise<string[]> {
  const resposta = await handleGerarCodigos(
    new Request(`${RAIZ}/setup/painel/codigos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    env,
    AGORA,
  )
  return ((await resposta.json()) as { recuperacao: string[] }).recuperacao
}

/**
 * Uma recuperacao INTEIRA pela rota de producao: o codigo abre o registro e a
 * passkey nova entra.
 *
 * O que importa nos testes que a chamam e o estado que o consumo DEIXA, o
 * codigo usado com `usado_em`, os outros cinco com `invalidado_em`, as sessoes
 * apagadas. Escrever esse estado com um `UPDATE` do teste provaria o estado que
 * o teste inventou, e nao o que o Worker produz.
 */
async function usarCodigoDeRecuperacao(codigo: string): Promise<AutenticadorFalso> {
  const novo = await AutenticadorFalso.criar()

  const opcoes = await handleOpcoesDeRegistro(
    postarJson(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo }),
    env,
    AGORA,
  )
  expect(opcoes.status).toBe(200)

  const bilheteDoRegistro = /__Host-painel_desafio=([^;]*)/.exec(
    opcoes.headers.get('set-cookie') ?? '',
  )?.[1] as string
  const desafio = ((await opcoes.clone().json()) as { challenge: string }).challenge

  const credencial = await novo.registrar(
    cerimonia({ rpId: env.PANEL_RP_ID, origem: RAIZ, desafio, tipo: 'webauthn.create' }),
  )

  const verificacao = await handleVerificarRegistro(
    postarJson(
      CAMINHO_DA_VERIFICACAO,
      { apelido: 'Aparelho novo', credencial },
      `__Host-painel_desafio=${bilheteDoRegistro}`,
    ),
    env,
    AGORA,
  )
  expect(verificacao.status).toBe(200)

  return novo
}

async function postarCodigo(codigo: string): Promise<Response> {
  return await despachar(
    postarFormulario(ROTA_ENTRAR_CODIGO.caminho, `codigo=${encodeURIComponent(codigo)}`),
    env,
    AGORA,
    ROTA_ENTRAR_CODIGO,
    handleEntrarPorCodigo,
  )
}

function postarJson(caminho: string, corpo: unknown, cookie?: string): Request {
  const cabecalhos: Record<string, string> = { 'content-type': 'application/json', origin: RAIZ }
  if (cookie !== undefined) cabecalhos.cookie = cookie

  return new Request(`${RAIZ}${caminho}`, {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify(corpo),
  })
}

// ---------------------------------------------------------------------------

describe('REC: recuperacao, aparelhos e revogacao', () => {
  let aparelho: AutenticadorFalso

  beforeEach(async () => {
    await limparBanco(env.DB)
    aparelho = await AutenticadorFalso.criar()
    await cadastrarAparelho(aparelho, { apelido: 'Celular do dono', backup: true })
  })

  // -------------------------------------------------------------------------
  // A garantia que da nome a etapa
  // -------------------------------------------------------------------------

  test('REC-01: apagar a linha invalida a sessao emitida (§10.13)', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)

    expect((await abrirAparelhos(sessao)).status).toBe(200)

    const saida = await agir(sessao, 'acao=sair_de_tudo')
    expect(saida.status).toBe(303)

    // O MESMO cookie, ainda assinado e ainda dentro do prazo, deixa de valer: a
    // LINHA e a autoridade, e nao o cookie.
    const depois = await abrirAparelhos(sessao)
    expect(depois.status).toBe(303)
    expect(depois.headers.get('location')).toBe('/painel/entrar')
  })

  // -------------------------------------------------------------------------
  // A entrada por codigo de recuperacao (§10.11, §15.3 decisao 1)
  // -------------------------------------------------------------------------

  test('REC-02: o codigo correto NAO emite sessao, NAO consome e NAO grava', async () => {
    const codigos = await gerarCodigosPeloAssistente()
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      postarFormulario(ROTA_ENTRAR_CODIGO.caminho, `codigo=${codigos[0] as string}`),
      { ...env, DB: comoD1(contador) } as unknown as typeof env,
      AGORA,
      ROTA_ENTRAR_CODIGO,
      handleEntrarPorCodigo,
    )

    expect(resposta.status).toBe(200)
    // Nenhum cookie: nem de sessao, nem de bilhete. Um codigo nao vira senha.
    expect(resposta.headers.get('set-cookie')).toBe(null)
    // 1 leitura, 0 escrita, o contrato inteiro desta rota.
    expect({ escritas: contador.escritas, leituras: contador.prepares }).toEqual({
      escritas: 0,
      leituras: 1,
    })

    const corpo = await resposta.text()
    expect(corpo).toContain('Cadastrar este aparelho')
    // O codigo volta num campo ESCONDIDO, para o corpo do POST seguinte, nunca
    // na URL (§7.1).
    expect(corpo).toContain(`value="${codigos[0] as string}"`)
    expect(corpo).toContain('data-tipo="recuperacao"')

    // **O contrato desta pagina com o `painel.js`, nome por nome.** Ele procura
    // `getElementById('registrar')` e, dentro dele,
    // `querySelector('input[name="codigo"]')`; sem os dois, o dono que perdeu o
    // telefone digita o codigo do papel, aperta o botao e nada acontece, a
    // unica rota de volta ao painel morre em silencio. Renomear qualquer um dos
    // dois deixava esta suite inteira verde, porque REC-16 chama
    // `handleOpcoesDeRegistro` direto, com o codigo em JSON, e nunca toca esta
    // marcacao.
    expect(corpo).toContain('<form id="registrar"')
    expect(corpo).toContain(`name="codigo" value="${codigos[0] as string}"`)
  })

  test('REC-03: codigo errado responde igual a codigo inexistente, e nao grava', async () => {
    const console = capturarConsole()
    let semNenhum: Response
    let comOutros: Response
    try {
      // Sem nenhum codigo cadastrado.
      semNenhum = await postarCodigo('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')

      // E com seis cadastrados, errando o valor: MESMO status, MESMA frase.
      await gerarCodigosPeloAssistente()
      comOutros = await postarCodigo('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')
    } finally {
      console.parar()
    }

    expect(semNenhum.status).toBe(403)
    expect(comOutros.status).toBe(403)

    const corpoDoErrado = await comOutros.text()
    expect(await semNenhum.text()).toBe(corpoDoErrado)
    // O formulario volta com a recusa: a hora de digitar o codigo do papel e a
    // pior hora para obrigar a pessoa a procurar o caminho de novo.
    expect(corpoDoErrado).toContain(ROTA_ENTRAR_CODIGO.caminho)
    // Nenhuma escrita, em nenhum dos dois.
    expect(await acoesAuditadas()).toEqual(['codigos_gerados'])
  })

  test('REC-04: o codigo continua valendo depois do POST: quem consome e o registro', async () => {
    const codigos = await gerarCodigosPeloAssistente()

    expect((await postarCodigo(codigos[0] as string)).status).toBe(200)
    expect((await postarCodigo(codigos[0] as string)).status).toBe(200)

    const vivos = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM painel_codigos WHERE tipo = 'recuperacao' AND usado_em IS NULL",
    ).first<{ n: number }>()
    expect(vivos?.n).toBe(codigos.length)
  })

  test('REC-04b: codigo JA CONSUMIDO e recusado na porta, com a recusa de codigo inexistente', async () => {
    // Antes desta trava, `hashesVivos('recuperacao')` nao filtrava `usado_em`:
    // um codigo gasto passava AQUI, o dono percorria a cerimonia WebAuthn
    // inteira, dois gestos de biometria e uma chave nova criada no aparelho, e
    // so no fim levava `credencial_invalida`, sem nenhuma pista de que o
    // problema era o codigo. O uso unico NUNCA esteve em risco: quem o garante
    // e o `WHERE hash = ? AND usado_em IS NULL` do consumo, que e atomico. O que
    // estava errado era a HORA de contar a verdade.
    const codigos = await gerarCodigosPeloAssistente()
    const codigo = codigos[0] as string

    // Contrapositivo, e ele e obrigatorio: sem esta linha o teste passaria
    // igual com a porta recusando tudo.
    expect((await postarCodigo(codigo)).status).toBe(200)

    // Marca como consumido do mesmo jeito que o registro marca. O papel inteiro
    // vai junto porque o teste nao tem a subchave para descobrir qual linha e
    // qual codigo, e nao precisa: o que se afirma e o comportamento da porta
    // diante de uma linha com `usado_em` preenchido.
    await env.DB.prepare("UPDATE painel_codigos SET usado_em = ? WHERE tipo = 'recuperacao'")
      .bind(AGORA)
      .run()

    const depois = await postarCodigo(codigo)
    const inexistente = await postarCodigo('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')

    expect(depois.status).toBe(403)
    // A recusa e a MESMA de codigo inexistente (§10.3): separar os dois casos
    // daria um oraculo de enumeracao a quem tem a tela publica na mao.
    expect(await depois.text()).toBe(await inexistente.text())

    // E a porta nao ficou quebrada para sempre: um papel NOVO volta a passar.
    const novos = await gerarCodigosPeloAssistente()
    expect((await postarCodigo(novos[0] as string)).status).toBe(200)
  })

  test('REC-05: a rota do codigo corre sob a familia `codigo` do limitador (§7.4)', async () => {
    const limitador = new LimitadorFalso({ permitido: false, esperarSegundos: 42 })

    const console = capturarConsole()
    let resposta: Response
    try {
      resposta = await despachar(
        postarFormulario(ROTA_ENTRAR_CODIGO.caminho, 'codigo=qualquer'),
        env,
        AGORA,
        ROTA_ENTRAR_CODIGO,
        handleEntrarPorCodigo,
        { limite: 'codigo', limitador },
      )
    } finally {
      console.parar()
    }

    expect(resposta.status).toBe(429)
    expect(resposta.headers.get('retry-after')).toBe('42')
    // O prefixo do balde e o de §7.4, e nao o do login: misturar os dois faria
    // uma rajada na entrada por codigo trancar quem tenta entrar com a digital.
    expect(limitador.chaves.every((chave) => chave.startsWith('codigo:'))).toBe(true)
    // Tentativa recusada pelo limitador nao toca o banco (RL-05).
    expect(await acoesAuditadas()).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Varios aparelhos, o teto de 10 e a regra da ultima (§10.13)
  // -------------------------------------------------------------------------

  test('REC-06: a tela lista os aparelhos com apelido, datas e as flags BE/BS', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa', backup: false })

    const sessao = await abrirSessao(aparelho.credentialId)
    const corpo = await (await abrirAparelhos(sessao)).text()

    expect(corpo).toContain('Celular do dono')
    expect(corpo).toContain('Tablet da mesa')
    // As duas frases de §3, e elas sao o que a pessoa realmente precisa saber.
    expect(corpo).toContain('Est&aacute; salvo na conta do celular')
    expect(corpo).toContain('Existe s&oacute; neste aparelho')
    // O aviso do endereco, obrigatorio (§10.14).
    expect(corpo).toContain(env.PANEL_RP_ID)
    expect(corpo).toContain('precisar')
    // E o aviso de §10.13 sobre a sessao atual.
    expect(corpo).toContain('Este &eacute; o aparelho que voc&ecirc; est&aacute; usando')
  })

  test('REC-07: a tela NUNCA exibe o `credential_id` inteiro (§10.13)', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)
    const corpo = await (await abrirAparelhos(sessao)).text()

    // Nem o prefixo de 8 hex aparece na lista: ele so serve na tela de
    // conferencia da remocao, que e onde a pessoa confere o alvo (REC-10).
    expect(corpo).not.toContain(await prefixoDeCredencial(aparelho.credentialId))
    expect(corpo).not.toContain('Identifica')

    // O id cru existe em UM lugar so, e e o `value` do campo escondido que diz
    // ao POST qual linha apagar. Fora dali, nenhuma ocorrencia.
    const ocorrencias = corpo.split(aparelho.credentialId).length - 1
    expect(ocorrencias).toBe(1)
    expect(corpo).toContain(
      `<input type="hidden" name="${CAMPO_DO_APARELHO}" value="${aparelho.credentialId}">`,
    )
  })

  test('REC-08: nao da para remover a ultima (§10.13)', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    let envio: Response
    try {
      envio = (await comDigital(sessao, `acao=remover&aparelho=${aparelho.credentialId}`, aparelho))
        .envio
    } finally {
      console.parar()
    }

    expect(envio.status).toBe(409)
    expect(await envio.text()).toContain('Cadastre outro aparelho antes de remover este.')
    // A linha continua, e a sessao dela tambem: uma remocao recusada nao pode
    // deslogar quem tentou.
    expect(await contarCredenciais()).toBe(1)
    expect(await contarSessoes()).toBe(1)
    // E nao ha linha de `passkey_removida` mentindo no historico. A de
    // `stepup_recusado` E esperada: `comDigital` comeca pelo POST sem digital,
    // que e o primeiro envio de todo caminho positivo, e §10.10 manda registrar
    // tambem a tentativa recusada por step-up ausente.
    expect(await acoesAuditadas()).toEqual(['stepup_recusado'])
  })

  test('REC-08b: a regra da ultima e ATOMICA: duas remocoes juntas, uma so vence', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })

    // Duas sessoes vivas, como as duas abas do cenario: cada uma prepara a
    // remocao do aparelho da OUTRA. Sao alvos diferentes de proposito, dois
    // POSTs para a MESMA linha nao distinguem nada, porque o segundo acha a
    // linha ja apagada de qualquer jeito.
    const daPrimeira = await abrirSessao(aparelho.credentialId)
    const daSegunda = await abrirSessao(outro.credentialId)

    const console = capturarConsole()
    let respostas: Response[]
    try {
      const primeira = await prepararEnvio(
        daPrimeira,
        `acao=remover&aparelho=${outro.credentialId}`,
        aparelho,
      )
      const segunda = await prepararEnvio(
        daSegunda,
        `acao=remover&aparelho=${aparelho.credentialId}`,
        outro,
      )

      // O `Promise.all` e o teste: as duas cerimonias ja passaram, e os dois
      // POSTs entram no Worker juntos. Uma regra escrita como
      // `if (await contarCredenciais() > 1) DELETE` deixa as duas verem "duas"
      // antes de qualquer escrita, apaga as duas, e o dono acorda com ZERO
      // passkeys, trancado fora do painel, com saida so pelo papel. E o
      // desfecho que a regra da ultima existe para impedir, e ele so aparece
      // com os envios simultaneos.
      respostas = await Promise.all([primeira.disparar(), segunda.disparar()])
    } finally {
      console.parar()
    }

    // O invariante, e nao a ordem: quem venceu a corrida nao importa.
    expect(await contarCredenciais()).toBe(1)

    const removidas = (await acoesAuditadas()).filter((acao) => acao === 'passkey_removida')
    expect(removidas.length).toBe(1)

    const venceram = respostas.filter(
      (resposta) =>
        resposta.status === 303 &&
        resposta.headers.get('location') === `${ROTA_APARELHOS.caminho}?ok=aparelho_removido`,
    )
    expect(venceram.length).toBe(1)
  })

  test('REC-09: remover apaga a credencial E as sessoes dela, e so as dela', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })

    const sessao = await abrirSessao(aparelho.credentialId)
    const sessaoDoOutro = await abrirSessao(outro.credentialId)

    const { envio } = await comDigital(
      sessao,
      `acao=remover&aparelho=${outro.credentialId}`,
      aparelho,
    )

    expect(envio.status).toBe(303)
    expect(envio.headers.get('location')).toBe(`${ROTA_APARELHOS.caminho}?ok=aparelho_removido`)
    expect(await contarCredenciais()).toBe(1)

    // A sessao do aparelho removido morreu; a de quem removeu continua viva,
    // **com o `sid` NOVO**. §10.10, passo 4: a mesma resposta que aplica a
    // mudanca expira o envelope e rotaciona o `sid`, entao o cookie ANTIGO
    // deixa de valer junto com ele. Seguir o `Set-Cookie`, como o navegador
    // faz, e o que prende a rotacao; afirmar `200` no cookie velho prenderia
    // justamente a AUSENCIA dela.
    expect((await abrirAparelhos(sessaoDoOutro)).status).toBe(303)

    // O MESMO auxiliar de REC-14, de proposito: as duas acoes protegidas de
    // §10.10 que rotacionam o `sid` (`remover_passkey` aqui, `gerar_codigos`
    // la) passam pela mesma trava, e a assimetria que deixou `gerar_codigos`
    // com uma assercao de cabecalho por um ciclo inteiro nao tem mais onde
    // reaparecer.
    await esperarRotacaoNoBanco(envio, sessao)

    // Sem log, sem mudanca: a linha saiu no MESMO lote (§8.8), com o prefixo no
    // `alvo` e nunca o id cru.
    // `stepup_recusado` e o primeiro envio (sem digital), e `passkey_removida` e
    // o segundo. As duas linhas juntas sao o rastro de §9.9 de uma remocao.
    expect(await acoesAuditadas()).toEqual(['stepup_recusado', 'passkey_removida'])
    const linha = await env.DB.prepare(
      'SELECT alvo, step_up FROM painel_auditoria ORDER BY id DESC LIMIT 1',
    ).first<{ alvo: string; step_up: number }>()
    expect(linha?.alvo).toBe(await prefixoDeCredencial(outro.credentialId))
    expect(linha?.step_up).toBe(1)
  })

  test('REC-10: remover exige step-up, e o `op_hash` prende AQUELE aparelho', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    try {
      // Sem digital: a tela de conferencia, e nada removido.
      const semDigital = await agir(sessao, `acao=remover&aparelho=${outro.credentialId}`)
      expect(semDigital.status).toBe(403)
      expect(await contarCredenciais()).toBe(2)

      const tela = await semDigital.text()
      expect(mudancaDaTela(tela)).toEqual({ acao: 'remover_passkey', alvo: outro.credentialId })

      // A digital colhida para o aparelho A nao remove o aparelho B: o servidor
      // recalcula o `op_hash` do corpo que ELE recebeu.
      const cerimoniaResposta = await pedirOpcoesDeStepUp(sessao, {
        acao: 'remover_passkey',
        alvo: outro.credentialId,
      })
      const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
      const envelope = cookieDoEnvelope(cerimoniaResposta)
      const digital = await digitalPara(aparelho, challenge)

      const trocado = await despachar(
        postarFormulario(
          ROTA_APARELHOS.caminho,
          new URLSearchParams({
            csrf: sessao.ficha,
            acao: 'remover',
            aparelho: aparelho.credentialId,
            digital,
          }).toString(),
          `${sessao.cookie}; ${envelope}`,
        ),
        env,
        AGORA,
        ALVO.rota,
        ALVO.handler,
      )

      expect(trocado.status).toBe(403)
      expect(await contarCredenciais()).toBe(2)
      expect(console.linhas.join(' ')).toContain('conteudo_diferente')
    } finally {
      console.parar()
    }
  })

  test('REC-11: credencial de endereco antigo aparece como tal e nao segura a ultima', async () => {
    const velho = await AutenticadorFalso.criar()
    await cadastrarAparelho(velho, { apelido: 'Celular antigo', rpId: ENDERECO_ANTIGO })

    const sessao = await abrirSessao(aparelho.credentialId)
    const corpo = await (await abrirAparelhos(sessao)).text()

    // Sem o endereco tecnico no cartao: a frase diz o que importa.
    expect(corpo).not.toContain(ENDERECO_ANTIGO)
    expect(corpo).toContain('n&atilde;o consegue mais')

    // Ela nao conta para a regra da ultima: remover a UNICA do endereco de hoje
    // continua sendo recusado, mesmo com duas linhas na tabela.
    const console = capturarConsole()
    try {
      const { envio } = await comDigital(
        sessao,
        `acao=remover&aparelho=${aparelho.credentialId}`,
        aparelho,
      )
      expect(envio.status).toBe(409)
    } finally {
      console.parar()
    }
    expect(await contarCredenciais()).toBe(2)
  })

  test('REC-20: credencial de endereco antigo sai livremente, inclusive TODAS (§10.14)', async () => {
    const velho = await AutenticadorFalso.criar()
    const outroVelho = await AutenticadorFalso.criar()
    await cadastrarAparelho(velho, { apelido: 'Celular antigo', rpId: ENDERECO_ANTIGO })
    await cadastrarAparelho(outroVelho, { apelido: 'Tablet antigo', rpId: ENDERECO_ANTIGO })

    // O cartao dessas linhas diz "Pode ser removido sem medo" e desenha o botao
    // de remover. Enquanto o `DELETE` casava a LINHA pelo `rp_id` de hoje, o
    // botao nao podia funcionar nunca: `changes === 0` virava
    // `409 ultima_passkey`, "Cadastre outra passkey antes de remover esta",
    // com duas passkeys do endereco de hoje na tabela, e sem linha de auditoria
    // nem revogacao de sessao, porque os passos seguintes do lote sao presos a
    // mudanca. O celular perdido do endereco antigo ficava no banco para sempre.
    let sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    try {
      for (const alvo of [velho, outroVelho]) {
        const { envio } = await comDigital(
          sessao,
          `acao=remover&aparelho=${alvo.credentialId}`,
          aparelho,
        )
        expect(envio.status).toBe(303)
        expect(envio.headers.get('location')).toBe(`${ROTA_APARELHOS.caminho}?ok=aparelho_removido`)
        // O passo 4 de §10.10 rotacionou o `sid`: a proxima cerimonia vai com a
        // sessao nova, como o navegador iria.
        sessao = await sessaoRotacionada(envio)
      }
    } finally {
      console.parar()
    }

    // "Inclusive todas": as DUAS do endereco antigo sairam, e a unica do
    // endereco de hoje continua, a regra da ultima conta so o `rp_id` atual.
    expect(await contarCredenciais()).toBe(1)
    const removidas = (await acoesAuditadas()).filter((acao) => acao === 'passkey_removida')
    expect(removidas.length).toBe(2)

    const restante = await env.DB.prepare('SELECT rp_id FROM painel_credenciais').first<{
      rp_id: string
    }>()
    expect(restante?.rp_id).toBe(env.PANEL_RP_ID)
  })

  test('REC-21: o envelope de step-up morre na requisicao que o usa (§10.10, passo 4)', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    let envio: Response
    let envelope: string
    let campos: URLSearchParams
    try {
      const feito = await comDigital(
        sessao,
        `acao=remover&aparelho=${outro.credentialId}`,
        aparelho,
      )
      envio = feito.envio
      envelope = feito.envelope
      campos = feito.campos
      expect(envio.status).toBe(303)

      // Os dois `Set-Cookie` juntos sao a garantia: o envelope morre, e o `sid`
      // que ele nomeia deixa de existir.
      expect(envelopeExpiradoEm(envio)).toBe(true)
      const nova = await sessaoRotacionada(envio)

      // O reenvio do MESMO par (envelope + digital), agora com a sessao NOVA,
      // o que um script na pagina faria dentro dos 120 s restantes. Sem a
      // rotacao, `exigirStepUp` fecharia de novo e um gesto do dono autorizaria
      // N operacoes; com ela, o `sid` do envelope nao e mais o da sessao.
      const repetido = await despachar(
        postarFormulario(
          ROTA_APARELHOS.caminho,
          new URLSearchParams({ ...Object.fromEntries(campos), csrf: nova.ficha }).toString(),
          `${nova.cookie}; ${envelope}`,
        ),
        env,
        AGORA,
        ALVO.rota,
        ALVO.handler,
      )

      // `403` de step-up, e nao o `409` de "ja removido": a recusa acontece
      // ANTES de a rota chegar ao banco.
      expect(repetido.status).toBe(403)
      expect(console.linhas.join(' ')).toContain('sessao_diferente')
    } finally {
      console.parar()
    }

    expect(await contarCredenciais()).toBe(1)
  })

  test('REC-22: falha de step-up em /painel/aparelhos conta, e a decima apaga a sessao', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    try {
      // `digital` PREENCHIDA e invalida, sem envelope nenhum. O envio sem
      // digital e o primeiro passo do caminho normal e nao conta (§10.10); este
      // e martelada, e conta.
      for (let tentativa = 1; tentativa < FALHAS_DE_STEPUP_ATE_APAGAR; tentativa++) {
        const recusa = await agir(
          sessao,
          `acao=remover&aparelho=${outro.credentialId}&digital=nao-e-uma-assertion`,
        )
        expect({ tentativa, status: recusa.status }).toEqual({ tentativa, status: 403 })
        expect({ tentativa, falhas: await falhasDaSessao(sessao.sidHash) }).toEqual({
          tentativa,
          falhas: tentativa,
        })
      }

      // Nove falhas: a sessao continua de pe.
      expect(await contarSessoes()).toBe(1)

      const decima = await agir(
        sessao,
        `acao=remover&aparelho=${outro.credentialId}&digital=nao-e-uma-assertion`,
      )
      expect(decima.status).toBe(403)
    } finally {
      console.parar()
    }

    // A decima apaga a linha, e o cookie que ainda esta assinado deixa de valer
    // quem roubou a sessao perde a unica tela que remove aparelhos.
    expect(await contarSessoes()).toBe(0)
    expect((await abrirAparelhos(sessao)).status).toBe(303)
    expect(await contarCredenciais()).toBe(2)
  })

  test('REC-23: a tela de conferencia diz QUAL aparelho vai sair (§10.10, §10.13)', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    let doOutro: string
    let doAtual: string
    try {
      doOutro = await (await agir(sessao, `acao=remover&aparelho=${outro.credentialId}`)).text()
      doAtual = await (await agir(sessao, `acao=remover&aparelho=${aparelho.credentialId}`)).text()
    } finally {
      console.parar()
    }

    // §10.10: "a tela TEM QUE mostrar o valor literal antes da biometria", e em
    // `remover_passkey` o valor literal E o aparelho. Sem isto o dono encosta o
    // dedo sem nada na tela que contradiga um `value` trocado por um XSS.
    expect(doOutro).toContain('Tablet da mesa')
    expect(doOutro).toContain(await prefixoDeCredencial(outro.credentialId))
    // E nao mostra o aparelho ERRADO: conferir o alvo so vale se for o alvo.
    expect(doOutro).not.toContain('Celular do dono')

    // O id cru continua so nos DOIS lugares que a cerimonia exige, e nenhum
    // deles e texto que a pessoa le: o campo escondido que diz ao POST qual
    // linha apagar, e o `data-mudanca` que o `painel.js` manda assinar. O
    // resumo acima usa o prefixo de 8 hex, como §10.13 manda, uma terceira
    // ocorrencia aqui e o id cru tendo vazado para a tela.
    expect(doOutro.split(outro.credentialId).length - 1).toBe(2)

    // E quando o alvo e a sessao de agora, o aviso obrigatorio de §10.13.
    expect(doAtual).toContain('Celular do dono')
    expect(doAtual).toContain('Este &eacute; o aparelho que voc&ecirc; est&aacute; usando')
  })

  test('REC-12: o teto de 10 credenciais por endereco vale na GRAVACAO', async () => {
    // Enche ate o teto com aparelhos deste endereco.
    for (let i = 1; i < TETO_DE_CREDENCIAIS; i++) {
      await cadastrarAparelho(await AutenticadorFalso.criar(), { apelido: `Aparelho ${i}` })
    }
    expect(await contarCredenciais()).toBe(TETO_DE_CREDENCIAIS)

    const codigos = await gerarCodigosPeloAssistente()
    const console = capturarConsole()
    let opcoes: Response
    try {
      opcoes = await handleOpcoesDeRegistro(
        postarJson(CAMINHO_DAS_OPCOES, { tipo: 'recuperacao', codigo: codigos[0] as string }),
        env,
        AGORA,
      )
    } finally {
      console.parar()
    }

    // A cerimonia nem comeca: gastar uma biometria do dono para recusar no fim
    // seria pior do que recusar antes.
    expect(opcoes.status).toBe(401)
    expect(await contarCredenciais()).toBe(TETO_DE_CREDENCIAIS)
    // E a tela diz por que, em vez de mostrar um botao que so pode falhar.
    const sessao = await abrirSessao(aparelho.credentialId)
    expect(await (await abrirAparelhos(sessao)).text()).toContain('limite de aparelhos')
  })

  // -------------------------------------------------------------------------
  // Sair de todos os aparelhos: sem step-up, porque desligar e barato
  // -------------------------------------------------------------------------

  test('REC-13: `sair_de_tudo` NAO pede step-up e apaga TODAS as sessoes (§10.10)', async () => {
    const outro = await AutenticadorFalso.criar()
    await cadastrarAparelho(outro, { apelido: 'Tablet da mesa' })
    const sessao = await abrirSessao(aparelho.credentialId)
    await abrirSessao(outro.credentialId)
    expect(await contarSessoes()).toBe(2)

    const resposta = await agir(sessao, 'acao=sair_de_tudo')

    expect(resposta.status).toBe(303)
    // O `303` vai para a tela de ENTRAR, e nao para `/painel/aparelhos`: quem
    // apertou o botao acabou de perder a propria sessao, e a frase precisa
    // aparecer onde a pessoa esta a partir daquele instante.
    expect(resposta.headers.get('location')).toBe('/painel/entrar?ok=saiu_de_tudo')
    expect(await contarSessoes()).toBe(0)
    // Nenhum aparelho perdeu o cadastro: sair nao e remover.
    expect(await contarCredenciais()).toBe(2)
    // Sem log, sem mudanca (§8.8), e sem step-up na coluna.
    expect(await acoesAuditadas()).toEqual(['sessao_encerrada'])
    const linha = await env.DB.prepare(
      'SELECT step_up FROM painel_auditoria ORDER BY id DESC LIMIT 1',
    ).first<{ step_up: number }>()
    expect(linha?.step_up).toBe(0)

    // E a frase da lista fechada aparece na tela de entrar.
    const entrar = await despachar(
      new Request(`${RAIZ}/painel/entrar?ok=saiu_de_tudo`),
      env,
      AGORA,
      {
        ...ROTA_APARELHOS,
        caminho: '/painel/entrar',
        metodos: ['GET'],
        sessao: false,
        csrf: false,
      },
      (await import('../src/routes/painel/entrar')).handlePaginaDeEntrar,
    )
    expect(await entrar.text()).toContain('Você saiu de todos os aparelhos')
  })

  // -------------------------------------------------------------------------
  // Gerar codigos pela tela, com step-up (§10.11)
  // -------------------------------------------------------------------------

  test('REC-14: gerar codigos pela tela exige step-up e mostra o conjunto UMA vez', async () => {
    const antigos = await gerarCodigosPeloAssistente()
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    let semDigital: Response
    try {
      semDigital = await agir(sessao, 'acao=gerar_codigos')
    } finally {
      console.parar()
    }
    expect(semDigital.status).toBe(403)

    const { envio } = await comDigital(sessao, 'acao=gerar_codigos', aparelho)
    expect(envio.status).toBe(200)

    // §10.10, passo 4, tambem na acao que responde `200`: o envelope morre e o
    // `sid` que ele nomeia deixa de existir na MESMA resposta que aplica. Sem a
    // rotacao, o envelope expirado no navegador nao adianta contra quem ja
    // copiou o valor dele, e um gesto do dono continuaria autorizando conjunto
    // novo de codigos pelo resto dos 120 s.
    expect(envelopeExpiradoEm(envio)).toBe(true)
    // **E a rotacao e conferida no BANCO e no pedido seguinte**, nao pela
    // presenca do cabecalho: `esperarRotacaoNoBanco` exige que o `sid` novo
    // exista em `painel_sessoes`, que o antigo tenha morrido, que o cookie novo
    // ABRA a tela (o clique "Ja anotei, voltar", logo abaixo desta pagina) e que
    // o antigo nao abra mais. Enquanto aqui bastava
    // `expect(sessaoEmitidaEm(envio)).not.toBe(null)`, apagar a rotacao do lote
    // (mutacao M8, descrita no auxiliar) deslogava o dono NA TELA DOS CODIGOS
    // com a suite inteira verde, no unico instante em que ele nao pode ser
    // interrompido, porque os codigos aparecem uma vez so (§10.11) e os antigos
    // acabaram de ser apagados.
    const nova = await esperarRotacaoNoBanco(envio, sessao)

    // O clique de verdade: o link "Ja anotei, voltar" desta pagina, com o
    // cookie que ela devolveu. `esperarRotacaoNoBanco` ja mediu o `200`; aqui a
    // tela e lida para provar que e a de Aparelhos, e nao a de entrar.
    expect(await (await abrirAparelhos(nova)).text()).toContain(
      '<h1>Aparelhos e c&oacute;digos</h1>',
    )

    const corpo = await envio.text()
    // Os seis de recuperacao e o da parada, na tela, uma vez so.
    expect(corpo).toContain('Anote estes c&oacute;digos agora')
    // Seis de 20 caracteres (`XXXXX-XXXXX-XXXXX-XXXXX`, 23 com hifens) e um de
    // 16 (o da parada, `XXXXX-XXXXX-XXXXXX`, 18 com hifens, o ultimo grupo
    // absorve o resto). O piso do casamento e o menor dos dois.
    const mostrados = [...corpo.matchAll(/<code>([A-Z0-9-]{18,})<\/code>/g)]
    expect(mostrados.length).toBe(7)

    // O conjunto antigo morreu inteiro: nenhum dos codigos velhos abre mais a
    // tela de cadastro.
    expect((await postarCodigo(antigos[0] as string)).status).toBe(403)

    // `codigos_gerados` do assistente; DOIS `stepup_recusado`, o envio sem
    // digital que este teste faz de proposito e o primeiro envio de
    // `comDigital`, que e o caminho normal de quem aperta o botao; e enfim o
    // `codigos_gerados` da tela. §10.10 manda registrar as duas recusas.
    expect(await acoesAuditadas()).toEqual([
      'codigos_gerados',
      'stepup_recusado',
      'stepup_recusado',
      'codigos_gerados',
    ])
  })

  // -------------------------------------------------------------------------
  // Cadastrar outro aparelho pela sessao (§10.13)
  // -------------------------------------------------------------------------

  test('REC-15: cadastrar outro aparelho exige o step-up de `adicionar_passkey`', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)
    const novo = await AutenticadorFalso.criar()

    const console = capturarConsole()
    try {
      // Sem digital nenhuma: recusado, e nada gravado.
      const semNada = await handleOpcoesDeRegistro(
        postarJson(CAMINHO_DAS_OPCOES, { tipo: 'sessao' }, sessao.cookie),
        env,
        AGORA,
        {},
      )
      expect(semNada.status).toBe(403)

      // Com a cerimonia inteira: `{acao:'adicionar_passkey'}`, o envelope, a
      // digital do aparelho JA cadastrado e so entao a criacao da chave nova.
      const cerimoniaResposta = await pedirOpcoesDeStepUp(sessao, { acao: 'adicionar_passkey' })
      const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
      const envelope = cookieDoEnvelope(cerimoniaResposta)
      const digital = await digitalPara(aparelho, challenge)

      const pedido = new Request(`${RAIZ}${CAMINHO_DAS_OPCOES}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: RAIZ,
          cookie: `${sessao.cookie}; ${envelope}`,
          'x-painel-csrf': sessao.ficha,
        },
        body: JSON.stringify({ tipo: 'sessao', digital, apelido: 'Aparelho novo' }),
      })
      const opcoes = await handleOpcoesDeRegistro(pedido, env, AGORA)
      expect(opcoes.status).toBe(200)

      const bilheteDoRegistro = /__Host-painel_desafio=([^;]*)/.exec(
        opcoes.headers.get('set-cookie') ?? '',
      )?.[1] as string
      const desafio = ((await opcoes.clone().json()) as { challenge: string }).challenge

      const credencial = await novo.registrar(
        cerimonia({
          rpId: env.PANEL_RP_ID,
          origem: RAIZ,
          desafio,
          tipo: 'webauthn.create',
        }),
      )

      const verificacao = await handleVerificarRegistro(
        postarJson(
          CAMINHO_DA_VERIFICACAO,
          { apelido: 'Aparelho novo', credencial },
          `__Host-painel_desafio=${bilheteDoRegistro}`,
        ),
        env,
        AGORA,
      )

      expect(verificacao.status).toBe(200)
      // Registrar NAO emite sessao (§15.3 decisao 5).
      expect(verificacao.headers.get('set-cookie')).not.toContain('__Host-painel_sessao=')
      expect(await verificacao.json()).toEqual({ ok: true, para: '/painel/entrar' })
    } finally {
      console.parar()
    }

    expect(await contarCredenciais()).toBe(2)
    expect(await acoesAuditadas()).toEqual(['passkey_registrada'])
  })

  test('REC-16: o codigo de recuperacao usado invalida os demais e derruba as sessoes', async () => {
    const codigos = await gerarCodigosPeloAssistente()
    await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    try {
      await usarCodigoDeRecuperacao(codigos[0] as string)
    } finally {
      console.parar()
    }

    // Invalidacao em bloco: se um codigo foi usado por quem nao devia, os
    // outros estao na mesma lista vazada (§10.11).
    const vivos = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM painel_codigos
        WHERE tipo = 'recuperacao' AND usado_em IS NULL AND invalidado_em IS NULL`,
    ).first<{ n: number }>()
    expect(vivos?.n).toBe(0)

    // E qualquer sessao aberta pode ser dele.
    expect(await contarSessoes()).toBe(0)
    expect(await acoesAuditadas()).toEqual(['codigos_gerados', 'recuperacao_usada'])
  })

  test('REC-24: depois de uma recuperacao a tela diz que ha ZERO codigos valendo', async () => {
    const codigos = await gerarCodigosPeloAssistente()

    const antes = await abrirSessao(aparelho.credentialId)
    expect(await (await abrirAparelhos(antes)).text()).toContain(
      `<strong>${String(codigos.length)}</strong>`,
    )

    const console = capturarConsole()
    try {
      await usarCodigoDeRecuperacao(codigos[2] as string)
    } finally {
      console.parar()
    }

    // A recuperacao apaga TODAS as sessoes (§10.11); o dono entra de novo, com o
    // aparelho que acabou de cadastrar, e vai conferir a rede de seguranca.
    const depois = await abrirSessao(aparelho.credentialId)
    const tela = await (await abrirAparelhos(depois)).text()

    // O consumo marca `usado_em` no codigo usado e `invalidado_em` nos outros
    // cinco. Contar so `invalidado_em IS NULL`, que e o que `hashesVivos` faz,
    // e faz DE PROPOSITO, porque o codigo de PARADA nao e de uso unico, deixa
    // exatamente um hash de pe: o do codigo ja queimado. A tela escrevia entao
    // "voce ainda tem 1 codigos que nunca foram usados", em verde, com ZERO
    // codigos utilizaveis, e o dono so descobria na proxima perda de aparelho,
    // trancado fora do painel.
    expect(tela).toContain('n&atilde;o tem nenhum')
    expect(tela).not.toContain('ainda tem')
  })

  // -------------------------------------------------------------------------
  // As rotas administrativas (§7.1, §10.8)
  // -------------------------------------------------------------------------

  test('REC-17: `/setup/painel/zerar` exige Bearer e nao toca `account_tokens`', async () => {
    await env.DB.prepare(
      `INSERT INTO account_tokens (id, ig_user_id, encrypted_token, expires_at, created_at, updated_at)
       VALUES (1, '17841400000000000', 'cifrado-ficticio', ?, ?, ?)`,
    )
      .bind(AGORA + 60_000, AGORA, AGORA)
      .run()
    await abrirSessao(aparelho.credentialId)

    // Sem cabecalho: 401, e nada acontece.
    const semToken = await handleZerarAcesso(
      new Request(`${RAIZ}/setup/painel/zerar`, { method: 'POST' }),
      env,
      AGORA,
    )
    expect(semToken.status).toBe(401)
    expect(await contarSessoes()).toBe(1)

    // Com Bearer e sem `?tudo=1`: so as sessoes.
    const soSessoes = await handleZerarAcesso(
      new Request(`${RAIZ}/setup/painel/zerar`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
      env,
      AGORA,
    )
    expect(soSessoes.status).toBe(200)
    expect(await contarSessoes()).toBe(0)
    expect(await contarCredenciais()).toBe(1)

    // Com `?tudo=1`: tambem as credenciais.
    const tudo = await handleZerarAcesso(
      new Request(`${RAIZ}/setup/painel/zerar?tudo=1`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
      env,
      AGORA,
    )
    expect(tudo.status).toBe(200)
    expect(await contarCredenciais()).toBe(0)

    // A conexao com o Instagram continua intacta, a regressao escrita em §13.2.
    const conta = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_tokens').first<{
      n: number
    }>()
    expect(conta?.n).toBe(1)

    expect(await acoesAuditadas()).toEqual(['acesso_zerado', 'acesso_zerado'])
  })

  // -------------------------------------------------------------------------
  // A lingua das duas telas novas (§12.1, §12.7)
  // -------------------------------------------------------------------------

  test('REC-18: nenhuma palavra proibida do glossario nas duas telas novas', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)

    const telas: { nome: string; corpo: string }[] = [
      { nome: ROTA_APARELHOS.caminho, corpo: await (await abrirAparelhos(sessao)).text() },
      {
        nome: ROTA_ENTRAR_CODIGO.caminho,
        corpo: await (
          await despachar(
            new Request(`${RAIZ}${ROTA_ENTRAR_CODIGO.caminho}`),
            env,
            AGORA,
            ROTA_ENTRAR_CODIGO,
            handleEntrarPorCodigo,
          )
        ).text(),
      },
    ]

    for (const tela of telas) {
      // So o `<body>`: o `<head>` carrega `stylesheet` e `viewport`, que sao
      // atributos de HTML e nao texto que alguem le na tela.
      const corpo = /<body>([\s\S]*)<\/body>/.exec(tela.corpo)?.[1] ?? tela.corpo

      // Contrapositivo: um corpo vazio passaria calado.
      expect({ [tela.nome]: corpo.length > 500 }).toEqual({ [tela.nome]: true })

      for (const proibida of PALAVRAS_PROIBIDAS) {
        const onde = `${proibida} em ${tela.nome}`
        expect({ [onde]: contemPalavra(corpo, proibida) }).toEqual({ [onde]: false })
      }
    }
  })

  test('REC-19: o GET de `/painel/aparelhos` executa ZERO escritas no D1 (§6)', async () => {
    const sessao = await abrirSessao(aparelho.credentialId)
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      pedirTela(ROTA_APARELHOS.caminho, sessao.cookie),
      { ...env, DB: comoD1(contador) } as unknown as typeof env,
      AGORA,
      ALVO.rota,
      ALVO.handler,
    )

    expect(resposta.status).toBe(200)
    expect({ escritas: contador.escritas }).toEqual({ escritas: 0 })
  })
})
