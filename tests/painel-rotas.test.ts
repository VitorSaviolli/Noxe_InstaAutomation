import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  handleOpcoesDeEntrar,
  handlePaginaDeEntrar,
  handleVerificarEntrada,
} from '../src/routes/painel/entrar'
import { invalidarBaldesDeReserva } from '../src/routes/painel/guardas'
import { cabecalhos } from '../src/routes/painel/html'
import { handleInicio } from '../src/routes/painel/inicio'
import { TETO_DO_CORPO_DA_API } from '../src/routes/painel/registrar'
import {
  ROTA_ENTRAR,
  ROTA_INICIO,
  ROTA_OPCOES_DE_ENTRAR,
  ROTA_VERIFICAR_ENTRADA,
  ROTAS,
  type RotaDoPainel,
  TETO_DO_CORPO_DE_FORMULARIO,
} from '../src/routes/painel/rotas'
import { despachar, routePainel } from '../src/routes/painel/router'
import { PRAZO_DE_ENVELOPE_MS } from '../src/security/signed-envelope'
import {
  emitirSessao,
  PRAZO_ABSOLUTO_DE_SESSAO_MS,
  PRAZO_OCIOSO_DE_SESSAO_MS,
} from '../src/services/panel-session'
import type { Env } from '../src/types/env'
import {
  AutenticadorFalso,
  cerimonia,
  comOrigin,
  comRpId,
  semUp,
  semUv,
  trocarByte,
} from './fixtures/autenticador'
import { limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  D1BatchQuebrado,
  D1Contador,
  LimitadorFalso,
  pedir,
  RAIZ,
  responder,
} from './fixtures/dubles'

/**
 * ROTA · HDR · SES(06,07) — o portao de rotas, o login e os cabecalhos.
 *
 * `now` e sempre injetado nos testes que medem prazo ou contam consulta: eles
 * dirigem `despachar`, que e a mesma funcao que o roteador usa. Os poucos que
 * passam pelo Worker inteiro (`responder`) existem so para provar a LIGACAO —
 * que o caminho chega mesmo ao handler — e nao afirmam nada sobre relogio.
 */

const HANDLE_DO_DONO = 'handle-do-dono-de-teste'

/** O que a tabela de §11.4 devolve nas duas familias. Escrito, nao derivado. */
const FRASE_DE_CREDENCIAL = 'Não foi possível confirmar. Tente de novo.'

function ambienteCom(mudanca: Record<string, unknown>): Env {
  return { ...env, ...mudanca } as unknown as Env
}

/** O `env` SEM um binding, que e como um binding nao cadastrado chega. */
function ambienteSem(nome: string): Env {
  const { [nome]: _ausente, ...resto } = env as unknown as Record<string, unknown>
  return resto as unknown as Env
}

function cabecalhosDe(resposta: Response): Record<string, string> {
  return Object.fromEntries(resposta.headers)
}

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

