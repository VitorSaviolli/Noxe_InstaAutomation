import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeEach, describe, expect, test } from 'vitest'
import formularioDoAsset from '../public/painel/parar/index.html?raw'
import worker, { runScheduledTasks } from '../src/index'
import { PainelAuditoriaRepository } from '../src/repositories/painel-auditoria-repository'
import {
  type LinhaDeFabrica,
  PainelConfigRepository,
} from '../src/repositories/painel-config-repository'
import {
  CAMINHO_DA_PARADA,
  CAMINHO_DO_FORMULARIO,
  handleFormularioDeParada,
  handleGerarCodigos,
  handleParada,
  PAGINA_DO_FORMULARIO,
  TETO_DO_CORPO_DA_PARADA,
} from '../src/routes/painel/parada'
import { timingSafeEqual } from '../src/security/constant-time'
import { evaluateComment } from '../src/services/automation'
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../src/services/config-store'
import {
  ALFABETO_DOS_CODIGOS,
  CODIGOS_DE_RECUPERACAO,
  COMPARADOR_PADRAO,
  formatarCodigo,
  normalizarCodigo,
  sortearCodigo,
  TAMANHO_DO_CODIGO,
} from '../src/services/panel-codes'
import type { Env } from '../src/types/env'
import type { CommentEvent } from '../src/types/meta'
import { gravarConfig, LINHA_DE_CONFIG_VALIDA, limparBanco } from './fixtures/banco'
import {
  AGORA,
  capturarConsole,
  comoD1,
  D1BatchQuebrado,
  D1Contador,
  D1SegundoBatchQuebrado,
  IG_USER_ID,
  RAIZ,
} from './fixtures/dubles'

/**
 * STOP — a parada de emergencia (§13.2, 14 garantias).
 *
 * Esta suite congela a rota que §10.12 chama de "a ultima que precisa
 * funcionar": ela desliga a automacao sem sessao, sem `rpId` e sem WebAuthn,
 * e nao pode nem revelar se existe codigo cadastrado.
 *
 * `now` e sempre injetado. Os testes que exercitam o ROTEADOR passam por
 * `worker.fetch` (e ai o relogio e o real, entao nenhum deles afirma
 * carimbo de tempo); todos os outros chamam os handlers exportados direto.
 */

/** O mesmo valor ficticio do `vitest.config.ts`. */
const ADMIN = 'admin-token-de-teste'

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

interface ConjuntoDeCodigos {
  recuperacao: string[]
  parada: string
}

/** Roda `POST /setup/painel/codigos` e devolve os codigos em claro. */
async function gerarCodigos(ambiente: Env = env): Promise<ConjuntoDeCodigos> {
  const resposta = await handleGerarCodigos(
    new Request(`${RAIZ}/setup/painel/codigos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}` },
    }),
    ambiente,
    AGORA,
  )

  expect(resposta.status).toBe(200)
  return (await resposta.json()) as ConjuntoDeCodigos
}

/**
 * As tres paginas, escritas AQUI de novo, byte a byte.
 *
 * A duplicacao e o teste: §10.12 fixa o "texto integral da pagina" das tres
 * respostas, e comparar com uma constante importada de `parada.ts` provaria
 * apenas que o arquivo e igual a ele mesmo.
 */
