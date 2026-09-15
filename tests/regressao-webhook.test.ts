import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import { type AutomationConfig, automationConfig } from '../src/config'
import { processEvents } from '../src/index'
import { CommentsRepository } from '../src/repositories/comments-repository'
import { readWebhookRequest } from '../src/routes/webhook'
import { evaluateComment, processComment } from '../src/services/automation'
import type { CommentEvent } from '../src/types/meta'
import { ligarConta, limparBanco } from './fixtures/banco'
import {
  AGORA,
  CONFIG_DE_TESTE,
  comoApi,
  comoD1,
  configDeTeste,
  D1BatchQuebrado,
  D1Contador,
  IG_USER_ID,
  MetaFalsa,
  responder,
  TETO_DE_SUBREQUESTS,
  USERNAME_CONTA,
} from './fixtures/dubles'

/**
 * REG, regressao do webhook da Meta.
 *
 * Congela o comportamento de HOJE, antes de existir qualquer linha do painel.
 * O webhook e a unica porta que a Meta usa: ele nao tem cookie, nao tem ficha
 * CSRF, nao tem limitador e nao pode passar a ter. Quando um teste daqui ficar
 * vermelho durante as etapas do painel, isso E a regressao, o sinal para
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

const CORPO_VAZIO = JSON.stringify({ object: 'instagram', entry: [] })

/** O `responder` do fixture, ja com o env desta suite. */
function responderComEnv(request: Request): Promise<Response> {
  return responder(request, env)
}

