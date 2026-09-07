/**
 * Dubles injetados por parametro e o cenario minimo compartilhado.
 *
 * Nada de mock de modulo: os dubles sao classes locais que o teste passa por
 * parametro. Um nome por conceito — quem precisa de um duble da Meta, de um
 * relogio fixo ou de uma config de teste importa daqui, e nao escreve o seu.
 *
 * Este arquivo mora em `tests/fixtures/`, que nao casa com o `include` do
 * vitest, entao ele nao vira uma suite vazia.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import type { AutomationConfig } from '../../src/config'
import worker from '../../src/index'
import type { MetaApiClient } from '../../src/services/meta-api'
import type { Env } from '../../src/types/env'
import type { ApiResult, MediaInfoResponse, MediaListResponse } from '../../src/types/meta'

/** Statements que gravam. Serve para separar leitura de escrita na contagem. */
const ESCRITA = /^\s*(insert|update|delete|replace)/i

/**
 * Envolve um D1Database real e conta o que passa por ele.
 *
 * E o unico jeito honesto de transformar "nao estoura o teto de 50
 * subrequests por invocacao" — que e uma afirmacao sobre a plataforma, e que
 * o Miniflare NAO impoe — numa afirmacao sobre o codigo.
 *
 * `prepares` conta cada statement preparado, inclusive os que depois entram
 * num `db.batch()`. Como um `db.batch()` inteiro vale UM subrequest, o numero
 * e conservador: ele nunca subestima o gasto real.
 */
export class D1Contador {
  /**
   * O SQL de cada statement preparado, na ordem.
   *
   * Existe para as afirmacoes de NAO-consulta: "a tela nunca toca
   * `processed_comments`" so e uma afirmacao se alguem olhar o SQL. Contar
   * quantos statements passaram nao diz QUAIS passaram.
   */
  readonly sqls: string[] = []
  prepares = 0
  escritas = 0
  batches = 0
  execs = 0
  dumps = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    this.sqls.push(sql)
    this.prepares++
    if (ESCRITA.test(sql)) this.escritas++
    return this.real.prepare(sql)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches++
    return this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    this.execs++
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    this.dumps++
    return this.real.dump()
  }

  /** Zera os contadores sem trocar o banco por baixo. */
  zerar(): void {
    this.sqls.length = 0
    this.prepares = 0
    this.escritas = 0
    this.batches = 0
    this.execs = 0
    this.dumps = 0
  }
}

/** Entrega o contador onde o codigo de producao espera um D1Database. */
export function comoD1(contador: D1Contador): D1Database {
  return contador as unknown as D1Database
}

// ---------------------------------------------------------------------------
// O cenario minimo que toda suite de regressao monta
// ---------------------------------------------------------------------------

/** Relogio fixo do projeto. Sem fake timers: `now` e sempre injetado. */
export const AGORA = 1_700_000_000_000

/** Conta profissional ficticia usada em todas as suites. */
export const IG_USER_ID = '17841400000000000'
export const USERNAME_CONTA = 'conta_de_teste'

/** Raiz ficticia do Worker nos testes. */
export const RAIZ = 'https://exemplo.workers.dev'

/** Teto de subrequests por invocacao. Nao e imposto pelo Miniflare (§13.3). */
export const TETO_DE_SUBREQUESTS = 50

/**
 * Config de teste ESCRITA AQUI, e nao derivada de `src/config.ts`.
 *
 * Este repositorio e um template publico: quem instala clona e troca a
 * palavra-gatilho, o texto e o link. Um teste que dependesse desses valores
 * ficaria vermelho na maquina de todo mundo que usa o produto como ele foi
 * feito para ser usado. O que a regressao congela e o COMPORTAMENTO dado uma
 * config conhecida — a forma do contrato de `src/config.ts` e conferida a
 * parte, campo a campo.
 */
export const CONFIG_DE_TESTE: AutomationConfig = {
  enabled: true,
  triggerKeywords: ['eu quero', 'quero o link'],
  matchMode: 'exact',
  caseSensitive: false,
  normalizeAccents: true,
  ignorePunctuation: true,
  processOnlyReels: true,
  allowedMediaIds: ['*'],
  publicReplyEnabled: true,
  publicReplyText: 'Enviei as informacoes no seu Direct.',
  privateReplyEnabled: true,
  privateReplyText: 'Ola, {username}! Aqui esta o link que voce pediu: {link}',
  destinationUrl: 'https://exemplo.com/link',
  userCooldownHours: 24,
}

/** A config de teste com um campo trocado. */
export function configDeTeste(patch: Partial<AutomationConfig> = {}): AutomationConfig {
  return { ...CONFIG_DE_TESTE, ...patch }
}

/**
 * Duble da Graph API da Meta.
 *
 * Guarda a ORDEM das chamadas — e o que prova que nenhuma consulta extra
 * entrou no caminho — e o texto exato de cada Direct.
 */
export class MetaFalsa {
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

  async getMediaInfo(mediaId: string) {
    this.chamadas.push('mediaInfo')
    return { ok: true as const, data: { id: mediaId, media_product_type: 'REELS' } }
  }

