import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import worker from '../src/index'
import {
  chaveDoBalde,
  JANELA_EM_SEGUNDOS,
  limitadorDaFamilia,
  limitar,
  zerarLimite,
} from '../src/routes/painel/guardas'
import { CAMINHO_DA_PARADA, handleGerarCodigos, handleParada } from '../src/routes/painel/parada'
import type { Env } from '../src/types/env'
import { gravarConfig, limparBanco } from './fixtures/banco'
import {
  AGORA,
  BindingDeLimiteFalso,
  BindingDeLimiteQuebrado,
  capturarConsole,
  comoBindingDeLimite,
  comoD1,
  D1Contador,
  LimitadorFalso,
  RAIZ,
} from './fixtures/dubles'

/**
 * RL — rate limit (§13.2, 10 garantias).
 *
 * O limitador e uma camada de defesa **opcional**, e a propriedade que esta
 * suite existe para provar e negativa: **nada do desenho depende dela para
 * estar correto** (§7.4). Por isso o ambiente de teste segue SEM os tres
 * bindings, de proposito — a ausencia e a prova.
 *
 * Tres camadas, nenhuma tocando a rede (§13.4): o **algoritmo** com `agora`
 * injetado; a **rota** com o duble (429, corpo generico e zero consultas); e o
 * **adaptador do binding**, que afirma a chave enviada, a queda para a reserva
 * quando o binding estoura, e que cada familia fala com o binding dela.
 *
 * `now` e sempre injetado, e `invalidarBaldesDeReserva()` roda no `beforeEach`
 * global de `tests/setup.ts` — sem isso um teste deixaria o balde cheio para o
 * seguinte, porque `AGORA` e o mesmo instante em todos eles.
 */

/** O mesmo valor ficticio do `vitest.config.ts`. */
const ADMIN = 'admin-token-de-teste'

const IP = '203.0.113.7'
const OUTRO_IP = '198.51.100.9'

/** Teto de cada familia, copiado de §7.4 — a fonte, e nao o codigo. */
const TETO_DO_LOGIN = 10
const TETO_DO_CODIGO = 30
const TETO_DA_PARADA = 30

/** Um POST qualquer do painel, com ou sem o IP que a Cloudflare carimba. */
function pedidoDoPainel(ip: string | null = null): Request {
  return new Request(`${RAIZ}/painel/entrar`, {
    method: 'POST',
    headers: ip === null ? {} : { 'cf-connecting-ip': ip },
  })
}

/** Um `POST` de formulario para a rota da parada. */
function postDaParada(corpo: string, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cabecalhos },
    body: corpo,
  })
}

/** O corpo do formulario com o codigo digitado. */
function comOCodigo(codigo: string): string {
  return `codigo=${encodeURIComponent(codigo)}`
}

/** O ambiente de teste com os limitadores que o caso precisa, e so eles. */
function comLimitadores(limitadores: Record<string, unknown>): Env {
  return { ...(env as unknown as Record<string, unknown>), ...limitadores } as unknown as Env
}

/**
 * Gera um conjunto de codigos pela rota de producao.
 *
 * Passa por `POST /setup/painel/codigos` de proposito: um codigo escrito a mao
 * no banco provaria o hash do teste, e nao o do Worker.
 */
