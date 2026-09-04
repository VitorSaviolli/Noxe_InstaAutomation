import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import worker, { processEvents } from '../src/index'
import { CommentsRepository } from '../src/repositories/comments-repository'
import { readWebhookRequest } from '../src/routes/webhook'
import { evaluateComment, processComment } from '../src/services/automation'
import type { MetaApiClient } from '../src/services/meta-api'
import { storeAccessToken } from '../src/services/token-manager'
import type { CommentEvent } from '../src/types/meta'
import { limparBanco } from './fixtures/banco'
import { comoD1, D1Contador } from './fixtures/dubles'

/**
 * REG — regressao do webhook da Meta.
 *
 * Congela o comportamento de HOJE, antes de existir qualquer linha do painel.
 * O webhook e a unica porta que a Meta usa: ele nao tem cookie, nao tem ficha
 * CSRF, nao tem limitador e nao pode passar a ter. Quando um teste daqui ficar
 * vermelho durante as etapas do painel, isso E a regressao — o sinal para
 * parar, nao para ajustar o teste.
 */

const APP_SECRET = 'segredo-de-teste'
const CAMINHO = 'https://exemplo.workers.dev/webhooks/instagram'

/** O mesmo teto que `readWebhookRequest` aplica hoje. */
const MAX_BODY_BYTES = 512 * 1024

/** Calcula a assinatura que a Meta enviaria para um corpo. */
async function assinar(corpo: string, segredo = APP_SECRET): Promise<string> {
  const chave = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpo))
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

/** POST no webhook com os cabecalhos informados e NADA alem deles. */
function requisicao(corpo: string, cabecalhos: Record<string, string> = {}): Request {
  return new Request(CAMINHO, { method: 'POST', body: corpo, headers: cabecalhos })
}

/** POST ja assinado, sem cookie e sem ficha CSRF. */
async function requisicaoAssinada(corpo: string): Promise<Request> {
  return requisicao(corpo, {
    'content-type': 'application/json',
    'x-hub-signature-256': await assinar(corpo),
  })
}

async function responder(request: Request): Promise<Response> {
  const ctx = createExecutionContext()
  const resposta = await worker.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  return resposta
}

const CORPO_VAZIO = JSON.stringify({ object: 'instagram', entry: [] })