function paginaEsperada(frase: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parada de emergencia</title>
</head>
<body>
<h1>${frase}</h1>
</body>
</html>
`
}

const PAGINA_PARADA = paginaEsperada('Pronto. A automação está desligada.')
const PAGINA_CODIGO_INCORRETO = paginaEsperada('Esse código não confere. Confira e digite de novo.')
const PAGINA_INDISPONIVEL = paginaEsperada(
  'Não foi possível confirmar agora. Em caso de erro a automação para sozinha.',
)

/** A linha global, do jeito que o banco a guarda. */
async function linhaDeConfig() {
  return env.DB.prepare(
    'SELECT enabled, versao, parado_por_codigo_em FROM painel_config WHERE id = 1',
  ).first<{ enabled: number; versao: number; parado_por_codigo_em: number | null }>()
}

/** Todas as linhas de auditoria, da mais antiga para a mais nova. */
async function linhasDeAuditoria() {
  const resultado = await env.DB.prepare(
    'SELECT ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois ' +
      'FROM painel_auditoria ORDER BY id',
  ).all<Record<string, unknown>>()

  return resultado.results ?? []
}

/**
 * D1 que estoura em toda consulta preparada.
 *
 * Classe local injetada por parametro, como todo duble deste projeto — nada de
 * mock de modulo. Prova a TERCEIRA resposta de §10.12.
 */
class D1ForaDoAr {
  prepare(_sql: string): D1PreparedStatement {
    throw new Error('D1 fora do ar')
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.reject(new Error('D1 fora do ar'))
  }

  exec(_query: string): Promise<D1ExecResult> {
    return Promise.reject(new Error('D1 fora do ar'))
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('D1 fora do ar'))
  }
}

/**
 * Corpo `chunked` que entrega pedacos sob demanda e CONTA quantos entregou.
 *
 * A contagem e a prova de que o teto de 1 KB corta durante a leitura: um
 * leitor que bufferiza o corpo inteiro antes de medir puxa os 40 pedacos, um
 * que corta no caminho puxa meia duzia.
 */
class CorpoEmPedacos {
  entregues = 0

  constructor(
    private readonly pedacos: number,
    private readonly tamanho: number,
  ) {}

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      pull: (controlador) => {
        if (this.entregues >= this.pedacos) {
          controlador.close()
          return
        }
        this.entregues++
        controlador.enqueue(new Uint8Array(this.tamanho).fill(0x78))
      },
    })
  }
}

/**
 * Os cabecalhos de pagina de §11.5, escritos AQUI de novo, valor a valor.
 *
 * A duplicacao e o teste, pelo mesmo motivo das tres paginas: importar a
 * constante de `parada.ts` provaria apenas que o arquivo e igual a ele mesmo.
 * `form-action 'self'` e a linha que mais importa — a pagina do formulario e
 * onde a pessoa digita o codigo, e e ela que impede um `action` reescrito de
 * postar o codigo para fora. A etapa 9 move isto para `html.ts`; este mapa e o
 * que torna aquele refactor visivel.
 */
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

/** O mapa de cabecalhos de uma resposta, em minusculas, como o teste compara. */
function cabecalhosDe(resposta: Response): Record<string, string> {
  return Object.fromEntries(resposta.headers)
}

/** Comparador duble: registra o que foi comparado e responde o que mandarem. */
class ComparadorFalso {
  readonly comparacoes: Array<[string, string]> = []

  constructor(private readonly resposta: boolean) {}

  readonly comparar = (a: string, b: string): boolean => {
    this.comparacoes.push([a, b])
    return this.resposta
  }
}

/** Um comentario que aciona a automacao com a config de `gravarConfig`. */
function comentarioQueAciona(): CommentEvent {
  return {
    commentId: 'comment-stop-1',
    mediaId: '17900000000000001',
    fromId: 'igsid-stop-1',
    fromUsername: 'visitante',
    text: 'eu quero',
    parentId: null,
    mediaProductType: 'REELS',
  }
}

describe('STOP — a parada de emergencia', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
  })

  test('STOP-01: codigo correto via POST desliga a automacao sem sessao', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // Nenhum cookie na requisicao: a rota nao depende de sessao nenhuma.
    const requisicao = postDaParada(comOCodigo(parada))
    expect(requisicao.headers.get('cookie')).toBeNull()

    const contador = new D1Contador(env.DB)
    const resposta = await handleParada(requisicao, { ...env, DB: comoD1(contador) }, AGORA)

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe(PAGINA_PARADA)
    // E nao emite sessao nenhuma de volta: parar nao e entrar.
    expect(resposta.headers.get('set-cookie')).toBeNull()

    // A contabilidade do caminho de SUCESSO, que e a que faltava (§9.10):
    // duas leituras (hashes vivos, estado da automacao) e duas escritas (o
    // `UPDATE` e a linha de auditoria) dentro de UM unico `db.batch()`.
    expect({
      prepares: contador.prepares,
      escritas: contador.escritas,
      batches: contador.batches,
    }).toEqual({ prepares: 4, escritas: 2, batches: 1 })

    expect(await linhaDeConfig()).toEqual({
      enabled: 0,
      versao: 2,
      parado_por_codigo_em: AGORA,
    })
  })

  test('STOP-01: a parada grava em UM lote so — o segundo batch() nao existe', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // O contador acima diz `batches: 1`, mas contagem sozinha nao separa "um
    // lote" de "dois lotes que gravam a mesma coisa" quando alguem olha so o
    // estado final. Este duble separa: o segundo `db.batch()` estoura. Quebrar
    // §8.8 no sentido "grava a config, DEPOIS tenta logar" deixa de passar
    // verde — a resposta vira a terceira frase em vez de "Pronto".
    const banco = new D1SegundoBatchQuebrado(env.DB)
    const resposta = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: banco as unknown as D1Database },
      AGORA,
    )

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe(PAGINA_PARADA)
    expect(banco.batches).toBe(1)

    // E as duas metades foram gravadas juntas, nao uma de cada vez.
    expect(await linhaDeConfig()).toEqual({
      enabled: 0,
      versao: 2,
      parado_por_codigo_em: AGORA,
    })
    expect(await linhasDeAuditoria()).toHaveLength(2)
  })

  test('STOP-01: sem linha de configuracao, a parada materializa a linha desligada', async () => {
    const { parada } = await gerarCodigos()
    expect(await linhaDeConfig()).toBeNull()

    const resposta = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)

    expect(resposta.status).toBe(200)
    // Linha ausente NAO e "ja desligada": sem linha quem manda e a fabrica, que
    // nasce ligada. O ramo `INSERT` do `ON CONFLICT` materializa a linha (§8.3).
    expect(await linhaDeConfig()).toEqual({
      enabled: 0,
      versao: 1,
      parado_por_codigo_em: AGORA,
    })
  })

  test('STOP-02: GET /painel/parada redireciona para /painel/parar, que serve o formulario', async () => {
    const ctx = createExecutionContext()
    const redirecionada = await worker.fetch(new Request(`${RAIZ}${CAMINHO_DA_PARADA}`), env, ctx)
    await waitOnExecutionContext(ctx)

    // `303`, e nao `405`: as duas grafias diferem por uma letra e a pessoa vai
    // digitar do papel, no celular, no pior dia do projeto (§11.6).
    expect(redirecionada.status).toBe(303)
    expect(redirecionada.headers.get('location')).toBe(CAMINHO_DO_FORMULARIO)

    const outro = createExecutionContext()
    const formulario = await worker.fetch(
      new Request(`${RAIZ}${CAMINHO_DO_FORMULARIO}`),
      env,
      outro,
    )
    await waitOnExecutionContext(outro)

    expect(formulario.status).toBe(200)
    expect(formulario.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const corpo = await formulario.text()
    expect(corpo).toBe(PAGINA_DO_FORMULARIO)
    // Sem script e sem interpolacao: a pagina de emergencia nao pode depender
    // de JavaScript para abrir.
    expect(corpo).not.toContain('<script')
    expect(corpo).toContain('<form method="post" action="/painel/parada">')
  })

  test('STOP-02: o asset e a copia do Worker sao o mesmo arquivo, byte a byte', () => {
    // Em producao o asset responde primeiro (§11.2) e o Worker serve a copia;
    // duas copias sem prova de igualdade divergem na primeira etapa que mexer
    // numa delas, e a que a pessoa veria seria a errada.
    expect(formularioDoAsset).toBe(PAGINA_DO_FORMULARIO)
  })

  test('STOP-03: o codigo na query string nunca e lido', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const contador = new D1Contador(env.DB)
    const resposta = await handleParada(
      new Request(`${RAIZ}${CAMINHO_DA_PARADA}?codigo=${encodeURIComponent(parada)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }),
      { ...env, DB: comoD1(contador) },
      AGORA,
    )

    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toBe(PAGINA_CODIGO_INCORRETO)

    // Corpo vazio nao normaliza: recusa antes de qualquer consulta ao D1.
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 0,
      escritas: 0,
    })
    expect((await linhaDeConfig())?.enabled).toBe(1)
  })

  test('STOP-04: codigo errado responde codigo_incorreto e nao provoca escrita', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    const contador = new D1Contador(env.DB)
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        // Bem formado — 16 caracteres do alfabeto —, so que nao e o codigo.
        postDaParada(comOCodigo('0000000000000000')),
        { ...env, DB: comoD1(contador) },
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(403)
    expect(await resposta.text()).toBe(PAGINA_CODIGO_INCORRETO)

    // O NOME deste teste promete `codigo_incorreto`, entao o teste confere o
    // codigo que foi registrado — e nao so o status. `credencial_invalida` NAO
    // se aplica a esta rota (§10.12, ultimo paragrafo), e §11.4 se declara a
    // unica tabela: uma grafia de fora dela nao pode passar verde aqui.
    expect(registrado.linhas).toEqual([`painel: POST ${CAMINHO_DA_PARADA} 403 codigo_incorreto`])

    expect(contador.escritas).toBe(0)
    expect(contador.batches).toBe(0)
    expect((await linhaDeConfig())?.enabled).toBe(1)
    // Auditoria inclusive: fracasso de requisicao NAO autenticada nao vira
    // linha no D1 — gravar tentativa de estranho seria escrita provocada por
    // estranho, na mesma cota do webhook (§9.9). A unica linha que existe e a
    // do `codigos_gerados` acima; a tentativa recusada nao acrescentou nenhuma.
    expect(await linhasDeAuditoria()).toHaveLength(1)
    expect((await linhasDeAuditoria())[0]?.acao).toBe('codigos_gerados')
  })

  test('STOP-05: a resposta nao contem link, texto nem campo de config', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const corpos = [
      await (await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)).text(),
      await (await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA)).text(),
      await (
        await handleParada(
          postDaParada(comOCodigo(parada)),
          { ...env, DB: new D1ForaDoAr() as unknown as D1Database },
          AGORA,
        )
      ).text(),
    ]

    for (const corpo of corpos) {
      expect(corpo).not.toContain(LINHA_DE_CONFIG_VALIDA.destination_url)
      expect(corpo).not.toContain(LINHA_DE_CONFIG_VALIDA.private_reply_text)
      expect(corpo).not.toContain(LINHA_DE_CONFIG_VALIDA.public_reply_text)
      expect(corpo).not.toContain('eu quero')
      expect(corpo).not.toContain(IG_USER_ID)
      expect(corpo).not.toContain(parada)
      // Nenhum link: a pagina nao leva a lugar nenhum.
      expect(corpo).not.toContain('href')
    }
  })

  test('STOP-06: codigo errado custa 1 leitura e 0 escrita', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    const contador = new D1Contador(env.DB)
    await handleParada(
      postDaParada(comOCodigo('0000000000000000')),
      {
        ...env,
        DB: comoD1(contador),
      },
      AGORA,
    )

    // A leitura dos hashes vivos, e mais nada: o estado da automacao so e
    // consultado depois de o codigo conferir (§9.10).
    expect({
      prepares: contador.prepares,
      escritas: contador.escritas,
      batches: contador.batches,
    }).toEqual({ prepares: 1, escritas: 0, batches: 0 })
  })

  test('STOP-06: codigo malformado custa ZERO leitura', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    for (const digitado of ['', 'abc', 'U'.repeat(16), '0'.repeat(15), '0'.repeat(17)]) {
      const contador = new D1Contador(env.DB)
      const resposta = await handleParada(
        postDaParada(comOCodigo(digitado)),
        {
          ...env,
          DB: comoD1(contador),
        },
        AGORA,
      )

      expect(`${digitado.length}=${resposta.status}`).toBe(`${digitado.length}=403`)
      expect(`${digitado.length}=${contador.prepares}`).toBe(`${digitado.length}=0`)
    }
  })

  test('STOP-07: depois da parada, evaluateComment devolve automacao_desligada', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // Antes: a automacao processa.
    const antes = await carregarConfigEfetiva(env, AGORA)
    expect(
      evaluateComment(comentarioQueAciona(), antes.global, IG_USER_ID, 'conta_de_teste'),
    ).toEqual({ process: true, keyword: 'eu quero' })

    await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)

    // Depois: sem invalidar o cache a mao. `handleParada` derruba o cache do
    // isolate, senao este mesmo instante continuaria servindo "ligado" ate o
    // TTL vencer.
    const depois = await carregarConfigEfetiva(env, AGORA)
    expect(depois.global.enabled).toBe(false)
    expect(
      evaluateComment(comentarioQueAciona(), depois.global, IG_USER_ID, 'conta_de_teste'),
    ).toEqual({ process: false, reason: 'automacao_desligada' })
  })

  test('STOP-08: acionar duas vezes e idempotente e a segunda vez nao grava', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const primeira = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)
    const depoisDaPrimeira = await linhaDeConfig()

    const contador = new D1Contador(env.DB)
    const segunda = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: comoD1(contador) },
      AGORA + 60_000,
    )

    expect(segunda.status).toBe(primeira.status)
    expect(await segunda.text()).toBe(PAGINA_PARADA)

    // Duas leituras, zero escritas: hashes vivos e estado da automacao (§9.10).
    expect({
      prepares: contador.prepares,
      escritas: contador.escritas,
      batches: contador.batches,
    }).toEqual({ prepares: 2, escritas: 0, batches: 0 })

    // A linha nao andou: nem a versao, nem o carimbo da parada.
    expect(await linhaDeConfig()).toEqual(depoisDaPrimeira)
    expect(await linhasDeAuditoria()).toHaveLength(2)
  })

  test('STOP-08: em rajada, cinco POSTs simultaneos param a automacao UMA vez', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // A leitura de `lerEstadoDaAutomacao` e uma decisao fora do banco: cinco
    // requisicoes simultaneas leem `enabled = 1` as cinco e mandam cinco
    // `UPDATE`. Sem o `WHERE painel_config.enabled = 1` do `DO UPDATE`, a
    // versao pulava de 1 para 6 — e a versao e o carimbo que §8.8 usa como
    // chave do log de auditoria e como trava otimista da tela.
    const respostas = await Promise.all(
      Array.from({ length: 5 }, () => handleParada(postDaParada(comOCodigo(parada)), env, AGORA)),
    )

    for (const [i, resposta] of respostas.entries()) {
      expect(`${i}=${resposta.status}`).toBe(`${i}=200`)
    }

    // A direcao e segura em qualquer intercalacao, e a versao resultante e
    // exatamente uma a mais que a anterior.
    expect(await linhaDeConfig()).toEqual({
      enabled: 0,
      versao: 2,
      parado_por_codigo_em: AGORA,
    })

    // E nenhuma linha de auditoria carimba uma versao que nunca existiu.
    const acionamentos = (await linhasDeAuditoria()).filter((l) => l.acao === 'parada_acionada')
    for (const [i, linha] of acionamentos.entries()) {
      expect(`${i}=${linha.versao}`).toBe(`${i}=2`)
    }
  })

  test('STOP-09: o codigo de parada nao emite sessao e so muda enabled', async () => {
    // O nome antigo prometia "nao serve para logar, ler nem editar", e o corpo
    // so prova a metade "editar" (mais a ausencia de cookie). As outras duas so
    // ganham significado quando as rotas de sessao existirem: e com a etapa 9
    // que este teste ganha a metade "logar" — tentar `POST /painel/sessao` com
    // o codigo de parada — e a metade "ler" — tentar `GET /painel` com ele.
    // Nome que promete mais do que o corpo prova e pior que teste ausente.
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada, recuperacao } = await gerarCodigos()

    // Nao e credencial administrativa: nao abre nenhuma rota /setup/*.
    for (const codigo of [parada, ...recuperacao]) {
      const ctx = createExecutionContext()
      const resposta = await worker.fetch(
        new Request(`${RAIZ}/setup/authorize`, { headers: { authorization: `Bearer ${codigo}` } }),
        env,
        ctx,
      )
      await waitOnExecutionContext(ctx)
      expect(resposta.status).toBe(401)
    }

    // E nao vira sessao: acionar a parada nao emite cookie nenhum.
    const parou = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)
    expect(parou.headers.get('set-cookie')).toBeNull()

    // A unica coisa que ele mudou no banco foi `enabled` — nenhum outro campo.
    const linha = await env.DB.prepare('SELECT * FROM painel_config WHERE id = 1').first<
      Record<string, unknown>
    >()
    expect(linha?.destination_url).toBe(LINHA_DE_CONFIG_VALIDA.destination_url)
    expect(linha?.private_reply_text).toBe(LINHA_DE_CONFIG_VALIDA.private_reply_text)
    expect(linha?.trigger_keywords).toBe(LINHA_DE_CONFIG_VALIDA.trigger_keywords)
  })

  test('STOP-10: a comparacao passa por timingSafeEqual (comparador duble)', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // A metade que o duble NAO alcanca. Comparacao em tempo constante e, por
    // construcao, funcionalmente identica a `===`: nenhum teste de caixa-preta
    // separa as duas, e sem esta linha trocar o padrao por `(a, b) => a === b`
    // passava verde com o nome do teste dizendo `timingSafeEqual`. O binding
    // exportado e o unico lugar do projeto que nomeia o comparador deste
    // caminho, e e ele que fica congelado aqui.
    expect(COMPARADOR_PADRAO).toBe(timingSafeEqual)

    // Um comparador que sempre diz "nao" recusa ATE o codigo certo: nao existe
    // um segundo caminho de comparacao escondido na rota.
    const sempreNao = new ComparadorFalso(false)
    const recusada = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA, {
      comparar: sempreNao.comparar,
    })

    expect(recusada.status).toBe(403)
    expect((await linhaDeConfig())?.enabled).toBe(1)

    // E o que ele recebeu foram DOIS hashes em hex — nunca o codigo digitado.
    expect(sempreNao.comparacoes).toHaveLength(1)
    for (const [esperado, doBanco] of sempreNao.comparacoes) {
      expect(esperado).toMatch(/^[0-9a-f]{64}$/)
      expect(doBanco).toMatch(/^[0-9a-f]{64}$/)
      expect(esperado).not.toContain(parada)
    }

    // E o inverso: um comparador que sempre diz "sim" aceita ate o codigo
    // errado. O veredito da rota passa inteiro pelo comparador.
    const sempreSim = new ComparadorFalso(true)
    const aceita = await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA, {
      comparar: sempreSim.comparar,
    })

    expect(aceita.status).toBe(200)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('STOP-11: nenhuma das tres respostas contem configuracao, link, contagem ou estado da conta', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const falha = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: new D1ForaDoAr() as unknown as D1Database },
      AGORA,
    )
    const errado = await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA)
    const certo = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)

    // O texto INTEGRAL de cada pagina, byte a byte. Nao ha o que acrescentar a
    // elas sem este teste ficar vermelho.
    expect(await falha.text()).toBe(PAGINA_INDISPONIVEL)
    expect(await errado.text()).toBe(PAGINA_CODIGO_INCORRETO)
    expect(await certo.text()).toBe(PAGINA_PARADA)

    expect([falha.status, errado.status, certo.status]).toEqual([503, 403, 200])
  })

  test('STOP-11: as tres respostas e o formulario carregam os cabecalhos de §11.5', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const falha = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: new D1ForaDoAr() as unknown as D1Database },
      AGORA,
    )
    const errado = await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA)
    const certo = await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)
    const formulario = handleFormularioDeParada(new Request(`${RAIZ}${CAMINHO_DO_FORMULARIO}`))

    // O mapa INTEIRO, e nao "contem CSP": `toEqual` pega tanto a linha apagada
    // quanto a linha acrescentada. Sem isto, apagar CSP, HSTS, X-Frame-Options,
    // Referrer-Policy, COOP/CORP e Permissions-Policy das quatro respostas
    // passava verde na suite inteira.
    for (const [nome, resposta] of [
      ['503', falha],
      ['403', errado],
      ['200', certo],
      ['formulario', formulario],
    ] as const) {
      expect(`${nome}=${JSON.stringify(cabecalhosDe(resposta))}`).toBe(
        `${nome}=${JSON.stringify(CABECALHOS_DE_PAGINA)}`,
      )
    }

    // Duas ausencias que a igualdade acima ja garante, escritas por extenso
    // porque sao proibicoes, e nao valores: `Cross-Origin-Embedder-Policy:
    // require-corp` quebraria as miniaturas do `fbcdn.net` (§11.5), e
    // `Access-Control-*` nao pode existir em hipotese nenhuma.
    for (const resposta of [falha, errado, certo, formulario]) {
      expect(resposta.headers.get('cross-origin-embedder-policy')).toBeNull()
      for (const [nome] of resposta.headers) {
        expect(nome.startsWith('access-control-')).toBe(false)
      }
    }
  })

  test('STOP-12: a pagina nao informa se existe codigo cadastrado', async () => {
    await gravarConfig(env.DB, { enabled: 1 })

    // Sem nenhum codigo no banco.
    const semNenhum = await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA)
    const corpoSemNenhum = await semNenhum.text()

    await gerarCodigos()

    // Com sete codigos no banco, e um palpite que nao bate.
    const comSete = await handleParada(postDaParada(comOCodigo('0000000000000000')), env, AGORA)

    expect(comSete.status).toBe(semNenhum.status)
    expect(await comSete.text()).toBe(corpoSemNenhum)
    expect(corpoSemNenhum).toBe(PAGINA_CODIGO_INCORRETO)
  })

  test('STOP-13: falha de D1 devolve a terceira resposta, na leitura e na gravacao', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const naLeitura = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: new D1ForaDoAr() as unknown as D1Database },
      AGORA,
    )
    expect(naLeitura.status).toBe(503)
    expect(await naLeitura.text()).toBe(PAGINA_INDISPONIVEL)

    // Le tudo, e estoura no lote. Nada pode ter sido gravado pela metade.
    const naGravacao = await handleParada(
      postDaParada(comOCodigo(parada)),
      { ...env, DB: new D1BatchQuebrado(env.DB) as unknown as D1Database },
      AGORA,
    )
    expect(naGravacao.status).toBe(503)
    expect(await naGravacao.text()).toBe(PAGINA_INDISPONIVEL)

    expect((await linhaDeConfig())?.enabled).toBe(1)
    // Sem log, sem mudanca: a auditoria e a config caem juntas (§8.8).
    expect(await linhasDeAuditoria()).toHaveLength(1)
  })

  test('STOP-14: PANEL_RP_ID ausente derruba GET /painel em 503 e a parada continua desligando', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    // O binding NAO cadastrado chega como `undefined` em Workers, e nao como
    // string vazia: `env.PANEL_RP_ID.length` sozinho lancaria `TypeError`.
    const { PANEL_RP_ID: _semRpId, ...semRpId } = env as unknown as Record<string, unknown>
    const ambiente = semRpId as unknown as Env
    expect(ambiente.PANEL_RP_ID).toBeUndefined()

    // Nenhuma linha do roteador lanca `TypeError` nesse cenario: `/health` e o
    // formulario da parada respondem normalmente, e nada devolve 500.
    for (const caminho of ['/health', CAMINHO_DO_FORMULARIO]) {
      const ctx = createExecutionContext()
      const resposta = await worker.fetch(new Request(`${RAIZ}${caminho}`), ambiente, ctx)
      await waitOnExecutionContext(ctx)
      expect(`${caminho}=${resposta.status}`).toBe(`${caminho}=200`)
    }

    // A metade que a etapa do roteador tornou verdade (§13.2, §11.1): sem
    // `PANEL_RP_ID` o portao de sanidade fecha o painel inteiro em **503**, e
    // nao em 404 nem em 500. `/painel/` — um caminho do painel sem rota — cai
    // no MESMO 503, porque o portao vem antes do `switch`.
    for (const caminho of ['/painel', '/painel/']) {
      const doPainel = createExecutionContext()
      const painel = await worker.fetch(new Request(`${RAIZ}${caminho}`), ambiente, doPainel)
      await waitOnExecutionContext(doPainel)
      expect(`${caminho}=${painel.status}`).toBe(`${caminho}=503`)
    }

    // E o mais importante: a parada continua desligando a automacao.
    const resposta = await handleParada(postDaParada(comOCodigo(parada)), ambiente, AGORA)

    expect(resposta.status).toBe(200)
    expect(await resposta.text()).toBe(PAGINA_PARADA)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('STOP-14: sem PANEL_SESSION_KEY a parada responde a terceira frase, e nao 500', async () => {
    await gravarConfig(env.DB, { enabled: 1 })

    const { PANEL_SESSION_KEY: _semChave, ...semChave } = env as unknown as Record<string, unknown>
    const resposta = await handleParada(
      postDaParada(comOCodigo('0000000000000000')),
      semChave as unknown as Env,
      AGORA,
    )

    // Sem a raiz de `k_codigos` nao ha como comparar codigo nenhum — e ai sim
    // ela devolve o 503, sem lancar `TypeError` (§11.1).
    expect(resposta.status).toBe(503)
    expect(await resposta.text()).toBe(PAGINA_INDISPONIVEL)
    expect((await linhaDeConfig())?.enabled).toBe(1)
  })
})

