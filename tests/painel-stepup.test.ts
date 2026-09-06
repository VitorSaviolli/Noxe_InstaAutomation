import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { handleAjustes } from '../src/routes/painel/ajustes'
import { handleMensagem } from '../src/routes/painel/mensagem'
import { handlePalavras } from '../src/routes/painel/palavras'
import {
  ROTA_AJUSTES,
  ROTA_MENSAGEM,
  ROTA_OPCOES_DE_STEPUP,
  ROTA_PALAVRAS,
  type RotaDoPainel,
} from '../src/routes/painel/rotas'
import { despachar, type HandlerDoPainel } from '../src/routes/painel/router'
import { jsonCanonico, opHash } from '../src/routes/painel/stepup'
import { PRAZO_DE_ENVELOPE_MS } from '../src/security/signed-envelope'
import { invalidarCacheDeConfig } from '../src/services/config-store'
import {
  emitirEnvelope,
  emitirSessao,
  fichaCsrf,
  PRAZO_OCIOSO_DE_SESSAO_MS,
} from '../src/services/panel-session'
import { AutenticadorFalso, cerimonia, semUv } from './fixtures/autenticador'
import { gravarConfig, limparBanco } from './fixtures/banco'
import { AGORA, capturarConsole, RAIZ } from './fixtures/dubles'

/**
 * STEP — o step-up de §10.10: uma operacao, presa ao conteudo.
 *
 * As 17 garantias de §13.2 sao STEP-01 a STEP-17; STEP-18 a STEP-21 sao o
 * "mais" da mesma linha — `json_canonico` com vetores congelados e o mesmo hash
 * a partir do JSON da cerimonia e do formulario urlencoded. STEP-22 em diante
 * sao as travas da cerimonia e da tela que as dezessete nao nomeiam mas das
 * quais dependem.
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

/** A mudanca canonica que a tela de conferencia entrega ao `painel.js`. */
function mudancaDaTela(corpo: string): Record<string, unknown> {
  const achado = /data-mudanca="([^"]*)"/.exec(corpo)
  if (achado === null) throw new Error('a tela de conferencia nao trouxe a mudanca')
  return JSON.parse(desescapar(achado[1] as string)) as Record<string, unknown>
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
    handleOpcoesDaRota,
  )
}

/** O handler da rota da cerimonia, importado pelo caminho de producao. */
const handleOpcoesDaRota: HandlerDoPainel = async (entrada) =>
  (await import('../src/routes/painel/stepup')).handleOpcoesDeStepUp(entrada)

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
 */
