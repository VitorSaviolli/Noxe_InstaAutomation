import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  CORPO_VAZIO,
  exigirCsrf,
  exigirOrigem,
  invalidarBaldesDeReserva,
} from '../src/routes/painel/guardas'
import type { RotaDoPainel } from '../src/routes/painel/rotas'
import { despachar, type EntradaDaRota } from '../src/routes/painel/router'
import { emitirSessao, fichaCsrf, PRAZO_OCIOSO_DE_SESSAO_MS } from '../src/services/panel-session'
import { limparBanco } from './fixtures/banco'
import { AGORA, comoD1, D1Contador, RAIZ } from './fixtures/dubles'

/**
 * CSRF — as nove garantias de §13.2, mais as cinco camadas de §10.9.
 *
 * **Como esta suite exercita a escada.** Ela dirige `despachar` — a funcao de
 * producao que centraliza metodo, origem, corpo, limitador, sessao, ficha e
 * step-up — passando uma linha de rota declarada AQUI. A linha e um
 * `RotaDoPainel` como qualquer outra: mesmos campos, mesmo tipo, mesmo caminho
 * exato sob `/painel`. Isso e injecao de dependencia, e nao dublê: o codigo
 * exercitado e o mesmo que atende `/painel` em producao.
 *
 * Ela existe porque a etapa do roteador entrega a MAQUINA da ficha CSRF antes
 * de entregar a primeira tela que grava por formulario. Sem esta suite, as nove
 * garantias so ficariam verdes duas etapas depois, e a maquina viajaria sem
 * teste exatamente no periodo em que seis telas serao construidas sobre ela.
 * Quando a primeira tela de gravacao nascer, ela herda tudo isto ja provado.
 *
 * `now` e sempre injetado; `AGORA = 1_700_000_000_000`; nenhum `vi.mock`.
 */

/**
 * A rota de teste: POST autenticado com ficha, na familia de FORMULARIO.
 *
 * `escreve: true` porque ela representa a forma que a etapa das telas vai usar
 * — gravar e responder `303`. O handler abaixo nao grava nada; quem prova "nada
 * gravado" e o contador de consultas.
 */
const ROTA_DE_FORMULARIO: RotaDoPainel = {
  caminho: '/painel/ajustes',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
}

/** A mesma coisa na familia JSON, onde a ficha viaja no cabecalho. */
const ROTA_DE_API: RotaDoPainel = {
  caminho: '/painel/api/stepup/opcoes',
  metodos: ['POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: false,
}

const FORMULARIO = 'application/x-www-form-urlencoded'

/** Registra que o handler chegou a rodar. E o que "nada gravado" precisa. */
class HandlerEspiao {
  chamadas = 0

  readonly responder = (entrada: EntradaDaRota): Response => {
    this.chamadas++
    return new Response(`ok:${entrada.rota.caminho}`, { status: 200 })
  }
}

interface Sessao {
  readonly cookie: string
  readonly ficha: string
  readonly sidHash: string
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
    sidHash: emitida.sidHash,
  }
}

