import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import worker, { processEvents, runScheduledTasks } from '../src/index'
import { comoPublico, type EstadoDoPainel, type EstadoPublicoDoPainel } from '../src/routes/health'
import { contaConectada } from '../src/routes/painel/inicio'
import type { CommentEvent } from '../src/types/meta'
import { ligarConta, limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoApi,
  comoD1,
  configDeTeste,
  D1Contador,
  MetaComContaParada,
  MetaFalsa,
  MetaQueFalha,
  pedir,
  responder,
  TETO_DE_SUBREQUESTS,
} from './fixtures/dubles'

/**
 * REG, regressao do roteador.
 *
 * O painel vai entrar pelo `default:` do `switch` de `src/index.ts`. Este
 * arquivo congela, antes disso, quem NAO passa por ali: as sete rotas de hoje
 * respondem exatamente o que respondem, e o 404 continua sendo 404.
 */

/** Corpo e status do `default:` de hoje. E o que o painel vai substituir. */
const NAO_ENCONTRADO = { status: 404, corpo: 'Not Found' }

/** O `responder` do fixture, ja com o env desta suite. */
function responderComEnv(request: Request): Promise<Response> {
  return responder(request, env)
}

/** As sete rotas registradas hoje, com o status que cada uma devolve sem nada. */
const SETE_ROTAS: ReadonlyArray<{ caminho: string; status: number }> = [
  { caminho: '/health', status: 200 },
  { caminho: '/privacy-policy', status: 200 },
  { caminho: '/data-deletion', status: 200 },
  // GET sem hub.verify_token e o handshake recusado.
  { caminho: '/webhooks/instagram', status: 403 },
  { caminho: '/setup/authorize', status: 401 },
  // Sem state e sem code, o callback para em 400 antes de qualquer rede.
  { caminho: '/oauth/callback', status: 400 },
  { caminho: '/setup/subscribe', status: 401 },
]