function postDeApi(caminho: string, corpo: unknown, cabecalhosExtras: Record<string, string> = {}) {
  return new Request(`${RAIZ}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: RAIZ, ...cabecalhosExtras },
    body: JSON.stringify(corpo),
  })
}

/**
 * Uma requisicao BEM formada para qualquer linha da tabela.
 *
 * Ela e derivada da propria linha — metodo, familia e origem —, entao uma rota
 * nova entra nos lacos que a percorrem sem ninguem escrever nada a mao.
 */
function pedirDaRota(rota: RotaDoPainel): Request {
  const metodo = rota.metodos.includes('GET') ? 'GET' : 'POST'
  if (metodo === 'GET') return pedir(rota.caminho)

  const familia = rota.caminho.startsWith('/painel/api/')
  return new Request(`${RAIZ}${rota.caminho}`, {
    method: 'POST',
    headers: {
      'content-type': familia ? 'application/json' : 'application/x-www-form-urlencoded',
      origin: RAIZ,
    },
    body: familia ? '{}' : '',
  })
}

/** Roda `POST /painel/api/entrar/opcoes` e devolve o desafio e o cookie dele. */
async function pedirDesafio(
  ambiente: Env = env,
  now = AGORA,
): Promise<{ desafio: string; cookie: string; resposta: Response }> {
  const resposta = await despachar(
    postDeApi('/painel/api/entrar/opcoes', {}),
    ambiente,
    now,
    ROTA_OPCOES_DE_ENTRAR,
    handleOpcoesDeEntrar,
  )

  const opcoes = (await resposta.clone().json()) as { challenge: string }
  const envelope = /__Host-painel_desafio=([^;]*)/.exec(resposta.headers.get('set-cookie') ?? '')
  return {
    desafio: opcoes.challenge,
    cookie: `__Host-painel_desafio=${envelope?.[1] ?? ''}`,
    resposta,
  }
}

describe('ROTA — o portao de sanidade e o despacho', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('routePainel devolve null para quem nao e do painel — e e isso que preserva o 404', async () => {
    for (const caminho of ['/health', '/webhooks/instagram', '/painelzinho', '/', '/setup']) {
      const url = new URL(`${RAIZ}${caminho}`)
      const resultado = await routePainel(pedir(caminho), env, url, AGORA)
      expect({ [caminho]: resultado }).toEqual({ [caminho]: null })
    }
  })

  test('sem PANEL_RP_ID o painel inteiro responde 503, e sem lancar TypeError', async () => {
    const ambiente = ambienteSem('PANEL_RP_ID')
    expect(ambiente.PANEL_RP_ID).toBeUndefined()

    for (const caminho of ['/painel', '/painel/entrar', '/painel/api/entrar/opcoes', '/painel/x']) {
      const url = new URL(`${RAIZ}${caminho}`)
      const resposta = await routePainel(pedir(caminho), ambiente, url, AGORA)
      expect({ [caminho]: resposta?.status }).toEqual({ [caminho]: 503 })
    }
  })

  test('sem PANEL_SESSION_KEY tambem: o portao e falha FECHADA', async () => {
    const url = new URL(`${RAIZ}/painel/entrar`)
    const resposta = await routePainel(
      pedir('/painel/entrar'),
      ambienteSem('PANEL_SESSION_KEY'),
      url,
      AGORA,
    )

    expect(resposta?.status).toBe(503)
    expect(await resposta?.text()).toContain('O painel ainda não foi ativado neste deploy.')
  })

  test('o 503 do portao respeita a familia: HTML na pagina, JSON na API', async () => {
    const ambiente = ambienteSem('PANEL_RP_ID')

    const daPagina = await routePainel(
      pedir('/painel/entrar'),
      ambiente,
      new URL(`${RAIZ}/painel/entrar`),
      AGORA,
    )
    const daApi = await routePainel(
      pedir('/painel/api/entrar/opcoes'),
      ambiente,
      new URL(`${RAIZ}/painel/api/entrar/opcoes`),
      AGORA,
    )

    expect(daPagina?.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await daApi?.json()).toEqual({
      erro: 'painel_desativado',
      mensagem: 'O painel ainda não foi ativado neste deploy.',
    })
  })

  test('caminho /painel/** desconhecido responde 404 pela tabela de §11.4', async () => {
    const daPagina = await responder(pedir('/painel/nao-existe'), env)
    const daApi = await responder(pedir('/painel/api/nao-existe'), env)

    expect(daPagina.status).toBe(404)
    expect(await daPagina.text()).toContain('Página não encontrada.')

    expect(daApi.status).toBe(404)
    expect(await daApi.json()).toEqual({
      erro: 'rota_desconhecida',
      mensagem: 'Página não encontrada.',
    })
  })

  test('metodo errado e 405 com `Allow`, e OPTIONS cai la de proposito', async () => {
    const espiao = { chamadas: 0 }
    const handler = () => {
      espiao.chamadas++
      return new Response('nao devia', { status: 200 })
    }

    for (const metodo of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const resposta = await despachar(
        new Request(`${RAIZ}/painel/entrar`, { method: metodo, headers: { origin: RAIZ } }),
        env,
        AGORA,
        ROTA_ENTRAR,
        handler,
      )

      expect({ [metodo]: resposta.status }).toEqual({ [metodo]: 405 })
      expect({ [metodo]: resposta.headers.get('allow') }).toEqual({ [metodo]: 'GET' })
    }

    expect(espiao.chamadas).toBe(0)
  })

  test('HEAD e tratado como GET', async () => {
    const resposta = await despachar(
      new Request(`${RAIZ}/painel/entrar`, { method: 'HEAD' }),
      env,
      AGORA,
      ROTA_ENTRAR,
      handlePaginaDeEntrar,
    )

    expect(resposta.status).toBe(200)
  })

  test('nenhuma resposta do painel traz cabecalho `Access-Control-*`', async () => {
    const respostas = [
      await responder(pedir('/painel'), env),
      await responder(pedir('/painel/entrar'), env),
      await responder(pedir('/painel/nao-existe'), env),
      await responder(
        new Request(`${RAIZ}/painel/entrar`, { method: 'OPTIONS', headers: { origin: RAIZ } }),
        env,
      ),
    ]

    for (const resposta of respostas) {
      for (const [nome] of resposta.headers) {
        expect(nome.startsWith('access-control-')).toBe(false)
      }
    }
  })

  test('o roteador nao ve /painel/parada nem /painel/parar: elas sao desviadas antes', async () => {
    // Elas tem `case` proprio em `src/index.ts`, ANTES do `default:`, para nao
    // passarem pelo portao de sanidade (§11.1). Aqui a prova pelo avesso: se
    // alguem as registrasse no roteador, este teste ficaria vermelho.
    for (const caminho of ['/painel/parada', '/painel/parar']) {
      const resposta = await routePainel(pedir(caminho), env, new URL(`${RAIZ}${caminho}`), AGORA)
      expect({ [caminho]: resposta?.status }).toEqual({ [caminho]: 404 })
    }

    // E pelo direito: pelo Worker inteiro, o formulario responde 200.
    const formulario = await responder(pedir('/painel/parar'), env)
    expect(formulario.status).toBe(200)
  })
})

describe('ROTA — o portao de sessao (§11.3, passos 6 e 9)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('GET /painel sem cookie responde 303 para /painel/entrar, com ZERO consulta ao D1', async () => {
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      pedir('/painel'),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )

    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe('/painel/entrar')
    // Um cookie ausente e recusado no passo 6, e o passo 9 nem acontece.
    expect(contador.prepares).toBe(0)
  })

  test('cookie de lixo tambem custa ZERO consulta: o HMAC e o filtro gratis', async () => {
    const contador = new D1Contador(env.DB)

    for (const lixo of ['', 'x', 's1.a.b.c', 'a.b.c.d.e', 's2.a.1.b']) {
      const resposta = await despachar(
        pedir('/painel', { cookie: `__Host-painel_sessao=${lixo}` }),
        ambienteCom({ DB: comoD1(contador) }),
        AGORA,
        ROTA_INICIO,
        handleInicio,
      )
      expect({ [lixo]: resposta.status }).toEqual({ [lixo]: 303 })
    }

    expect(contador.prepares).toBe(0)
  })

  test('a recusa do passo 6 respeita a familia: 401 JSON na API, 303 na pagina', async () => {
    // §11.3 fixa as duas formas, e a diferenca nao e cosmetica: o `painel.js`
    // faz `resposta.json()` nas rotas `/painel/api/*`, e um 303 com HTML no
    // lugar do 401 vira erro de parse no navegador do dono.
    const daApi: RotaDoPainel = {
      caminho: '/painel/api/stepup/opcoes',
      metodos: ['POST'],
      sessao: true,
      csrf: true,
      stepUp: false,
      escreve: false,
      gravaConfig: false,
    }
    const espiao = { chamadas: 0 }
    const handler = () => {
      espiao.chamadas++
      return new Response('nao devia', { status: 200 })
    }

    const contador = new D1Contador(env.DB)
    const semCookie = await despachar(
      new Request(`${RAIZ}${daApi.caminho}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: RAIZ },
        body: '{}',
      }),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      daApi,
      handler,
    )

    expect(semCookie.status).toBe(401)
    expect(await semCookie.json()).toEqual({
      erro: 'sessao_ausente',
      mensagem: 'Sua sessão expirou. Entre de novo.',
    })
    expect(semCookie.headers.get('location')).toBeNull()
    expect(espiao.chamadas).toBe(0)
    expect(contador.prepares).toBe(0)

    // A metade de pagina, lado a lado, para que a diferenca seja a afirmacao.
    const daPagina = await despachar(pedir('/painel'), env, AGORA, ROTA_INICIO, handleInicio)
    expect(daPagina.status).toBe(303)
    expect(daPagina.headers.get('location')).toBe('/painel/entrar')
  })

  test('cookie com MAC valido mas SEM linha no banco e recusado — a linha e a autoridade', async () => {
    const sessao = await emitirSessao(env, AGORA)

    const resposta = await despachar(
      pedir('/painel', { cookie: `__Host-painel_sessao=${sessao.valor}` }),
      env,
      AGORA,
      ROTA_INICIO,
      handleInicio,
    )

    expect(resposta.status).toBe(303)
  })

  test('com a linha viva, o Inicio abre; ociosa demais, nao abre', async () => {
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

    const cookie = { cookie: `__Host-painel_sessao=${sessao.valor}` }

    const dentro = await despachar(pedir('/painel', cookie), env, AGORA, ROTA_INICIO, handleInicio)
    expect(dentro.status).toBe(200)
    // O titulo da tela de Inicio, e nao um trecho do corpo dela: o assunto
    // deste teste e o PORTAO de sessao, e prende-lo a uma frase da tela faria
    // toda mudanca de texto quebrar um teste que nao fala sobre texto.
    expect(await dentro.text()).toContain('<h1>In&iacute;cio</h1>')

    // Dentro das 12 h absolutas, mas parada ha mais de 2 h: e o celular
    // esquecido na mesa, e ele expira sozinho.
    const ocioso = AGORA + PRAZO_OCIOSO_DE_SESSAO_MS + 1
    const fora = await despachar(pedir('/painel', cookie), env, ocioso, ROTA_INICIO, handleInicio)
    expect(fora.status).toBe(303)
  })
})

describe('ROTA — a tela de entrar, e o custo dela', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('GET /painel/entrar renderiza com ZERO consulta ao D1', async () => {
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      pedir('/painel/entrar'),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      ROTA_ENTRAR,
      handlePaginaDeEntrar,
    )
    const corpo = await resposta.text()

    expect(resposta.status).toBe(200)
    expect(contador.prepares).toBe(0)
    // O link "Continuar" e a mitigacao escrita do `SameSite=Strict` (§10.8).
    expect(corpo).toContain('href="/painel"')
    expect(corpo).toContain('<noscript>')
    expect(corpo).toContain('<script src="/painel/painel.js" defer></script>')
    expect(corpo).toContain('<link rel="stylesheet" href="/painel/painel.css">')
  })

  test('POST /painel/api/entrar/opcoes devolve as options com ZERO consulta ao D1', async () => {
    const contador = new D1Contador(env.DB)
    const { resposta, desafio } = await pedirDesafio(ambienteCom({ DB: comoD1(contador) }))
    const opcoes = (await resposta.json()) as Record<string, unknown>

    expect(resposta.status).toBe(200)
    expect(contador.prepares).toBe(0)
    expect(opcoes).toEqual({
      challenge: desafio,
      rpId: env.PANEL_RP_ID,
      // VAZIA: devolver a lista de `credential_id` a quem ainda nao provou nada
      // seria enumeracao de graca (§10.7).
      allowCredentials: [],
      userVerification: 'required',
      timeout: 120_000,
    })
  })

  test('o Worker inteiro liga os caminhos do painel aos handlers', async () => {
    // A prova de LIGACAO: o `default:` de `src/index.ts` chega ao roteador, e o
    // roteador chega a cada handler. Sem relogio injetado, e de proposito — o
    // que se afirma aqui e o fio, e nao o prazo.
    const entrar = await responder(pedir('/painel/entrar'), env)
    const inicio = await responder(pedir('/painel'), env)
    const opcoes = await responder(postDeApi('/painel/api/entrar/opcoes', {}), env)
    const convite = await responder(pedir('/painel/convite'), env)

    expect({
      entrar: entrar.status,
      inicio: inicio.status,
      opcoes: opcoes.status,
      convite: convite.status,
    }).toEqual({ entrar: 200, inicio: 303, opcoes: 200, convite: 200 })
  })
})

describe('ROTA — o login, e a sessao que so nasce aqui (§10.7)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  /** A cerimonia inteira, do desafio ao cookie de sessao. */
  async function entrar(
    aparelho: AutenticadorFalso,
    opcoes: {
      readonly mudar?: (c: ReturnType<typeof cerimonia>) => ReturnType<typeof cerimonia>
      readonly handle?: string | null
      readonly now?: number
      readonly ambiente?: Env
      readonly cookie?: string
    } = {},
  ): Promise<Response> {
    const ambiente = opcoes.ambiente ?? env
    const now = opcoes.now ?? AGORA
    const desafio = await pedirDesafio(ambiente, now)
    const base = cerimonia({
      rpId: env.PANEL_RP_ID,
      origem: RAIZ,
      desafio: desafio.desafio,
      tipo: 'webauthn.get',
    })

    const assertion = await aparelho.autenticar(
      opcoes.mudar === undefined ? base : opcoes.mudar(base),
      opcoes.handle === undefined ? HANDLE_DO_DONO : opcoes.handle,
    )

    return despachar(
      postDeApi(
        '/painel/api/entrar/verificar',
        { credencial: assertion },
        { cookie: opcoes.cookie ?? desafio.cookie },
      ),
      ambiente,
      now,
      ROTA_VERIFICAR_ENTRADA,
      handleVerificarEntrada,
    )
  }

  test('assertion valida entra: 1 leitura, 3 escritas, e a linha de sessao existe', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const contador = new D1Contador(env.DB)
    const resposta = await entrar(aparelho, { ambiente: ambienteCom({ DB: comoD1(contador) }) })

    expect(resposta.status).toBe(200)
    expect(await resposta.clone().json()).toEqual({ ok: true, para: '/painel' })

    // §9.10: login bem-sucedido = 1 leitura + 3 escritas, num lote so.
    expect({
      leituras: contador.prepares - contador.escritas,
      escritas: contador.escritas,
    }).toEqual({ leituras: 1, escritas: 3 })
    expect(contador.batches).toBe(1)

    const sessoes = await env.DB.prepare(
      'SELECT credential_id, rp_id, expira_em, ociosa_ate, falhas_stepup FROM painel_sessoes',
    ).all<Record<string, unknown>>()
    expect(sessoes.results).toEqual([
      {
        credential_id: aparelho.credentialId,
        rp_id: env.PANEL_RP_ID,
        expira_em: AGORA + PRAZO_ABSOLUTO_DE_SESSAO_MS,
        ociosa_ate: AGORA + PRAZO_OCIOSO_DE_SESSAO_MS,
        falhas_stepup: 0,
      },
    ])

    const credencial = await env.DB.prepare(
      'SELECT usado_em FROM painel_credenciais LIMIT 1',
    ).first<{ usado_em: number }>()
    expect(credencial?.usado_em).toBe(AGORA)

    const auditoria = await env.DB.prepare(
      'SELECT acao, origem, step_up, alvo FROM painel_auditoria',
    ).all<Record<string, unknown>>()
    expect(auditoria.results).toEqual([{ acao: 'login', origem: 'painel', step_up: 0, alvo: null }])
  })

  test('§11.4: excecao inesperada no login e `500 falha_interna`, e nunca `503`', async () => {
    // Mesmo defeito, mesma prova, que o de `registrar.ts` (commit `75a5312`,
    // coberto em `painel-convite.test.ts`): a tabela canonica de §11.4 da
    // `indisponivel` (503) a "D1 indisponivel ou cota estourada" e
    // `falha_interna` (500) a "qualquer excecao nao prevista". Uma assertion
    // GENUINA e valida — a leitura da credencial e a verificacao da assinatura
    // fecham as duas — e so o `db.batch()` final de `abrirSessao` que estoura,
    // exatamente como um D1 fora do ar quebraria no meio da escrita.
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await entrar(aparelho, {
        ambiente: ambienteCom({ DB: new D1BatchQuebrado(env.DB) }),
      })
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(500)
    expect(await resposta.json()).toEqual({
      erro: 'falha_interna',
      mensagem: 'Algo deu errado. Tente de novo.',
    })
    expect(registrado.linhas.join('\n')).toContain('falha_interna')
    expect(registrado.linhas.join('\n')).not.toContain('indisponivel')
    // Nunca `credencial_invalida`: uma excecao nao e um motivo de `recusar()`,
    // e colapsa-la ali seria o MESMO oraculo generico aplicado a um bug nosso.
    expect(registrado.linhas.join('\n')).not.toContain('credencial_invalida')
    // A sessao nunca nasceu: sem `set-cookie`, e sem alterar a forma da recusa
    // de um login que falhou.
    expect(resposta.headers.get('set-cookie')).toBeNull()

    const sessoes = await env.DB.prepare('SELECT COUNT(*) AS n FROM painel_sessoes').first<{
      n: number
    }>()
    expect(sessoes?.n).toBe(0)
  })

  test('SES-06: o cookie de sessao sai com os QUATRO atributos', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const resposta = await entrar(aparelho)
    const cookie = resposta.headers.get('set-cookie') ?? ''

    expect(cookie.startsWith('__Host-painel_sessao=')).toBe(true)
    expect(cookie).toContain('; HttpOnly')
    expect(cookie).toContain('; Secure')
    expect(cookie).toContain('; SameSite=Strict')
    expect(cookie).toContain('; Path=/')
    // `Path=/painel` e INVALIDO: o prefixo `__Host-` exige `Path=/` (§7.2).
    expect(cookie).not.toContain('Path=/painel')
    // `Max-Age` e o restante do prazo absoluto — 12 h a partir do login.
    expect(cookie).toContain(`Max-Age=${PRAZO_ABSOLUTO_DE_SESSAO_MS / 1000}`)
    expect(cookie).not.toContain('Domain=')
  })

  test('SES-07: o cookie nao aparece no corpo nem em outro cabecalho', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const resposta = await entrar(aparelho)
    const valor = (resposta.headers.get('set-cookie') ?? '').split(';')[0]?.split('=')[1] ?? ''
    const sid = valor.split('.')[1] ?? ''
    const corpo = await resposta.clone().text()

    expect(sid.length).toBeGreaterThan(20)
    expect(corpo).not.toContain(valor)
    expect(corpo).not.toContain(sid)

    for (const [nome, conteudo] of resposta.headers) {
      if (nome === 'set-cookie') continue
      expect({ [nome]: conteudo.includes(sid) }).toEqual({ [nome]: false })
    }
  })

  test('nem o `sid` nem o cookie vao para o `console`', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const console = capturarConsole()
    let cookie = ''
    try {
      cookie = (await entrar(aparelho)).headers.get('set-cookie') ?? ''
    } finally {
      console.parar()
    }

    const sid = cookie.split(';')[0]?.split('=')[1]?.split('.')[1] ?? ''
    for (const linha of console.linhas) {
      expect(linha).not.toContain(sid)
    }
  })

  test('Ruling 33 / §10.3: TODO motivo interno sai como `credencial_invalida`', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    const outro = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const casos: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
      ['sem cookie de desafio', () => entrar(aparelho, { cookie: '' })],
      [
        'desafio expirado',
        async () => {
          const desafio = await pedirDesafio(env, AGORA)
          const assertion = await aparelho.autenticar(
            cerimonia({
              rpId: env.PANEL_RP_ID,
              origem: RAIZ,
              desafio: desafio.desafio,
              tipo: 'webauthn.get',
            }),
            HANDLE_DO_DONO,
          )
          return despachar(
            postDeApi(
              '/painel/api/entrar/verificar',
              { credencial: assertion },
              { cookie: desafio.cookie },
            ),
            env,
            AGORA + 120_001,
            ROTA_VERIFICAR_ENTRADA,
            handleVerificarEntrada,
          )
        },
      ],
      ['credencial desconhecida', () => entrar(outro)],
      [
        'origem de outro dominio',
        () => entrar(aparelho, { mudar: (c) => comOrigin(c, 'https://evil.com') }),
      ],
      [
        'rp_id de outro dominio',
        () => entrar(aparelho, { mudar: (c) => comRpId(c, 'outro.example') }),
      ],
      ['UV = 0', () => entrar(aparelho, { mudar: semUv })],
      ['UP = 0', () => entrar(aparelho, { mudar: semUp })],
      ['dono diferente', () => entrar(aparelho, { handle: 'handle-de-outra-pessoa' })],
      [
        'assinatura de outra chave',
        async () => {
          const desafio = await pedirDesafio()
          const boa = await aparelho.autenticar(
            cerimonia({
              rpId: env.PANEL_RP_ID,
              origem: RAIZ,
              desafio: desafio.desafio,
              tipo: 'webauthn.get',
            }),
            HANDLE_DO_DONO,
          )
          return despachar(
            postDeApi(
              '/painel/api/entrar/verificar',
              { credencial: { ...boa, signature: trocarByte(boa.signature, 10) } },
              { cookie: desafio.cookie },
            ),
            env,
            AGORA,
            ROTA_VERIFICAR_ENTRADA,
            handleVerificarEntrada,
          )
        },
      ],
      [
        'corpo sem credencial',
        async () => {
          const desafio = await pedirDesafio()
          return despachar(
            postDeApi('/painel/api/entrar/verificar', { nada: true }, { cookie: desafio.cookie }),
            env,
            AGORA,
            ROTA_VERIFICAR_ENTRADA,
            handleVerificarEntrada,
          )
        },
      ],
    ]

    for (const [nome, rodar] of casos) {
      const resposta = await rodar()
      expect({ [nome]: resposta.status }).toEqual({ [nome]: 401 })
      expect({ [nome]: await resposta.json() }).toEqual({
        [nome]: { erro: 'credencial_invalida', mensagem: FRASE_DE_CREDENCIAL },
      })
      expect({ [nome]: resposta.headers.get('set-cookie') }).toEqual({ [nome]: null })
    }

    // E o que sustenta o colapso: nenhuma tentativa gravou nada.
    const linhas = await env.DB.prepare('SELECT COUNT(*) AS total FROM painel_sessoes').first<{
      total: number
    }>()
    expect(linhas?.total).toBe(0)
  })

  test('login fracassado custa 1 leitura e ZERO escritas', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const contador = new D1Contador(env.DB)
    const resposta = await entrar(aparelho, {
      ambiente: ambienteCom({ DB: comoD1(contador) }),
      mudar: semUv,
    })

    expect(resposta.status).toBe(401)
    expect({
      leituras: contador.prepares - contador.escritas,
      escritas: contador.escritas,
    }).toEqual({ leituras: 1, escritas: 0 })
  })

  test('o motivo interno vai para o log, e nunca para o corpo', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    const console = capturarConsole()
    let corpo = ''
    try {
      corpo = await (await entrar(aparelho, { mudar: semUv })).text()
    } finally {
      console.parar()
    }

    const doPainel = console.linhas.filter((linha) => linha.startsWith('painel:'))

    // UMA linha por tentativa recusada, carregando os DOIS codigos: o canonico
    // que §11.4 manda registrar e o motivo interno que o dono precisa para
    // depurar. Duas linhas seriam amplificacao de log na rota nao autenticada
    // mais exposta do painel — mesma classe do Ruling 27 da Task 6.
    expect(doPainel).toHaveLength(1)
    expect(doPainel[0]).toContain('credencial_invalida')
    expect(doPainel[0]).toContain('verificacao_de_usuario_ausente')
    expect(doPainel[0]).toContain('401')
    expect(corpo).not.toContain('verificacao_de_usuario_ausente')
  })

  test('o `Max-Age` do cookie de desafio e DERIVADO do prazo do envelope', async () => {
    const { cookie, resposta } = await pedirDesafio()

    // Uma grafia so: subir o envelope de `entrar` para 180 s move os dois
    // numeros juntos. Duas constantes fariam o cookie morrer antes do desafio,
    // e o login passaria a falhar com `desafio_invalido` sem teste reclamar.
    const segundos = Math.floor(PRAZO_DE_ENVELOPE_MS.entrar / 1000)
    expect(resposta.headers.get('set-cookie')).toContain(`Max-Age=${segundos}`)
    expect(cookie.startsWith('__Host-painel_desafio=')).toBe(true)

    const opcoes = (await resposta.json()) as { timeout: number }
    expect(opcoes.timeout).toBe(PRAZO_DE_ENVELOPE_MS.entrar)
  })

  test('RS256 tambem entra: os dois algoritmos de §10.4 fecham', async () => {
    const aparelho = await AutenticadorFalso.criar('RS256')
    await cadastrarAparelho(aparelho)

    expect((await entrar(aparelho)).status).toBe(200)
  })

  test('sign_count que regride avisa mas NAO recusa', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)
    await env.DB.prepare('UPDATE painel_credenciais SET sign_count = 50').run()

    const console = capturarConsole()
    let resposta: Response
    try {
      resposta = await entrar(aparelho, { mudar: (c) => ({ ...c, signCount: 3 }) })
    } finally {
      console.parar()
    }

    // Passkeys sincronizadas devolvem 0 sempre; recusar trancaria o dono fora.
    expect(resposta.status).toBe(200)
    expect(console.linhas.join('\n')).toContain('sign_count_regrediu')
  })

  test('o limitador recusa antes de qualquer sorteio, com `Retry-After`', async () => {
    const limitador = new LimitadorFalso({ permitido: false, esperarSegundos: 37 })
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      postDeApi('/painel/api/entrar/opcoes', {}),
      ambienteCom({ DB: comoD1(contador) }),
      AGORA,
      ROTA_OPCOES_DE_ENTRAR,
      handleOpcoesDeEntrar,
      { limite: 'login', limitador },
    )

    expect(resposta.status).toBe(429)
    expect(resposta.headers.get('retry-after')).toBe('37')
    expect(resposta.headers.get('set-cookie')).toBeNull()
    expect(contador.prepares).toBe(0)
    expect(limitador.chaves).toEqual(['painel:global'])
  })

  test('RL-08: login bem-sucedido zera o balde daquele IP', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    /** A rota das opcoes COM o passo 5, exatamente como o roteador a chama. */
    const opcoesLimitadas = () =>
      despachar(
        postDeApi('/painel/api/entrar/opcoes', {}),
        env,
        AGORA,
        ROTA_OPCOES_DE_ENTRAR,
        handleOpcoesDeEntrar,
        { limite: 'login' },
      )

    // O balde da familia `login` tem teto 10 na janela de 60 s. Oito aqui.
    for (let i = 0; i < 8; i++) {
      expect((await opcoesLimitadas()).status).toBe(200)
    }

    // A cerimonia de login inteira, tambem COM o passo 5: ela consome a nona e
    // a decima fichas do balde. Sem `zerarLimite`, o balde fica cheio.
    const desafio = await opcoesLimitadas()
    const opcoes = (await desafio.json()) as { challenge: string }
    const cookie = /__Host-painel_desafio=([^;]*)/.exec(desafio.headers.get('set-cookie') ?? '')
    const assertion = await aparelho.autenticar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: opcoes.challenge,
        tipo: 'webauthn.get',
      }),
      HANDLE_DO_DONO,
    )
    const login = await despachar(
      postDeApi(
        '/painel/api/entrar/verificar',
        { credencial: assertion },
        { cookie: `__Host-painel_desafio=${cookie?.[1] ?? ''}` },
      ),
      env,
      AGORA,
      ROTA_VERIFICAR_ENTRADA,
      handleVerificarEntrada,
      { limite: 'login' },
    )
    expect(login.status).toBe(200)

    // A decima primeira tentativa seria `429` se o balde nao tivesse sido
    // zerado. Ela passa: quem provou quem e nao continua pagando pelas
    // tentativas de quem nao provou.
    expect((await opcoesLimitadas()).status).toBe(200)
  })

  test('RL-01: sem login que feche a assinatura, a decima primeira tentativa e 429', async () => {
    // O contrapositivo do teste acima, e o que o torna discriminante: e o mesmo
    // balde, o mesmo teto e a mesma janela — muda so o login no meio.
    const opcoes = () =>
      despachar(
        postDeApi('/painel/api/entrar/opcoes', {}),
        env,
        AGORA,
        ROTA_OPCOES_DE_ENTRAR,
        handleOpcoesDeEntrar,
        { limite: 'login' },
      )

    for (let i = 0; i < 10; i++) {
      expect((await opcoes()).status).toBe(200)
    }

    const estourado = await opcoes()
    expect(estourado.status).toBe(429)
    expect(estourado.headers.get('retry-after')).not.toBeNull()
  })

  test('o desafio vem SEMPRE do cookie, e nunca do corpo', async () => {
    const aparelho = await AutenticadorFalso.criar('ES256')
    await cadastrarAparelho(aparelho)

    // Um desafio escolhido por quem responde. Se a rota o aceitasse, a cerimonia
    // inteira perderia o sentido: o atacante assinaria um desafio proprio.
    const meuDesafio = 'ZGVzYWZpby1lc2NvbGhpZG8tcG9yLXF1ZW0tcmVzcG9uZGU'
    const assertion = await aparelho.autenticar(
      cerimonia({
        rpId: env.PANEL_RP_ID,
        origem: RAIZ,
        desafio: meuDesafio,
        tipo: 'webauthn.get',
      }),
      HANDLE_DO_DONO,
    )

    const semCookie = await despachar(
      postDeApi('/painel/api/entrar/verificar', { desafio: meuDesafio, credencial: assertion }),
      env,
      AGORA,
      ROTA_VERIFICAR_ENTRADA,
      handleVerificarEntrada,
    )

    // E a variante mais dificil: cookie VALIDO, mas de outro desafio, com o
    // desafio escolhido tambem no corpo. O do cookie e o unico que vale.
    const outroCookie = await pedirDesafio()
    const comCookieDeOutroDesafio = await despachar(
      postDeApi(
        '/painel/api/entrar/verificar',
        { desafio: meuDesafio, credencial: assertion },
        { cookie: outroCookie.cookie },
      ),
      env,
      AGORA,
      ROTA_VERIFICAR_ENTRADA,
      handleVerificarEntrada,
    )

    expect({ semCookie: semCookie.status, comOutro: comCookieDeOutroDesafio.status }).toEqual({
      semCookie: 401,
      comOutro: 401,
    })
    expect(await semCookie.json()).toEqual({
      erro: 'credencial_invalida',
      mensagem: FRASE_DE_CREDENCIAL,
    })
  })

  test('instalacao sem dono responde igual a credencial errada — nunca um codigo proprio', async () => {
    // Banco vazio: nao existe `painel_estado`, entao nao existe dono. Um codigo
    // ou um status diferente aqui seria um oraculo de graca: qualquer anonimo
    // descobriria, por polling barato, que a instalacao ainda nao tem passkey —
    // que e exatamente o instante em que um convite `pre=0` interceptado ainda
    // funciona (§15.4).
    const aparelho = await AutenticadorFalso.criar('ES256')
    const semDono = await entrar(aparelho)

    await cadastrarAparelho(aparelho)
    const comDonoEOutraCredencial = await entrar(await AutenticadorFalso.criar('ES256'))

    expect(semDono.status).toBe(comDonoEOutraCredencial.status)
    expect(await semDono.json()).toEqual(await comDonoEOutraCredencial.json())
    expect(semDono.status).toBe(401)
  })
})