describe('STOP — o corpo de 1 KB e os outros portoes gratuitos', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
  })

  test('STOP: corpo acima de 1 KB e recusado antes de tocar o D1', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const enchimento = 'x'.repeat(TETO_DO_CORPO_DA_PARADA + 1)
    const contador = new D1Contador(env.DB)
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        postDaParada(`${comOCodigo(parada)}&sobra=${enchimento}`),
        { ...env, DB: comoD1(contador) },
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
    expect((await linhaDeConfig())?.enabled).toBe(1)
    // O status vem de §11.4 e a frase de §10.12 — e o codigo registrado tem
    // que ser o da tabela, nao um sinonimo qualquer.
    expect(registrado.linhas).toEqual([`painel: POST ${CAMINHO_DA_PARADA} 413 corpo_grande_demais`])
  })

  test('STOP: corpo chunked sem content-length e cortado DURANTE a leitura', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    // Um POST `chunked` nao tem `content-length`: o portao barato nao vale, e
    // e este o caminho em que "capado em 1 KB" precisa ser teto de verdade. O
    // contador de pedacos e a prova de que o corte acontece DURANTE a leitura
    // — com `arrayBuffer()` o corpo inteiro (10 KB) seria bufferizado na
    // memoria do isolate primeiro, e os 40 pedacos sairiam todos.
    const corpo = new CorpoEmPedacos(40, 256)
    const contador = new D1Contador(env.DB)
    const resposta = await handleParada(
      new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: corpo.stream(),
      }),
      { ...env, DB: comoD1(contador) },
      AGORA,
    )

    expect(resposta.status).toBe(413)
    expect(await resposta.text()).toBe(PAGINA_CODIGO_INCORRETO)
    expect(contador.prepares).toBe(0)
    // Parou perto do teto, e nao no fim do corpo.
    expect(corpo.entregues).toBeLessThan(10)
  })

  test('STOP: a conexao que cai no meio do corpo devolve a terceira frase, nunca 500', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    // 3G que cai no meio do POST — o celular com sinal ruim e exatamente o
    // cenario que §10.12 nomeia. A leitura do corpo tem que morar dentro do
    // `try`: fora dele isto virava `500 Internal Server Error`, e o dono ficava
    // sem saber se a automacao parou.
    const contador = new D1Contador(env.DB)
    const resposta = await handleParada(
      new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new ReadableStream({
          start(controlador) {
            controlador.error(new Error('conexao caiu'))
          },
        }),
      }),
      { ...env, DB: comoD1(contador) },
      AGORA,
    )

    expect(resposta.status).toBe(503)
    expect(await resposta.text()).toBe(PAGINA_INDISPONIVEL)
    expect(contador.prepares).toBe(0)
    expect((await linhaDeConfig())?.enabled).toBe(1)
  })

  test('STOP: um content-length mentiroso nao passa pelo teto', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    await gerarCodigos()

    const contador = new D1Contador(env.DB)
    const resposta = await handleParada(
      postDaParada('codigo=0000000000000000', { 'content-length': String(2 * 1024) }),
      { ...env, DB: comoD1(contador) },
      AGORA,
    )

    // O cabecalho vem de quem chama e pode mentir para os dois lados; o teto
    // barra pelo declarado E pelo lido.
    expect(resposta.status).toBe(413)
    expect(contador.prepares).toBe(0)
  })

  test('STOP: content-type que nao e formulario nao chega ao D1', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()

    const contador = new D1Contador(env.DB)
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ codigo: parada }),
        }),
        { ...env, DB: comoD1(contador) },
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(415)
    expect(contador.prepares).toBe(0)
    expect((await linhaDeConfig())?.enabled).toBe(1)
    expect(registrado.linhas).toEqual([`painel: POST ${CAMINHO_DA_PARADA} 415 tipo_nao_suportado`])
  })

  test('STOP: o content-type e comparado sem caixa, como manda a RFC 9110', async () => {
    // Media type e case-INSENSITIVE. Recusar `Application/...` mostraria "Esse
    // codigo nao confere" para um codigo que confere — a mentira que o
    // argumento (c) de §10.12 existe para impedir.
    for (const grafia of [
      'application/x-www-form-urlencoded',
      'Application/x-www-form-urlencoded',
      'APPLICATION/X-WWW-FORM-URLENCODED',
      ' application/x-www-form-urlencoded; charset=UTF-8',
    ]) {
      await limparBanco(env.DB)
      invalidarCacheDeConfig()
      await gravarConfig(env.DB, { enabled: 1 })
      const { parada } = await gerarCodigos()

      const resposta = await handleParada(
        postDaParada(comOCodigo(parada), { 'content-type': grafia }),
        env,
        AGORA,
      )

      expect(`${grafia}=${resposta.status}`).toBe(`${grafia}=200`)
      expect(`${grafia}=${(await linhaDeConfig())?.enabled}`).toBe(`${grafia}=0`)
    }

    // E o que continua de fora e o tipo ERRADO, nao a caixa dele.
    const recusado = await handleParada(
      postDaParada('codigo=0000000000000000', { 'content-type': 'Application/JSON' }),
      env,
      AGORA,
    )
    expect(recusado.status).toBe(415)
  })

  test('STOP: o 405 do painel registra metodo_nao_permitido', async () => {
    const registrado = capturarConsole()
    let resposta: Response
    try {
      resposta = await handleParada(
        new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, { method: 'DELETE' }),
        env,
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    expect(resposta.status).toBe(405)
    expect(resposta.headers.get('allow')).toBe('GET, POST')
    // §11.4 tem a linha `405 metodo_nao_permitido`, e ate agora esta rota
    // devolvia o status sem registrar o codigo.
    expect(registrado.linhas).toEqual([
      `painel: DELETE ${CAMINHO_DA_PARADA} 405 metodo_nao_permitido`,
    ])

    const noFormulario = capturarConsole()
    let doAsset: Response
    try {
      doAsset = handleFormularioDeParada(
        new Request(`${RAIZ}${CAMINHO_DO_FORMULARIO}`, { method: 'POST' }),
      )
    } finally {
      noFormulario.parar()
    }

    expect(doAsset.status).toBe(405)
    expect(noFormulario.linhas).toEqual([
      `painel: POST ${CAMINHO_DO_FORMULARIO} 405 metodo_nao_permitido`,
    ])
  })

  test('STOP: /setup/painel/codigos nao se anuncia como painel no log (Ruling 19)', async () => {
    const registrado = capturarConsole()
    let semBearer: Response
    let metodoErrado: Response
    try {
      semBearer = await handleGerarCodigos(
        new Request(`${RAIZ}/setup/painel/codigos`, { method: 'POST' }),
        env,
        AGORA,
      )
      metodoErrado = await handleGerarCodigos(
        new Request(`${RAIZ}/setup/painel/codigos`, { method: 'GET' }),
        env,
        AGORA,
      )
    } finally {
      registrado.parar()
    }

    // A resposta em texto + 401 casa com as irmas `/setup/*` (`oauth.ts:52`).
    expect(semBearer.status).toBe(401)
    expect(await semBearer.text()).toBe('Nao autorizado')
    expect(metodoErrado.status).toBe(405)

    // E, como elas, esta rota NAO loga: §11.4 e a tabela do painel, e a grafia
    // `nao_autorizado` nao existe nela. Quem nao e painel nao se anuncia como
    // `painel:` (Ruling 19).
    expect(registrado.linhas).toEqual([])
  })

  test('STOP: OPTIONS cai em 405 com Allow, e nunca em Access-Control-*', async () => {
    const ctx = createExecutionContext()
    const resposta = await worker.fetch(
      new Request(`${RAIZ}${CAMINHO_DA_PARADA}`, { method: 'OPTIONS' }),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)

    expect(resposta.status).toBe(405)
    expect(resposta.headers.get('allow')).toBe('GET, POST')
    for (const [nome] of resposta.headers) {
      expect(nome.startsWith('access-control-')).toBe(false)
    }
  })
})