describe('REG: o roteador antes do painel', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-23: sao exatamente sete rotas e cada uma responde o mesmo status', async () => {
    expect(SETE_ROTAS).toHaveLength(7)

    const obtidos: Record<string, number> = {}
    for (const rota of SETE_ROTAS) {
      obtidos[rota.caminho] = (await responderComEnv(pedir(rota.caminho))).status
    }

    expect(obtidos).toEqual(Object.fromEntries(SETE_ROTAS.map((r) => [r.caminho, r.status])))
  })

  test('REG-24: /qualquer-coisa continua 404', async () => {
    for (const caminho of ['/qualquer-coisa', '/', '/setup', '/oauth', '/webhooks']) {
      const resposta = await responderComEnv(pedir(caminho))
      expect(resposta.status).toBe(NAO_ENCONTRADO.status)
      expect(await resposta.text()).toBe(NAO_ENCONTRADO.corpo)
    }
  })

  test('REG-25: /painelzinho cai no 404 e nao no painel', async () => {
    const resposta = await responderComEnv(pedir('/painelzinho'))

    expect(resposta.status).toBe(NAO_ENCONTRADO.status)
    expect(await resposta.text()).toBe(NAO_ENCONTRADO.corpo)
  })

  test('REG-26: /painel e /painel/ entram os dois no painel, e nenhum vira o 404 cru', async () => {
    // Esta garantia MUDOU de forma na etapa do roteador, e a mudanca esta
    // escrita aqui porque ela e deliberada. Antes do painel existir, os dois
    // caminhos respondiam o mesmo 404 e o teste comparava corpo com corpo, era
    // a forma que um roteador com `case '/painel'` e sem `/painel/` deixava
    // vermelha. Agora `/painel` E uma rota (sem sessao, `303` para
    // `/painel/entrar`) e `/painel/` NAO e (`404 rota_desconhecida`, da tabela
    // de §11.4): comparar os dois passou a ser impossivel sem inventar um
    // apelido de caminho, e §7.1 diz "um caminho por tela".
    //
    // O que continua sendo afirmado, e e o que importava: os DOIS sao tratados
    // pelo painel, e nenhum deles escapa para o `default:` do Worker.
    const semBarra = await responderComEnv(pedir('/painel'))
    const comBarra = await responderComEnv(pedir('/painel/'))

    expect(semBarra.status).toBe(303)
    expect(semBarra.headers.get('location')).toBe('/painel/entrar')

    expect(comBarra.status).toBe(404)
    expect(await comBarra.text()).not.toBe(NAO_ENCONTRADO.corpo)

    // E a trava do apelido: `/painel/` nao pode virar sinonimo de `/painel`.
    expect(comBarra.headers.get('location')).toBeNull()
  })

  /**
   * As TRES metades de §11.9, e a do meio e a que importa.
   *
   * `/health` e publica: nao tem Bearer, nao tem cookie, e qualquer anonimo a
   * consulta em laco de graca. Por isso o campo `painel` tem duas resolucoes da
   * MESMA pergunta, e a diferenca e a autorizacao.
   */
  const PAINEL_PUBLICOS = ['desativado', 'sem_acesso', 'pronto']
  const PAINEL_DETALHADOS = [
    'desativado',
    'sem_passkey',
    'sem_codigo_parada',
    'pronto_arquivo',
    'pronto_banco',
    'pronto_parado',
  ]

  test('REG-27b: sem Bearer, corpo.painel e um dos TRES valores publicos', async () => {
    const corpo = (await (await responderComEnv(pedir('/health'))).json()) as Record<
      string,
      unknown
    >

    expect(PAINEL_PUBLICOS).toContain(corpo.painel)

    // O banco de teste esta vazio: nao ha credencial para o `rp_id` atual, e o
    // estado detalhado e `sem_passkey`. O publico tem de mostrar o MESCLADO.
    expect(corpo.painel).toBe('sem_acesso')
  })

  test('REG-27c: com Bearer valido, corpo.painel e um dos SEIS valores', async () => {
    const corpo = (await (
      await responderComEnv(pedir('/health', { authorization: 'Bearer admin-token-de-teste' }))
    ).json()) as Record<string, unknown>

    expect(PAINEL_DETALHADOS).toContain(corpo.painel)
    expect(corpo.painel).toBe('sem_passkey')

    // E nenhum campo novo entrou junto com a autorizacao.
    expect(Object.keys(corpo).sort()).toEqual(['configurado', 'painel', 'status', 'webhook'])
  })

  test('REG-27d: `sem_passkey` NUNCA aparece numa resposta sem Bearer', async () => {
    // O motivo nao e pudor: o convite comum funciona exatamente enquanto nao
    // existe nenhuma credencial, e some quando a primeira passkey nasce.
    // Publicar `sem_passkey` a anonimo entrega, por polling de graca, o instante
    // preciso em que um convite interceptado ainda vale.
    const semNada = await responderComEnv(pedir('/health'))
    const comBearerErrado = await responderComEnv(
      pedir('/health', { authorization: 'Bearer token-errado' }),
    )

    for (const resposta of [semNada, comBearerErrado]) {
      const corpo = (await resposta.json()) as Record<string, unknown>
      expect(corpo.painel).not.toBe('sem_passkey')
      expect(corpo.painel).not.toBe('sem_codigo_parada')
      expect(PAINEL_PUBLICOS).toContain(corpo.painel)
    }
  })

  test('REG-27f: a fusao de SEIS para TRES de §11.9 esta inteira, valor por valor', () => {
    // **REG-27d nao prendia isto, e a diferenca importa.** Ele afirmava que o
    // valor publico esta na lista dos tres e que nao e `sem_passkey`, o que
    // `pronto` tambem satisfaz. Ou seja: trocar a fusao de `sem_codigo_parada`
    // de `sem_acesso` para `pronto` passava verde, e essa e justamente a fusao
    // que §11.9 explica ser a PROTECAO ("junto com `sem_passkey` ele descreve o
    // grau de desamparo do painel para quem nao tem nada").
    //
    // Um mapa exaustivo num `toEqual` unico afirma as duas metades de uma vez: o
    // destino de cada um dos seis, e que sao exatamente seis. Um valor novo no
    // enum sem linha aqui quebra, que e o mesmo criterio do dicionario de
    // `CommentStatus`.
    const fusao: Record<EstadoDoPainel, EstadoPublicoDoPainel> = {
      desativado: comoPublico('desativado'),
      sem_passkey: comoPublico('sem_passkey'),
      sem_codigo_parada: comoPublico('sem_codigo_parada'),
      pronto_arquivo: comoPublico('pronto_arquivo'),
      pronto_banco: comoPublico('pronto_banco'),
      pronto_parado: comoPublico('pronto_parado'),
    }

    expect(fusao).toEqual({
      desativado: 'desativado',
      // Os DOIS graus de desamparo colapsam no mesmo valor, e e a fusao que
      // impede o anonimo de saber quando um convite interceptado ainda vale.
      sem_passkey: 'sem_acesso',
      sem_codigo_parada: 'sem_acesso',
      // Os tres `pronto_*` colapsam nao por ameaca, mas porque um enum que muda
      // de TAMANHO conforme quem pergunta e mais facil de testar do que um que
      // muda de conteudo.
      pronto_arquivo: 'pronto',
      pronto_banco: 'pronto',
      pronto_parado: 'pronto',
    })
  })

  test('REG-27e: `corpo.painel` concorda com o 503 real das telas, nos TRES pisos', async () => {
    // **O defeito que este teste prende foi meu, e ele mentia exatamente onde
    // doi.** A primeira versao do campo `painel` reescreveu o predicado de
    // habilitacao a mao e conferia comprimento ZERO de dois bindings.
    // `painelHabilitado` (§10.2), quem de fato decide o `503` de toda rota do
    // painel, exige TRES pisos. Entre os dois havia uma faixa inteira de
    // configuracao (uma chave de 31 caracteres, um caractere perdido no
    // copiar-e-colar) em que toda tela respondia `503 painel_desativado` e esta
    // rota respondia `pronto`; o assistente, que le daqui, mandava o dono ficar
    // tranquilo. §11.9 abre dizendo que NAO existe `/painel/diagnostico`: este
    // campo e o unico diagnostico do subsistema.
    //
    // A afirmacao nao e sobre o predicado, e sobre a CONCORDANCIA entre as duas
    // respostas. Reescrever o degrau por fora de `painelHabilitado` volta a
    // ficar vermelho aqui, seja qual for a grafia nova.
    const abaixoDoPiso: ReadonlyArray<{ nome: string; patch: Record<string, unknown> }> = [
      { nome: 'chave de sessao com 31', patch: { PANEL_SESSION_KEY: 'a'.repeat(31) } },
      { nome: 'admin token com 19', patch: { SETUP_ADMIN_TOKEN: 'b'.repeat(19) } },
      { nome: 'rp_id vazio', patch: { PANEL_RP_ID: '' } },
      { nome: 'chave de sessao ausente', patch: { PANEL_SESSION_KEY: undefined } },
    ]

    for (const caso of abaixoDoPiso) {
      const ambiente = { ...env, ...caso.patch } as unknown as typeof env

      const tela = await responder(pedir('/painel'), ambiente)
      const saude = await responder(pedir('/health'), ambiente)
      const corpo = (await saude.json()) as Record<string, unknown>

      // A tela nao existe...
      expect({ [caso.nome]: tela.status }).toEqual({ [caso.nome]: 503 })
      // ...entao o diagnostico tem de dizer isso, e nao "pronto".
      expect({ [caso.nome]: corpo.painel }).toEqual({ [caso.nome]: 'desativado' })
    }

    // Contrapositivo, e ele e obrigatorio: com o ambiente INTEIRO o campo NAO e
    // `desativado`, senao um degrau que devolvesse sempre `desativado` passaria
    // neste laco sem provar nada.
    const inteiro = (await (await responderComEnv(pedir('/health'))).json()) as Record<
      string,
      unknown
    >
    expect(inteiro.painel).not.toBe('desativado')
  })

  test('REG-27: /health continua com o mesmo corpo, mais UM campo', async () => {
    const resposta = await responderComEnv(pedir('/health'))
    const corpo = (await resposta.json()) as Record<string, unknown>

    // O conjunto EXATO de campos. A etapa do painel acrescentou EXATAMENTE um,
    // `painel`, e ele mora na RAIZ, irmao de `status` e `webhook`, nunca
    // dentro de `configurado`. E aqui que um campo a mais fica visivel.
    expect(Object.keys(corpo).sort()).toEqual(['configurado', 'painel', 'status', 'webhook'])
    expect(corpo.status).toBe('ok')
    expect(corpo.webhook).toBe('/webhooks/instagram')

    const configurado = corpo.configurado as Record<string, unknown>
    expect(Object.keys(configurado).sort()).toEqual(['apiVersion', 'appId', 'contaAutorizada'])
    expect(typeof configurado.appId).toBe('boolean')
    expect(typeof configurado.apiVersion).toBe('string')
    expect(configurado.contaAutorizada).toBe(false)
  })

  test('REG-28: as paginas legais continuam sem exigir sessao', async () => {
    for (const caminho of ['/privacy-policy', '/data-deletion']) {
      const semNada = await responderComEnv(pedir(caminho))
      expect(semNada.status).toBe(200)
      expect(semNada.headers.get('set-cookie')).toBeNull()

      const comCookieQualquer = await responderComEnv(
        pedir(caminho, { cookie: 'painel_sessao=lixo' }),
      )
      expect(comCookieQualquer.status).toBe(200)
    }
  })

  test('REG-30: as rotas de hoje nao caem no default: onde o painel vai entrar', async () => {
    // A forma de HOJE da garantia "routePainel devolve null para estes
    // caminhos": eles sao atendidos por um `case` proprio e nunca chegam ao
    // `default:`. A metade que cita `routePainel` pelo nome entra na etapa
    // que cria o roteador do painel.
    for (const rota of SETE_ROTAS) {
      const resposta = await responderComEnv(pedir(rota.caminho))
      expect(resposta.status).not.toBe(NAO_ENCONTRADO.status)
    }

    // E o contrapositivo: quem nao tem `case` cai no `default:`.
    const desconhecida = await responderComEnv(pedir('/nao-existe'))
    expect(desconhecida.status).toBe(NAO_ENCONTRADO.status)
    expect(await desconhecida.text()).toBe(NAO_ENCONTRADO.corpo)
  })
})