describe('ROTA — os tetos de corpo e o `content-type` (§11.3, passos 3 e 4)', () => {
  /** Uma rota de FORMULARIO, para o teto de 32 KB ter onde ser exercido. */
  const ROTA_DE_FORMULARIO: RotaDoPainel = {
    caminho: '/painel/ajustes',
    metodos: ['POST'],
    sessao: false,
    csrf: false,
    stepUp: false,
    escreve: true,
    gravaConfig: false,
  }

  const eco = (): Response => new Response('ok', { status: 200 })

  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('corpo de formulario acima de 32 KB e recusado, com e sem `content-length`', async () => {
    const grande = `campo=${'x'.repeat(TETO_DO_CORPO_DE_FORMULARIO)}`
    const contador = new D1Contador(env.DB)
    const ambiente = ambienteCom({ DB: comoD1(contador) })

    const comTamanho = await despachar(
      new Request(`${RAIZ}/painel/ajustes`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
        body: grande,
      }),
      ambiente,
      AGORA,
      ROTA_DE_FORMULARIO,
      eco,
    )

    // O `content-length` mente para os dois lados, entao o teto de verdade e o
    // corte DURANTE a leitura do stream: aqui o corpo chega `chunked`.
    const semTamanho = await despachar(
      new Request(`${RAIZ}/painel/ajustes`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
        body: new ReadableStream({
          start(controlador) {
            controlador.enqueue(new TextEncoder().encode(grande))
            controlador.close()
          },
        }),
      }),
      ambiente,
      AGORA,
      ROTA_DE_FORMULARIO,
      eco,
    )

    expect({ com: comTamanho.status, sem: semTamanho.status }).toEqual({ com: 413, sem: 413 })
    expect(await comTamanho.text()).toContain('Dados grandes demais.')
    expect(contador.prepares).toBe(0)
  })

  test('exatamente no teto passa, e um byte acima nao', async () => {
    const noTeto = 'x'.repeat(TETO_DO_CORPO_DE_FORMULARIO)
    const acima = 'x'.repeat(TETO_DO_CORPO_DE_FORMULARIO + 1)

    const cabe = await despachar(
      new Request(`${RAIZ}/painel/ajustes`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
        body: noTeto,
      }),
      env,
      AGORA,
      ROTA_DE_FORMULARIO,
      eco,
    )
    const naoCabe = await despachar(
      new Request(`${RAIZ}/painel/ajustes`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
        body: acima,
      }),
      env,
      AGORA,
      ROTA_DE_FORMULARIO,
      eco,
    )

    expect({ noTeto: cabe.status, acima: naoCabe.status }).toEqual({ noTeto: 200, acima: 413 })
  })

  test('o teto da API continua sendo 8 KB, e nao o de formulario', async () => {
    const resposta = await despachar(
      postDeApi('/painel/api/entrar/opcoes', { lixo: 'x'.repeat(TETO_DO_CORPO_DA_API) }),
      env,
      AGORA,
      ROTA_OPCOES_DE_ENTRAR,
      handleOpcoesDeEntrar,
    )

    expect(resposta.status).toBe(413)
    expect(TETO_DO_CORPO_DA_API).toBeLessThan(TETO_DO_CORPO_DE_FORMULARIO)
  })

  test('`content-type` errado e 415, e com `charset` continua valendo', async () => {
    const errado = await despachar(
      new Request(`${RAIZ}/painel/api/entrar/opcoes`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: RAIZ },
        body: 'a=1',
      }),
      env,
      AGORA,
      ROTA_OPCOES_DE_ENTRAR,
      handleOpcoesDeEntrar,
    )
    const certo = await despachar(
      new Request(`${RAIZ}/painel/api/entrar/opcoes`, {
        method: 'POST',
        headers: { 'content-type': 'Application/JSON; charset=utf-8', origin: RAIZ },
        body: '{}',
      }),
      env,
      AGORA,
      ROTA_OPCOES_DE_ENTRAR,
      handleOpcoesDeEntrar,
    )

    expect({ errado: errado.status, certo: certo.status }).toEqual({ errado: 415, certo: 200 })
  })

  test('JSON malformado e `corpo_invalido`, e nao 500', async () => {
    const resposta = await despachar(
      new Request(`${RAIZ}/painel/api/entrar/verificar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: RAIZ },
        body: '{isto nao e json',
      }),
      env,
      AGORA,
      ROTA_VERIFICAR_ENTRADA,
      handleVerificarEntrada,
    )

    expect(resposta.status).toBe(400)
    expect(await resposta.json()).toEqual({
      erro: 'corpo_invalido',
      mensagem: 'Não foi possível ler os dados enviados.',
    })
  })

  test('toda rota com `escreve: false` executa ZERO escritas no D1', async () => {
    // O laco vem da TABELA, e nao de tres handlers escritos a mao: e a metade
    // da regra de forma de §7.1 que ja da para afirmar hoje, e uma linha nova
    // em `rotas.ts` entra nele sozinha. Passa pelo Worker inteiro para cobrir
    // tambem as rotas que o roteador despacha sem `despachar`.
    const semEscrita = ROTAS.filter((rota) => !rota.escreve)

    // Contrapositivo: uma tabela vazia faria o laco passar sem provar nada.
    expect(semEscrita.length).toBeGreaterThan(0)
    expect(semEscrita.map((rota) => rota.caminho)).toContain('/painel/convite')

    for (const rota of semEscrita) {
      await limparBanco(env.DB)
      invalidarBaldesDeReserva()

      const contador = new D1Contador(env.DB)
      const resposta = await responder(pedirDaRota(rota), ambienteCom({ DB: comoD1(contador) }))

      // O status nao importa aqui — importa que nada foi gravado, seja ela
      // atendida, redirecionada ou recusada.
      expect({ [rota.caminho]: contador.escritas, status: resposta.status < 500 }).toEqual({
        [rota.caminho]: 0,
        status: true,
      })
    }
  })

  test('a familia de FORMULARIO tambem recusa `content-type` errado com 415', async () => {
    // A camada 4 de §10.9 e a que "sozinha ja elimina CSRF por formulario
    // HTML", e e justamente na familia de formulario que um form cross-site
    // consegue postar. `text/plain` e `multipart/form-data` sao os dois tipos
    // que um `<form>` consegue emitir sem JavaScript.
    for (const tipo of ['text/plain', 'multipart/form-data; boundary=x', 'application/json']) {
      const resposta = await despachar(
        new Request(`${RAIZ}/painel/ajustes`, {
          method: 'POST',
          headers: { 'content-type': tipo, origin: RAIZ },
          body: 'campo=1',
        }),
        env,
        AGORA,
        ROTA_DE_FORMULARIO,
        eco,
      )

      expect({ [tipo]: resposta.status }).toEqual({ [tipo]: 415 })
    }

    // E o contrapositivo, com o `charset` que os navegadores anexam.
    const certo = await despachar(
      new Request(`${RAIZ}/painel/ajustes`, {
        method: 'POST',
        headers: {
          'content-type': 'Application/X-WWW-Form-UrlEncoded; charset=utf-8',
          origin: RAIZ,
        },
        body: 'campo=1',
      }),
      env,
      AGORA,
      ROTA_DE_FORMULARIO,
      eco,
    )
    expect(certo.status).toBe(200)
  })
})

describe('HDR — cabecalhos e CSP (§11.5)', () => {
  const CABECALHOS_DE_PAGINA: Record<string, string> = {
    'cache-control': 'private, no-store',
    'content-security-policy':
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
      "script-src 'self'; style-src 'self'; " +
      "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'none'; " +
      "require-trusted-types-for 'script'; upgrade-insecure-requests",
    'content-type': 'text/html; charset=utf-8',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), ' +
      'payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }

  const CABECALHOS_DE_API: Record<string, string> = {
    'cache-control': 'private, no-store',
    'content-security-policy':
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    vary: 'Cookie',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }

  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('o mapa INTEIRO de cabecalhos de pagina, e nao "contem CSP"', () => {
    // `toEqual` sobre o mapa completo pega tanto a linha apagada quanto a
    // acrescentada. Sem isto, apagar HSTS ou COOP passaria verde na suite toda.
    expect(cabecalhos('pagina')).toEqual(CABECALHOS_DE_PAGINA)
    expect(cabecalhos('api')).toEqual(CABECALHOS_DE_API)
  })

  test('a CSP das paginas nao tem `unsafe-inline` nem `unsafe-eval`, e tem trusted types', async () => {
    const resposta = await despachar(
      pedir('/painel/entrar'),
      env,
      AGORA,
      ROTA_ENTRAR,
      handlePaginaDeEntrar,
    )
    const csp = resposta.headers.get('content-security-policy') ?? ''

    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("require-trusted-types-for 'script'")
    expect(csp).toContain("script-src 'self'")
    // `img-src` so com `'self'`, `data:` e os dois CDNs da Meta.
    expect(csp).toContain("img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net")
  })

  test('`Cross-Origin-Embedder-Policy` nunca aparece: ele quebraria as miniaturas', async () => {
    for (const resposta of [
      await responder(pedir('/painel/entrar'), env),
      await responder(postDeApi('/painel/api/entrar/opcoes', {}), env),
    ]) {
      expect(resposta.headers.get('cross-origin-embedder-policy')).toBeNull()
    }
  })

  test('`private, no-store` e `Vary: Cookie` em TODA resposta do painel', async () => {
    const respostas: ReadonlyArray<readonly [string, Response]> = [
      ['inicio', await responder(pedir('/painel'), env)],
      ['entrar', await responder(pedir('/painel/entrar'), env)],
      ['convite', await responder(pedir('/painel/convite'), env)],
      ['opcoes', await responder(postDeApi('/painel/api/entrar/opcoes', {}), env)],
      ['404', await responder(pedir('/painel/nao-existe'), env)],
      ['405', await responder(new Request(`${RAIZ}/painel/entrar`, { method: 'OPTIONS' }), env)],
    ]

    for (const [nome, resposta] of respostas) {
      const mapa = cabecalhosDe(resposta)
      expect({ [nome]: mapa['cache-control'] }).toEqual({ [nome]: 'private, no-store' })
      expect({ [nome]: mapa.vary }).toEqual({ [nome]: 'Cookie' })
      expect({ [nome]: mapa['x-content-type-options'] }).toEqual({ [nome]: 'nosniff' })
      expect({ [nome]: mapa['referrer-policy'] }).toEqual({ [nome]: 'no-referrer' })
    }
  })

  test('nenhum corpo de erro carrega stack, nome de excecao, coluna nem a palavra proibida', async () => {
    const proibido = /Error|at \w+ \(|SQLITE|D1_|undefined|payload/
    const entradas: ReadonlyArray<readonly [string, Request]> = [
      ['404', pedir('/painel/nao-existe')],
      ['405', new Request(`${RAIZ}/painel/entrar`, { method: 'DELETE' })],
      [
        '415',
        new Request(`${RAIZ}/painel/api/entrar/opcoes`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain', origin: RAIZ },
          body: 'oi',
        }),
      ],
      [
        '400',
        new Request(`${RAIZ}/painel/api/entrar/verificar`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: RAIZ },
          body: '{{{',
        }),
      ],
      [
        '403',
        new Request(`${RAIZ}/painel/api/entrar/opcoes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
          body: '{}',
        }),
      ],
    ]

    for (const [nome, request] of entradas) {
      const corpo = await (await responder(request, env)).text()
      expect({ [nome]: proibido.test(corpo) }).toEqual({ [nome]: false })
    }
  })

  test('a marca de "ja seguro" e um Symbol: um corpo do cliente nao consegue forjar', async () => {
    const { html, cru } = await import('../src/routes/painel/html')

    // A razao de existir do `Symbol`: um objeto que veio de `JSON.parse` — isto
    // e, do corpo de uma requisicao — nunca carrega um simbolo. Se a marca
    // fosse a presenca do campo `texto`, este corpo se declararia seguro
    // sozinho e emitiria script cru na tela do dono.
    const forjado = JSON.parse('{"texto":"<script>alert(1)</script>"}') as unknown
    const saida = html`<p>${forjado}</p>`

    // O objeto NAO e desembrulhado: ele cai no ramo comum, vira texto e e
    // escapado. Trocar a marca pela presenca do campo `texto` faria esta saida
    // virar `<p><script>alert(1)</script></p>`.
    expect(saida.texto).toBe('<p>[object Object]</p>')
    expect(saida.texto).not.toContain('<script>')

    // A mesma tentativa com a forma exata que a interface interna tem.
    const comCampos = JSON.parse('{"texto":"<b>x</b>","seguro":true}') as unknown
    expect(html`${comCampos}`.texto).toBe('[object Object]')

    // E o contrapositivo: o que passou por `cru()` — a UNICA porta — entra como
    // esta, senao o teste acima passaria com a tag escapando tudo sempre.
    expect(html`${cru('<b>ok</b>')}`.texto).toBe('<b>ok</b>')
    expect(html`${html`<i>ok</i>`}`.texto).toBe('<i>ok</i>')
  })

  test('os cabecalhos de §11.5 vencem os extras da rota, nos tres construtores', async () => {
    // A ordem do spread e a trava, e ela precisa de teste porque o tipo estreito
    // de `extras` e acidente de hoje: uma rota futura que passasse
    // `content-security-policy` nos extras herdaria o buraco em toda tela.
    const { pagina, html } = await import('../src/routes/painel/html')
    const { json, redirecionar } = await import('../src/routes/painel/resposta')

    const hostis: Record<string, string> = {
      'content-security-policy': 'default-src *',
      'cache-control': 'public, max-age=31536000',
      vary: '*',
      'x-frame-options': 'ALLOWALL',
      'x-content-type-options': 'sniff',
      'referrer-policy': 'unsafe-url',
    }

    const respostas: ReadonlyArray<readonly [string, Response]> = [
      ['pagina', pagina({ titulo: 'x', corpo: html`<p>x</p>`, extras: hostis })],
      ['json', json({ ok: true }, { extras: hostis })],
      ['redirecionar', redirecionar('/painel', hostis)],
    ]

    for (const [nome, resposta] of respostas) {
      expect({ [nome]: resposta.headers.get('cache-control') }).toEqual({
        [nome]: 'private, no-store',
      })
      expect({ [nome]: resposta.headers.get('vary') }).toEqual({ [nome]: 'Cookie' })
      expect({ [nome]: resposta.headers.get('x-frame-options') }).toEqual({ [nome]: 'DENY' })
      expect({ [nome]: resposta.headers.get('x-content-type-options') }).toEqual({
        [nome]: 'nosniff',
      })
      expect({ [nome]: resposta.headers.get('referrer-policy') }).toEqual({ [nome]: 'no-referrer' })
      expect({ [nome]: resposta.headers.get('content-security-policy') }).not.toEqual({
        [nome]: 'default-src *',
      })
    }

    // E o extra que DEVE sobreviver, senao a trava acima teria sido escrita
    // apagando `set-cookie`, `allow` e `location` junto.
    expect(json({ ok: true }, { extras: { 'set-cookie': 'a=b' } }).headers.get('set-cookie')).toBe(
      'a=b',
    )
    expect(redirecionar('/painel').headers.get('location')).toBe('/painel')
  })

  test('a tag `html` escapa por padrao, e a pagina inteira nasce dela', async () => {
    // A prova indireta e a que interessa aqui: `pagina()` interpola o titulo
    // pela mesma tag, entao um titulo hostil sairia escapado. O laco por tela
    // com valor de banco chega com a etapa que le o banco.
    const { html } = await import('../src/routes/painel/html')
    const saida = html`<p>${'<script>alert(1)</script>'}</p>`

    expect(saida.texto).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(saida.texto).not.toContain('<script>')
  })
})