async function comDigital(
  alvo: { rota: RotaDoPainel; handler: HandlerDoPainel },
  campos: string,
  sessao: Sessao,
  aparelho: AutenticadorFalso,
  opcoes: OpcoesDeEnvio = {},
): Promise<{ conferencia: Response; envio: Response; mudanca: Record<string, unknown> }> {
  const conferencia = await postar(alvo, campos, sessao, opcoes)
  const mudanca = mudancaDaTela(await conferencia.text())

  const cerimoniaResposta = await pedirOpcoes(sessao, mudanca, {
    now: opcoes.now,
    ambiente: opcoes.ambiente,
  })
  const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }

  const envio = await postar(alvo, campos, sessao, {
    ...opcoes,
    stepup: cookieDoEnvelope(cerimoniaResposta),
    digital: await digitalPara(aparelho, challenge),
  })

  return { conferencia, envio, mudanca }
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

    const { envio } = await comDigital(
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
    const segunda = await postar(
      MENSAGEM,
      `privateReplyText=${encodeURIComponent(OUTRO_TEXTO)}`,
      { ...seguinte, ficha },
      { versao: 2, stepup: '__Host-painel_stepup=nao-importa', digital: 'nao-importa' },
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

  test('STEP-10: `mediaScope` para "todas" exige step-up (a metade positiva e da Task 13)', async () => {
    // **A metade positiva desta garantia esta ADIADA, e o teste diz isso em vez
    // de esconder** (Ruling 68): a tela dona de `mediaScope` — `/painel/reels` —
    // nao existe, entao o campo nao e gravavel nem com a digital. O que se
    // afirma aqui e a metade que existe: alargar o escopo PARA a digital, e a
    // ordem dos portoes e a de §10.10 — o step-up vem ANTES da recusa por campo
    // nao gravavel, entao a resposta e `403`, e nao `400`.
    await gravarConfig(env.DB, { media_scope: 'selecionadas' })
    const sessao = await abrirSessao(aparelho.credentialId)

    const resposta = await postar(AJUSTES, 'mediaScope=todas', sessao)

    expect(resposta.status).toBe(403)
    expect((await auditoria())[0]?.acao).toBe('stepup_recusado')
    expect((await linhaDeConfig())?.media_scope).toBe('selecionadas')
  })

  test('STEP-11: desligar a automacao NAO exige step-up', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const sessao = await abrirSessao(aparelho.credentialId)

    const resposta = await postar(AJUSTES, 'enabled=nao', sessao)

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
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao(aparelho.credentialId)

    // Um campo de risco baixo (subir o intervalo) junto de um protegido (o
    // link). §10.10: se qualquer campo do lote exige, o lote inteiro exige.
    const semDigital = await postar(
      AJUSTES,
      `userCooldownHours=48&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    expect(semDigital.status).toBe(403)
    expect((await linhaDeConfig())?.user_cooldown_hours).toBe(24)

    // E com uma digital que NAO fecha, tambem nao: nem o campo barato passa.
    const conferencia = await postar(
      AJUSTES,
      `userCooldownHours=48&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
    )
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const comDigitalRuim = await postar(
      AJUSTES,
      `userCooldownHours=48&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      { stepup: cookieDoEnvelope(cerimoniaResposta), digital: '{"credencial":{}}' },
    )

    expect(comDigitalRuim.status).toBe(403)
    const linha = await linhaDeConfig()
    expect({ horas: linha?.user_cooldown_hours, link: linha?.destination_url }).toEqual({
      horas: 24,
      link: 'https://exemplo.com/do-banco',
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
    // §15.4: em `/painel/mensagem` a tela diz, ANTES do gesto, que o toque cobre
    // a tela inteira.
    expect(corpo).toContain('confirma <strong>os tr&ecirc;s campos desta tela de uma vez</strong>')
  })

  test('STEP-23: mexer num campo escondido da tela de conferencia muda o hash e a gravacao e recusada', async () => {
    await gravarConfig(env.DB, { user_cooldown_hours: 24 })
    const sessao = await abrirSessao(aparelho.credentialId)

    // O lote leva um campo barato e um protegido; a cerimonia assina os dois.
    const campos = `userCooldownHours=1&destinationUrl=${encodeURIComponent(LINK_NOVO)}`
    const conferencia = await postar(AJUSTES, campos, sessao)
    const cerimoniaResposta = await pedirOpcoes(sessao, mudancaDaTela(await conferencia.text()))
    const { challenge } = (await cerimoniaResposta.json()) as { challenge: string }
    const digital = await digitalPara(aparelho, challenge)

    // O campo escondido do lado BARATO e mexido depois da digital.
    const mexido = await postar(
      AJUSTES,
      `userCooldownHours=0&destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      { stepup: cookieDoEnvelope(cerimoniaResposta), digital },
    )

    expect(mexido.status).toBe(403)
    const linha = await linhaDeConfig()
    expect({ horas: linha?.user_cooldown_hours, link: linha?.destination_url }).toEqual({
      horas: 24,
      link: 'https://exemplo.com/do-banco',
    })
  })

  test('STEP-24: link fora da allowlist e barrado MESMO com a digital correta', async () => {
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { envio } = await comDigital(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_PROIBIDO)}`,
      sessao,
      aparelho,
    )

    expect(envio.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).not.toBe(LINK_PROIBIDO)
    // E a recusa e do VALIDADOR, e nao do step-up: a linha diz `mudanca_recusada`.
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'stepup_recusado',
      'mudanca_recusada',
    ])
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
    await gravarConfig(env.DB)
    const sessao = await abrirSessao(aparelho.credentialId)

    const { envio } = await comDigital(
      MENSAGEM,
      `destinationUrl=${encodeURIComponent(LINK_NOVO)}`,
      sessao,
      aparelho,
      { ambiente: env },
    )

    expect(envio.status).toBe(403)
    expect((await linhaDeConfig())?.destination_url).toBe('https://exemplo.com/do-banco')
    expect((await auditoria()).map((linha) => linha.acao)).toEqual([
      'stepup_recusado',
      'mudanca_recusada',
    ])
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
})