describe('REG-29: o cron', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-29: o cron continua sendo apenas runScheduledTasks', async () => {
    const viaCron = new D1Contador(env.DB)
    const ctx = createExecutionContext()
    await worker.scheduled(
      { scheduledTime: AGORA, cron: '*/5 * * * *', noRetry() {} },
      { ...env, DB: comoD1(viaCron) },
      ctx,
    )
    await waitOnExecutionContext(ctx)

    const direto = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(direto) }, AGORA)

    // Mesmo gasto pelos dois caminhos: o `scheduled` nao faz nada por fora.
    expect({ prepares: viaCron.prepares, escritas: viaCron.escritas }).toEqual({
      prepares: direto.prepares,
      escritas: direto.escritas,
    })

    // E o gasto e o de hoje: a leitura do token, a varredura de pendentes e a
    // leitura barata da poda de auditoria (§8.9), a UNICA coisa do painel que
    // pode entrar no cron, e ela entrou na etapa da parada de emergencia.
    // Nenhuma escrita: a poda so apaga quando ha o que apagar.
    expect({ prepares: direto.prepares, escritas: direto.escritas }).toEqual({
      prepares: 3,
      escritas: 0,
    })
  })
})

/**
 * O cron e a outra ponta do fatiamento do lote (§16.1): e ele que entrega o
 * excedente que o webhook nao coube. Estes testes ficam neste arquivo porque e
 * aqui que o cron ja mora (REG-29).
 */