  /** Quantas chamadas a Meta — que contam no mesmo teto das consultas ao D1. */
  get total(): number {
    return this.chamadas.length
  }
}

/** Entrega o duble onde o codigo de producao espera um MetaApiClient. */
export function comoApi(falsa: MetaFalsa | MetaQueFalha): MetaApiClient {
  return falsa as unknown as MetaApiClient
}

/**
 * Duble da Meta que sempre falha o Direct com um erro RETENTAVEL.
 *
 * `HTTP_500` esta na lista de `isRetryable`: e o 500 transitorio que nao pode
 * consumir a unica tentativa de um comentario reagendado.
 */
export class MetaQueFalha {
  tentativasDeDirect = 0

  async sendPrivateReply(_ig: string, _comment: string, _text: string) {
    this.tentativasDeDirect++
    return {
      ok: false as const,
      error: {
        status: 500,
        code: null,
        subcode: null,
        message: 'indisponivel',
        shortCode: 'HTTP_500',
      },
    }
  }

  async replyToComment(_comment: string, _message: string) {
    return { ok: true as const, data: { id: 'reply-1' } }
  }

  async getMediaInfo(mediaId: string) {
    return { ok: true as const, data: { id: mediaId, media_product_type: 'REELS' } }
  }
}

/** D1 que estoura em `batch()`, para provar que a falha nao escapa em silencio. */
export class D1BatchQuebrado {
  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.real.prepare(sql)
  }

  batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.reject(new Error('D1 fora do ar'))
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

/**
 * D1 que deixa o PRIMEIRO `batch()` passar e estoura no segundo.
 *
 * Existe para provar que uma rota grava em UM lote so. "Grava a config,
 * depois tenta logar" — a variante que §8.8 proibe em letras grandes — passa
 * verde por qualquer contagem que olhe so o resultado final, porque os dois
 * lotes gravam a mesma coisa. Aqui o segundo lote nao existe, e se alguem o
 * criar a rota devolve erro em vez de sucesso.
 */
export class D1SegundoBatchQuebrado {
  batches = 0

  constructor(private readonly real: D1Database) {}

  prepare(sql: string): D1PreparedStatement {
    return this.real.prepare(sql)
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches++
    if (this.batches > 1) {
      return Promise.reject(new Error('segundo db.batch() nao pode existir'))
    }
    return this.real.batch<T>(statements)
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.real.exec(query)
  }

  dump(): Promise<ArrayBuffer> {
    return this.real.dump()
  }
}

// ---------------------------------------------------------------------------
// Os dubles do limitador de taxa (§13.4)
// ---------------------------------------------------------------------------

/**
 * Duble do binding `ratelimits` da Cloudflare.
 *
 * Guarda a ORDEM e o TEXTO de cada chave recebida — e o que prova que a chave
 * enviada e exatamente a de §7.4, e que cada familia de rota fala com o binding
 * dela e com mais nenhum.
 */
export class BindingDeLimiteFalso {
  readonly chaves: string[] = []

  /** `Number.POSITIVE_INFINITY` = sempre libera; util quando o teto nao importa. */
  constructor(private readonly teto: number = Number.POSITIVE_INFINITY) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.chaves.push(key)
    const usadas = this.chaves.filter((guardada) => guardada === key).length
    return { success: usadas <= this.teto }
  }

  /** Quantas vezes ESTE binding foi consultado, com qualquer chave. */
  get total(): number {
    return this.chaves.length
  }
}

/** Binding que estoura. Prova que a excecao nao abre nem tranca a rota. */
export class BindingDeLimiteQuebrado {
  chamadas = 0

  async limit(_opcoes: { key: string }): Promise<{ success: boolean }> {
    this.chamadas++
    throw new Error('limitador fora do ar')
  }
}

/** Entrega o duble onde o codigo de producao espera um binding `ratelimits`. */
export function comoBindingDeLimite(
  falso: BindingDeLimiteFalso | BindingDeLimiteQuebrado,
): RateLimit {
  return falso as unknown as RateLimit
}

/**
 * Duble da porta `Limitador`, injetado por parametro (§13.4).
 *
 * Existe para o teste de rota forcar a recusa sem depender de contagem: uma
 * afirmacao sobre o `429` nao pode nascer presa ao teto de outra afirmacao.
 */
export class LimitadorFalso {
  readonly chaves: string[] = []
  readonly zerados: string[] = []

  constructor(
    private readonly veredito: { permitido: boolean; esperarSegundos: number } = {
      permitido: true,
      esperarSegundos: 0,
    },
  ) {}

  async permitir(chave: string, _agora: number) {
    this.chaves.push(chave)
    return this.veredito
  }

  zerar(chave: string): void {
    this.zerados.push(chave)
  }
}

/**
 * Captura tudo o que passa pelo `console` durante um trecho de teste.
 *
 * Mora no fixture porque duas suites precisam da MESMA captura: a de OAuth
 * prova que o corpo dos codigos nunca vai para o log, e a da parada prova que
 * o codigo de erro registrado e exatamente o de §11.4. Duas copias
 * divergiriam na primeira vez que uma delas ganhasse um nivel novo.
 *
 * Sempre com `try/finally`: um `expect` que falha no meio deixaria o console
 * do processo trocado para todas as suites seguintes.
 */