describe('CODIGO — geracao, formato e normalizacao', () => {
  test('CODIGO: o alfabeto Crockford nao tem I, L, O nem U', () => {
    expect(ALFABETO_DOS_CODIGOS).toHaveLength(32)
    expect(new Set(ALFABETO_DOS_CODIGOS).size).toBe(32)
    for (const ambiguo of ['I', 'L', 'O', 'U']) {
      expect(`${ambiguo}=${ALFABETO_DOS_CODIGOS.includes(ambiguo)}`).toBe(`${ambiguo}=false`)
    }
  })

  test('CODIGO: 20 caracteres na recuperacao (100 bits) e 16 na parada (80 bits)', () => {
    expect(TAMANHO_DO_CODIGO.recuperacao * 5).toBe(100)
    expect(TAMANHO_DO_CODIGO.parada * 5).toBe(80)
    expect(CODIGOS_DE_RECUPERACAO).toBe(6)

    for (const tipo of ['recuperacao', 'parada'] as const) {
      const codigo = sortearCodigo(tipo)
      expect(codigo).toHaveLength(TAMANHO_DO_CODIGO[tipo])
      expect([...codigo].every((c) => ALFABETO_DOS_CODIGOS.includes(c))).toBe(true)
    }
  })

  test('CODIGO: dois sorteios seguidos nao coincidem', () => {
    const sorteados = new Set(Array.from({ length: 50 }, () => sortearCodigo('parada')))
    expect(sorteados.size).toBe(50)
  })

  test('CODIGO: a normalizacao aceita o que a pessoa realmente digita', () => {
    const original = '0123456789ABCDEFGHJK'

    // Formatado com hifens, em minusculas, com espaco sobrando.
    expect(normalizarCodigo(' 01234-56789-abcde-fghjk ', 'recuperacao')).toBe(original)
    // I e L viraram 1, O virou 0 — as confusoes que o alfabeto ja previu.
    expect(normalizarCodigo('OI23456789ABCDEFGHJK', 'recuperacao')).toBe('0123456789ABCDEFGHJK')
    expect(normalizarCodigo('Ol23456789ABCDEFGHJK', 'recuperacao')).toBe('0123456789ABCDEFGHJK')
  })

  test('CODIGO: a normalizacao recusa tamanho errado, tipo errado e caractere de fora', () => {
    // O tamanho e do TIPO: um codigo de recuperacao nao passa como parada.
    expect(normalizarCodigo('0123456789ABCDEFGHJK', 'parada')).toBeNull()
    expect(normalizarCodigo('0123456789ABCDEF', 'recuperacao')).toBeNull()
    // `U` nao e mapeado de proposito: Crockford o exclui por outro motivo, e
    // mapea-lo para `V` transformaria um erro de digitacao em codigo valido.
    expect(normalizarCodigo('U123456789ABCDEF', 'parada')).toBeNull()
    expect(normalizarCodigo('!123456789ABCDEF', 'parada')).toBeNull()
    expect(normalizarCodigo('', 'parada')).toBeNull()
  })

  test('CODIGO: a exibicao agrupa de cinco em cinco e o resto vai no ultimo grupo', () => {
    expect(formatarCodigo('0123456789ABCDEFGHJK')).toBe('01234-56789-ABCDE-FGHJK')
    expect(formatarCodigo('0123456789ABCDEF')).toBe('01234-56789-ABCDEF')
    // E o hifen e so exibicao: ele volta a sumir na normalizacao.
    expect(normalizarCodigo(formatarCodigo('0123456789ABCDEF'), 'parada')).toBe('0123456789ABCDEF')
  })
})