function comentario(indice: number): CommentEvent {
  return {
    commentId: `comment-cron-${indice}`,
    mediaId: 'media-1',
    fromId: `igsid-cron-${indice}`,
    fromUsername: `visitante-${indice}`,
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
  }
}

async function statusPorComentario(): Promise<Record<string, string>> {
  const resultado = await env.DB.prepare('SELECT comment_id, status FROM processed_comments').all<{
    comment_id: string
    status: string
  }>()

  return Object.fromEntries((resultado.results ?? []).map((l) => [l.comment_id, l.status]))
}

describe('§16.1: o cron entrega o excedente que o webhook fatiou', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  test('§16.1: o excedente reagendado e entregue na varredura seguinte', async () => {
    const doWebhook = new MetaFalsa()
    await processEvents(
      Array.from({ length: 10 }, (_, i) => comentario(i)),
      env,
      AGORA,
      { createApi: () => comoApi(doWebhook), resolveConfig: () => configDeTeste() },
    )

    // A fatia entregou 5; os outros 5 ficaram esperando.
    expect(
      Object.values(await statusPorComentario()).filter((s) => s === 'retry_pending'),
    ).toHaveLength(5)

    const doCron = new MetaFalsa()
    const contador = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(contador) }, AGORA, {
      createApi: () => comoApi(doCron),
      resolveConfig: () => configDeTeste(),
    })

    // Nenhum comentario ficou pelo caminho.
    const status = await statusPorComentario()
    expect(Object.keys(status)).toHaveLength(10)
    expect(Object.values(status).filter((s) => s === 'completed')).toHaveLength(10)

    // E a varredura tambem coube no teto: consultas ao D1 e chamadas a Meta
    // dividem os mesmos 50 subrequests por invocacao.
    expect(contador.prepares + doCron.total).toBeLessThan(TETO_DE_SUBREQUESTS)
  })

  test('§16.1: uma varredura cheia cabe no teto de 50, com fila maior que o lote', async () => {
    // Fila de 30 pendentes: mais do que qualquer varredura pode drenar. Assim
    // a conta abaixo mede o LOTE do cron, e nao o tamanho da fila, se alguem
    // dobrar RETRY_BATCH_SIZE, este teste vermelha.
    await env.DB.batch(
      Array.from({ length: 30 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO processed_comments
             (comment_id, media_id, commenter_scoped_id_hash, status,
              attempt_count, next_retry_at, created_at, updated_at)
           VALUES (?, 'media-1', ?, 'retry_pending', 0, ?, ?, ?)`,
        ).bind(`comment-fila-${i}`, `hash-${i}`, AGORA, AGORA, AGORA),
      ),
    )

    const doCron = new MetaFalsa()
    const contador = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(contador) }, AGORA, {
      createApi: () => comoApi(doCron),
      resolveConfig: () => configDeTeste(),
    })

    // Consultas ao D1 e chamadas a Meta dividem os mesmos 50 subrequests.
    expect(contador.prepares + doCron.total).toBeLessThan(TETO_DE_SUBREQUESTS)

    // E a varredura drenou de verdade, nao passou raspando por estar vazia.
    const status = await statusPorComentario()
    expect(Object.values(status).filter((s) => s === 'completed').length).toBeGreaterThan(0)
    expect(Object.values(status).filter((s) => s === 'retry_pending').length).toBeGreaterThan(0)
  })
})

describe('§16.3: a retentativa do cron passa por renderTemplate', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  test('§16.3: o Direct da retentativa troca TODAS as ocorrencias e sanitiza', async () => {
    await env.DB.prepare(
      `INSERT INTO processed_comments
         (comment_id, media_id, commenter_scoped_id_hash, status,
          attempt_count, next_retry_at, created_at, updated_at)
       VALUES ('comment-retentativa', 'media-1', 'hash-qualquer', 'retry_pending',
               1, ?, ?, ?)`,
    )
      .bind(AGORA, AGORA, AGORA)
      .run()

    const api = new MetaFalsa()
    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () =>
        configDeTeste({
          privateReplyText: 'Oi {username}! Link: {link}, de novo: {link}',
          // O caractere de controle no meio e o que o `.replace()` cru deixava
          // passar para dentro da mensagem.
          destinationUrl: 'https://exemplo.com/a\u0000b',
        }),
    })

    expect(api.textosEnviados).toEqual([
      'Oi ! Link: https://exemplo.com/ab, de novo: https://exemplo.com/ab',
    ])
  })
})

describe('§16.1: a retentativa do cron tem a mesma escada do caminho inline', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  /** Grava um pendente com o numero de tentativas ja gastas. */
  async function pendente(commentId: string, tentativas: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO processed_comments
         (comment_id, media_id, commenter_scoped_id_hash, status,
          attempt_count, next_retry_at, created_at, updated_at)
       VALUES (?, 'media-1', 'hash-1', 'retry_pending', ?, ?, ?, ?)`,
    )
      .bind(commentId, tentativas, AGORA, AGORA, AGORA)
      .run()
  }

  async function registro(commentId: string) {
    return env.DB.prepare(
      'SELECT status, attempt_count, next_retry_at FROM processed_comments WHERE comment_id = ?',
    )
      .bind(commentId)
      .first<{ status: string; attempt_count: number; next_retry_at: number | null }>()
  }

  test('§16.1: erro retentavel na varredura agenda de novo, nao mata o comentario', async () => {
    await pendente('comment-transitorio', 0)
    const api = new MetaQueFalha()

    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () => configDeTeste(),
    })

    // Antes de §16.1 so caia aqui quem ja tinha falhado uma entrega, e um unico
    // 500 transitorio da Meta bastava para marcar `failed`. Agora todo
    // comentario a partir do sexto do lote passa por aqui: perder na primeira
    // seria perder comentario, que e a garantia que esta etapa promete.
    const linha = await registro('comment-transitorio')
    expect(linha?.status).toBe('retry_pending')
    expect(linha?.attempt_count).toBe(1)
    expect(linha?.next_retry_at).toBeGreaterThan(AGORA)
  })

  test('§16.1: esgotadas as tentativas, a varredura marca failed', async () => {
    await pendente('comment-esgotado', 3)
    const api = new MetaQueFalha()

    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () => configDeTeste(),
    })

    expect((await registro('comment-esgotado'))?.status).toBe('failed')
  })
})