describe('REG: o webhook da Meta nao tem cookie, ficha CSRF nem limitador', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
  })

  test('REG-01: POST assinado sem cookie e sem ficha CSRF continua 200 EVENT_RECEIVED', async () => {
    const resposta = await responderComEnv(await requisicaoAssinada(CORPO_VAZIO))

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe('EVENT_RECEIVED')
    // E nao devolve cookie nenhum de volta.
    expect(resposta.headers.get('set-cookie')).toBeNull()
  })

  test('REG-02: assinatura invalida continua 401', async () => {
    const resposta = await responderComEnv(
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
    const resposta = await responderComEnv(await requisicaoAssinada(enorme))

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

  test('REG-04b: corpo em stream SEM content-length e cortado DURANTE a leitura', async () => {
    // Um POST `chunked` nao tem `content-length`, entao o portao do REG-04 nao
    // dispara. Antes, `request.text()` lia os 4 MB inteiros e so depois media.
    const PEDACO = 64 * 1024
    const TOTAL = 4 * 1024 * 1024
    let entregues = 0
    const corpo = new ReadableStream<Uint8Array>({
      pull(controle) {
        if (entregues >= TOTAL) {
          controle.close()
          return
        }
        entregues += PEDACO
        controle.enqueue(new Uint8Array(PEDACO).fill(0x61))
      },
    })
    const pedido = new Request(CAMINHO, {
      method: 'POST',
      body: corpo,
      headers: { 'x-hub-signature-256': await assinar('qualquer') },
    })
    expect(pedido.headers.get('content-length')).toBeNull()

    const parsed = await readWebhookRequest(pedido, env)

    expect(parsed).toEqual({ ok: false, status: 413, reason: 'payload_muito_grande' })
    // Parou logo depois do teto, e nao no fim dos 4 MB.
    expect(entregues).toBeLessThan(MAX_BODY_BYTES + 4 * PEDACO)
  })

  test('REG-05: PUT continua 405', async () => {
    const resposta = await responderComEnv(new Request(CAMINHO, { method: 'PUT' }))
    expect(resposta.status).toBe(405)
  })

  test('REG-06: a assinatura continua conferida sobre o corpo CRU', async () => {
    // Mesmo JSON, bytes diferentes: re-serializar invalida o HMAC.
    const original = '{"object":"instagram","entry":[]}'
    const reserializado = JSON.stringify(JSON.parse(original), null, 2)

    const resposta = await responderComEnv(
      requisicao(reserializado, { 'x-hub-signature-256': await assinar(original) }),
    )

    expect(resposta.status).toBe(401)
  })

  test('REG-07: a ordem tamanho -> assinatura -> parse nao mudou', async () => {
    // 1. Tamanho vem antes da assinatura: corpo enorme mal assinado da 413.
    const enorme = `{"recheio":"${'a'.repeat(MAX_BODY_BYTES)}"}`
    const porTamanho = await responderComEnv(
      requisicao(enorme, { 'x-hub-signature-256': await assinar(enorme, 'outro-segredo') }),
    )
    expect(porTamanho.status).toBe(413)

    // 2. Assinatura vem antes do parse: JSON quebrado e bem assinado da 200,
    //    e JSON valido mal assinado da 401.
    const quebrado = 'isto nao e json'
    const porAssinatura = await responderComEnv(await requisicaoAssinada(quebrado))
    expect(porAssinatura.status).toBe(200)

    const jsonValidoMalAssinado = await responderComEnv(
      requisicao(CORPO_VAZIO, { 'x-hub-signature-256': await assinar(CORPO_VAZIO, 'outro') }),
    )
    expect(jsonValidoMalAssinado.status).toBe(401)
  })

  test('REG-08: nenhum limitador e aplicado: 100 POSTs assinados seguidos, todos 200', async () => {
    const pedido = await requisicaoAssinada(CORPO_VAZIO)
    const assinatura = pedido.headers.get('x-hub-signature-256') ?? ''

    const status: number[] = []
    for (let i = 0; i < 100; i++) {
      const resposta = await responderComEnv(
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
 * exatamente estes vereditos, e este e o unico lugar onde eles estao escritos.
 *
 * Os vereditos rodam contra `CONFIG_DE_TESTE`, escrita no proprio fixture, e
 * NAO contra `automationConfig`. Este repositorio e um template publico: trocar
 * a palavra-gatilho, o texto e o link e o uso NORMAL do produto, e um teste que
 * dependesse desses valores ficaria vermelho na maquina de quem instalasse o
 * projeto. De `src/config.ts` a regressao congela a FORMA do contrato, no
 * primeiro teste abaixo.
 */
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

/** `'array'` ou o `typeof` do valor: compara forma sem comparar conteudo. */
function formaDe(valor: unknown): string {
  return Array.isArray(valor) ? 'array' : typeof valor
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
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'segunda palavra-gatilho da lista',
    evento: evento({ text: 'quero o link' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'quero o link' },
  },
  {
    nome: 'maiusculas casam porque caseSensitive e false',
    evento: evento({ text: 'EU QUERO' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'acento casa porque normalizeAccents e true',
    evento: evento({ text: 'eu querô' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'pontuacao casa porque ignorePunctuation e true',
    evento: evento({ text: 'eu quero!!!' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'emoji casa porque simbolo vira espaco',
    evento: evento({ text: 'eu quero 🔥' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'espacos extras casam porque colapsam',
    evento: evento({ text: '  eu    quero  ' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'texto sem a palavra-gatilho',
    evento: evento({ text: 'adorei o video' }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'frase que contem a palavra nao casa em modo exact',
    evento: evento({ text: 'por favor eu quero isso' }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'a mesma frase casa quando o modo e contains',
    evento: evento({ text: 'por favor eu quero isso' }),
    config: configDeTeste({ matchMode: 'contains' }),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'maiusculas nao casam quando caseSensitive e true',
    evento: evento({ text: 'EU QUERO' }),
    config: configDeTeste({ caseSensitive: true }),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'so espacos',
    evento: evento({ text: '   ' }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'sem_correspondencia' },
  },
  {
    nome: 'comentario da propria conta pelo fromId',
    evento: evento({ fromId: IG_USER_ID }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'comentario_proprio' },
  },
  {
    nome: 'comentario da propria conta pelo username',
    evento: evento({ fromUsername: USERNAME_CONTA }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'comentario_proprio' },
  },
  {
    nome: 'resposta dentro de uma thread',
    evento: evento({ parentId: 'comment-pai' }),
    config: configDeTeste(),
    esperado: { process: false, reason: 'resposta_a_comentario' },
  },
  {
    nome: 'automacao desligada vence tudo',
    evento: evento(),
    config: configDeTeste({ enabled: false }),
    esperado: { process: false, reason: 'automacao_desligada' },
  },
  {
    nome: 'midia fora da lista permitida',
    evento: evento({ mediaId: 'media-9' }),
    config: configDeTeste({ allowedMediaIds: ['media-1'] }),
    esperado: { process: false, reason: 'midia_nao_permitida' },
  },
  {
    nome: 'midia dentro da lista permitida',
    evento: evento({ mediaId: 'media-1' }),
    config: configDeTeste({ allowedMediaIds: ['media-1'] }),
    esperado: { process: true, keyword: 'eu quero' },
  },
  {
    nome: 'link ainda com o placeholder entre colchetes',
    evento: evento(),
    config: configDeTeste({ destinationUrl: '[QUALQUER_COISA_ENTRE_COLCHETES]' }),
    esperado: { process: false, reason: 'link_nao_configurado' },
  },
  {
    nome: 'username vazio nao confunde o anti-loop',
    evento: evento({ fromUsername: '' }),
    config: configDeTeste(),
    esperado: { process: true, keyword: 'eu quero' },
  },
]

describe('REG-09: a tabela de decisao de evaluateComment', () => {
  test('REG-09: a FORMA do contrato de config nao mudou', () => {
    // Os VALORES sao de quem instalou o projeto e mudam a cada clone. O que nao
    // pode mudar sem que os 20 vereditos abaixo parem de descrever o produto e
    // a forma: os mesmos campos, com os mesmos tipos, e `matchMode` dentro do
    // conjunto valido.
    expect(Object.keys(automationConfig).sort()).toEqual(Object.keys(CONFIG_DE_TESTE).sort())

    for (const chave of Object.keys(CONFIG_DE_TESTE) as (keyof AutomationConfig)[]) {
      expect({ [chave]: formaDe(automationConfig[chave]) }).toEqual({
        [chave]: formaDe(CONFIG_DE_TESTE[chave]),
      })
    }

    expect(['exact', 'contains']).toContain(automationConfig.matchMode)
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

describe('REG-10: o webhook nao depende da listagem de midias', () => {
  test('REG-10: com allowedMediaIds ["*"], um media_id nunca visto e aceito', () => {
    const veredito = evaluateComment(
      evento({ mediaId: '17999999999999999' }),
      configDeTeste(),
      IG_USER_ID,
      USERNAME_CONTA,
    )

    expect(veredito).toEqual({ process: true, keyword: 'eu quero' })
  })

  test('REG-10: entregar um comentario de midia desconhecida nao consulta listagem alguma', async () => {
    await limparBanco(env.DB)
    const api = new MetaFalsa()

    const resultado = await processComment(evento({ mediaId: '17999999999999999' }), {
      api: comoApi(api),
      repo: new CommentsRepository(env.DB),
      igUserId: IG_USER_ID,
      accountUsername: USERNAME_CONTA,
      config: configDeTeste(),
      now: AGORA,
    })

    expect(resultado.kind).toBe('completed')
    // Nem `getMediaInfo` (o tipo da midia veio no proprio webhook) nem
    // qualquer outra consulta a Meta alem do Direct e da resposta publica.
    expect(api.chamadas).toEqual(['private', 'public'])
  })
})

/**
 * §16.1, o lote do webhook cabe nas 50 consultas por invocacao.
 *
 * Bug PRE-EXISTENTE, independente do painel: cada comentario entregue custa 5
 * consultas ao D1 e o lote custa outras 2, entao `10 x 5 + 2 = 52` estourava o
 * teto de 50 subrequests por invocacao e a invocacao inteira morria, com o
 * lote grande de um Reel viral, que e exatamente quando o dano e maior.
 *
 * A correcao fatia o lote e passa o excedente para a fila que o cron ja varre.
 * O teto NAO e imposto pelo Miniflare (§13.3), entao contar as consultas com o
 * `D1Contador` e a melhor aproximacao disponivel, e ela e conservadora: cada
 * statement preparado conta, mesmo os que depois viajam juntos num `db.batch()`
 * que vale um subrequest so.
 */
const CONFIG_DO_LOTE = configDeTeste()

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

/** Roda `processEvents` contando o que ele gasta no D1, sem tocar a rede. */
async function processarContando(
  events: readonly CommentEvent[],
  api: MetaFalsa,
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

describe('§16.1: o lote do webhook cabe nas 50 consultas por invocacao', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    await ligarConta(env, AGORA)
  })

  test('§16.1: um lote de 10 comentarios executa menos de 50 consultas', async () => {
    const contador = await processarContando(loteDe(10), new MetaFalsa())

    expect(contador.prepares).toBeLessThan(TETO_DE_SUBREQUESTS)

    // E a conta fechada, para a folga ficar visivel em vez de implicita:
    // 2 do lote (token da conta e credencial) + 5 entregues x 5 consultas
    // + 5 reagendados. Os 5 reagendados viajam num `db.batch()` unico, que
    // vale 1 subrequest, o gasto real e 28, o contado e 32.
    expect({ prepares: contador.prepares, batches: contador.batches }).toEqual({
      prepares: 2 + 5 * 5 + 5,
      batches: 1,
    })
  })

  test('§16.1: nenhum comentario do lote se perde: o excedente vira fila do cron', async () => {
    const api = new MetaFalsa()

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
    const api = new MetaFalsa()
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
    const api = new MetaFalsa()
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

  test('§16.1: o excedente sem tipo de midia confirmado NAO e reagendado', async () => {
    const api = new MetaFalsa()
    const semTipo = evento({
      commentId: 'comment-sem-tipo',
      fromId: 'igsid-sem-tipo',
      mediaProductType: null,
    })

    await processarContando([...loteDe(5), semTipo], api)

    // `retryPending` entrega sem consultar nada: reagendar sem saber o tipo
    // mandaria o Direct numa publicacao que talvez nem seja Reel. Na duvida
    // nao processamos, a mesma escolha do caminho inline.
    const ids = (await linhasDoBanco()).map((l) => l.comment_id)
    expect(ids).not.toContain('comment-sem-tipo')
  })

  test('§16.1: sem processOnlyReels, o excedente sem tipo de midia e reagendado', async () => {
    const api = new MetaFalsa()
    const semTipo = evento({
      commentId: 'comment-sem-tipo',
      fromId: 'igsid-sem-tipo',
      mediaProductType: null,
    })

    // O contrapositivo: o portao e sobre o Reel, e nao um bloqueio cego.
    await processarContando(
      [...loteDe(5), semTipo],
      api,
      configDeTeste({ processOnlyReels: false }),
    )

    const ids = (await linhasDoBanco()).map((l) => l.comment_id)
    expect(ids).toContain('comment-sem-tipo')
  })

  test('§16.1: o cooldown do excedente atravessa invocacoes, nao so o lote', async () => {
    const autor = { fromId: 'igsid-teimoso', fromUsername: 'teimoso' }

    // Primeira invocacao: o comentario do autor cai no excedente e e reagendado.
    await processarContando(
      [...loteDe(5, 'a'), evento({ commentId: 'comment-teimoso-1', ...autor })],
      new MetaFalsa(),
    )

    // Segunda invocacao, ANTES de o cron rodar: o mesmo autor volta. A linha
    // `retry_pending` da primeira e um Direct prometido, reagendar de novo
    // renderia dois Directs para a mesma pessoa.
    await processarContando(
      [...loteDe(5, 'b'), evento({ commentId: 'comment-teimoso-2', ...autor })],
      new MetaFalsa(),
    )

    const ids = (await linhasDoBanco()).map((l) => l.comment_id)
    expect(ids.filter((id) => id.startsWith('comment-teimoso-'))).toEqual(['comment-teimoso-1'])
  })

  test('§16.1: falha ao reagendar vira erro registrado, e nao rejeicao silenciosa', async () => {
    const api = new MetaFalsa()

    // `processEvents` roda dentro de `ctx.waitUntil`: uma rejeicao aqui sumiria
    // sem log nenhum, levando junto o excedente inteiro.
    const promessa = processEvents(
      loteDe(10),
      { ...env, DB: new D1BatchQuebrado(env.DB) as unknown as D1Database },
      AGORA,
      { createApi: () => comoApi(api), resolveConfig: () => CONFIG_DO_LOTE },
    )

    await expect(promessa).resolves.toBeUndefined()
    // E a fatia que ja tinha sido entregue continua entregue.
    expect(api.chamadas.filter((c) => c === 'private')).toHaveLength(5)
  })

  test('D1 fora do ar ANTES do laco vira erro registrado, e nao rejeicao silenciosa', async () => {
    const api = new MetaFalsa()
    const d1Fora = {
      prepare() {
        throw new Error('D1 indisponivel')
      },
    } as unknown as D1Database

    // A leitura da conta e a primeira coisa do lote. Antes ela ficava fora de
    // qualquer `try`, e a rejeicao sumia dentro do `waitUntil`.
    const promessa = processEvents(loteDe(3), { ...env, DB: d1Fora }, AGORA, {
      createApi: () => comoApi(api),
      resolveConfig: () => CONFIG_DO_LOTE,
    })

    await expect(promessa).resolves.toBeUndefined()
    expect(api.chamadas).toHaveLength(0)
  })

  test('§16.1: dois comentarios do mesmo autor no excedente viram um so', async () => {
    const api = new MetaFalsa()
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
    const api = new MetaFalsa()
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