describe('CODIGO — POST /setup/painel/codigos', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
  })

  test('CODIGO: um lote com o DELETE, os sete INSERT e a linha de auditoria', async () => {
    const contador = new D1Contador(env.DB)
    await gerarCodigos({ ...env, DB: comoD1(contador) })

    // 1 DELETE + 6 recuperacao + 1 parada + 1 auditoria, num unico `db.batch()`.
    expect({
      prepares: contador.prepares,
      escritas: contador.escritas,
      batches: contador.batches,
    }).toEqual({ prepares: 9, escritas: 9, batches: 1 })

    const linhas = await env.DB.prepare(
      'SELECT tipo, versao_hash, usado_em, invalidado_em FROM painel_codigos',
    ).all<{ tipo: string; versao_hash: number; usado_em: null; invalidado_em: null }>()

    const resultados = linhas.results ?? []
    expect(resultados).toHaveLength(7)
    expect(resultados.filter((l) => l.tipo === 'recuperacao')).toHaveLength(6)
    expect(resultados.filter((l) => l.tipo === 'parada')).toHaveLength(1)
    expect(resultados.every((l) => l.versao_hash === 1 && l.usado_em === null)).toBe(true)
  })

  test('CODIGO: a auditoria nasce aqui, com antes e depois nulos', async () => {
    await gerarCodigos()

    expect(await linhasDeAuditoria()).toEqual([
      {
        ocorrido_em: AGORA,
        versao: 0,
        origem: 'assistente',
        ator: 'assistente',
        step_up: 0,
        acao: 'codigos_gerados',
        alvo: null,
        campos: '[]',
        antes: null,
        depois: null,
      },
    ])
  })

  test('CODIGO: a parada grava a segunda linha de auditoria, tambem sem antes e depois', async () => {
    await gravarConfig(env.DB, { enabled: 1 })
    const { parada } = await gerarCodigos()
    await handleParada(postDaParada(comOCodigo(parada)), env, AGORA)

    const linhas = await linhasDeAuditoria()
    expect(linhas).toHaveLength(2)
    expect(linhas[1]).toEqual({
      ocorrido_em: AGORA,
      // A versao RESULTANTE: a linha comecou em 1 e a parada a levou para 2.
      versao: 2,
      origem: 'parada',
      ator: 'parada',
      step_up: 0,
      acao: 'parada_acionada',
      alvo: null,
      campos: '[]',
      antes: null,
      depois: null,
    })
  })

  test('CODIGO: um conjunto novo apaga o antigo inteiro', async () => {
    const primeiro = await gerarCodigos()
    await gravarConfig(env.DB, { enabled: 1 })

    const segundo = await gerarCodigos()
    expect(segundo.parada).not.toBe(primeiro.parada)

    // O codigo antigo, impresso num papel que a pessoa achou que substituiu,
    // nao vale mais.
    const comOAntigo = await handleParada(postDaParada(comOCodigo(primeiro.parada)), env, AGORA)
    expect(comOAntigo.status).toBe(403)
    expect((await linhaDeConfig())?.enabled).toBe(1)

    const comONovo = await handleParada(postDaParada(comOCodigo(segundo.parada)), env, AGORA)
    expect(comONovo.status).toBe(200)
    expect((await linhaDeConfig())?.enabled).toBe(0)
  })

  test('CODIGO: os codigos voltam formatados e cada um so uma vez', async () => {
    const conjunto = await gerarCodigos()

    expect(conjunto.recuperacao).toHaveLength(6)
    for (const codigo of conjunto.recuperacao) {
      expect(codigo).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    }
    expect(conjunto.parada).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{6}$/)
    expect(new Set([...conjunto.recuperacao, conjunto.parada]).size).toBe(7)
  })

  test('CODIGO: o banco guarda hash, e nunca o codigo', async () => {
    const conjunto = await gerarCodigos()

    const linhas = await env.DB.prepare('SELECT hash FROM painel_codigos').all<{ hash: string }>()
    const hashes = (linhas.results ?? []).map((l) => l.hash)

    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    }
    for (const codigo of [...conjunto.recuperacao, conjunto.parada]) {
      const normalizado = codigo.replaceAll('-', '')
      expect(hashes.some((h) => h.includes(normalizado.toLowerCase()))).toBe(false)
      expect(hashes.some((h) => h.includes(normalizado))).toBe(false)
    }
  })
})

