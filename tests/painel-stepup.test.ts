import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { CAMPO_DA_ACAO } from '../src/routes/painel/campos'
import { TELA_DOS_REELS } from '../src/routes/painel/dicionario'
import { gravarConfiguracao } from '../src/routes/painel/gravar'
import { handleChave } from '../src/routes/painel/inicio'
import { handleMensagem } from '../src/routes/painel/mensagem'
import { esquecerAListagem } from '../src/routes/painel/midias'
import { handlePalavras } from '../src/routes/painel/palavras'
import { CAMPO_DO_REEL, handleReel, SEGUIR_O_GERAL } from '../src/routes/painel/reel'
import { handleReels } from '../src/routes/painel/reels'
import {
  ROTA_AJUSTES,
  ROTA_CHAVE,
  ROTA_INICIO,
  ROTA_MENSAGEM,
  ROTA_OPCOES_DE_STEPUP,
  ROTA_PALAVRAS,
  ROTA_REEL,
  ROTA_REELS,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import { handleOpcoesDeStepUp, jsonCanonico, opHash } from '../src/routes/painel/stepup'
import { PRAZO_DE_ENVELOPE_MS } from '../src/security/signed-envelope'
import { invalidarCacheDeConfig } from '../src/services/config-store'
import { limparTexto } from '../src/services/config-validation'
import {
  emitirEnvelope,
  emitirSessao,
  fichaCsrf,
  PRAZO_OCIOSO_DE_SESSAO_MS,
} from '../src/services/panel-session'
import { prefixoDeCredencial } from '../src/services/webauthn/verificar'
import { AutenticadorFalso, cerimonia, semUv } from './fixtures/autenticador'
import { gravarConfig, gravarMidia, limparBanco } from './fixtures/banco'
import { AGORA, capturarConsole, RAIZ } from './fixtures/dubles'

/**
 * STEP — o step-up de §10.10: uma operacao, presa ao conteudo.
 *
 * As 17 garantias de §13.2 sao STEP-01 a STEP-17; STEP-18 a STEP-21 sao o
 * "mais" da mesma linha — `json_canonico` com vetores congelados e o mesmo hash
 * a partir do JSON da cerimonia e do formulario urlencoded. STEP-22 em diante
 * sao as travas da cerimonia e da tela que as dezessete nao nomeiam mas das
 * quais dependem. STEP-39 mora junto dos vetores por assunto e nao por numero:
 * ele nasceu na etapa 12c, e renumerar os que ja existiam trocaria o nome de
 * testes que outros documentos citam.
 *
 * **A cerimonia e feita de verdade, ponta a ponta.** Nada de `vi.mock`: o
 * `AutenticadorFalso` produz os mesmos bytes que um autenticador real
 * produziria, e as rotas sao chamadas por `despachar`, a MESMA funcao que o
 * roteador usa — um teste que chamasse o handler direto pularia a escada de
 * §11.3 e afirmaria menos do que parece.
 *
 * **Nenhum valor da instalacao do dono entra neste arquivo.** Texto, link e
 * dominio sao ficticios, pelo mesmo motivo que `configDeTeste` existe: este
 * repositorio e um template publico.
 */

const FORMULARIO = 'application/x-www-form-urlencoded'
const HANDLE_DO_DONO = 'handle-do-dono-de-teste'

/** Dominio FICTICIO, e o mesmo que a linha de config de teste usa. */
const DOMINIO_DE_TESTE = 'exemplo.com'

/** Textos e link FICTICIOS. Nunca os da instalacao de quem escreveu o teste. */
const TEXTO_NOVO = 'Ola, {username}! O link e este aqui: {link}'
const OUTRO_TEXTO = 'Oi, {username}! Segue o link: {link}'
const TEXTO_PUBLICO_NOVO = 'Mandei tudo no seu Direct, pode conferir.'
/** Palavra-gatilho FICTICIA: o lado BARATO dos lotes mistos deste arquivo. */
const PALAVRA_NOVA = 'quero o cardapio'
const LINK_NOVO = `https://${DOMINIO_DE_TESTE}/promocao`
const LINK_PROIBIDO = 'https://outro-dominio-ficticio.example/promocao'

/**
 * O ambiente com a allowlist CONFIGURADA.
 *
 * O `env` do `vitest.config.ts` traz `ALLOWED_LINK_DOMAINS: ''`, e lista vazia
 * nao "passa tudo": ela recusa qualquer mudanca de endereco (§9.8, §12.7,
 * LNK-12). Sem esta linha, a metade POSITIVA das garantias do link e dos dois
 * textos nao teria como existir — e um teste que so consegue provar a recusa e
 * exatamente o que §13.1 proibe. STEP-29 usa o `env` cru, e afirma a recusa.
 */
const AMBIENTE = { ...env, ALLOWED_LINK_DOMAINS: DOMINIO_DE_TESTE } as unknown as typeof env

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

/** A credencial do dono no banco, como o registro a teria deixado. */
async function cadastrarAparelho(aparelho: AutenticadorFalso): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO painel_estado (id, usuario_handle, criado_em, atualizado_em)
     VALUES (1, ?, ?, ?)`,
  )
    .bind(HANDLE_DO_DONO, AGORA, AGORA)
    .run()

  await env.DB.prepare(
    `INSERT INTO painel_credenciais
       (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
        sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 'Aparelho', 'convite', ?, NULL)`,
  )
    .bind(
      aparelho.credentialId,
      env.PANEL_RP_ID,
      HANDLE_DO_DONO,
      JSON.stringify(aparelho.jwkParaOBanco),
      aparelho.algCose,
      AGORA,
    )
    .run()
}

/**
 * Uma SEGUNDA credencial do mesmo dono, sem tocar em `painel_estado`.
 *
 * Existe para separar "a passkey que abriu a sessao" de "a passkey que
 * autorizou a mudanca" — §9.9 quer a segunda no `ator`, e enquanto so houvesse
 * uma credencial cadastrada as duas coincidiam e a distincao era indistinguivel.
 */
async function cadastrarSegundoAparelho(outro: AutenticadorFalso): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO painel_credenciais
       (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
        sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 'Outro aparelho', 'sessao', ?, NULL)`,
  )
    .bind(
      outro.credentialId,
      env.PANEL_RP_ID,
      HANDLE_DO_DONO,
      JSON.stringify(outro.jwkParaOBanco),
      outro.algCose,
      AGORA,
    )
    .run()
}

/** O alvo de cada rota que grava, para os testes que variam de tela. */
const MENSAGEM: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_MENSAGEM,
  handler: handleMensagem,
}
const AJUSTES: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_AJUSTES,
  handler: handleAjustes,
}
const PALAVRAS: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_PALAVRAS,
  handler: handlePalavras,
}
/** A tela dona de `mediaScope`, que nasceu na Etapa 12 (Ruling 68). */
const REELS: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_REELS,
  handler: handleReels,
}

/** A tela de UM Reel — a unica rota cuja gravacao tem um ALVO (Ruling 96). */
const REEL: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_REEL,
  handler: handleReel,
}

/** A rota dona de `enabled` — a unica que o declara fora da restauracao. */
const CHAVE: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_CHAVE,
  handler: handleChave,
}

/** As duas acoes de `/painel/chave` (§7.1), como o handler de teste as le. */
const LIGAR = 'ligar'
const DESLIGAR = 'desligar'

/**
 * Uma gravadora que TRADUZ `acao` num campo **e** declara um campo protegido.
 *
 * Nenhuma rota de `src/` tem essa forma hoje, e e por isso que o buraco do
 * Ruling 86 era inalcancavel: `/painel/chave` e a unica que usa `patchDoHandler`
 * e ela so escreve `enabled`, que nunca e protegido — entao aquela rota nunca
 * chega a tela de conferencia. O que fecha o buraco antes de ele ser alcancavel
 * e testa-lo onde ele existe de verdade: no funil.
 *
 * **Isto nao inventa rota nenhuma.** `despachar` recebe o handler por parametro,
 * como todo teste desta suite ja faz; o caminho, os metodos e a escada de §11.3
 * continuam sendo os de `ROTA_CHAVE`. O que muda e so o `PedidoDeGravacao`, que
 * e um argumento de funcao, e a combinacao que ele monta e exatamente a que a
 * Task 13 pode trazer: uma tela que declara uma operacao no corpo e escreve um
 * campo que pede digital.
 */
const CHAVE_COM_LINK: { rota: RotaDoPainel; handler: HandlerDoPainel } = {
  rota: ROTA_CHAVE,
  handler: async (entrada) => {
    const acao =
      entrada.corpo.familia === 'formulario' ? entrada.corpo.campos.get(CAMPO_DA_ACAO) : null

    return await gravarConfiguracao(entrada, {
      para: ROTA_INICIO.caminho,
      confirmacao: acao === LIGAR ? 'ligada' : 'desligada',
      campos: ['enabled', 'destinationUrl'],
      estruturais: [CAMPO_DA_ACAO],
      patchDoHandler: { enabled: acao === LIGAR },
    })
  },
}

interface OpcoesDeEnvio {
  readonly versao?: number
  readonly now?: number
  /** O ambiente daquele envio. So o teste da allowlist vazia troca. */
  readonly ambiente?: typeof env
  /** O cookie do envelope de step-up, quando a requisicao carrega um. */
  readonly stepup?: string | null
  /** A assertion serializada do campo escondido `digital`. */
  readonly digital?: string
}

/** Um POST completo — ficha, versao e o corpo — pela escada de §11.3. */
async function postar(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  campos: string,
  sessao: Sessao,
  opcoes: OpcoesDeEnvio = {},
): Promise<Response> {
  const partes = [`csrf=${sessao.ficha}`, `versao=${opcoes.versao ?? 1}`]
  if (campos !== '') partes.push(campos)
  if (opcoes.digital !== undefined) {
    partes.push(`digital=${encodeURIComponent(opcoes.digital)}`)
  }

  const cookies = [sessao.cookie]
  if (opcoes.stepup !== undefined && opcoes.stepup !== null) cookies.push(opcoes.stepup)

  return await despachar(
    new Request(`${RAIZ}${alvo.rota.caminho}`, {
      method: 'POST',
      headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: cookies.join('; ') },
      body: partes.join('&'),
    }),
    opcoes.ambiente ?? AMBIENTE,
    opcoes.now ?? AGORA,
    alvo.rota,
    alvo.handler,
  )
}