describe('a conta parada nao pode queimar a fila do cron', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  /** Grava um pendente pronto para a varredura. */
  async function pendente(commentId: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO processed_comments
         (comment_id, media_id, commenter_scoped_id_hash, status,
          attempt_count, next_retry_at, created_at, updated_at)
       VALUES (?, 'media-1', ?, 'retry_pending', 0, ?, ?, ?)`,
    )
      .bind(commentId, `hash-${commentId}`, AGORA, AGORA, AGORA)
      .run()
  }

  async function registro(commentId: string) {
    return env.DB.prepare(
      'SELECT status, attempt_count FROM processed_comments WHERE comment_id = ?',
    )
      .bind(commentId)
      .first<{ status: string; attempt_count: number }>()
  }

  test('token invalido deixa o pendente intacto em vez de marcar failed', async () => {
    await pendente('comment-token-morto')

    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(new MetaComContaParada()),
      resolveConfig: () => configDeTeste(),
    })

    // `TOKEN_INVALIDO` nao esta em `isRetryable`, e o ramo `else` marcava
    // `failed`, que e TERMINAL: o comentario de quem digitou a palavra-gatilho
    // era apagado do mundo por um problema da CONTA. Parar e reversivel, o
    // dono reconecta e a varredura seguinte entrega.
    const linha = await registro('comment-token-morto')
    expect(linha?.status).toBe('retry_pending')
    expect(linha?.attempt_count).toBe(0)
  })

  test('a varredura abandona o resto da fila na primeira falha de conta', async () => {
    await pendente('comment-a')
    await pendente('comment-b')
    await pendente('comment-c')

    const api = new MetaComContaParada()
    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () => configDeTeste(),
    })

    // Um unico Direct tentado, e nao tres: insistir contra uma conta ja
    // sinalizada e como um aviso vira bloqueio.
    expect(api.tentativasDeDirect).toBe(1)

    for (const id of ['comment-a', 'comment-b', 'comment-c']) {
      expect((await registro(id))?.status).toBe('retry_pending')
    }
  })

  test('403 na conta tem o mesmo tratamento que o token invalido', async () => {
    await pendente('comment-proibido')

    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(new MetaComContaParada('PROIBIDO')),
      resolveConfig: () => configDeTeste(),
    })

    expect((await registro('comment-proibido'))?.status).toBe('retry_pending')
  })

  test('uma etapa do cron que estoura nao derruba as seguintes', async () => {
    await pendente('comment-sobrevivente')

    // `resolveConfig` estourando simula a falha DENTRO de `retryPending`: sem
    // `executarEtapa`, a rejeicao subia por `runScheduledTasks` e levava junto
    // a poda da auditoria, sem uma linha de log.
    await expect(
      runScheduledTasks(env, AGORA, {
        createApi: () => comoApi(new MetaFalsa()),
        resolveConfig: () => {
          throw new Error('config indisponivel')
        },
      }),
    ).resolves.toBeUndefined()

    expect((await registro('comment-sobrevivente'))?.status).toBe('retry_pending')
  })
})
/**
 * O token que venceu.
 *
 * `expires_at` existia desde a 0001 e era lido por UM lugar so, `shouldRefresh`
 *, que responde `false` tanto para "ainda cedo" quanto para "tarde demais". O
 * resultado e que o prazo vencido nao produzia nem renovacao, nem aviso, nem
 * tela dizendo a verdade: a linha continuava em `account_tokens`, e todo mundo
 * que perguntava "tem conta?" perguntava so isso.
 *
 * Um token longo do Instagram vale 60 dias. Quem troca a senha, cai num
 * checkpoint ou passa dois meses sem o cron rodar tem a linha intacta e nada
 * sendo entregue, e via, nas seis telas do painel, "Conectada. A automacao
 * consegue falar com o Instagram para enviar".
 */
describe('o token vencido nao pode passar por conta conectada', () => {
  /** Um instante depois dos 60 dias que `ligarConta` grava. */
  const DEPOIS_DO_PRAZO = AGORA + 61 * 24 * 60 * 60 * 1000

  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  test('o painel diz "nao conectada" depois de o prazo passar', async () => {
    // Contrapositivo primeiro: a MESMA linha, perguntada dentro do prazo,
    // responde conectada. Sem ele o teste passaria com um `SELECT` quebrado.
    expect(await contaConectada(env.DB, AGORA)).toBe(true)

    expect(await contaConectada(env.DB, DEPOIS_DO_PRAZO)).toBe(false)
  })

  test('o limite e o instante exato de `expires_at`, e nao um arredondamento', async () => {
    const linha = await env.DB.prepare('SELECT expires_at FROM account_tokens WHERE id = 1').first<{
      expires_at: number
    }>()
    const vence = linha?.expires_at ?? 0
    expect(vence).toBeGreaterThan(AGORA)

    // Um milissegundo antes ainda vale; no instante do vencimento, nao vale
    // mais. `expires_at > ?` e um `>=` disfarcado seriam indistinguiveis em
    // qualquer teste que nao encoste no limite.
    expect(await contaConectada(env.DB, vence - 1)).toBe(true)
    expect(await contaConectada(env.DB, vence)).toBe(false)
  })

  test('/health nao responde `contaAutorizada` para um token morto', async () => {
    // **O UNICO teste desta suite ancorado no relogio real, e a excecao tem
    // motivo.** `/health` entra por `worker.fetch`, que calcula o proprio
    // `now = Date.now()`, nenhum parametro atravessa a rota. `AGORA` e
    // novembro de 2023, entao um token gravado com ele ja nasce vencido do
    // ponto de vista de `//health`, e a versao anterior deste teste falhava
    // no CONTRAPOSITIVO, nao na garantia. Congelar o relogio com fake timers
    // resolveria por fora o que a rota decide por dentro, e esconderia
    // exatamente o acoplamento que interessa aqui.
    const agoraReal = Date.now()
    const SESSENTA_E_UM_DIAS = 61 * 24 * 60 * 60 * 1000

    await limparBanco(env.DB)
    await ligarConta(env, agoraReal)

    const dentro = await (await responderComEnv(pedir('/health'))).json()
    expect(dentro).toMatchObject({ configurado: { contaAutorizada: true } })

    // A MESMA conta, gravada 61 dias antes: os 60 dias de `ligarConta` ja
    // passaram, e a linha continua la.
    await limparBanco(env.DB)
    await ligarConta(env, agoraReal - SESSENTA_E_UM_DIAS)

    const fora = await (await responderComEnv(pedir('/health'))).json()
    expect(fora).toMatchObject({ configurado: { contaAutorizada: false } })
  })

  test('o cron avisa no console em vez de desistir calado', async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA - 61 * 24 * 60 * 60 * 1000)

    const console = capturarConsole()
    try {
      await runScheduledTasks(env, AGORA, {
        createApi: () => comoApi(new MetaFalsa()),
        resolveConfig: () => configDeTeste(),
      })
    } finally {
      console.parar()
    }

    expect(console.linhas.join(' ')).toContain('token_vencido')
  })

  test('um token dentro do prazo nao gera o aviso', async () => {
    // O contrapositivo do teste acima: sem ele, um `console.warn` incondicional
    // passaria pelos dois.
    const console = capturarConsole()
    try {
      await runScheduledTasks(env, AGORA, {
        createApi: () => comoApi(new MetaFalsa()),
        resolveConfig: () => configDeTeste(),
      })
    } finally {
      console.parar()
    }

    expect(console.linhas.join(' ')).not.toContain('token_vencido')
  })
})