describe('AUDITORIA — a poda de 500 linhas no cron', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
  })

  /** Enche a auditoria com `quantidade` linhas, em lotes que o D1 aguenta. */
  async function encherAuditoria(quantidade: number): Promise<void> {
    for (let inicio = 0; inicio < quantidade; inicio += 100) {
      const fatia = Math.min(100, quantidade - inicio)
      await env.DB.batch(
        Array.from({ length: fatia }, (_, i) =>
          env.DB.prepare(
            `INSERT INTO painel_auditoria
               (id, ocorrido_em, versao, origem, ator, step_up, acao, alvo, campos, antes, depois)
             VALUES (?, ?, 1, 'painel', 'migracao', 0, 'config_alterada', NULL, '[]', NULL, NULL)`,
          ).bind(inicio + i + 1, AGORA),
        ),
      )
    }
  }

  test('AUDITORIA: com 500 linhas a poda nao escreve nada', async () => {
    await encherAuditoria(500)

    const contador = new D1Contador(env.DB)
    const apagadas = await new PainelAuditoriaRepository(comoD1(contador)).podar()

    expect(apagadas).toBe(0)
    // Uma leitura, zero escritas — e nenhum `COUNT(*)` em lugar nenhum (§8.9).
    expect({ prepares: contador.prepares, escritas: contador.escritas }).toEqual({
      prepares: 1,
      escritas: 0,
    })
    expect(await contarAuditoria()).toBe(500)
  })

  test('AUDITORIA: com 503 linhas a poda deixa exatamente as 500 mais recentes', async () => {
    await encherAuditoria(503)

    const apagadas = await new PainelAuditoriaRepository(env.DB).podar()

    expect(apagadas).toBe(3)
    expect(await contarAuditoria()).toBe(500)

    // Apaga do lado ANTIGO: o maior id nunca sai, e a sequencia continua
    // monotonica sem `AUTOINCREMENT`.
    const maisAntiga = await env.DB.prepare(
      'SELECT MIN(id) AS menor, MAX(id) AS maior FROM painel_auditoria',
    ).first<{ menor: number; maior: number }>()
    expect(maisAntiga).toEqual({ menor: 4, maior: 503 })
  })

  test('AUDITORIA: a poda entra no cron, e o cron continua sem escrever quando nao ha o que podar', async () => {
    await encherAuditoria(503)

    const contador = new D1Contador(env.DB)
    const registrado = capturarConsole()
    try {
      await runScheduledTasks({ ...env, DB: comoD1(contador) }, AGORA)
    } finally {
      registrado.parar()
    }

    expect(await contarAuditoria()).toBe(500)
    // A poda escreve so quando ha o que apagar.
    expect(contador.escritas).toBe(1)

    // §11.7: argumentos separados, SEM template string com dado variavel
    // dentro. O numero de linhas e inofensivo — o que a regra impede e o
    // precedente de existir um `console` do painel que interpola valor.
    expect(registrado.linhas.filter((linha) => linha.startsWith('painel:'))).toEqual([
      'painel: auditoria_podada 3',
    ])

    const segunda = new D1Contador(env.DB)
    await runScheduledTasks({ ...env, DB: comoD1(segunda) }, AGORA)
    expect(segunda.escritas).toBe(0)
  })

  async function contarAuditoria(): Promise<number> {
    const linha = await env.DB.prepare('SELECT COUNT(*) AS total FROM painel_auditoria').first<{
      total: number
    }>()
    return linha?.total ?? -1
  }
})

