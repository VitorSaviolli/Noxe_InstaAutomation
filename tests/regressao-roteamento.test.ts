import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import worker, { processEvents, runScheduledTasks } from '../src/index'
import type { MetaApiClient } from '../src/services/meta-api'
import { storeAccessToken } from '../src/services/token-manager'
import type { CommentEvent } from '../src/types/meta'
import { limparBanco } from './fixtures/banco'
import { comoD1, D1Contador } from './fixtures/dubles'

/**
 * REG — regressao do roteador.
 *
 * O painel vai entrar pelo `default:` do `switch` de `src/index.ts`. Este
 * arquivo congela, antes disso, quem NAO passa por ali: as sete rotas de hoje
 * respondem exatamente o que respondem, e o 404 continua sendo 404.
 */

const AGORA = 1_700_000_000_000
const RAIZ = 'https://exemplo.workers.dev'

/** Corpo e status do `default:` de hoje. E o que o painel vai substituir. */
const NAO_ENCONTRADO = { status: 404, corpo: 'Not Found' }

async function responder(request: Request): Promise<Response> {
  const ctx = createExecutionContext()
  const resposta = await worker.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  return resposta
}

function get(caminho: string, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`${RAIZ}${caminho}`, { headers: cabecalhos })
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

describe('REG — o roteador antes do painel', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-23: sao exatamente sete rotas e cada uma responde o mesmo status', async () => {
    expect(SETE_ROTAS).toHaveLength(7)

    const obtidos: Record<string, number> = {}
    for (const rota of SETE_ROTAS) {
      obtidos[rota.caminho] = (await responder(get(rota.caminho))).status
    }

    expect(obtidos).toEqual(Object.fromEntries(SETE_ROTAS.map((r) => [r.caminho, r.status])))
  })

  test('REG-24: /qualquer-coisa continua 404', async () => {
    for (const caminho of ['/qualquer-coisa', '/', '/setup', '/oauth', '/webhooks']) {
      const resposta = await responder(get(caminho))
      expect(resposta.status).toBe(NAO_ENCONTRADO.status)
      expect(await resposta.text()).toBe(NAO_ENCONTRADO.corpo)
    }
  })

  test('REG-25: /painelzinho cai no 404 e nao no painel', async () => {
    const resposta = await responder(get('/painelzinho'))

    expect(resposta.status).toBe(NAO_ENCONTRADO.status)
    expect(await resposta.text()).toBe(NAO_ENCONTRADO.corpo)
  })

  test('REG-26: /painel e /painel/ levam ao mesmo lugar', async () => {
    const semBarra = await responder(get('/painel'))
    const comBarra = await responder(get('/painel/'))

    expect(comBarra.status).toBe(semBarra.status)
    expect(await comBarra.text()).toBe(await semBarra.text())
  })

  test('REG-27: /health continua com o mesmo corpo', async () => {
    const resposta = await responder(get('/health'))
    const corpo = (await resposta.json()) as Record<string, unknown>

    // O conjunto EXATO de campos. A etapa que acrescentar o campo do painel
    // acrescenta exatamente um, e e aqui que isso fica visivel.
    expect(Object.keys(corpo).sort()).toEqual(['configurado', 'status', 'webhook'])
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
      const semNada = await responder(get(caminho))
      expect(semNada.status).toBe(200)
      expect(semNada.headers.get('set-cookie')).toBeNull()

      const comCookieQualquer = await responder(get(caminho, { cookie: 'painel_sessao=lixo' }))
      expect(comCookieQualquer.status).toBe(200)
    }
  })

  test('REG-30: as rotas de hoje nao caem no default: onde o painel vai entrar', async () => {
    // A forma de HOJE da garantia "routePainel devolve null para estes
    // caminhos": eles sao atendidos por um `case` proprio e nunca chegam ao
    // `default:`. A metade que cita `routePainel` pelo nome entra na etapa
    // que cria o roteador do painel.
    for (const rota of SETE_ROTAS) {
      const resposta = await responder(get(rota.caminho))
      expect(resposta.status).not.toBe(NAO_ENCONTRADO.status)
    }

    // E o contrapositivo: quem nao tem `case` cai no `default:`.
    const desconhecida = await responder(get('/nao-existe'))
    expect(desconhecida.status).toBe(NAO_ENCONTRADO.status)
    expect(await desconhecida.text()).toBe(NAO_ENCONTRADO.corpo)
  })
})

describe('REG-29 — o cron', () => {
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

    // E o gasto e o de hoje: a leitura do token e a varredura de pendentes.
    // Nenhuma escrita, e nada de painel — a poda da auditoria e a UNICA coisa
    // do painel que pode entrar aqui, e ela ainda nao existe.
    expect({ prepares: direto.prepares, escritas: direto.escritas }).toEqual({
      prepares: 2,
      escritas: 0,
    })
  })
})