async function gerarCodigoDeParada(ambiente: Env = env): Promise<string> {
  const resposta = await handleGerarCodigos(
    new Request(`${RAIZ}/setup/painel/codigos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    ambiente,
    AGORA,
  )

  expect(resposta.status).toBe(200)
  return ((await resposta.json()) as { parada: string }).parada
}

/** Chama `limitar()` `vezes` vezes e devolve a lista de vereditos. */
async function tentar(
  vezes: number,
  request: Request,
  familia: 'login' | 'codigo' | 'parada',
  ambiente: Env = env,
  agora: number = AGORA,
): Promise<boolean[]> {
  const vereditos: boolean[] = []
  for (let i = 0; i < vezes; i++) {
    vereditos.push((await limitar(request, ambiente, familia, agora)).permitido)
  }
  return vereditos
}

/** `[true, true, ...]` com o tamanho pedido. Deixa a falha legivel. */
function todasPassam(vezes: number): boolean[] {
  return Array.from({ length: vezes }, () => true)
}

describe('RL — o algoritmo, com `agora` injetado', () => {
  test('RL-01: a decima primeira tentativa em 60 s e recusada com 429', async () => {
    const request = pedidoDoPainel(IP)

    // O teto do login e 10 por 60 s (§7.4). As dez primeiras passam...
    expect(await tentar(TETO_DO_LOGIN, request, 'login')).toEqual(todasPassam(TETO_DO_LOGIN))

    // ...e a decima primeira, no MESMO instante, nao passa.
    const decimaPrimeira = await limitar(request, env, 'login', AGORA)
    expect(decimaPrimeira.permitido).toBe(false)
    // O `Retry-After` que a rota devolve sai daqui, e nunca passa da janela.
    expect(decimaPrimeira.esperarSegundos).toBe(JANELA_EM_SEGUNDOS)
  })

  test('RL-02: passada a janela de 60 s, libera', async () => {
    const request = pedidoDoPainel(IP)
    await tentar(TETO_DO_LOGIN, request, 'login')

    // Um milissegundo antes de a janela virar, ainda esta fechado.
    const quaseLa = await limitar(request, env, 'login', AGORA + JANELA_EM_SEGUNDOS * 1000 - 1)
    expect(quaseLa.permitido).toBe(false)

    // Exatamente na virada, o balde e outro.
    const depois = await limitar(request, env, 'login', AGORA + JANELA_EM_SEGUNDOS * 1000)
    expect(depois.permitido).toBe(true)
  })

  test('RL-02: relogio que anda para tras nao libera o balde', async () => {
    const request = pedidoDoPainel(IP)
    await tentar(TETO_DO_LOGIN, request, 'login')

    // Uma hora ATRAS. Um limitador que aceitasse isso como "janela nova" seria
    // um limitador que se desliga sozinho quando o relogio volta.
    const passado = await limitar(request, env, 'login', AGORA - 3_600_000)
    expect(passado.permitido).toBe(false)
    expect(passado.esperarSegundos).toBeLessThanOrEqual(JANELA_EM_SEGUNDOS)
  })

  test('RL-03: IPs diferentes nao compartilham contador', async () => {
    await tentar(TETO_DO_LOGIN, pedidoDoPainel(IP), 'login')
    expect((await limitar(pedidoDoPainel(IP), env, 'login', AGORA)).permitido).toBe(false)

    // O vizinho continua com o balde inteiro.
    expect(await tentar(TETO_DO_LOGIN, pedidoDoPainel(OUTRO_IP), 'login')).toEqual(
      todasPassam(TETO_DO_LOGIN),
    )
    expect((await limitar(pedidoDoPainel(OUTRO_IP), env, 'login', AGORA)).permitido).toBe(false)
  })

  test('RL-04: requisicao sem CF-Connecting-IP cai no balde global e continua limitada', async () => {
    const semIp = pedidoDoPainel(null)

    // E o primeiro caminho que um atacante tentaria: omitir o cabecalho para
    // sair do balde. Ele sai do balde por IP e cai no global — nunca livre.
    expect(await tentar(TETO_DO_LOGIN, semIp, 'login')).toEqual(todasPassam(TETO_DO_LOGIN))
    expect((await limitar(semIp, env, 'login', AGORA)).permitido).toBe(false)

    // E o balde global nao rouba a vez de quem tem IP.
    expect((await limitar(pedidoDoPainel(IP), env, 'login', AGORA)).permitido).toBe(true)
  })

  test('RL-04: a chave de cada balde e exatamente a de §7.4', () => {
    expect({
      login: chaveDoBalde('login', pedidoDoPainel(IP)),
      codigo: chaveDoBalde('codigo', pedidoDoPainel(IP)),
      parada: chaveDoBalde('parada', pedidoDoPainel(IP)),
      loginSemIp: chaveDoBalde('login', pedidoDoPainel(null)),
      codigoSemIp: chaveDoBalde('codigo', pedidoDoPainel(null)),
      paradaSemIp: chaveDoBalde('parada', pedidoDoPainel(null)),
    }).toEqual({
      login: `painel:${IP}`,
      codigo: `codigo:${IP}`,
      parada: `parada:${IP}`,
      loginSemIp: 'painel:global',
      codigoSemIp: 'codigo:global',
      paradaSemIp: 'parada:global',
    })
  })

  test('RL-08: tentativa bem-sucedida zera o contador daquele IP', async () => {
    const request = pedidoDoPainel(IP)
    await tentar(TETO_DO_LOGIN, request, 'login')
    expect((await limitar(request, env, 'login', AGORA)).permitido).toBe(false)

    // Quem provou quem e nao pode continuar pagando pelas tentativas de quem
    // nao provou: o login que fecha devolve o balde ao estado inicial.
    zerarLimite(request, env, 'login')

    expect(await tentar(TETO_DO_LOGIN, request, 'login')).toEqual(todasPassam(TETO_DO_LOGIN))
    // E zerar nao e passe livre: o teto volta a valer do zero.
    expect((await limitar(request, env, 'login', AGORA)).permitido).toBe(false)
  })

  test('RL-08: zerar um balde nao mexe no balde do vizinho', async () => {
    await tentar(TETO_DO_LOGIN, pedidoDoPainel(OUTRO_IP), 'login')
    zerarLimite(pedidoDoPainel(IP), env, 'login')

    expect((await limitar(pedidoDoPainel(OUTRO_IP), env, 'login', AGORA)).permitido).toBe(false)
  })

  test('RL-09: a parada tem limite proprio, mais generoso que o do login', async () => {
    const request = pedidoDoPainel(IP)

    // No MESMO instante e com o MESMO IP: o login fecha na decima primeira...
    await tentar(TETO_DO_LOGIN, request, 'login')
    expect((await limitar(request, env, 'login', AGORA)).permitido).toBe(false)

    // ...e a parada, que e caminho de emergencia, continua aberta muito depois.
    expect(await tentar(TETO_DA_PARADA, request, 'parada')).toEqual(todasPassam(TETO_DA_PARADA))
    expect((await limitar(request, env, 'parada', AGORA)).permitido).toBe(false)
    expect(TETO_DA_PARADA).toBeGreaterThan(TETO_DO_LOGIN)
  })

  test('RL-09: o codigo de recuperacao tambem tem balde proprio e mais generoso', async () => {
    const request = pedidoDoPainel(IP)
    await tentar(TETO_DO_LOGIN, request, 'login')
    expect((await limitar(request, env, 'login', AGORA)).permitido).toBe(false)

    // Um bot martelando a tela de entrar nao pode consumir a cota de que o dono
    // precisa para digitar o codigo de recuperacao numa emergencia (§7.4).
    expect(await tentar(TETO_DO_CODIGO, request, 'codigo')).toEqual(todasPassam(TETO_DO_CODIGO))
    expect((await limitar(request, env, 'codigo', AGORA)).permitido).toBe(false)
  })
})

describe('RL — o adaptador do binding', () => {
  test('RL-10: os tres bindings sao distintos e cada familia fala com o seu', async () => {
    const login = new BindingDeLimiteFalso()
    const codigo = new BindingDeLimiteFalso()
    const parada = new BindingDeLimiteFalso()
    const ambiente = comLimitadores({
      PANEL_LIMITER_LOGIN: comoBindingDeLimite(login),
      PANEL_LIMITER_CODIGO: comoBindingDeLimite(codigo),
      PANEL_LIMITER_STOP: comoBindingDeLimite(parada),
    })

    await limitar(pedidoDoPainel(IP), ambiente, 'login', AGORA)
    await limitar(pedidoDoPainel(IP), ambiente, 'codigo', AGORA)
    await limitar(pedidoDoPainel(IP), ambiente, 'parada', AGORA)

    // Cada binding viu UMA chave, a dele, e nenhuma das outras duas.
    expect({ login: login.chaves, codigo: codigo.chaves, parada: parada.chaves }).toEqual({
      login: [`painel:${IP}`],
      codigo: [`codigo:${IP}`],
      parada: [`parada:${IP}`],
    })
  })

  test('RL-10: a parada fala com PANEL_LIMITER_STOP e nunca com o do login', async () => {
    await limparBanco(env.DB)
    await gravarConfig(env.DB, { enabled: 1 })

    const login = new BindingDeLimiteFalso()
    const codigo = new BindingDeLimiteFalso()
    const parada = new BindingDeLimiteFalso()
    const ambiente = comLimitadores({
      PANEL_LIMITER_LOGIN: comoBindingDeLimite(login),
      PANEL_LIMITER_CODIGO: comoBindingDeLimite(codigo),
      PANEL_LIMITER_STOP: comoBindingDeLimite(parada),
    })

    const resposta = await handleParada(
      postDaParada(comOCodigo('0000000000000000'), { 'cf-connecting-ip': IP }),
      ambiente,
      AGORA,
    )

    expect(resposta.status).toBe(403)
    expect({ login: login.total, codigo: codigo.total, parada: parada.chaves }).toEqual({
      login: 0,
      codigo: 0,
      parada: [`parada:${IP}`],
    })
  })

  test('RL-01: o binding que recusa vira 429 na rota, sem consultar o D1', async () => {
    await limparBanco(env.DB)
    await gravarConfig(env.DB, { enabled: 1 })

    // Teto 1: a segunda tentativa deste IP e recusada pelo binding.
    const contador = new D1Contador(env.DB)
    const ambiente = comLimitadores({
      DB: comoD1(contador),
      PANEL_LIMITER_STOP: comoBindingDeLimite(new BindingDeLimiteFalso(1)),
    })

    const primeira = await handleParada(
      postDaParada(comOCodigo('0000000000000000'), { 'cf-connecting-ip': IP }),
      ambiente,
      AGORA,
    )
    expect(primeira.status).toBe(403)
    contador.zerar()

    const segunda = await handleParada(
      postDaParada(comOCodigo('0000000000000000'), { 'cf-connecting-ip': IP }),
      ambiente,
      AGORA,
    )

    expect(segunda.status).toBe(429)
    expect(segunda.headers.get('retry-after')).toBe(String(JANELA_EM_SEGUNDOS))
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 0,
      escritas: 0,
    })
  })

  test('RL-06: excecao do binding cai no limitador de reserva, e nao abre o login', async () => {
    const quebrado = new BindingDeLimiteQuebrado()
    const ambiente = comLimitadores({ PANEL_LIMITER_LOGIN: comoBindingDeLimite(quebrado) })
    const request = pedidoDoPainel(IP)

    const console = capturarConsole()
    try {
      // O binding estoura em TODAS as chamadas. Abrir o portao aqui entregaria
      // o login a quem so precisa derrubar o contador da Cloudflare.
      expect(await tentar(TETO_DO_LOGIN, request, 'login', ambiente)).toEqual(
        todasPassam(TETO_DO_LOGIN),
      )
      expect((await limitar(request, ambiente, 'login', AGORA)).permitido).toBe(false)
    } finally {
      console.parar()
    }

    expect(quebrado.chamadas).toBe(TETO_DO_LOGIN + 1)
    // A falha aparece no log com o codigo do projeto, e a chave — que carrega
    // um IP — nao vai junto.
    expect(console.linhas.every((linha) => linha.startsWith('painel: indisponivel'))).toBe(true)
    expect(console.linhas.some((linha) => linha.includes(IP))).toBe(false)
  })

  test('RL-06: limitador indisponivel NAO tranca a parada', async () => {
    await limparBanco(env.DB)
    await gravarConfig(env.DB, { enabled: 1 })
    const codigo = await gerarCodigoDeParada()

    const quebrado = new BindingDeLimiteQuebrado()
    const ambiente = comLimitadores({ PANEL_LIMITER_STOP: comoBindingDeLimite(quebrado) })

    const console = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        postDaParada(comOCodigo(codigo), { 'cf-connecting-ip': IP }),
        ambiente,
        AGORA,
      )
    } finally {
      console.parar()
    }

    // O freio nao pode ficar do lado de la de uma camada opcional que caiu.
    expect(resposta.status).toBe(200)
    expect(quebrado.chamadas).toBe(1)
    expect(await estadoDaAutomacao()).toBe(0)
  })
})

describe('RL — a rota, com o duble injetado', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('RL-01: a recusa vira 429 com Retry-After e a chave e a da parada', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const codigo = await gerarCodigoDeParada()
    const recusa = new LimitadorFalso({ permitido: false, esperarSegundos: 47 })

    const resposta = await handleParada(
      postDaParada(comOCodigo(codigo), { 'cf-connecting-ip': IP }),
      env,
      AGORA,
      { limitador: recusa },
    )

    expect(resposta.status).toBe(429)
    // O `Retry-After` e o do veredito, e nao uma constante escondida na rota.
    expect(resposta.headers.get('retry-after')).toBe('47')
    expect(recusa.chaves).toEqual([`parada:${IP}`])
    // Recusado ANTES de conferir o codigo: um codigo CORRETO tambem para aqui,
    // e a automacao continua ligada.
    expect(await estadoDaAutomacao()).toBe(1)
  })

  test('RL-05: a tentativa recusada devolve o corpo generico e executa ZERO consultas', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const contador = new D1Contador(env.DB)
    const ambiente = comLimitadores({ DB: comoD1(contador) })

    const resposta = await handleParada(
      postDaParada(comOCodigo('0000000000000000'), { 'cf-connecting-ip': IP }),
      ambiente,
      AGORA,
      { limitador: new LimitadorFalso({ permitido: false, esperarSegundos: 60 }) },
    )

    expect(resposta.status).toBe(429)
    // Uma das TRES frases de §10.12, e nada alem disso: a rota nao ganha uma
    // quarta pagina so porque a tabela de §11.4 tem uma linha para 429.
    expect(await resposta.text()).toContain(
      'Não foi possível confirmar agora. Em caso de erro a automação para sozinha.',
    )
    // "Nao gasta cota" e uma afirmacao sobre faturamento; o contador e o unico
    // jeito honesto de transforma-la numa afirmacao sobre codigo (§13.4).
    expect({
      prepares: contador.prepares,
      escritas: contador.escritas,
      batches: contador.batches,
    }).toEqual({ prepares: 0, escritas: 0, batches: 0 })
  })

  test('RL-04: sem CF-Connecting-IP a rota da parada usa o balde global', async () => {
    const observador = new LimitadorFalso()

    await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA, {
      limitador: observador,
    })

    expect(observador.chaves).toEqual(['parada:global'])
  })
})

describe('RL — o webhook e a camada ausente', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('RL-07: o limitador do painel nao se aplica ao webhook', async () => {
    // Aplicar limite la faria a Meta receber 429, desistir da entrega e, no
    // limite, cancelar a inscricao — o preco de proteger o que ja e protegido
    // pela assinatura do corpo.
    const RAJADA = TETO_DA_PARADA + TETO_DO_LOGIN + 10
    const respostas: number[] = []

    for (let i = 0; i < RAJADA; i++) {
      const ctx = createExecutionContext()
      const handshake = await worker.fetch(
        new Request(
          `${RAIZ}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify-token-de-teste&hub.challenge=${i}`,
          { headers: { 'cf-connecting-ip': IP } },
        ),
        env,
        ctx,
      )
      await waitOnExecutionContext(ctx)
      respostas.push(handshake.status)

      const semAssinatura = createExecutionContext()
      const post = await worker.fetch(
        new Request(`${RAIZ}/webhooks/instagram`, {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP },
        }),
        env,
        semAssinatura,
      )
      await waitOnExecutionContext(semAssinatura)
      respostas.push(post.status)
    }

    // Nenhuma delas e 429, e a legitima (o handshake) continua 200 na ultima.
    expect(respostas.filter((status) => status === 429)).toEqual([])
    expect(respostas.filter((status) => status === 200)).toHaveLength(RAJADA)

    // E o mais forte: os baldes do painel continuam INTEIROS para aquele IP.
    // Se o webhook falasse com o limitador, esta rajada teria estourado os dois.
    expect(await tentar(TETO_DO_LOGIN, pedidoDoPainel(IP), 'login')).toEqual(
      todasPassam(TETO_DO_LOGIN),
    )
    expect(await tentar(TETO_DA_PARADA, pedidoDoPainel(IP), 'parada')).toEqual(
      todasPassam(TETO_DA_PARADA),
    )
  })

  test('RL-06: ausentes os tres bindings, a parada continua desligando a automacao', async () => {
    // A excecao declarada de §7.4, escrita como teste: o ambiente de teste NAO
    // tem os limitadores, e e essa ausencia que prova que o painel funciona sem
    // a camada. Se um dia alguem os acrescentar aos bindings de teste, esta
    // primeira linha fica vermelha antes de a suite provar menos do que promete.
    const ambiente = env as unknown as Record<string, unknown>
    expect([
      ambiente.PANEL_LIMITER_LOGIN,
      ambiente.PANEL_LIMITER_CODIGO,
      ambiente.PANEL_LIMITER_STOP,
    ]).toEqual([undefined, undefined, undefined])

    await gravarConfig(env.DB, { enabled: 1 })
    const codigo = await gerarCodigoDeParada()

    const resposta = await handleParada(
      postDaParada(comOCodigo(codigo), { 'cf-connecting-ip': IP }),
      env,
      AGORA,
    )

    expect(resposta.status).toBe(200)
    expect(await estadoDaAutomacao()).toBe(0)
  })

  test('RL-06: sem binding, quem assume e a reserva — e ela limita de verdade', async () => {
    // `limitadorDaFamilia` devolve a reserva, e nao um "sempre pode". A prova e
    // comportamental: a reserva recusa depois do teto, sem binding nenhum.
    const reserva = limitadorDaFamilia(env, 'login')
    const chave = chaveDoBalde('login', pedidoDoPainel(IP))

    for (let i = 0; i < TETO_DO_LOGIN; i++) {
      expect(`${i}=${(await reserva.permitir(chave, AGORA)).permitido}`).toBe(`${i}=true`)
    }

    expect((await reserva.permitir(chave, AGORA)).permitido).toBe(false)
  })
})

/** `enabled` da linha de configuracao, ou `null` quando ela nao existe. */
async function estadoDaAutomacao(): Promise<number | null> {
  const linha = await env.DB.prepare('SELECT enabled FROM painel_config WHERE id = 1').first<{
    enabled: number
  }>()
  return linha?.enabled ?? null
}