describe('STOP — o fork que ainda esta com o link de fabrica entre colchetes', () => {
  beforeEach(async () => {
    await limparBanco(env.DB)
    invalidarCacheDeConfig()
  })

  /** A fabrica de um fork recem-clonado: tudo valido, menos o link. */
  const FABRICA_COM_PLACEHOLDER: LinhaDeFabrica = {
    trigger_keywords: '["eu quero"]',
    match_mode: 'exact',
    case_sensitive: 0,
    normalize_accents: 1,
    ignore_punctuation: 1,
    process_only_reels: 1,
    media_scope: 'todas',
    public_reply_enabled: 1,
    public_reply_text: 'Enviei as informacoes no seu Direct.',
    private_reply_enabled: 1,
    private_reply_text: 'Segue o link como prometido {link}',
    destination_url: '[COLE_SEU_LINK]',
    user_cooldown_hours: 24,
  }

  test('STOP: o CHECK do schema deixa o placeholder passar, e a parada materializa a linha', async () => {
    // §8.3: se um `CHECK` de produto (`destination_url LIKE 'https://%'`)
    // estivesse no schema, a parada de emergencia falharia com erro de
    // constraint num fork que ainda nao trocou o link. A ultima rota que
    // precisa funcionar nao pode depender de o link estar bonito.
    await env.DB.batch([
      new PainelConfigRepository(env.DB).statementDeParada(AGORA, FABRICA_COM_PLACEHOLDER),
    ])

    expect(await linhaDeConfig()).toEqual({
      enabled: 0,
      versao: 1,
      parado_por_codigo_em: AGORA,
    })
  })

  test('STOP: a leitura seguinte reprova o link e o snapshot vira parado_por_erro', async () => {
    await env.DB.batch([
      new PainelConfigRepository(env.DB).statementDeParada(AGORA, FABRICA_COM_PLACEHOLDER),
    ])
    invalidarCacheDeConfig()

    const snapshot = await carregarConfigEfetiva(env, AGORA)

    // O COMPORTAMENTO e o mesmo dos dois lados — a automacao para —, mas o
    // ROTULO que a tela vai mostrar e `parado_por_erro`, e nao `banco` com
    // `enabled: 0`: o validador unico roda tambem na LEITURA, e
    // `new URL('[COLE_SEU_LINK]')` estoura antes de qualquer outra coisa.
    expect(snapshot.origem).toBe('parado_por_erro')
    expect(snapshot.global.enabled).toBe(false)
    expect(snapshot.versao).toBe(1)
    expect(snapshot.avisos.some((aviso) => aviso.startsWith('destinationUrl:'))).toBe(true)

    // E o comentario nao passa, que e o que de fato importa.
    expect(
      evaluateComment(comentarioQueAciona(), snapshot.global, IG_USER_ID, 'conta_de_teste'),
    ).toEqual({ process: false, reason: 'automacao_desligada' })
  })
})