function desescapar(valor: string): string {
  return valor
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * Um texto escrito como a LISTA dos pontos de codigo dele.
 *
 * STEP-39 compara formas que sao visualmente identicas e diferentes ponto a
 * ponto — e essa diferenca invisivel e o assunto do teste. Impressa como
 * texto, a falha mostraria a MESMA letra acentuada nos dois lados e ninguem
 * entenderia por que o teste quebrou; impressa como `U+0061 U+0301` contra
 * `U+00E1`, ela se explica sozinha.
 */
function pontosDeCodigo(texto: string): string[] {
  return [...texto].map(
    (simbolo) => `U+${(simbolo.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
}

/** A mudanca canonica que a tela de conferencia entrega ao `painel.js`. */
function mudancaDaTela(corpo: string): Record<string, unknown> {
  const achado = /data-mudanca="([^"]*)"/.exec(corpo)
  if (achado === null) throw new Error('a tela de conferencia nao trouxe a mudanca')
  return JSON.parse(desescapar(achado[1] as string)) as Record<string, unknown>
}

/**
 * O `<form id="confirmar">` que o servidor renderizou, lido como um navegador o
 * leria: o `action`, e cada `<input type="hidden">` com nome e valor.
 *
 * **Nenhum teste desta suite montava o segundo POST a partir do formulario de
 * verdade** — todos remontavam o corpo da ficha e da versao que o proprio teste
 * guardava, e por isso tres quebras de uma linha na tela de conferencia
 * sobreviviam a suite inteira: a ficha virar constante (o botao daria `403
 * csrf_invalido` e o step-up seria IMPOSSIVEL), a `versao` sair incrementada (a
 * trava otimista virava carimbo automatico no unico formulario que pede
 * biometria) e o `action` apontar para outra tela.
 *
 * E a mesma classe do achado I-5 da Task 11 — nada ligava o formulario
 * renderizado ao funil que o le — reaparecendo na tela nova.
 */
function formularioDeConfirmacao(corpo: string): {
  action: string
  campos: URLSearchParams
} {
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

/** O valor do cookie `__Host-painel_stepup` que a cerimonia devolveu. */
function cookieDoEnvelope(resposta: Response): string {
  const bruto = resposta.headers.get('set-cookie') ?? ''
  const achado = /__Host-painel_stepup=([^;]*)/.exec(bruto)
  if (achado === null) throw new Error('a cerimonia nao emitiu o cookie de step-up')
  return `__Host-painel_stepup=${achado[1] as string}`
}

/** O passo 2 de §10.10: `POST /painel/api/stepup/opcoes`. */
async function pedirOpcoes(
  sessao: Sessao,
  mudanca: unknown,
  opcoes: { operacao?: unknown; ficha?: string; now?: number; ambiente?: typeof env } = {},
): Promise<Response> {
  const cabecalhos: Record<string, string> = {
    'content-type': 'application/json',
    origin: RAIZ,
    cookie: sessao.cookie,
  }
  const ficha = opcoes.ficha ?? sessao.ficha
  if (ficha !== '') cabecalhos['x-painel-csrf'] = ficha

  return await despachar(
    new Request(`${RAIZ}${ROTA_OPCOES_DE_STEPUP.caminho}`, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify({
        operacao: opcoes.operacao ?? (mudanca as { acao?: unknown } | null)?.acao ?? undefined,
        mudanca,
      }),
    }),
    opcoes.ambiente ?? AMBIENTE,
    opcoes.now ?? AGORA,
    ROTA_OPCOES_DE_STEPUP,
    handleOpcoesDeStepUp,
  )
}

/** A digital: a assertion serializada do jeito que o `painel.js` a monta. */
async function digitalPara(
  aparelho: AutenticadorFalso,
  desafio: string,
  opcoes: { uv?: boolean } = {},
): Promise<string> {
  const base = cerimonia({
    rpId: env.PANEL_RP_ID,
    origem: `https://${env.PANEL_RP_ID}`,
    desafio,
    tipo: 'webauthn.get',
  })
  const credencial = await aparelho.autenticar(
    opcoes.uv === false ? semUv(base) : base,
    HANDLE_DO_DONO,
  )
  return JSON.stringify({ credencial })
}

/**
 * A cerimonia inteira, do primeiro POST ao envio com a digital.
 *
 * Ela e a forma NORMAL de uso, e por isso mora no fixture: cada teste que
 * afirma uma trava troca exatamente UMA peca dela, e a troca fica visivel.
 *
 * **O segundo POST e dirigido pelo `<form id="confirmar">` RENDERIZADO**, e nao
 * pela mesma string de campos que o primeiro envio usou (Ruling 81). Reenviar a
 * string do teste era o que escondia o C-1 da rodada 2: `acao=restaurar` estava
 * na lista de estruturais da rota, a tela de conferencia nao o reemitia, e o
 * botao "Voltar a esta versao" morria em `400 dados_invalidos` DEPOIS de colher
 * a digital — enquanto um cliente que montasse o proprio corpo, como este
 * fixture montava, passava. A suite pegava o adulterado e deixava passar o
 * legitimo, que e a inversao exata do que ela existe para fazer.
 *
 * Esta foi a QUARTA quebra de uma linha da tela de conferencia a sobreviver a
 * suite inteira, entao deixou de ser conserto caso a caso e virou regra: todo
 * caminho positivo do step-up passa por `formularioDeConfirmacao`.
 */
async function comDigital(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  campos: string,
  sessao: Sessao,
  aparelho: AutenticadorFalso,
  opcoes: OpcoesDeEnvio = {},
): Promise<{
  conferencia: Response
  envio: Response
  mudanca: Record<string, unknown>
  /** O envelope e a digital que ESTE envio usou, para quem quiser reapresenta-los. */
  envelope: string
  digital: string
}> {
  const conferencia = await postar(alvo, campos, sessao, opcoes)
  const tela = await conferencia.text()
  const mudanca = mudancaDaTela(tela)
  const formulario = formularioDeConfirmacao(tela)

  // O `action` do formulario e a rota que vai receber o segundo POST. Afirmar a
  // igualdade aqui prende o destino em TODO caminho positivo, e nao so no
  // STEP-32: um `action` apontando para outra tela mandaria a digital para um
  // handler que nao e o dono daquele conteudo.
  expect(formulario.action).toBe(alvo.rota.caminho)

  // E o que a tela NAO pode reemitir: `confirmar` (§10.12). Um gesto que o
  // servidor recarrega sozinho no formulario seguinte deixa de ser um gesto —
  // a pessoa confirmaria religar a automacao sem nunca ter marcado nada. A
  // afirmacao mora aqui, e nao num teste so, porque a tela de conferencia ja
  // perdeu uma linha quatro vezes sem a suite notar (Ruling 81).
  expect(formulario.campos.has('confirmar')).toBe(false)

  const cerimoniaResposta = await pedirOpcoes(sessao, mudanca, {
    now: opcoes.now,
    ambiente: opcoes.ambiente,
  })
  const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

  const envelope = cookieDoEnvelope(cerimoniaResposta)
  const digital = await digitalPara(aparelho, challenge)
  const envio = await postarFormulario(alvo, formulario, sessao, envelope, digital, opcoes)

  return { conferencia, envio, mudanca, envelope, digital }
}

/**
 * O segundo POST, montado do jeito que o navegador o monta: os campos
 * escondidos que o servidor emitiu, mais a digital no campo que a tela deixou
 * vazio para ela.
 *
 * Nada daqui vem do teste — nem a ficha, nem a versao, nem os campos de
 * configuracao, nem a operacao declarada. E o que faz da tela de conferencia uma
 * peca sob teste em vez de um enfeite que ninguem le.
 */
async function postarFormulario(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  formulario: { action: string; campos: URLSearchParams },
  sessao: Sessao,
  envelope: string,
  digital: string,
  opcoes: OpcoesDeEnvio = {},
): Promise<Response> {
  formulario.campos.set('digital', digital)

  return await despachar(
    new Request(`${RAIZ}${formulario.action}`, {
      method: 'POST',
      headers: {
        'content-type': FORMULARIO,
        origin: RAIZ,
        cookie: `${sessao.cookie}; ${envelope}`,
      },
      body: formulario.campos.toString(),
    }),
    opcoes.ambiente ?? AMBIENTE,
    opcoes.now ?? AGORA,
    alvo.rota,
    alvo.handler,
  )
}

/** A linha daquele Reel em `painel_midias`, lida crua. */
async function sobreposicaoDe(mediaId: string): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('SELECT * FROM painel_midias WHERE media_id = ?')
    .bind(mediaId)
    .first<Record<string, unknown>>()
}

async function linhaDeConfig(): Promise<Record<string, unknown> | null> {
  return await env.DB.prepare('SELECT * FROM painel_config WHERE id = 1').first<
    Record<string, unknown>
  >()
}

async function auditoria(): Promise<
  { acao: string; step_up: number; campos: string; versao: number }[]
> {
  const { results } = await env.DB.prepare(
    'SELECT acao, step_up, campos, versao FROM painel_auditoria ORDER BY id',
  ).all<{ acao: string; step_up: number; campos: string; versao: number }>()
  return results ?? []
}

async function falhasDaSessao(sidHash: string): Promise<number | null> {
  const linha = await env.DB.prepare('SELECT falhas_stepup FROM painel_sessoes WHERE sid_hash = ?')
    .bind(sidHash)
    .first<{ falhas_stepup: number }>()
  return linha === null ? null : linha.falhas_stepup
}

/**
 * D1 que deixa OUTRO escritor passar na frente, DENTRO do lote.
 *
 * Duble local, injetado por parametro — nada de `vi.mock`. Ele existe para o
 * unico cenario em que a trava otimista de §8.8 age depois da leitura fresca: um
 * segundo escritor empurra a `versao` entre o `SELECT` do funil e o
 * `db.batch()`, e o `UPDATE` da configuracao altera ZERO linhas sem que o lote
 * rejeite nada.
 *
 * Sem esse duble o cenario e inalcancavel — e foi exatamente ele que um mutante
 * sobrevivente apontou: apagar o `AND changes() > 0` de `statementDeRotacao`
 * deixava a suite inteira verde.
 */