/**
 * O indice da varredura do cron (migration 0006).
 *
 * O indice parcial some sem barulho: se o `WHERE` de `findRetryPending` deixar
 * de implicar o predicado dele, trocar o literal `'retry_pending'` por um `?`
 * ligado em tempo de execucao basta, o SQLite volta ao scan de tabela e
 * NENHUM outro teste muda de cor. O plano de consulta e a unica coisa que
 * percebe.
 */
describe('a varredura do cron continua indo pelo indice', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  /** O plano de consulta daquele SQL, numa linha so. */
  async function plano(sql: string, ...valores: unknown[]): Promise<string> {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...valores)
      .all<{ detail: string }>()
    return (results ?? []).map((linha) => linha.detail).join(' | ')
  }

  test('`findRetryPending` usa o indice parcial, e nao varre a tabela', async () => {
    const detalhe = await plano(
      `SELECT * FROM processed_comments
        WHERE status = 'retry_pending' AND next_retry_at IS NOT NULL
          AND next_retry_at <= ?
        ORDER BY next_retry_at ASC
        LIMIT ?`,
      AGORA,
      10,
    )

    expect(detalhe).toContain('idx_comments_retry_pendentes')
    expect(detalhe).not.toContain('SCAN processed_comments')
  })

  test('o indice e mesmo PARCIAL, e nao um composto com o nome novo', async () => {
    // O teste acima casa por NOME, e nome nao e garantia: um
    // `(status, next_retry_at)` chamado `idx_comments_retry_pendentes` passaria
    // por ele inteiro e pagaria de volta as tres escritas que a 0006 existe
    // para nao pagar. O que separa os dois e a clausula `WHERE` na definicao.
    const linha = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
      .bind('idx_comments_retry_pendentes')
      .first<{ sql: string }>()

    const definicao = (linha?.sql ?? '').replace(/\s+/g, ' ')

    expect(definicao).toContain("WHERE status = 'retry_pending'")
    // E `status` NAO pode voltar como coluna indexada: dentro do indice ela e
    // constante, e uma entrada que a repetisse seria maior sem ordenar nada.
    expect(definicao).toContain('(next_retry_at)')
  })

  test('o indice antigo saiu, e o cooldown por autor manteve o dele', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'processed_comments'",
    ).all<{ name: string }>()
    const nomes = (results ?? []).map((linha) => linha.name)

    // Dois indices ao mesmo tempo nao dariam erro nenhum, so pagariam a
    // escrita que a 0006 existe para nao pagar.
    expect(nomes).not.toContain('idx_comments_retry')
    expect(nomes).toContain('idx_comments_retry_pendentes')
    expect(nomes).toContain('idx_comments_commenter')
  })
})