function postDeFormulario(corpo: string, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}`, {
    method: 'POST',
    headers: { 'content-type': FORMULARIO, origin: RAIZ, ...cabecalhos },
    body: corpo,
  })
}

function despacharFormulario(request: Request, espiao: HandlerEspiao, ambiente = env) {
  return despachar(request, ambiente, AGORA, ROTA_DE_FORMULARIO, espiao.responder)
}

describe('CSRF — a ficha derivada da sessao (§10.9, camada 3)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('CSRF-01: POST sem ficha e recusado, e o handler nem chega a rodar', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()
    const contador = new D1Contador(env.DB)

    const resposta = await despacharFormulario(
      postDeFormulario('acao=salvar', { cookie: sessao.cookie }),
      espiao,
      { ...env, DB: comoD1(contador) },
    )

    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toContain('Requisição bloqueada por segurança.')
    // "Nada gravado" nas duas metades que importam: o handler nao rodou, e
    // NENHUMA escrita saiu — a recusa acontece no passo 7, antes do passo 9.
    expect(espiao.chamadas).toBe(0)
    expect({ escritas: contador.escritas, prepares: contador.prepares }).toEqual({
      escritas: 0,
      prepares: 0,
    })
  })

  test('CSRF-02: ficha de OUTRA sessao e recusada', async () => {
    const minha = await abrirSessao('credencial-a')
    const alheia = await abrirSessao('credencial-b')
    const espiao = new HandlerEspiao()

    // A ficha e valida — so que para outra sessao. Se ela nao dependesse do
    // `sid_hash`, seria uma constante do deploy e a camada 3 nao valeria nada.
    expect(alheia.ficha).not.toBe(minha.ficha)

    const resposta = await despacharFormulario(
      postDeFormulario(`csrf=${encodeURIComponent(alheia.ficha)}`, { cookie: minha.cookie }),
      espiao,
    )

    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('CSRF-03: ficha correta SEM cookie e recusada, e a recusa e a do passo 6', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despacharFormulario(
      postDeFormulario(`csrf=${encodeURIComponent(sessao.ficha)}`),
      espiao,
    )

    // Sem cookie a rota nem chega ao passo 7: quem recusa e o portao de sessao,
    // e numa PAGINA a recusa dele e o `303` para a tela de entrar (§11.3).
    expect(resposta.status).toBe(303)
    expect(resposta.headers.get('location')).toBe('/painel/entrar')
    expect(espiao.chamadas).toBe(0)
  })

  test('CSRF-06: GET nao exige ficha', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despachar(
      new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}`, { headers: { cookie: sessao.cookie } }),
      env,
      AGORA,
      ROTA_DE_FORMULARIO,
      espiao.responder,
    )

    // A rota declara `csrf: true`, e ainda assim o `GET` passa: exigir ficha num
    // link tornaria o proprio link impossivel de escrever, e `GET` nao muda
    // estado nenhum.
    expect(resposta.status).toBe(200)
    expect(espiao.chamadas).toBe(1)
  })

  test('CSRF-07: ficha na QUERY STRING nao e aceita', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despacharFormulario(
      new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}?csrf=${encodeURIComponent(sessao.ficha)}`, {
        method: 'POST',
        headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie },
        body: 'acao=salvar',
      }),
      espiao,
    )

    // Ficha na URL vazaria em `Referer`, no historico e em log de proxy — e
    // passaria a valer num link que alguem clica.
    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('CSRF-07: a ficha na query string tambem nao vale nas rotas `/painel/api/*`', async () => {
    // A mesma proibicao, na outra familia. Sao dois lugares diferentes de onde
    // a ficha pode ser lida — campo escondido e cabecalho — e a URL nao pode
    // ser um terceiro em NENHUM dos dois.
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despachar(
      new Request(`${RAIZ}${ROTA_DE_API.caminho}?csrf=${encodeURIComponent(sessao.ficha)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: RAIZ, cookie: sessao.cookie },
        body: '{}',
      }),
      env,
      AGORA,
      ROTA_DE_API,
      espiao.responder,
    )

    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('a ficha correta no campo escondido passa, e e a mesma da API no cabecalho', async () => {
    const sessao = await abrirSessao()
    const doFormulario = new HandlerEspiao()
    const daApi = new HandlerEspiao()

    const porFormulario = await despacharFormulario(
      postDeFormulario(`csrf=${encodeURIComponent(sessao.ficha)}&acao=salvar`, {
        cookie: sessao.cookie,
      }),
      doFormulario,
    )

    const porCabecalho = await despachar(
      new Request(`${RAIZ}${ROTA_DE_API.caminho}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: RAIZ,
          cookie: sessao.cookie,
          'x-painel-csrf': sessao.ficha,
        },
        body: '{}',
      }),
      env,
      AGORA,
      ROTA_DE_API,
      daApi.responder,
    )

    expect({ formulario: porFormulario.status, api: porCabecalho.status }).toEqual({
      formulario: 200,
      api: 200,
    })
    expect({ formulario: doFormulario.chamadas, api: daApi.chamadas }).toEqual({
      formulario: 1,
      api: 1,
    })
  })

  test('a ficha e derivada e nao sorteada: duas leituras da mesma sessao coincidem', async () => {
    const sessao = await abrirSessao()

    // Derivada de `k_csrf` e do `sid_hash`, entao ela nao precisa de coluna, nao
    // precisa de segundo cookie e e impossivel de dessincronizar.
    expect(await fichaCsrf(env, sessao.sidHash)).toBe(sessao.ficha)
  })

  test('ficha vazia e recusada como ficha ausente', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despacharFormulario(
      postDeFormulario('csrf=', { cookie: sessao.cookie }),
      espiao,
    )

    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('a comparacao passa por `timingSafeEqual`: um caractere trocado recusa', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()
    const quase = `${sessao.ficha.slice(0, -1)}${sessao.ficha.endsWith('A') ? 'B' : 'A'}`

    const resposta = await despacharFormulario(
      postDeFormulario(`csrf=${encodeURIComponent(quase)}`, { cookie: sessao.cookie }),
      espiao,
    )

    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('passo 8: uma rota com `stepUp: true` FALHA FECHADA ate o verificador existir', async () => {
    // Nenhuma rota da tabela declara `stepUp: true` hoje, e a razao e que o
    // verificador — `op_hash` recalculado no servidor — nasce com a etapa do
    // step-up. O ramo tem de recusar: uma autorizacao que nao da para verificar
    // nao pode ser concedida, e declarar `stepUp: true` cedo demais tem de
    // TRANCAR a rota, nunca abri-la em silencio.
    const comStepUp: RotaDoPainel = {
      caminho: '/painel/mensagem',
      metodos: ['POST'],
      sessao: true,
      csrf: true,
      stepUp: true,
      escreve: true,
    }
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()
    const contador = new D1Contador(env.DB)

    const resposta = await despachar(
      new Request(`${RAIZ}${comStepUp.caminho}`, {
        method: 'POST',
        headers: { 'content-type': FORMULARIO, origin: RAIZ, cookie: sessao.cookie },
        body: `csrf=${encodeURIComponent(sessao.ficha)}&acao=salvar`,
      }),
      { ...env, DB: comoD1(contador) },
      AGORA,
      comStepUp,
      espiao.responder,
    )

    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toContain('Confirme com sua passkey para continuar.')
    expect(espiao.chamadas).toBe(0)
    // O passo 8 vem ANTES do passo 9: recusar por step-up nao custa banco.
    expect(contador.prepares).toBe(0)
  })

  test('`exigirCsrf` sozinha nunca lanca com corpo vazio', async () => {
    const sessao = await abrirSessao()
    const request = new Request(`${RAIZ}/painel/ajustes`, { method: 'POST' })

    const recusa = await exigirCsrf(request, env, sessao.sidHash, CORPO_VAZIO, {
      request,
      caminho: '/painel/ajustes',
      formato: 'pagina',
    })

    expect(recusa?.status).toBe(403)
  })
})

describe('CSRF — origem obrigatoria e exata (§10.9, camada 2)', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarBaldesDeReserva()
  })

  test('CSRF-04: `Origin` de outro dominio e recusado MESMO com ficha correta', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despacharFormulario(
      postDeFormulario(`csrf=${encodeURIComponent(sessao.ficha)}`, {
        cookie: sessao.cookie,
        origin: 'https://outro-dominio.example',
      }),
      espiao,
    )

    // A origem e o passo 2 e a ficha e o passo 7: a ordem e o que faz a recusa
    // sair antes de qualquer HMAC.
    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toContain('Requisição bloqueada por segurança.')
    expect(espiao.chamadas).toBe(0)
  })

  test('CSRF-05: `https://exemplo.workers.dev.evil.com` e recusado (regressao de `includes`)', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    // Um `includes` ou um `startsWith` deixariam este passar, carregando o nome
    // do painel dentro dele. A comparacao e de string INTEIRA.
    for (const hostil of [
      `${RAIZ}.evil.com`,
      `${RAIZ}.evil.com/`,
      'https://evil.com/https://exemplo.workers.dev',
      `${RAIZ}:8443`,
      `${RAIZ}/`,
      'http://exemplo.workers.dev',
    ]) {
      const resposta = await despacharFormulario(
        postDeFormulario(`csrf=${encodeURIComponent(sessao.ficha)}`, {
          cookie: sessao.cookie,
          origin: hostil,
        }),
        espiao,
      )

      expect({ [hostil]: resposta.status }).toEqual({ [hostil]: 403 })
    }

    expect(espiao.chamadas).toBe(0)
  })

  test('CSRF-08: sem `Origin`, so passa com `Sec-Fetch-Site: same-origin`', async () => {
    const sessao = await abrirSessao()
    const comFallback = new HandlerEspiao()
    const semFallback = new HandlerEspiao()

    const passa = await despacharFormulario(
      new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}`, {
        method: 'POST',
        headers: {
          'content-type': FORMULARIO,
          cookie: sessao.cookie,
          'sec-fetch-site': 'same-origin',
        },
        body: `csrf=${encodeURIComponent(sessao.ficha)}`,
      }),
      comFallback,
    )

    const barra = await despacharFormulario(
      new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}`, {
        method: 'POST',
        headers: {
          'content-type': FORMULARIO,
          cookie: sessao.cookie,
          'sec-fetch-site': 'cross-site',
        },
        body: `csrf=${encodeURIComponent(sessao.ficha)}`,
      }),
      semFallback,
    )

    // O fallback existe para nao trancar o dono para fora num navegador que nao
    // mande `Origin`: deixou de ser pendencia de projeto e virou este teste.
    expect({ mesma: passa.status, cruzada: barra.status }).toEqual({ mesma: 200, cruzada: 403 })
    expect({ mesma: comFallback.chamadas, cruzada: semFallback.chamadas }).toEqual({
      mesma: 1,
      cruzada: 0,
    })
  })

  test('CSRF-09: sem `Origin` e sem `Sec-Fetch-Site`, e `origem_invalida`', async () => {
    const sessao = await abrirSessao()
    const espiao = new HandlerEspiao()

    const resposta = await despacharFormulario(
      new Request(`${RAIZ}${ROTA_DE_FORMULARIO.caminho}`, {
        method: 'POST',
        headers: { 'content-type': FORMULARIO, cookie: sessao.cookie },
        body: `csrf=${encodeURIComponent(sessao.ficha)}`,
      }),
      espiao,
    )

    expect(resposta.status).toBe(403)
    expect(espiao.chamadas).toBe(0)
  })

  test('a origem NAO e exigida em GET: o link vindo de fora tem de abrir', async () => {
    // §10.8: abrir o painel por um link colado noutro app e navegacao
    // cross-site. O navegador nao manda o cookie, e o dono cai em
    // `GET /painel/entrar` — que e o desenho. Exigir origem no `GET`
    // transformaria isso num `403` sem saida.
    const request = new Request(`${RAIZ}/painel/entrar`, {
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://web.whatsapp.com' },
    })

    expect(
      exigirOrigem(request, env, { request, caminho: '/painel/entrar', formato: 'pagina' }),
    ).toBeNull()
  })
})