/**
 * O cron e a outra ponta do fatiamento do lote (§16.1): e ele que entrega o
 * excedente que o webhook nao coube. Estes testes ficam neste arquivo porque e
 * aqui que o cron ja mora (REG-29).
 */
const IG_USER_ID = '17841400000000000'
const USERNAME_CONTA = 'conta_de_teste'
const TETO_DE_SUBREQUESTS = 50

/** Duble da Meta que guarda o texto exato de cada Direct. */
class ApiDoCron {
  readonly textosEnviados: string[] = []
  chamadas = 0

  async sendPrivateReply(_ig: string, _comment: string, text: string) {
    this.chamadas++
    this.textosEnviados.push(text)
    return { ok: true as const, data: { message_id: 'msg-cron' } }
  }

  async replyToComment(_comment: string, _message: string) {
    this.chamadas++
    return { ok: true as const, data: { id: 'reply-cron' } }
  }

  async getMediaInfo(_mediaId: string) {
    this.chamadas++
    return { ok: true as const, data: { id: 'media-1', media_product_type: 'REELS' } }
  }
}

function comoApi(falsa: ApiDoCron): MetaApiClient {
  return falsa as unknown as MetaApiClient
}

async function ligarConta(): Promise<void> {
  await storeAccessToken(env, {
    igUserId: IG_USER_ID,
    username: USERNAME_CONTA,
    accessToken: 'token-de-teste',
    expiresInSeconds: 60 * 24 * 60 * 60,
    now: AGORA,
  })
}

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

/** Config de teste: nunca depende do `src/config.ts` de quem clonou o projeto. */
function config(patch: Partial<AutomationConfig> = {}): AutomationConfig {
  return { ...automationConfig, destinationUrl: 'https://exemplo.com/link', ...patch }
}

async function statusPorComentario(): Promise<Record<string, string>> {
  const resultado = await env.DB.prepare('SELECT comment_id, status FROM processed_comments').all<{
    comment_id: string
    status: string
  }>()

  return Object.fromEntries((resultado.results ?? []).map((l) => [l.comment_id, l.status]))
}

describe('§16.1 — o cron entrega o excedente que o webhook fatiou', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta()
  })

  test('§16.1: o excedente reagendado e entregue na varredura seguinte', async () => {
    const doWebhook = new ApiDoCron()
    await processEvents(
      Array.from({ length: 10 }, (_, i) => comentario(i)),
      env,
      AGORA,
      { createApi: () => comoApi(doWebhook), resolveConfig: () => config() },
    )

    // A fatia entregou 5; os outros 5 ficaram esperando.
    expect(
      Object.values(await statusPorComentario()).filter((s) => s === 'retry_pending'),
    ).toHaveLength(5)

    const doCron = new ApiDoCron()
    const contador = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(contador) }, AGORA, {
      createApi: () => comoApi(doCron),
      resolveConfig: () => config(),
    })

    // Nenhum comentario ficou pelo caminho.
    const status = await statusPorComentario()
    expect(Object.keys(status)).toHaveLength(10)
    expect(Object.values(status).filter((s) => s === 'completed')).toHaveLength(10)

    // E a varredura tambem coube no teto: consultas ao D1 e chamadas a Meta
    // dividem os mesmos 50 subrequests por invocacao.
    expect(contador.prepares + doCron.chamadas).toBeLessThan(TETO_DE_SUBREQUESTS)
  })

  test('§16.1: uma varredura cheia (RETRY_BATCH_SIZE) cabe no teto de 50', async () => {
    // Duas invocacoes de webhook enchem a fila com 10 pendentes, que e
    // exatamente o teto por varredura.
    const doWebhook = new ApiDoCron()
    for (const bloco of [0, 1]) {
      await processEvents(
        Array.from({ length: 10 }, (_, i) => comentario(bloco * 10 + i)),
        env,
        AGORA,
        { createApi: () => comoApi(doWebhook), resolveConfig: () => config() },
      )
    }
    expect(
      Object.values(await statusPorComentario()).filter((s) => s === 'retry_pending'),
    ).toHaveLength(10)

    const doCron = new ApiDoCron()
    const contador = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(contador) }, AGORA, {
      createApi: () => comoApi(doCron),
      resolveConfig: () => config(),
    })

    expect(contador.prepares + doCron.chamadas).toBeLessThan(TETO_DE_SUBREQUESTS)
  })
})

describe('§16.3 — a retentativa do cron passa por renderTemplate', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta()
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

    const api = new ApiDoCron()
    await runScheduledTasks(env, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () =>
        config({
          privateReplyText: 'Oi {username}! Link: {link} — de novo: {link}',
          // O caractere de controle no meio e o que o `.replace()` cru deixava
          // passar para dentro da mensagem.
          destinationUrl: 'https://exemplo.com/a b',
        }),
    })

    expect(api.textosEnviados).toEqual([
      'Oi ! Link: https://exemplo.com/ab — de novo: https://exemplo.com/ab',
    ])
  })
})
