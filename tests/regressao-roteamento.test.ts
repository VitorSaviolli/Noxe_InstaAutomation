import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import worker, { processEvents, runScheduledTasks } from '../src/index'
import type { CommentEvent } from '../src/types/meta'
import { ligarConta, limparBanco } from './fixtures/banco'
import {
  AGORA,
  comoApi,
  comoD1,
  configDeTeste,
  D1Contador,
  MetaFalsa,
  MetaQueFalha,
  pedir,
  responder,
  TETO_DE_SUBREQUESTS,
} from './fixtures/dubles'

/**
 * REG — regressao do roteador.
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

describe('REG — o roteador antes do painel', () => {
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

  test('REG-26: /painel e /painel/ levam ao mesmo lugar', async () => {
    const semBarra = await responderComEnv(pedir('/painel'))
    const comBarra = await responderComEnv(pedir('/painel/'))

    expect(comBarra.status).toBe(semBarra.status)
    expect(await comBarra.text()).toBe(await semBarra.text())
  })

  test('REG-27: /health continua com o mesmo corpo', async () => {
    const resposta = await responderComEnv(pedir('/health'))
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

describe('§16.1 — o cron entrega o excedente que o webhook fatiou', () => {
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
    // a conta abaixo mede o LOTE do cron, e nao o tamanho da fila — se alguem
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

    // E a varredura drenou de verdade — nao passou raspando por estar vazia.
    const status = await statusPorComentario()
    expect(Object.values(status).filter((s) => s === 'completed').length).toBeGreaterThan(0)
    expect(Object.values(status).filter((s) => s === 'retry_pending').length).toBeGreaterThan(0)
  })
})

describe('§16.3 — a retentativa do cron passa por renderTemplate', () => {
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
          privateReplyText: 'Oi {username}! Link: {link} — de novo: {link}',
          // O caractere de controle no meio e o que o `.replace()` cru deixava
          // passar para dentro da mensagem.
          destinationUrl: 'https://exemplo.com/a\u0000b',
        }),
    })

    expect(api.textosEnviados).toEqual([
      'Oi ! Link: https://exemplo.com/ab — de novo: https://exemplo.com/ab',
    ])
  })
})

describe('§16.1 — a retentativa do cron tem a mesma escada do caminho inline', () => {
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