class D1ComEscritorConcorrente {
  /**
   * O lote da GRAVACAO e reconhecido pelo statement que o precede.
   *
   * O funil tambem le a configuracao por `db.batch()` — um lote inteiro vale um
   * subrequest —, e sabotar TODO lote empurraria a `versao` ja na leitura, que
   * cairia no `409` do passo 9 sem nunca chegar ao lote. O que se quer e a
   * corrida estreita: a leitura fresca passa, e o escritor concorrente entra
   * DEPOIS dela.
   *
   * O statement da gravacao e um `INSERT ... ON CONFLICT DO UPDATE ... WHERE
   * painel_config.versao = ?` — a trava otimista mora naquele `WHERE`, e e ele
   * que passa a nao casar depois da sabotagem.
   */
  private viuEscritaDeConfig = false

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    if (/^\s*INSERT INTO painel_config/i.test(sql)) this.viuEscritaDeConfig = true
    return this.real.prepare(sql)
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (this.viuEscritaDeConfig) {
      this.viuEscritaDeConfig = false
      // `this.real.prepare`, e nao `this.prepare`: a sabotagem nao pode se
      // reconhecer como a proxima gravacao.
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

let aparelho: AutenticadorFalso

beforeEach(async () => {
  await limparBanco(env.DB)
  invalidarCacheDeConfig()
  // O cache da listagem de §12.5 e por ISOLATE e sobrevive entre testes, como o
  // da configuracao. Esquece-lo aqui e o que impede um teste de herdar a
  // listagem que o anterior guardou — e de afirmar sobre uma Meta que nunca foi
  // chamada.
  esquecerAListagem()
  aparelho = await AutenticadorFalso.criar()
  await cadastrarAparelho(aparelho)
})

// ---------------------------------------------------------------------------
// As dezessete garantias de §13.2
// ---------------------------------------------------------------------------

describe('STEP — step-up preso ao conteudo', () => {
  test('STEP-01: step-up ausente bloqueia o texto do Direct', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const resposta = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.private_reply_text).not.toBe(TEXTO_NOVO)
    // §10.10: a tentativa recusada por step-up AUSENTE tambem gera linha.
    expect(await auditoria()).toEqual([
      { acao: 'stepup_recusado', step_up: 0, campos: '["privateReplyText"]', versao: 1 },
    ])
    // **E NAO conta como falha de step-up.** Ausente e o primeiro envio, o
    // caminho normal de quem apertou Salvar: se contasse, dez gravacoes
    // protegidas seguidas derrubariam a sessao de quem usa o painel certo.
    expect(await falhasDaSessao(sessao.sidHash)).toBe(0)
  })

  test('STEP-02: step-up ausente bloqueia o link', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const resposta = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_NOVO)
  })

  test('STEP-03: fora dos 120 s o step-up bloqueia', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const conferencia = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // Um milissegundo DEPOIS do prazo do envelope, e nem um a mais.
    const tarde = AGORA + PRAZO_DE_ENVELOPE_MS.stepup + 1
    const resposta = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      {
        now: tarde,
        stepup: cookieDoEnvelope(cerimoniaResposta),
        digital: await digitalPara(aparelho, challenge),
      },
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_NOVO)
  })

  test('STEP-04: `UV = 0` e recusado, e nada e gravado', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const conferencia = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // O autenticador RE-ASSINA com a flag `UV` apagada: a recusa vem da flag, e
    // nao de uma assinatura quebrada.
    const resposta = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      {
        stepup: cookieDoEnvelope(cerimoniaResposta),
        digital: await digitalPara(aparelho, challenge, { uv: false }),
      },
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_NOVO)
  })

  test('STEP-05: o step-up do link nao autoriza gravar o texto', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    // A cerimonia e feita para o LINK.
    const conferencia = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // E o formulario submetido muda o TEXTO. A assertion fecha; o `op_hash` nao.
    const resposta = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      {
        stepup: cookieDoEnvelope(cerimoniaResposta),
        digital: await digitalPara(aparelho, challenge),
      },
    )

    expect(resposta.status).toBe(403)
    const linha = await linhaDeConfig()
    expect({
      texto: linha?.private_reply_text === TEXTO_NOVO,
      link: linha?.destination_url === LINK_NOVO,
    }).toEqual({ texto: false, link: false })
  })

  test('STEP-06: o mesmo step-up nao serve para duas gravacoes', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const {
      envio,
      envelope: envelopeUsado,
      digital: digitalUsada,
    } = await comDigital(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      aparelho,
    )
    expect(envio.status).toBe(303)

    // O `sid` rotacionou: o cookie de sessao novo veio no MESMO `303`.
    const novos = envio.headers.getAll('set-cookie')
    const sessaoNova = novos.find((c) => c.startsWith('__Host-painel_sessao=')) as string
    const sidNovo = /__Host-painel_sessao=([^;]*)/.exec(sessaoNova)?.[1] as string
    const seguinte: Sessao = {
      cookie: `__Host-painel_sessao=${sidNovo}`,
      ficha: '',
      sidHash: '',
    }

    // Reapresentar o MESMO envelope numa segunda gravacao: ele nomeia um `sid`
    // que nao existe mais, e o proprio `303` acabou de apaga-lo.
    expect(novos.some((c) => c.startsWith('__Host-painel_stepup=;'))).toBe(true)

    const ficha = await fichaCsrf(
      env,
      (await env.DB.prepare('SELECT sid_hash FROM painel_sessoes').first<{ sid_hash: string }>())
        ?.sid_hash as string,
    )
    // O enunciado da linha de §13.2 e literal — "o MESMO step-up" —, entao a
    // segunda gravacao reapresenta o envelope REAL e a digital REAL da primeira,
    // e nao um par de valores-lixo. Ele nomeia um `sid` que nao existe mais, e o
    // proprio `303` acabou de apaga-lo.
    const segunda = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(OUTRO_TEXTO)}`,
      { ...seguinte, ficha },
      { versao: 2, stepup: envelopeUsado, digital: digitalUsada },
    )

    expect(segunda.status).toBe(403)
    expect((await linhaDeConfig())?.private_reply_text).toBe(TEXTO_NOVO)
  })

  test('STEP-07: o `op_hash` e recalculado no servidor — outro conteudo nao passa', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    // A cerimonia assina o texto A.
    const conferencia = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
    )
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // E o corpo submetido carrega o texto B — o campo escondido "mexido".
    const resposta = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(OUTRO_TEXTO)}`,
      sessao,
      {
        stepup: cookieDoEnvelope(cerimoniaResposta),
        digital: await digitalPara(aparelho, challenge),
      },
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.private_reply_text).not.toBe(OUTRO_TEXTO)
  })

  test('STEP-08: ir para "basta aparecer no meio" exige step-up, e com a digital passa', async () => {
    await gravarConfig(env.DB, { match_mode: 'exact', trigger_keywords: '["quero o link"]' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const { conferencia, envio } = await comDigital(PALAVRAS, 'matchMode=no_meio', sessao, aparelho)

    expect({ sem: conferencia.status, com: envio.status }).toEqual({ sem: 403, com: 303 })
    expect((await linhaDeConfig())?.match_mode).toBe('contains')
  })

  test('STEP-09: baixar o intervalo por pessoa exige step-up, e com a digital passa', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao(aparelho.credentialId)

    const { conferencia, envio } = await comDigital(
      AJUSTES,
      'userCooldownHours=1',
      sessao,
      aparelho,
    )

    expect({ sem: conferencia.status, com: envio.status }).toEqual({ sem: 403, com: 303 })
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(1)
  })

  test('STEP-10: `mediaScope` so e gravavel pela tela dona, e alargar pede a digital', async () => {
    // **Este teste media a coisa errada, e a rodada 2 provou** (Ruling 77). Ele
    // dizia afirmar "alargar o escopo pede a digital" e conferia um `403` que
    // vinha do escopo de `/painel/ajustes`, e nao da classificacao de risco —
    // quando o Ruling 73 pos a recusa de escopo antes da cerimonia, o `403`
    // virou `400` e a garantia apareceu como o que sempre foi: um teste que
    // fingia cobrir, proibido por §13.1.
    //
    // A classificacao de `mediaScope` — as DUAS direcoes — e afirmada em
    // META-06, direto sobre `camposProtegidos`. O que fica aqui e o que so o
    // HTTP prova.
    //
    // **A metade POSITIVA venceu na Etapa 12** (Ruling 68). Ate ela, a tela dona
    // de `mediaScope` nao existia e este teste so podia afirmar a metade
    // negativa, com a positiva escrita como adiada. `/painel/reels` nasceu, e as
    // duas metades passam a valer juntas:
    //
    //   1. as tres telas que NAO sao donas dele continuam recusando por ESCOPO
    //      — `400`, sem pedir digital nenhuma;
    //   2. a tela DONA aceita, e alargar para "em todos os meus Reels" pede a
    //      digital, porque §10.10 lista `mediaScope -> 'todas'` como
    //      alargamento do envelope de alcance.
    //
    // Sem a metade 2, a etapa entregaria a tela e ninguem saberia se o campo
    // dela chega a ser gravavel; sem a metade 1, a lista por rota do Ruling 70
    // deixaria de ser afirmada onde ela importa.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao(aparelho.credentialId)

    for (const alvo of [AJUSTES, PALAVRAS, MENSAGEM]) {
      const resposta = await postar(alvo, 'mediaScope=todas', sessao)

      expect({ [alvo.rota.caminho]: resposta.status }).toEqual({ [alvo.rota.caminho]: 400 })
      expect({ [alvo.rota.caminho]: (await linhaDeConfig())?.media_scope }).toEqual({
        [alvo.rota.caminho]: 'selecionadas',
      })
    }

    // E a recusa e por ESCOPO, nao por step-up: nenhuma linha `stepup_recusado`
    // e — o que importa para quem esta na tela — nenhuma digital foi pedida.
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'mudanca_recusada',
      'mudanca_recusada',
      'mudanca_recusada',
    ])

    // A metade positiva, pela tela dona. O segundo POST e dirigido pelo
    // `<form id="confirmar">` RENDERIZADO (Ruling 81) — `comDigital` cuida
    // disso, e e ele quem prende a tela de conferencia ao funil que a le.
    //
    // **A Meta nao e tocada neste caminho**, e por isso o handler entra sem
    // duble: sem nenhum Reel marcado, `salvarSelecao` nao tem id novo para
    // revalidar e nao chama `me/media`. O que este teste mede e a gravacao de
    // `mediaScope`, e um duble aqui so acrescentaria peca sem afirmar nada.
    const { conferencia, envio } = await comDigital(REELS, 'mediaScope=todas', sessao, aparelho)

    expect({ sem: conferencia.status, com: envio.status }).toEqual({ sem: 403, com: 303 })
    expect((await linhaDeConfig())?.media_scope).toBe('todas')

    // E a linha de auditoria diz que AQUELA gravacao passou pela digital.
    const ultima = (await auditoria()).at(-1)
    expect({ acao: ultima?.acao, campos: ultima?.campos, step_up: ultima?.step_up }).toEqual({
      acao: 'config_alterada',
      campos: '["mediaScope"]',
      step_up: 1,
    })
  })

  test('STEP-11: desligar a automacao NAO exige step-up', async () => {
    // O veiculo e `/painel/chave`, que e a rota dona de `enabled` (Ruling 74):
    // depois que a lista de `/painel/ajustes` encolheu, um `enabled=nao` mandado
    // para la e recusado por escopo, e o teste mediria o portao errado.
    await gravarConfig(env.DB, { enabled: 1 })
    const sessao = await abrirSessao(aparelho.credentialId)

    const resposta = await postar(CHAVE, 'acao=desligar', sessao)

    expect(resposta.status).toBe(303)
    expect((await linhaDeConfig())?.enabled).toBe(0)
    expect((await auditoria())[0]).toEqual({
      acao: 'config_alterada',
      step_up: 0,
      campos: '["enabled"]',
      versao: 2,
    })
  })

  test('STEP-12: estreitar o alcance NAO exige step-up', async () => {
    await gravarConfig(env.DB, {
      match_mode: 'contains',
      trigger_keywords: '["quero o link"]',
      user_cooldown_hours: 24,
    })
    const sessao = await abrirSessao(aparelho.credentialId)

    // Subir o intervalo e voltar para "o comentario tem que ser so isso": as
    // duas direcoes seguras, no mesmo lote.
    const resposta = await postar(PALAVRAS, 'matchMode=so_isso', sessao)

    expect(resposta.status).toBe(303)
    expect((await linhaDeConfig())?.match_mode).toBe('exact')
    expect((await auditoria())[0]?.step_up).toBe(0)
  })

  test('STEP-13: gravacao parcial e impossivel — o campo barato do lote tambem nao entra', async () => {
    // **O veiculo e `/painel/palavras`** (Ruling 78): o lote misto precisa de uma
    // rota dona dos DOIS campos, e depois do Ruling 74 `/painel/ajustes` nao
    // escreve o link — o lote seria recusado por escopo antes de a classificacao
    // rodar, e o teste mediria outro portao. `triggerKeywords` (barato) com
    // `matchMode` para "no meio" (protegido) e palavra por palavra o exemplo do
    // Ruling 66.
    await gravarConfig(env.DB, { match_mode: 'exact' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const lote = `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}&matchMode=no_meio`

    // §10.10: se qualquer campo do lote exige, o lote inteiro exige.
    const semDigital = await postar(PALAVRAS, lote, sessao)
    expect(semDigital.status).toBe(403)
    expect((await linhaDeConfig())?.trigger_keywords).toBe('["eu quero","quero o link"]')

    // E com uma digital que NAO fecha, tambem nao: nem o campo barato passa.
    const conferencia = await postar(PALAVRAS, lote, sessao)
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const comDigitalRuim = await postar(PALAVRAS, lote, sessao, {
      stepup: cookieDoEnvelope(cerimoniaResposta),
      digital: '{"credencial":{}}',
    })

    expect(comDigitalRuim.status).toBe(403)
    const linha = await linhaDeConfig()
    expect({ palavras: linha?.trigger_keywords, modo: linha?.match_mode }).toEqual({
      palavras: '["eu quero","quero o link"]',
      modo: 'exact',
    })
  })

  test('STEP-14: nao existe janela privilegiada — duas gravacoes seguidas pedem duas digitais', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const primeira = await comDigital(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      aparelho,
    )
    expect(primeira.envio.status).toBe(303)

    // A sessao rotacionou; a seguinte usa o cookie novo e a ficha nova.
    const sidNovo = /__Host-painel_sessao=([^;]*)/.exec(
      primeira.envio.headers
        .getAll('set-cookie')
        .find((c) => c.startsWith('__Host-painel_sessao=')) as string,
    )?.[1] as string
    const linhaViva = await env.DB.prepare('SELECT sid_hash FROM painel_sessoes').first<{
      sid_hash: string
    }>()
    const segunda: Sessao = {
      cookie: `__Host-painel_sessao=${sidNovo}`,
      ficha: await fichaCsrf(env, linhaViva?.sid_hash as string),
      sidHash: linhaViva?.sid_hash as string,
    }

    // A SEGUNDA mudanca protegida, sem digital nenhuma: barrada de novo.
    const semSegundaDigital = await postar(
      MENSAGEM,
      `publicReplyText=${encodeURIComponent(TEXTO_PUBLICO_NOVO)}`,
      segunda,
      { versao: 2 },
    )
    expect(semSegundaDigital.status).toBe(403)

    // E com a segunda digital, passa.
    const comSegundaDigital = await comDigital(
      MENSAGEM,
      `publicReplyText=${encodeURIComponent(TEXTO_PUBLICO_NOVO)}`,
      segunda,
      aparelho,
      { versao: 2 },
    )
    expect(comSegundaDigital.envio.status).toBe(303)
    expect((await linhaDeConfig())?.public_reply_text).toBe(TEXTO_PUBLICO_NOVO)
  })

  test('STEP-15: `publicReplyText` exige step-up, e com a digital passa', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { conferencia, envio } = await comDigital(
      MENSAGEM,
      `publicReplyText=${encodeURIComponent(TEXTO_PUBLICO_NOVO)}`,
      sessao,
      aparelho,
    )

    expect({ sem: conferencia.status, com: envio.status }).toEqual({ sem: 403, com: 303 })
    expect((await linhaDeConfig())?.public_reply_text).toBe(TEXTO_PUBLICO_NOVO)
  })

  test('STEP-16: o cookie de step-up e amarrado ao `sid` — outra sessao nao serve', async () => {
    await gravarConfig(env.DB)
    const primeira = await abrirSessao(aparelho.credentialId)
    const segunda = await abrirSessao(aparelho.credentialId)

    // A cerimonia acontece na PRIMEIRA sessao.
    const conferencia = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      primeira,
    )
    const cerimoniaResposta = await pedirOpcoes(primeira, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // E o envelope roubado e apresentado pela SEGUNDA. Mesmo conteudo, mesma
    // credencial, mesma digital valida — e ainda assim recusado.
    const resposta = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      segunda,
      {
        stepup: cookieDoEnvelope(cerimoniaResposta),
        digital: await digitalPara(aparelho, challenge),
      },
    )

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_NOVO)
  })

  test('STEP-17: dez falhas de step-up apagam a sessao', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)
    const corpo = `destinationUrl=${encodeURIComponent(LINK_NOVO)}`

    const console = capturarConsole()
    try {
      for (let tentativa = 1; tentativa <= 9; tentativa++) {
        const resposta = await postar(MENSAGEM, corpo, sessao, {
          stepup: '__Host-painel_stepup=envelope-que-nao-fecha',
          digital: '{"credencial":{}}',
        })
        expect({ tentativa, status: resposta.status }).toEqual({ tentativa, status: 403 })
        expect({ tentativa, falhas: await falhasDaSessao(sessao.sidHash) }).toEqual({
          tentativa,
          falhas: tentativa,
        })
      }

      // A DECIMA apaga a linha em vez de incrementar.
      const decima = await postar(MENSAGEM, corpo, sessao, {
        stepup: '__Host-painel_stepup=envelope-que-nao-fecha',
        digital: '{"credencial":{}}',
      })
      expect(decima.status).toBe(403)
      expect(await falhasDaSessao(sessao.sidHash)).toBe(null)

      // E a sessao morreu de verdade: a requisicao seguinte cai em `/painel/entrar`.
      const depois = await postar(MENSAGEM, corpo, sessao)
      expect({ status: depois.status, para: depois.headers.get('location') }).toEqual({
        status: 303,
        para: '/painel/entrar',
      })
    } finally {
      console.parar()
    }

    // Step-up AUSENTE nao conta como falha: as dez linhas sao das dez INVALIDAS.
    expect((await auditoria()).length).toBe(10)
  })

  // -------------------------------------------------------------------------
  // O "mais" de §13.2: `json_canonico` com vetores congelados
  // -------------------------------------------------------------------------

  test('STEP-18: `json_canonico` congelado — chaves por code point, sem espaco, numero inteiro', () => {
    // O vetor e ESCRITO, byte a byte, e nao derivado da funcao: um vetor
    // calculado pela propria implementacao nao congela nada.
    const canonico = jsonCanonico({
      acao: 'config',
      campos: {
        userCooldownHours: 48,
        matchMode: 'contains',
        enabled: true,
        triggerKeywords: ['quero o link', 'eu quero'],
      },
    })

    expect(canonico).toBe(
      '{"acao":"config","enabled":true,"matchMode":"contains",' +
        '"triggerKeywords":["quero o link","eu quero"],"userCooldownHours":48}',
    )
  })

  test('STEP-19: `json_canonico` normaliza — NFKC, sem invisiveis, e inteiro', () => {
    // As tres limpezas de §10.10 numa string so: a ligadura `ﬁ` e NFKC, o
    // zero-width e `\\p{Cf}`, e o espaco das pontas sai no `trim`.
    const canonico = jsonCanonico({
      acao: 'config',
      campos: { publicReplyText: '  con\u{fb01}rmado​  ', userCooldownHours: 48.9 },
    })

    expect(canonico).toBe('{"acao":"config","publicReplyText":"confirmado","userCooldownHours":48}')
  })

  test('STEP-20: duas operacoes diferentes com o mesmo conteudo nao compartilham assinatura', async () => {
    const campos = { alvo: 'aparelho-de-teste' }

    const [configuracao, remocao] = await Promise.all([
      opHash({ acao: 'config', campos }),
      opHash({ acao: 'remover_passkey', campos }),
    ])

    expect(configuracao).not.toBe(remocao)
  })

  test('STEP-21: o JSON da cerimonia e o formulario urlencoded chegam ao MESMO hash', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao(aparelho.credentialId)

    // O caminho do FORMULARIO: o funil le `userCooldownHours=1` como inteiro e
    // monta a mudanca canonica. A tela de conferencia devolve exatamente ela.
    const conferencia = await postar(AJUSTES, 'userCooldownHours=1', sessao)
    const mudanca = mudancaDaTela(await conferencia.text())

    expect(mudanca).toEqual({ acao: 'config', userCooldownHours: 1 })

    // O caminho do JSON: a cerimonia recebe o mesmo mapa e assina o mesmo hash.
    // A prova de que os dois se encontram e o envio funcionar: a rota de escrita
    // RECALCULA o hash do corpo urlencoded e compara com o do envelope.
    const cerimoniaResposta = await pedirOpcoes(sessao, mudanca)
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    const envio = await postar(AJUSTES, 'userCooldownHours=1', sessao, {
      stepup: cookieDoEnvelope(cerimoniaResposta),
      digital: await digitalPara(aparelho, challenge),
    })

    expect(envio.status).toBe(303)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(1)
  })

  test('STEP-39: `limparTexto` e IDEMPOTENTE — a propriedade, e nao os exemplos', () => {
    // A trava do achado A-1 da etapa 12b, e o motivo dela ser uma PROPRIEDADE.
    //
    // `json_canonico` normaliza com `limparTexto`, e os dois caminhos do
    // `op_hash` a aplicam um numero DIFERENTE de vezes: a rota de escrita uma
    // (corpo cru -> canonico), a cerimonia duas (a tela ja emite a mudanca
    // canonica em `data-mudanca`, o navegador a devolve, e `handleOpcoesDeStepUp`
    // canoniza de novo). Enquanto a funcao for idempotente os dois coincidem e
    // STEP-21 fecha. No dia em que deixar de ser, o envelope carrega um hash e a
    // rota recalcula outro para AQUELE texto — `conteudo_diferente`, `403`, e o
    // dono encostando o dedo para ouvir um nao que ninguem consegue explicar.
    // §10.10 nomeia essa falha: "o hash recalculado diverge e a trava vira bug
    // intermitente".
    //
    // **Por isso o teste e sobre a propriedade.** Uma lista de exemplos guarda
    // os exemplos; foi a lista que a ordem antiga passou, porque nenhum texto
    // realista tem `Cf` entre uma letra e um combinante. O que impede a
    // regressao e varrer um espaco GERADO, e afirmar a razao estrutural.
    const LETRA = 'a'
    const COMBINANTE = '\u0301' // U+0301, acento agudo combinante (Mn)
    const ZWJ = '\u200d' // Cf
    const NULO = '\u0000' // Cc
    const LIGADURA = '\ufb01' // a ligadura que o NFKC parte em duas letras
    const LARGURA_TOTAL = '\uff21' // outra forma de compatibilidade
    const ALFABETO = [LETRA, COMBINANTE, ZWJ, NULO, LIGADURA, LARGURA_TOTAL, ' ', '\u00a0']

    /** Todas as palavras de ate quatro simbolos sobre o alfabeto acima. */
    const palavras: string[] = ['']
    let fronteira: string[] = ['']
    for (let tamanho = 1; tamanho <= 4; tamanho++) {
      fronteira = fronteira.flatMap((prefixo) => ALFABETO.map((letra) => prefixo + letra))
      palavras.push(...fronteira)
    }

    // Contrapositivo de cobertura: o espaco varrido nao pode ter encolhido.
    expect(palavras.length).toBe(1 + 8 + 8 ** 2 + 8 ** 3 + 8 ** 4)

    const naoIdempotentes = palavras.filter((palavra) => {
      const uma = limparTexto(palavra)
      return limparTexto(uma) !== uma
    })

    expect(naoIdempotentes.map(pontosDeCodigo)).toEqual([])

    // A RAZAO estrutural, afirmada direto: a saida nunca contem `Cc`/`Cf`, e
    // por isso a segunda passada nao tem invisivel para tirar nem composicao
    // nova para fazer. Sem esta linha, o laco acima seria so uma lista de
    // exemplos maior.
    const comInvisivelNaSaida = palavras
      .map(limparTexto)
      .filter((limpo) => /[\p{Cc}\p{Cf}]/u.test(limpo))

    expect(comInvisivelNaSaida.map(pontosDeCodigo)).toEqual([])

    // E os casos patologicos nomeados, para que a falha DIGA o que quebrou em
    // vez de cuspir um indice de um laco de 4681.
    const NOMEADOS: readonly { nome: string; texto: string }[] = [
      { nome: 'Cf entre letra e combinante', texto: `a${ZWJ}${COMBINANTE}` },
      { nome: 'Cc entre letra e combinante', texto: `o${NULO}\u0303` },
      { nome: 'invisiveis repetidos', texto: `n${ZWJ}\u200c\u0303o` },
      { nome: 'ligadura de compatibilidade', texto: `  con${LIGADURA}rmado${ZWJ}  ` },
      { nome: 'espacos nas pontas', texto: '   ola mundo   ' },
      { nome: 'largura total', texto: '\uff21\uff22\uff23' },
      { nome: 'texto realista', texto: TEXTO_PUBLICO_NOVO },
    ]

    for (const caso of NOMEADOS) {
      const uma = limparTexto(caso.texto)
      expect({ [caso.nome]: pontosDeCodigo(limparTexto(uma)) }).toEqual({
        [caso.nome]: pontosDeCodigo(uma),
      })
    }

    // **O contrapositivo que impede este teste de ser vacuo.** A ordem ANTIGA —
    // NFKC primeiro, remocao depois — esta escrita aqui como TESTEMUNHA, e nao
    // como implementacao: ela prova que o espaco varrido de fato contem as
    // entradas que a regressao quebraria. Sem ela, um alfabeto mal escolhido
    // deixaria o laco verde nos dois mundos, e o teste guardaria nada.
    const ordemAntiga = (texto: string): string =>
      texto
        .normalize('NFKC')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()

    const quebradosPelaOrdemAntiga = palavras.filter((palavra) => {
      const uma = ordemAntiga(palavra)
      return ordemAntiga(uma) !== uma
    })

    expect(quebradosPelaOrdemAntiga.length).toBeGreaterThan(0)

    // E a testemunha vai mais longe: onde as duas ordens divergem, a ordem NOVA
    // entrega exatamente o ponto fixo da antiga. Quer dizer que a correcao nao
    // inventa forma nenhuma — ela so chega numa passada onde a antiga chegava
    // em duas, que e por que os vetores congelados de §13.2 nao se mexem.
    for (const palavra of quebradosPelaOrdemAntiga) {
      let pontoFixo = ordemAntiga(palavra)
      for (let volta = 0; volta < 8 && ordemAntiga(pontoFixo) !== pontoFixo; volta++) {
        pontoFixo = ordemAntiga(pontoFixo)
      }
      expect(pontosDeCodigo(limparTexto(palavra))).toEqual(pontosDeCodigo(pontoFixo))
    }
  })

  test('STEP-40: o `alvo` de 18 digitos atravessa `json_canonico` como TEXTO', () => {
    // Ruling 96, a metade que o Ruling 90 ja exigia por escrito: "se alguma
    // coisa sua fizer um id atravessar JSON, ele atravessa como string, com
    // teste que prove o round-trip de 18 digitos".
    //
    // O perigo medido, e nao descrito: os dois ids abaixo sao DIFERENTES como
    // texto e IGUAIS depois de `Number()`. Um `alvo` que virasse numero em
    // qualquer ponto do caminho assinaria a mudanca do Reel vizinho.
    const REEL = '178414000000000001'
    const VIZINHO = '178414000000000000'
    expect(REEL).not.toBe(VIZINHO)
    expect(Number(REEL)).toBe(Number(VIZINHO))

    const canonico = jsonCanonico({ acao: 'config', alvo: REEL, campos: { enabled: false } })

    // O id sai ENTRE ASPAS, e o JSON volta com os 18 digitos intactos.
    expect(canonico).toBe(`{"acao":"config","alvo":"${REEL}","enabled":false}`)
    expect(JSON.parse(canonico).alvo).toBe(REEL)
    expect(typeof JSON.parse(canonico).alvo).toBe('string')

    // E dois Reels diferentes com o MESMO patch nao compartilham assinatura —
    // que e o buraco inteiro do Ruling 96 numa linha.
    expect(canonico).not.toBe(
      jsonCanonico({ acao: 'config', alvo: VIZINHO, campos: { enabled: false } }),
    )

    // **Os vetores congelados nao se mexeram**: sem `alvo`, o JSON e o mesmo
    // byte a byte de antes desta rodada. STEP-18 e STEP-19 continuam valendo
    // sobre a mesma funcao, e esta linha e o que impede o campo novo de vazar
    // para a gravacao da linha global.
    expect(jsonCanonico({ acao: 'config', campos: { enabled: false } })).toBe(
      '{"acao":"config","enabled":false}',
    )
  })

  test('STEP-41: o `op_hash` amarra a digital AO REEL — trocar `midia` e recusado', async () => {
    // **A forma exata do Ruling 86, na tela que a Task 13 criou.** Ate o Ruling
    // 96, o `patchDoHandler` de `/painel/reel` era identico para qualquer Reel:
    // "voltar tudo a seguir a regra geral" produz os mesmos valores globais, e o
    // `media_id` vivia so no campo escondido `midia`, que a tela de conferencia
    // reemite e que ficava FORA da assinatura. Trocar `midia` entre os dois
    // POSTs mantinha o `oh` do envelope valido e mudava a entidade gravada — a
    // digital do dono cobrindo outro Reel.
    //
    // Os dois Reels tem a MESMA sobreposicao de proposito: e o que faz o patch
    // coincidir e o unico que separa os dois hashes ser o alvo.
    const REEL_A = '178414000000000001'
    const REEL_B = '178414000000000002'

    await gravarConfig(env.DB, { enabled: 1, user_cooldown_hours: 24 })
    await gravarMidia(env.DB, REEL_A, { user_cooldown_hours: 48 })
    await gravarMidia(env.DB, REEL_B, { user_cooldown_hours: 48 })
    const sessao = await abrirSessao(aparelho.credentialId)

    // A conferencia do REEL_A. Desfazer a sobreposicao ALARGA — o intervalo cai
    // de 48 para 24 —, entao §10.10 pede a digital (MID-21).
    const conferencia = await postar(
      REEL,
      `${CAMPO_DA_ACAO}=${SEGUIR_O_GERAL}&${CAMPO_DO_REEL}=${REEL_A}`,
      sessao,
    )
    expect(conferencia.status).toBe(403)

    const tela = await conferencia.text()
    const mudanca = mudancaDaTela(tela)
    const formulario = formularioDeConfirmacao(tela)

    // §10.10, a metade humana: a tela NOMEIA o Reel antes da biometria. Sem
    // isto o dono lia "Intervalo por pessoa: 48 para 24" e assinava sem saber
    // em qual Reel.
    expect(tela).toContain(TELA_DOS_REELS.soNesteReel)
    expect(tela).toContain(REEL_A)
    expect(tela).not.toContain(REEL_B)

    // E a metade da maquina: o alvo esta DENTRO da mudanca assinada, como texto.
    expect(mudanca.alvo).toBe(REEL_A)

    const cerimoniaResposta = await pedirOpcoes(sessao, mudanca)
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
    const envelope = cookieDoEnvelope(cerimoniaResposta)
    const digital = await digitalPara(aparelho, challenge)

    // **O ataque:** o mesmo envelope, a mesma digital, o mesmo formulario — com
    // `midia` trocado para o outro Reel.
    const trocado = new URLSearchParams(formulario.campos)
    trocado.set(CAMPO_DO_REEL, REEL_B)

    const registro = capturarConsole()
    let ataque: Response
    try {
      ataque = await postarFormulario(
        REEL,
        { action: formulario.action, campos: trocado },
        sessao,
        envelope,
        digital,
      )
    } finally {
      registro.parar()
    }

    expect(ataque.status).toBe(403)
    // **E o MOTIVO importa**: `conteudo_diferente` e o `op_hash` recalculado do
    // corpo recebido nao batendo com o que o envelope assinou. Sem esta linha,
    // uma recusa por outra razao qualquer — ficha, versao, corpo malformado —
    // deixaria o teste verde sem provar a amarracao.
    expect(registro.linhas.join(' ')).toContain('conteudo_diferente')

    // Nenhum dos dois Reels mudou.
    expect((await sobreposicaoDe(REEL_A))?.user_cooldown_hours).toBe(48)
    expect((await sobreposicaoDe(REEL_B))?.user_cooldown_hours).toBe(48)
    // Duas linhas de recusa: a do primeiro POST, que so pediu a digital
    // (`step_up_ausente`, o caminho normal de quem apertou Salvar), e a do
    // ataque. §10.10 manda registrar as duas.
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'stepup_recusado',
      'stepup_recusado',
    ])

    // Contrapositivo: o MESMO envelope e a MESMA digital, com o formulario
    // intacto, gravam. Sem ele o teste passaria com um step-up quebrado.
    const honesto = await postarFormulario(REEL, formulario, sessao, envelope, digital)

    expect(honesto.status).toBe(303)
    expect((await sobreposicaoDe(REEL_A))?.user_cooldown_hours).toBeNull()
    expect((await sobreposicaoDe(REEL_B))?.user_cooldown_hours).toBe(48)
  })

  // -------------------------------------------------------------------------
  // A cerimonia, a tela e o rastro
  // -------------------------------------------------------------------------

  test('STEP-22: a tela de conferencia mostra o valor LITERAL, antes e depois', async () => {
    await gravarConfig(env.DB, { destination_url: `https://${DOMINIO_DE_TESTE}/antigo` })
    const sessao = await abrirSessao(aparelho.credentialId)

    const corpo = await (
      await postar(MENSAGEM, `destinationUrl=${encodeURIComponent(LINK_NOVO)}`, sessao)
    ).text()

    expect(corpo).toContain('Confira o que vai mudar')
    expect(corpo).toContain(`https://${DOMINIO_DE_TESTE}/antigo`)
    expect(corpo).toContain(LINK_NOVO)
    // O gesto que a resolve precisa do `painel.js`, e a pagina o carrega.
    expect(corpo).toContain('/painel/painel.js')

    // **A frase de §15.4 mudou, e a mudanca e uma frase que mentia** (Ruling
    // 75). Ela dizia "um toque so confirma os TRES campos desta tela de uma
    // vez", e saia sempre que todos os campos mudados fossem protegidos — ou
    // seja, tambem numa tela com UMA mudanca, e tambem em `/painel/ajustes`, que
    // nao tem tres campos. Agora ela conta: com uma mudanca so nao ha o que
    // avisar, e a frase nao sai.
    expect(corpo).not.toContain('de uma vez')

    // Com DUAS, ela sai — e diz o numero, que e verdade em qualquer tela.
    const duas = await (
      await postar(
        MENSAGEM,
        `destinationUrl=${encodeURIComponent(LINK_NOVO)}&publicReplyText=${encodeURIComponent(
          TEXTO_PUBLICO_NOVO,
        )}`,
        sessao,
      )
    ).text()

    expect(duas).toContain('confirma <strong>as 2 mudan&ccedil;as acima de uma vez</strong>')
  })

  test('STEP-23: mexer num campo escondido da tela de conferencia muda o hash e a gravacao e recusada', async () => {
    // O veiculo e `/painel/palavras`, pelo mesmo motivo de STEP-13 (Ruling 78):
    // e a rota que tem um campo barato e um protegido ao mesmo tempo.
    await gravarConfig(env.DB, { match_mode: 'exact' })
    const sessao = await abrirSessao(aparelho.credentialId)

    // O lote leva um campo barato e um protegido; a cerimonia assina os dois.
    const campos = `triggerKeywords=${encodeURIComponent(PALAVRA_NOVA)}&matchMode=no_meio`
    const conferencia = await postar(PALAVRAS, campos, sessao)
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
    const digital = await digitalPara(aparelho, challenge)

    // O campo escondido do lado BARATO e mexido depois da digital.
    const mexido = await postar(
      PALAVRAS,
      `triggerKeywords=${encodeURIComponent('outra palavra')}&matchMode=no_meio`,
      sessao,
      { stepup: cookieDoEnvelope(cerimoniaResposta), digital },
    )

    expect(mexido.status).toBe(403)
    const linha = await linhaDeConfig()
    expect({ palavras: linha?.trigger_keywords, modo: linha?.match_mode }).toEqual({
      palavras: '["eu quero","quero o link"]',
      modo: 'exact',
    })
  })

  test('STEP-24: link fora da allowlist e barrado ANTES da cerimonia (§9.7, passos 7 e 8)', async () => {
    // **O titulo e a expectativa deste teste mudaram na etapa 12b, e a mudanca
    // e uma correcao, nao uma acomodacao.** Ele dizia "barrado MESMO com a
    // digital correta" e congelava a sequencia `['stepup_recusado',
    // 'mudanca_recusada']`: a tela de conferencia saia, o dono encostava o
    // dedo, a assertion era VERIFICADA COM SUCESSO, e so entao o validador
    // recusava.
    //
    // §9.7 numera **7. Validacao campo a campo** e **8. Step-up**, nessa ordem,
    // e a propria linha do passo 8 antecipa a objecao: "vem depois da validacao
    // porque o hash e sobre a mudanca canonica, que so existe depois do parse —
    // e isso nao e concessao: ate aqui nada foi gravado". O codigo fazia o
    // contrario, e era a terceira instancia viva da patologia do Ruling 73:
    // "nao existe motivo para gastar o gesto numa operacao que nao podia dar
    // certo. Uma cerimonia que nunca pode suceder ensina o dono que digital as
    // vezes nao faz nada".
    //
    // A garantia de §13.2 LNK — "link fora da lista recusado e nada gravado" —
    // continua inteira; o que mudou e que ela deixou de custar um gesto.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const recusa = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_PROIBIDO)}`,
      sessao,
    )
    const tela = await recusa.text()

    expect(recusa.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_PROIBIDO)

    // Nenhuma cerimonia foi oferecida: sem tela de conferencia, sem a mudanca
    // canonica que o `painel.js` mandaria assinar, e sem a linha de step-up
    // recusado na frente. So a recusa do validador.
    expect(tela).not.toContain('Confira o que vai mudar')
    expect(tela).not.toContain('data-mudanca')
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['mudanca_recusada'])
  })

  test('STEP-25: a gravacao com step-up carimba `step_up = 1` e rotaciona o `sid`', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { envio } = await comDigital(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      aparelho,
    )

    expect(envio.status).toBe(303)
    expect(
      (await auditoria()).map((linha) => ({ acao: linha.acao, step_up: linha.step_up })),
    ).toEqual([
      { acao: 'stepup_recusado', step_up: 0 },
      { acao: 'config_alterada', step_up: 1 },
    ])

    // A linha e a MESMA — o prazo absoluto nao foi estendido —, e o `sid` mudou.
    const viva = await env.DB.prepare(
      'SELECT sid_hash, expira_em, criada_em FROM painel_sessoes',
    ).first<{ sid_hash: string; expira_em: number; criada_em: number }>()

    expect(viva?.sid_hash).not.toBe(sessao.sidHash)
    expect({ expira: viva?.expira_em, criada: viva?.criada_em }).toEqual({
      expira: AGORA + 12 * 60 * 60 * 1000,
      criada: AGORA,
    })
  })

  test('STEP-26: a cerimonia exige a ficha CSRF e nao grava nada', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const semFicha = await pedirOpcoes(
      sessao,
      { acao: 'config', userCooldownHours: 1 },
      {
        ficha: '',
      },
    )
    expect(semFicha.status).toBe(403)

    const comFicha = await pedirOpcoes(sessao, { acao: 'config', userCooldownHours: 1 })
    expect(comFicha.status).toBe(200)
    // O cookie carrega os quatro atributos de §7.2 e o `Max-Age` DERIVADO do
    // prazo do envelope: escrever `120` a mao seria a segunda grafia de um
    // numero so, e o cookie morreria antes do envelope sem nenhum teste
    // reclamar.
    expect(comFicha.headers.get('set-cookie')).toContain('__Host-painel_stepup=')
    expect(comFicha.headers.get('set-cookie')).toContain(
      `Max-Age=${PRAZO_DE_ENVELOPE_MS.stepup / 1000}; Path=/; Secure; HttpOnly; SameSite=Strict`,
    )

    // Zero escrita: a cerimonia nao guarda estado nenhum (§10.10).
    expect(await auditoria()).toEqual([])
  })

  test('STEP-27: `operacao` diferente de `mudanca.acao` nao emite envelope', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const console = capturarConsole()
    try {
      const trocada = await pedirOpcoes(
        sessao,
        { acao: 'config', userCooldownHours: 1 },
        { operacao: 'remover_passkey' },
      )
      expect(trocada.status).toBe(400)
      expect(trocada.headers.get('set-cookie')).toBe(null)

      // E uma operacao que nenhuma rota de escrita sabe consumir tambem nao.
      const semConsumidor = await pedirOpcoes(sessao, { acao: 'remover_passkey', alvo: 'x' })
      expect(semConsumidor.status).toBe(400)
    } finally {
      console.parar()
    }
  })

  test('STEP-32: o formulario RENDERIZADO da tela de conferencia leva a gravacao ate o fim', async () => {
    // O segundo POST e montado a partir do `<form id="confirmar">` que o
    // servidor desenhou — `action`, `csrf`, `versao` e os escondidos DELE —, e
    // nao do que o teste guardou. E o que um navegador faz, e e a unica forma de
    // prender a ficha, a versao e o destino do formulario de uma vez.
    await gravarConfig(env.DB, { versao: 7 })
    const sessao = await abrirSessao(aparelho.credentialId)

    const conferencia = await postar(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      { versao: 7 },
    )
    const corpo = await conferencia.text()
    const formulario = formularioDeConfirmacao(corpo)

    // O que o servidor emitiu e o que o funil espera receber de volta.
    expect(formulario.action).toBe(ROTA_MENSAGEM.caminho)
    expect(formulario.campos.get('csrf')).toBe(sessao.ficha)
    expect(formulario.campos.get('versao')).toBe('7')
    expect(formulario.campos.get('destinationUrl')).toBe(LINK_NOVO)

    // A cerimonia, e entao o envio dirigido pelo PROPRIO formulario.
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(corpo))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
    formulario.campos.set('digital', await digitalPara(aparelho, challenge))

    const envio = await despachar(
      new Request(`${RAIZ}${formulario.action}`, {
        method: 'POST',
        headers: {
          'content-type': FORMULARIO,
          origin: RAIZ,
          cookie: `${sessao.cookie}; ${cookieDoEnvelope(cerimoniaResposta)}`,
        },
        body: formulario.campos.toString(),
      }),
      AMBIENTE,
      AGORA,
      ROTA_MENSAGEM,
      handleMensagem,
    )

    expect(envio.status).toBe(303)
    expect((await linhaDeConfig())?.destination_url).toBe(LINK_NOVO)
  })

  test('STEP-33: uma rota nao grava campo de outra tela, e recusa ANTES da digital', async () => {
    // §7.1 diz "step-up **sempre** no POST" de `/painel/mensagem`, e a celula so
    // e verdadeira porque aquela rota declara os tres campos sempre protegidos e
    // mais nenhum: `gravarConfiguracao` e agnostica de rota, entao sem a lista um
    // `triggerKeywords` mandado para la gravava sem digital nenhuma.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const intruso = await postar(
      MENSAGEM,
      `triggerKeywords=${encodeURIComponent('palavra intrusa')}&enabled=nao`,
      sessao,
    )

    expect(intruso.status).toBe(400)
    const linha = await linhaDeConfig()
    expect({ palavras: linha?.trigger_keywords, ligada: linha?.enabled }).toEqual({
      palavras: '["eu quero","quero o link"]',
      ligada: 1,
    })
    expect((await auditoria())[0]).toEqual({
      acao: 'mudanca_recusada',
      step_up: 0,
      campos: '["enabled","triggerKeywords"]',
      versao: 1,
    })

    // E o inverso, que e a razao de §15.4: um formulario de `/painel/palavras`
    // que carregasse o link gravaria o link sob uma digital pedida para outra
    // coisa. A lista impede — e desde o Ruling 73 impede ANTES de pedir a
    // digital, que e o que este trecho passou a afirmar.
    //
    // **Ele afirmava o contrario: `{ sem: 403, com: 400 }`** — a tela de
    // conferencia mostrando o link literal, a digital colhida, e so entao o
    // `400`. Era o comportamento do Ruling 70, e o Ruling 73 o desfez com o
    // argumento que este teste agora guarda: uma cerimonia que nunca pode
    // suceder ensina o dono que digital as vezes nao faz nada, e isso corroi a
    // unica trava que depende de ele prestar atencao. Escopo de rota e estatico
    // e conhecido antes de qualquer gesto.
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB)
    await cadastrarAparelho(aparelho)
    const outra = await abrirSessao(aparelho.credentialId)

    const recusado = await postar(
      PALAVRAS,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      outra,
    )
    const tela = await recusado.text()

    expect(recusado.status).toBe(400)
    // Nenhuma cerimonia foi oferecida: sem tela de conferencia, sem mudanca
    // canonica para o `painel.js` assinar, e sem linha de step-up recusado.
    expect(tela).not.toContain('data-mudanca')
    expect(tela).not.toContain('Confira o que vai mudar')
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['mudanca_recusada'])
    expect((await linhaDeConfig())?.destination_url).toBe('https://exemplo.com/do-banco')

    // E a recusa diz ONDE o campo se muda, em vez de "ainda nao da" (Ruling 75):
    // o link JA e editavel, so que na tela dele.
    expect(tela).toContain('na tela da mensagem e do link')
  })

  test('STEP-35: a restauracao alcanca o link, e a digital fecha (Ruling 74)', async () => {
    // A metade POSITIVA da consequencia declarada do Ruling 74 (Ruling 76).
    // `acao=restaurar` e uma operacao declarada, como `acao=ligar|desligar` de
    // §7.1, e o escopo dela e a uniao gravavel — nao a lista do formulario de
    // Ajustes. Sem isso, uma versao anterior que diferisse no link era
    // irrestauravel, e §9.9 so sanciona UMA recusa para a restauracao: "se a
    // allowlist encolheu".
    //
    // A protecao nao muda, e o teste mostra as duas metades: sem digital, a tela
    // de conferencia com o valor literal; com a digital presa ao `op_hash`,
    // grava. Quem prova que o BOTAO da tela emite este corpo — os onze campos
    // mais `acao=restaurar` — e GRAV-16 e GRAV-35, em `painel-auditoria`.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { conferencia, envio } = await comDigital(
      AJUSTES,
      `acao=restaurar&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      aparelho,
    )

    expect({ sem: conferencia.status, com: envio.status }).toEqual({ sem: 403, com: 303 })
    expect((await linhaDeConfig())?.destination_url).toBe(LINK_NOVO)
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'stepup_recusado',
      'config_alterada',
    ])
    // A gravacao levou o carimbo do step-up: §9.9 pergunta se a passkey estava
    // presente, e a restauracao de campo protegido responde que sim.
    expect((await auditoria())[1]?.step_up).toBe(1)

    // E o MESMO corpo sem a operacao declarada e recusado por escopo: e ela que
    // abre a uniao, e nao o formulario de Ajustes ter carregado o campo.
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
    await gravarConfig(env.DB)
    await cadastrarAparelho(aparelho)
    const outra = await abrirSessao(aparelho.credentialId)

    const semOperacao = await postar(
      AJUSTES,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      outra,
    )

    expect(semOperacao.status).toBe(400)
    expect((await linhaDeConfig())?.destination_url).toBe('https://exemplo.com/do-banco')
  })

  test('STEP-36: a mudanca assinada cobre o campo que o HANDLER produziu (Ruling 86)', async () => {
    // §10.10 promete que o autenticador assina *aquela* mudanca, e que a tela
    // mostra o valor literal antes da biometria. Ate o Ruling 86 as duas metades
    // discordavam: `depois` — o que a tela MOSTRA — fundia o patch do corpo com
    // o `patchDoHandler`, e o `op_hash` saia so do patch do CORPO. Um campo
    // produzido pelo handler era exibido na conferencia e ficava FORA da
    // assinatura, que e o inverso exato da garantia.
    //
    // O teste vive no nivel do funil porque e la que o defeito mora: hoje a
    // unica rota com `patchDoHandler` e `/painel/chave`, que so escreve
    // `enabled` — nunca protegido —, entao ela jamais renderiza a conferencia.
    // Esperar a rota que combine as duas coisas seria esperar a Task 13 com o
    // buraco aberto.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    // O corpo carrega `enabled=sim` de proposito, contra a operacao declarada:
    // e o que prende a PRECEDENCIA. O handler traduz `acao=desligar` em
    // `enabled: false`, e ele tem de vencer — se o corpo vencesse, mandar a
    // operacao junto com o campo cru deixaria um cliente adulterado escolher o
    // efeito por baixo da operacao que a tela anunciou.
    const { conferencia, envio, mudanca } = await comDigital(
      CHAVE_COM_LINK,
      `acao=${DESLIGAR}&enabled=sim&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      aparelho,
    )

    expect(conferencia.status).toBe(403)

    // A mudanca canonica que a tela entrega ao `painel.js` — e que o envelope
    // assina — carrega o `enabled` do HANDLER, e nao o do corpo.
    expect(mudanca).toEqual({ acao: 'config', destinationUrl: LINK_NOVO, enabled: false })

    // E o hash fecha nos dois lados: o servidor recalcula do corpo recebido, e o
    // envio passa. Se a soma fosse feita so num dos lados, esta linha seria um
    // `403 step_up_invalido`.
    expect(envio.status).toBe(303)
    const linha = await linhaDeConfig()
    expect({ link: linha?.destination_url, ligada: linha?.enabled }).toEqual({
      link: LINK_NOVO,
      ligada: 0,
    })
  })

  test('STEP-37: trocar a operacao entre os dois POSTs quebra o `op_hash`', async () => {
    // O caminho de ataque que o Ruling 80 abriu ao fazer `acao` sobreviver ao
    // segundo POST — e que o Ruling 86 fecha. A digital e a do dono, o envelope
    // esta dentro dos 120 s e o `oh` continua sendo o que ele assinou; o unico
    // campo trocado e a operacao declarada, que o handler traduz num campo de
    // configuracao. Sem o Ruling 86 esse campo nao entra no hash, entao a troca
    // e invisivel para a comparacao e a gravacao acontece com um efeito que
    // ninguem confirmou.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const conferencia = await postar(
      CHAVE_COM_LINK,
      `acao=${DESLIGAR}&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    const tela = await conferencia.text()
    const formulario = formularioDeConfirmacao(tela)

    // A cerimonia assina EXATAMENTE o que a tela mostrou (Ruling 81: o segundo
    // POST sai do formulario renderizado, e nao de uma string do teste).
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(tela))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

    // A UNICA coisa trocada entre o que foi assinado e o que e enviado.
    formulario.campos.set(CAMPO_DA_ACAO, LIGAR)

    const envio = await postarFormulario(
      CHAVE_COM_LINK,
      formulario,
      sessao,
      cookieDoEnvelope(cerimoniaResposta),
      await digitalPara(aparelho, challenge),
    )

    expect(envio.status).toBe(403)
    // E nada foi gravado: nem o link, que o corpo carregava sem alteracao, nem o
    // `enabled`, que a troca queria manter ligado contra o que o dono assinou.
    const linha = await linhaDeConfig()
    expect({ link: linha?.destination_url, ligada: linha?.enabled }).toEqual({
      link: 'https://exemplo.com/do-banco',
      ligada: 1,
    })
    // A falha de step-up INVALIDA conta, ao contrario da ausente (§10.10).
    expect(await falhasDaSessao(sessao.sidHash)).toBe(1)
  })

  test('STEP-34: o `ator` da auditoria e a passkey que AUTORIZOU, nao a que abriu a sessao', async () => {
    // §9.9 pergunta quem fez a mudanca, e a resposta e o aparelho que encostou o
    // dedo. A sessao aqui e aberta pelo aparelho A e a digital vem do B — o
    // cenario que a Task 14 vai tornar comum, e que hoje so existe porque este
    // teste cadastra a segunda credencial.
    await gravarConfig(env.DB)
    const segundo = await AutenticadorFalso.criar()
    await cadastrarSegundoAparelho(segundo)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { envio } = await comDigital(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      segundo,
    )
    expect(envio.status).toBe(303)

    const linhas = await env.DB.prepare('SELECT acao, ator FROM painel_auditoria ORDER BY id').all<{
      acao: string
      ator: string
    }>()

    expect(linhas.results?.map((linha) => linha.acao)).toEqual([
      'stepup_recusado',
      'config_alterada',
    ])
    expect(linhas.results?.[1]?.ator).toBe(
      `passkey:${await prefixoDeCredencial(segundo.credentialId)}`,
    )
    // E NAO o da sessao, que e o aparelho A.
    expect(linhas.results?.[1]?.ator).not.toBe(
      `passkey:${await prefixoDeCredencial(aparelho.credentialId)}`,
    )
  })

  test('STEP-29: com a allowlist VAZIA os tres campos de endereco sao recusados', async () => {
    // §9.8, §12.7 e LNK-12: lista nao configurada nao "passa tudo" — ela recusa
    // qualquer endereco. O validador devolve zero achados nesse estado de
    // proposito, e a recusa acontece na ESCRITA, perguntando a `configurada`.
    //
    // Ate a etapa do step-up esta promessa era verdadeira por ACIDENTE: os tres
    // campos paravam no `403 step_up_necessario` antes de chegar a validacao.
    // Este teste existe porque, com eles gravaveis, ela passou a depender de uma
    // pergunta explicita — e sem ela uma instalacao sem a variavel aceitaria
    // qualquer link, com a digital correta.
    // **Os TRES campos, e nao so o link.** §13.2 LNK lista "URL dentro do texto
    // do Direct passa pela allowlist" e "idem no texto publico" como garantias
    // SEPARADAS. A primeira grafia deste teste exercitava so `destinationUrl`, e
    // reduzir o predicado a `campo === 'destinationUrl'` deixava a suite verde —
    // o titulo nomeava tres e afirmava um, que e o teste que §13.1 proibe.
    const CAMPOS_DE_ENDERECO: readonly { campo: string; corpo: string; coluna: string }[] = [
      {
        campo: 'destinationUrl',
        corpo: `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
        coluna: 'destination_url',
      },
      {
        campo: 'privateReplyText',
        corpo: `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
        coluna: 'private_reply_text',
      },
      {
        campo: 'publicReplyText',
        corpo: `publicReplyText=${encodeURIComponent(TEXTO_PUBLICO_NOVO)}`,
        coluna: 'public_reply_text',
      },
    ]

    for (const caso of CAMPOS_DE_ENDERECO) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB)
      await cadastrarAparelho(aparelho)
      const sessao = await abrirSessao(aparelho.credentialId)
      const antes = (await linhaDeConfig())?.[caso.coluna]

      // **UM POST so, e a expectativa mudou na etapa 12b.** Ate aqui este teste
      // dirigia a cerimonia inteira por `comDigital` e afirmava a sequencia
      // `['stepup_recusado', 'mudanca_recusada']` — quer dizer: o painel de uma
      // instalacao sem a variavel de deploy mostrava a tela de conferencia,
      // colhia a digital do dono, VERIFICAVA a assertion com sucesso e so entao
      // dizia que nao. §9.7 poe a validacao no passo 7 e o step-up no passo 8,
      // e o Ruling 73 e literal sobre o custo de inverter isso: uma cerimonia
      // que nunca pode suceder ensina o dono que digital as vezes nao faz nada.
      // Nao ha sequer o que confirmar aqui — nenhum endereco pode ser gravado
      // enquanto a lista nao existir.
      const recusa = await postar(MENSAGEM, caso.corpo, sessao, { ambiente: env })
      const tela = await recusa.text()

      expect({ [caso.campo]: recusa.status }).toEqual({ [caso.campo]: 403 })
      expect({ [caso.campo]: (await linhaDeConfig())?.[caso.coluna] }).toEqual({
        [caso.campo]: antes,
      })
      expect({ [caso.campo]: (await auditoria()).map((linha) => linha.acao) }).toEqual({
        [caso.campo]: ['mudanca_recusada'],
      })
      // E a contraprova de que nenhum gesto foi pedido: a tela da recusa nao
      // traz a conferencia nem a mudanca canonica.
      expect({ [caso.campo]: tela.includes('data-mudanca') }).toEqual({ [caso.campo]: false })
      expect({ [caso.campo]: tela.includes('Confira o que vai mudar') }).toEqual({
        [caso.campo]: false,
      })
    }
  })

  test('STEP-30: gravacao que perde a trava otimista NAO rotaciona o `sid`', async () => {
    // O pior desfecho possivel para quem acabou de encostar o dedo no leitor: a
    // digital fecha, a trava otimista de §8.8 recusa a gravacao, e o `sid` no
    // banco muda assim mesmo — a rota responde `versao_desatualizada` SEM mandar
    // o cookie novo, e o dono e deslogado por uma gravacao que nunca aconteceu.
    //
    // Quem impede e o `AND changes() > 0` de `statementDeRotacao`, e este teste
    // nasceu de um MUTANTE SOBREVIVENTE: apagar aquela condicao deixava a suite
    // inteira verde.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)
    const sabotado = {
      ...AMBIENTE,
      DB: new D1ComEscritorConcorrente(env.DB) as unknown as D1Database,
    } as unknown as typeof env

    const { envio } = await comDigital(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`,
      sessao,
      aparelho,
      { ambiente: sabotado },
    )

    // A gravacao foi recusada pela trava, e nada mudou na configuracao.
    expect(envio.status).toBe(409)
    expect((await linhaDeConfig())?.private_reply_text).not.toBe(TEXTO_NOVO)

    // E a sessao continua sendo a MESMA: sem rotacao, sem cookie novo, sem
    // ninguem deslogado.
    const viva = await env.DB.prepare('SELECT sid_hash FROM painel_sessoes').first<{
      sid_hash: string
    }>()
    expect(viva?.sid_hash).toBe(sessao.sidHash)
    expect(envio.headers.getAll('set-cookie')).toEqual([])

    // Sem log, sem mudanca: a auditoria so tem a linha da tela de conferencia.
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['stepup_recusado'])
  })

  test('STEP-31: envelope com desafio VAZIO nao autoriza, mesmo assinado por nos', async () => {
    // Defesa em profundidade, e ela nasceu de um MUTANTE SOBREVIVENTE: apagar o
    // `desafio === ''` de `exigirStepUp` nao derrubava nenhum teste, porque so o
    // servidor assina envelope e a cerimonia nunca sorteia string vazia.
    //
    // O envelope daqui e emitido pela porta de PRODUCAO, com a chave de
    // verdade — e o que ele simula e um defeito NOSSO, nao um forjador. Sem a
    // linha, `verificarAssertion` compararia o desafio do cliente contra `''`, e
    // quem soubesse do defeito assinaria uma cerimonia vazia.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)
    const campos = `destinationUrl=${encodeURIComponent(LINK_NOVO)}`

    const conferencia = await postar(MENSAGEM, campos, sessao)
    const mudanca = mudancaDaTela(await conferencia.text())
    const envelope = await emitirEnvelope(
      AMBIENTE,
      'stepup',
      {
        c: '',
        oh: await opHash({
          acao: 'config',
          campos: Object.fromEntries(
            Object.entries(mudanca).filter(([nome]) => nome !== 'acao'),
          ) as Record<string, string>,
        }),
        sid: sessao.sidHash,
      },
      AGORA,
    )

    const resposta = await postar(MENSAGEM, campos, sessao, {
      stepup: `__Host-painel_stepup=${envelope}`,
      digital: await digitalPara(aparelho, ''),
    })

    expect(resposta.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_NOVO)
  })

  test('STEP-28: cancelar nao grava nada, e o rascunho continua na tela', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const corpo = await (
      await postar(MENSAGEM, `privateReplyText=${encodeURIComponent(TEXTO_NOVO)}`, sessao)
    ).text()

    // O rascunho volta inteiro, em campo escondido, sem ser gravado.
    expect(corpo).toContain('name="privateReplyText"')
    expect(corpo).toContain('Cancelar')
    expect((await linhaDeConfig())?.private_reply_text).toBe(
      'Ola, {username}! Aqui esta o link: {link}',
    )
  })

  test('STEP-38: mudanca INVALIDA em campo protegido morre no validador, sem cerimonia', async () => {
    // A garantia que a etapa 12b acrescentou, e o veiculo e de proposito uma
    // recusa que **nao** e a da allowlist. STEP-24 e STEP-29 ja cobrem o ramo
    // do dominio; um teste que so exercitasse aquele ramo deixaria o resto do
    // validador — tamanho, placeholder, cooldown, gatilho — fora da ordem de
    // §9.7, e a ordem e uma propriedade do funil, nao da allowlist.
    //
    // O veiculo e `publicReplyText` com um placeholder, que §9.7 recusa em uma
    // linha so: "nenhum placeholder", porque o texto publico nao passa por
    // `renderTemplate` e um `{link}` ali sairia escrito assim mesmo,
    // publicamente. O campo e protegido SEMPRE (§10.10), entao ele reune as
    // duas metades num corpo so: exige a digital e nunca poderia ser gravado.
    //
    // **Este e o teste que a mutacao de ORDEM PURA mata.** Mover
    // `validarOuRecusar` de volta para depois de `passarPeloStepUp` — sem
    // mudar mais nada — o quebra em tres pontos de uma vez: o `400
    // dados_invalidos` vira `403 step_up_necessario`, a tela passa a trazer a
    // conferencia e o `data-mudanca`, e a auditoria ganha a linha
    // `stepup_recusado` na frente.
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)
    const antes = (await linhaDeConfig())?.public_reply_text

    const recusa = await postar(
      MENSAGEM,
      `publicReplyText=${encodeURIComponent('Ja mandei o {link} no seu Direct.')}`,
      sessao,
    )
    const tela = await recusa.text()

    expect(recusa.status).toBe(400)
    expect((await linhaDeConfig())?.public_reply_text).toBe(antes)

    expect(tela).not.toContain('Confira o que vai mudar')
    expect(tela).not.toContain('data-mudanca')
    expect((await auditoria()).map((linha) => linha.acao)).toEqual(['mudanca_recusada'])
  })
})