describe('REG — o webhook da Meta nao tem cookie, ficha CSRF nem limitador', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-01: POST assinado sem cookie e sem ficha CSRF continua 200 EVENT_RECEIVED', async () => {
    const resposta = await responder(await requisicaoAssinada(CORPO_VAZIO))

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe('EVENT_RECEIVED')
    // E nao devolve cookie nenhum de volta.
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })

  test('REG-02: assinatura invalida continua 401', async () => {
    const resposta = await responder(
      requisicao(CORPO_VAZIO, {
        'content-type': 'application/json',
        'x-hub-signature-256': await assinar(CORPO_VAZIO, 'outro-segredo'),
      }),
    )

    expect(resposta.status).toBe(401)
    expect(await resposta.text()).toBe('assinatura_invalida')
  })

  test('REG-03: corpo acima de 512 KB continua 413 mesmo com assinatura valida', async () => {
    const enorme = `{"recheio":"${'a'.repeat(MAX_BODY_BYTES)}"}`
    const resposta = await responder(await requisicaoAssinada(enorme))

    expect(resposta.status).toBe(413)
  })

  test('REG-04: content-length mentiroso continua 413 antes de ler o corpo', async () => {
    const pedido = requisicao(CORPO_VAZIO, {
      'content-type': 'application/json',
      'content-length': String(MAX_BODY_BYTES + 1),
      'x-hub-signature-256': await assinar(CORPO_VAZIO),
    })

    const parsed = await readWebhookRequest(pedido, env)

    expect(parsed).toEqual({ ok: false, status: 413, reason: 'payload_muito_grande' })
    // A prova de que o corte veio ANTES de ler: o corpo continua intocado.
    expect(pedido.bodyUsed).toBe(false)
  })

  test('REG-05: PUT continua 405', async () => {
    const resposta = await responder(new Request(CAMINHO, { method: 'PUT' }))
    expect(resposta.status).toBe(405)
  })

  test('REG-06: a assinatura continua conferida sobre o corpo CRU', async () => {
    // Mesmo JSON, bytes diferentes: re-serializar invalida o HMAC.
    const original = '{"object":"instagram","entry":[]}'
    const reserializado = JSON.stringify(JSON.parse(original), null, 2)

    const resposta = await responder(
      requisicao(reserializado, { 'x-hub-signature-256': await assinar(original) }),
    )

    expect(resposta.status).toBe(401)
  })

  test('REG-07: a ordem tamanho -> assinatura -> parse nao mudou', async () => {
    // 1. Tamanho vem antes da assinatura: corpo enorme mal assinado da 413.
    const enorme = `{"recheio":"${'a'.repeat(MAX_BODY_BYTES)}"}`
    const porTamanho = await responder(
      requisicao(enorme, { 'x-hub-signature-256': await assinar(enorme, 'outro-segredo') }),
    )
    expect(porTamanho.status).toBe(413)

    // 2. Assinatura vem antes do parse: JSON quebrado e bem assinado da 200,
    //    e JSON valido mal assinado da 401.
    const quebrado = 'isto nao e json'
    const porAssinatura = await responder(await requisicaoAssinada(quebrado))
    expect(porAssinatura.status).toBe(200)

    const jsonValidoMalAssinado = await responder(
      requisicao(CORPO_VAZIO, { 'x-hub-signature-256': await assinar(CORPO_VAZIO, 'outro') }),
    )
    expect(jsonValidoMalAssinado.status).toBe(401)
  })

  test('REG-08: nenhum limitador e aplicado — 100 POSTs assinados seguidos, todos 200', async () => {
    const pedido = await requisicaoAssinada(CORPO_VAZIO)
    const assinatura = pedido.headers.get('x-hub-signature-256') ?? ''

    const status: number[] = []
    for (let i = 0; i < 100; i++) {
      const resposta = await responder(
        requisicao(CORPO_VAZIO, { 'x-hub-signature-256': assinatura }),
      )
      status.push(resposta.status)
    }

    expect(status.filter((s) => s === 200)).toHaveLength(100)
  })
})

/**
 * REG-09 congela a TABELA DE DECISAO de `evaluateComment`.
 *
 * Quando a configuracao passar a vir do banco, a tabela vazia precisa produzir
 * exatamente estes vereditos — e este e o unico lugar onde eles estao escritos.
 *
 * `destinationUrl` e `privateReplyText` ficam de fora do congelamento: sao os
 * dois campos que quem instala o projeto TROCA em `src/config.ts`, e um teste
 * que dependesse deles falharia em toda instalacao real.
 */
const LINK_DE_TESTE = 'https://exemplo.com/link'
const IG_USER_ID = '17841400000000000'
const USERNAME_CONTA = 'conta_de_teste'

function base(patch: Partial<AutomationConfig> = {}): AutomationConfig {
  return { ...automationConfig, destinationUrl: LINK_DE_TESTE, ...patch }
}

function evento(patch: Partial<CommentEvent> = {}): CommentEvent {
  return {
    commentId: 'comment-1',
    mediaId: 'media-1',
    fromId: 'igsid-visitante',
    fromUsername: 'visitante',
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
    ...patch,
  }
}

const AGORA = 1_700_000_000_000

/**
 * Duble da API da Meta. Registra as chamadas na ordem em que ocorrem, que e o
 * que permite provar que nenhuma consulta extra entrou no caminho do webhook.
 */
class ApiFalsa {
  readonly chamadas: string[] = []
  readonly textosEnviados: string[] = []

  async sendPrivateReply(_ig: string, _comment: string, text: string) {
    this.chamadas.push('private')
    this.textosEnviados.push(text)
    return { ok: true as const, data: { message_id: 'msg-1' } }
  }

  async replyToComment(_comment: string, _message: string) {
    this.chamadas.push('public')
    return { ok: true as const, data: { id: 'reply-1' } }
  }

  async getMediaInfo(_mediaId: string) {
    this.chamadas.push('mediaInfo')
    return { ok: true as const, data: { id: 'media-1', media_product_type: 'REELS' } }
  }
}

function comoApi(falsa: ApiFalsa): MetaApiClient {
  return falsa as unknown as MetaApiClient
}