export function capturarConsole(): { linhas: string[]; parar: () => void } {
  const linhas: string[] = []
  const originais = { log: console.log, warn: console.warn, error: console.error }

  const guardar = (...partes: unknown[]) => {
    linhas.push(partes.map((parte) => String(parte)).join(' '))
  }

  console.log = guardar
  console.warn = guardar
  console.error = guardar

  return {
    linhas,
    parar: () => {
      console.log = originais.log
      console.warn = originais.warn
      console.error = originais.error
    },
  }
}

/** Roda o Worker de verdade e espera o `waitUntil` terminar. */
export async function responder(request: Request, env: Env): Promise<Response> {
  const ctx = createExecutionContext()
  const resposta = await worker.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  return resposta
}

/** GET na raiz ficticia, com os cabecalhos informados e NADA alem deles. */
export function pedir(caminho: string, cabecalhos: Record<string, string> = {}): Request {
  return new Request(`${RAIZ}${caminho}`, { headers: cabecalhos })
}

/**
 * A palavra aparece com fronteira de palavra? Substring nao conta (§12.7).
 *
 * **Ela morava em TRES arquivos, com o corpo identico e um nome diferente no
 * terceiro** (`contemPalavraNoCorpo`). Tres copias de uma comparacao que
 * decide se a tela escreveu uma palavra proibida sao tres chances de uma delas
 * ficar para tras — e a que ficasse para tras seria a que continuaria dizendo
 * "verde" depois de a regra ter mudado. §13.1 nomeia `tests/fixtures/*` como o
 * lugar de um helper compartilhado, e este arquivo e o que ja hospeda o que
 * nao e duble (`AGORA`, `RAIZ`, `pedir`, `capturarConsole`) — abrir um quinto
 * arquivo de fixture criaria um nome que §13.1 nao lista.
 */
export function contemPalavra(texto: string, palavra: string): boolean {
  const escapada = palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\x2d')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapada}([^\\p{L}\\p{N}]|$)`, 'iu').test(texto)
}

/** Um item de `me/media` como a Meta o devolve. Tudo ficticio. */
export function itemDeMidia(
  id: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    media_type: 'VIDEO',
    media_product_type: 'REELS',
    caption: `Legenda ficticia do ${id}`,
    permalink: `https://www.instagram.com/reel/ficticio-${id}/`,
    thumbnail_url: `https://scontent.example/assinada-${id}.jpg?expira=1`,
    timestamp: '2026-01-15T12:00:00+0000',
    ...extras,
  }
}

/** Uma pagina de `me/media`, com ou sem `paging.next`. */
export function paginaDeMidias(itens: readonly unknown[], proximo: string | null) {
  return {
    data: itens as MediaListResponse['data'],
    paging:
      proximo === null
        ? { cursors: { after: 'cursor-que-ninguem-usa' } }
        : { next: 'https://graph.instagram.com/proxima', cursors: { after: proximo } },
  } as MediaListResponse
}

/**
 * Duble da listagem da Meta.
 *
 * Guarda a ORDEM e o CURSOR de cada chamada — e o que prova que a paginacao
 * para onde §12.5 manda e nao onde a contagem sugere.
 *
 * Mora aqui, e nao dentro de uma suite, porque DUAS suites precisam dele:
 * `painel-midias` afirma a paginacao e `painel-telas` percorre as telas novas
 * nos catorze lacos de garantia. A segunda copia seria a que divergiria.
 */
export class MetaDeListagem {
  readonly cursores: (string | undefined)[] = []
  readonly consultados: string[] = []

  constructor(
    private readonly paginas: readonly MediaListResponse[],
    private readonly opcoes: {
      readonly falharListagem?: boolean
      readonly conhecidos?: readonly string[]
    } = {},
  ) {}

  async listMedia(opcoes: { after?: string } = {}): Promise<ApiResult<MediaListResponse>> {
    this.cursores.push(opcoes.after)
    if (this.opcoes.falharListagem === true) {
      return {
        ok: false,
        error: { status: 500, code: null, subcode: null, message: 'fora', shortCode: 'HTTP_500' },
      }
    }
    const proxima = this.paginas[this.cursores.length - 1]
    return { ok: true, data: proxima ?? paginaDeMidias([], null) }
  }

  async getMediaInfo(mediaId: string): Promise<ApiResult<MediaInfoResponse>> {
    this.consultados.push(mediaId)
    const conhecidos = this.opcoes.conhecidos
    if (conhecidos !== undefined && !conhecidos.includes(mediaId)) {
      return {
        ok: false,
        error: {
          status: 404,
          code: 100,
          subcode: 33,
          message: 'nao existe',
          shortCode: 'OBJETO_INEXISTENTE',
        },
      }
    }
    return { ok: true, data: { id: mediaId, media_product_type: 'REELS' } }
  }
}

/** Entrega o duble da listagem onde a tela espera as dependencias de midias. */
export function comApiDeListagem(falsa: MetaDeListagem) {
  return { criarApi: () => falsa as unknown as MetaApiClient }
}