type Veredito = ReturnType<typeof evaluateComment>

interface Caso {
  nome: string
  evento: CommentEvent
  config: AutomationConfig
  esperado: Veredito
}

const CASOS: Caso[] = [
  {
    nome: 'palavra-gatilho exata',
    evento: evento(),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'segunda palavra-gatilho da lista',
    evento: evento({ text: 'quero o link' }),
    config: base(),
    esperado: { process: true, keyword: 'quero o link' },
  },
  {
    nome: 'maiusculas casam porque caseSensitive e false',
    evento: evento({ text: 'EU QUERO' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'acento casa porque normalizeAccents e true',
    evento: evento({ text: 'eu querô' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'pontuacao casa porque ignorePunctuation e true',
    evento: evento({ text: 'eu quero!!!' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'emoji casa porque simbolo vira espaco',
    evento: evento({ text: 'eu quero 🔥' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'espacos extras casam porque colapsam',
    evento: evento({ text: '  eu    quero  ' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'texto sem a palavra-gatilho',
    evento: evento({ text: 'adorei o video' }),
    config: base(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'frase que contem a palavra nao casa em modo exact',
    evento: evento({ text: 'por favor eu quero isso' }),
    config: base(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'a mesma frase casa quando o modo e contains',
    evento: evento({ text: 'por favor eu quero isso' }),
    config: base({ matchMode: 'contains' }),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'maiusculas nao casam quando caseSensitive e true',
    evento: evento({ text: 'EU QUERO' }),
    config: base({ caseSensitive: true }),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'so espacos',
    evento: evento({ text: '   ' }),
    config: base(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'comentario da propria conta pelo fromId',
    evento: evento({ fromId: IG_USER_ID }),
    config: base(),
    esperado: { process: false, reason: 'comentario_proprio' },
  },
  {
    nome: 'comentario da propria conta pelo username',
    evento: evento({ fromUsername: USERNAME_CONTA }),
    config: base(),
    esperado: { process: false, reason: 'comentario_proprio' },
  },
  {
    nome: 'resposta dentro de uma thread',
    evento: evento({ parentId: 'comment-pai' }),
    config: base(),
    esperado: { process: false, reason: 'resposta_a_comentario' },
  },
  {
    nome: 'automacao desligada vence tudo',
    evento: evento(),
    config: base({ enabled: false }),
    esperado: { process: false, reason: 'automacao_desligada' },
  },
  {
    nome: 'midia fora da lista permitida',
    evento: evento({ mediaId: 'media-9' }),
    config: base({ allowedMediaIds: ['media-1'] }),
    esperado: { process: false, reason: 'midia_nao_permitida' },
  },
  {
    nome: 'midia dentro da lista permitida',
    evento: evento({ mediaId: 'media-1' }),
    config: base({ allowedMediaIds: ['media-1'] }),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'link ainda com o placeholder entre colchetes',
    evento: evento(),
    config: base({ destinationUrl: '[COLOQUE_O_SEU_LINK_AQUI]' }),
    esperado: { process: false, reason: 'link_nao_configurado' },
  },
  {
    nome: 'username vazio nao confunde o anti-loop',
    evento: evento({ fromUsername: '' }),
    config: base(),
    esperado: { process: true, keyword: 'eu quero' },
  },
]

describe('REG-09 — a tabela de decisao de evaluateComment', () => {
  test('REG-09: a config de fabrica que a tabela congela nao mudou', () => {
    // Se algum destes campos mudar em src/config.ts, os 20 vereditos abaixo
    // deixam de descrever o produto — e a falha precisa apontar para aqui.
    expect({
      enabled: automationConfig.enabled,
      triggerKeywords: automationConfig.triggerKeywords,
      matchMode: automationConfig.matchMode,
      caseSensitive: automationConfig.caseSensitive,
      normalizeAccents: automationConfig.normalizeAccents,
      ignorePunctuation: automationConfig.ignorePunctuation,
      allowedMediaIds: automationConfig.allowedMediaIds,
    }).toEqual({
      enabled: true,
      triggerKeywords: ['eu quero', 'quero o link'],
      matchMode: 'exact',
      caseSensitive: false,
      normalizeAccents: true,
      ignorePunctuation: true,
      allowedMediaIds: ['*'],
    })
  })

  test('REG-09: sao 20 eventos, e nao menos', () => {
    expect(CASOS).toHaveLength(20)
  })

  for (const caso of CASOS) {
    test(`REG-09: ${caso.nome}`, () => {
      expect(evaluateComment(caso.evento, caso.config, IG_USER_ID, USERNAME_CONTA)).toEqual(
        caso.esperado,
      )
    })
  }
})

describe('REG-10 — o webhook nao depende da listagem de midias', () => {
  test('REG-10: com allowedMediaIds ["*"], um media_id nunca visto e aceito', () => {
    const veredito = evaluateComment(
      evento({ mediaId: '17999999999999999' }),
      base(),
      IG_USER_ID,
      USERNAME_CONTA,
    )

    expect(veredito).toEqual({ process: true, keyword: 'eu quero' })
  })

  test('REG-10: entregar um comentario de midia desconhecida nao consulta listagem alguma', async () => {
    await limparBanco(env.DB)
    const api = new ApiFalsa()

    const resultado = await processComment(evento({ mediaId: '17999999999999999' }), {
      api: comoApi(api),
      repo: new CommentsRepository(env.DB),
      igUserId: IG_USER_ID,
      accountUsername: USERNAME_CONTA,
      config: base(),
      now: AGORA,
    })

    expect(resultado.kind).toBe('completed')
    // Nem `getMediaInfo` (o tipo da midia veio no proprio webhook) nem
    // qualquer outra consulta a Meta alem do Direct e da resposta publica.
    expect(api.chamadas).toEqual(['private', 'public'])
  })
})

/**
 * §16.1 — o lote do webhook cabe nas 50 consultas por invocacao.
 *
 * Bug PRE-EXISTENTE, independente do painel: cada comentario entregue custa 5
 * consultas ao D1 e o lote custa outras 2, entao `10 x 5 + 2 = 52` estourava o
 * teto de 50 subrequests por invocacao e a invocacao inteira morria — com o
 * lote grande de um Reel viral, que e exatamente quando o dano e maior.
 *
 * A correcao fatia o lote e passa o excedente para a fila que o cron ja varre.
 * O teto NAO e imposto pelo Miniflare (§13.3), entao contar as consultas com o
 * `D1Contador` e a melhor aproximacao disponivel — e ela e conservadora: cada
 * statement preparado conta, mesmo os que depois viajam juntos num `db.batch()`
 * que vale um subrequest so.
 */
const TETO_DE_SUBREQUESTS = 50

/** Config do lote: link de teste, para nao depender do `src/config.ts` de quem clonou. */
const CONFIG_DO_LOTE = base()

/** N comentarios acionaveis, cada um de um autor diferente. */
function loteDe(quantos: number, prefixo = 'lote'): CommentEvent[] {
  return Array.from({ length: quantos }, (_, i) =>
    evento({
      commentId: `comment-${prefixo}-${i}`,
      fromId: `igsid-${prefixo}-${i}`,
      fromUsername: `visitante-${prefixo}-${i}`,
    }),
  )
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

/** Roda `processEvents` contando o que ele gasta no D1, sem tocar a rede. */
async function processarContando(
  events: readonly CommentEvent[],
  api: ApiFalsa,
  config: AutomationConfig = CONFIG_DO_LOTE,
): Promise<D1Contador> {
  const contador = new D1Contador(env.DB)
  await processEvents(events, { ...env, DB: comoD1(contador) }, AGORA, {
    createApi: () => comoApi(api),
    resolveConfig: () => config,
  })
  return contador
}

interface LinhaDoBanco {
  comment_id: string
  status: string
}

async function linhasDoBanco(): Promise<LinhaDoBanco[]> {
  const resultado = await env.DB.prepare(
    'SELECT comment_id, status FROM processed_comments ORDER BY comment_id',
  ).all<LinhaDoBanco>()
  return resultado.results ?? []
}

describe('§16.1 — o lote do webhook cabe nas 50 consultas por invocacao', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta()
  })

  test('§16.1: um lote de 10 comentarios executa menos de 50 consultas', async () => {
    const contador = await processarContando(loteDe(10), new ApiFalsa())

    expect(contador.prepares).toBeLessThan(TETO_DE_SUBREQUESTS)

    // E a conta fechada, para a folga ficar visivel em vez de implicita:
    // 2 do lote (token da conta e credencial) + 5 entregues x 5 consultas
    // + 5 reagendados. Os 5 reagendados viajam num `db.batch()` unico, que
    // vale 1 subrequest — o gasto real e 28, o contado e 32.
    expect({ prepares: contador.prepares, batches: contador.batches }).toEqual({
      prepares: 2 + 5 * 5 + 5,
      batches: 1,
    })
  })

  test('§16.1: nenhum comentario do lote se perde — o excedente vira fila do cron', async () => {
    const api = new ApiFalsa()

    await processarContando(loteDe(10), api)

    // A fatia da invocacao: so estes receberam Direct e resposta publica agora.
    expect(api.chamadas.filter((c) => c === 'private')).toHaveLength(5)
    expect(api.chamadas.filter((c) => c === 'public')).toHaveLength(5)

    const linhas = await linhasDoBanco()
    expect(linhas).toHaveLength(10)
    expect(linhas.filter((l) => l.status === 'completed')).toHaveLength(5)
    // O resto esperando o cron, que ja varre exatamente este status.
    expect(linhas.filter((l) => l.status === 'retry_pending')).toHaveLength(5)
  })

  test('§16.1: o excedente que hoje seria ignorado NAO e reagendado', async () => {
    const api = new ApiFalsa()
    const inertes = Array.from({ length: 5 }, (_, i) =>
      evento({
        commentId: `comment-inerte-${i}`,
        fromId: `igsid-inerte-${i}`,
        text: 'adorei o video',
      }),
    )

    await processarContando([...loteDe(5), ...inertes], api)

    // Reagendar um comentario sem palavra-gatilho faria o cron mandar Direct
    // para quem nunca pediu nada: o portao de `evaluateComment` vale tambem
    // para o excedente.
    const linhas = await linhasDoBanco()
    expect(linhas.map((l) => l.comment_id)).toEqual(loteDe(5).map((e) => e.commentId))
  })

  test('§16.1: o excedente respeita o cooldown do autor', async () => {
    const api = new ApiFalsa()
    const fatia = loteDe(5)
    const autorRepetido = evento({
      commentId: 'comment-repetido',
      // O mesmo autor do primeiro comentario da fatia, que ja foi atendido.
      fromId: 'igsid-lote-0',
      fromUsername: 'visitante-lote-0',
    })
    const autorNovo = evento({ commentId: 'comment-novo', fromId: 'igsid-novo' })

    await processarContando([...fatia, autorRepetido, autorNovo], api)

    const ids = (await linhasDoBanco()).map((l) => l.comment_id)
    expect(ids).toContain('comment-novo')
    expect(ids).not.toContain('comment-repetido')
  })

  test('§16.1: dois comentarios do mesmo autor no excedente viram um so', async () => {
    const api = new ApiFalsa()
    const doMesmoAutor = [0, 1].map((i) =>
      evento({ commentId: `comment-gemeo-${i}`, fromId: 'igsid-gemeo', fromUsername: 'gemeo' }),
    )

    await processarContando([...loteDe(5), ...doMesmoAutor], api)

    // Hoje o segundo cai em `usuario_em_cooldown` e nao vira linha; o
    // reagendamento nao pode furar isso so porque os dois entram no mesmo lote.
    const ids = (await linhasDoBanco()).map((l) => l.comment_id)
    expect(ids.filter((id) => id.startsWith('comment-gemeo-'))).toEqual(['comment-gemeo-0'])
  })

  test('§16.1: o excedente ja registrado nao vira linha nova nem sobrescreve status', async () => {
    const api = new ApiFalsa()
    const fatia = loteDe(5)
    const repetido = evento({ commentId: 'comment-lote-0', fromId: 'igsid-outro' })

    // O mesmo `comment_id` que a fatia acabou de completar volta no excedente:
    // o webhook reentregue nao pode ressuscitar o comentario como pendente.
    await processarContando([...fatia, repetido], api)

    const linhas = await linhasDoBanco()
    expect(linhas).toHaveLength(5)
    expect(linhas.find((l) => l.comment_id === 'comment-lote-0')?.status).toBe('completed')
  })
})
