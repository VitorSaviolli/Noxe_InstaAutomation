/**
 * O que as DUAS telas de Reels compartilham (§12.5).
 *
 * `/painel/reels` escolhe os Reels e `/painel/reel?midia=` ajusta um deles.
 * Elas dividem tres coisas, e cada uma seria um defeito se fosse escrita duas
 * vezes:
 *
 *   1. a **listagem** da Meta, com a paginacao de §12.5 — quatro paginas por
 *      toque, parada por `paging.next` e nao por contagem, e o filtro de Reels
 *      feito no Worker;
 *   2. o **estado efetivo** de um Reel — a global com a sobreposicao por cima —,
 *      que e o `antes`/`depois` que o funil registra na auditoria (§9.9);
 *   3. o **cartao** de um Reel, que aparece na lista e no topo da tela do Reel.
 *
 * **`thumbnail_url` nunca sai daqui para o D1** (§12.5): ela e um endereco
 * assinado que vence em minutos, e a migration `0002` nao tem coluna para ela
 * de proposito. Ela vive no `<img>` da resposta e morre com ela.
 *
 * **`media_id` e TEXT em todo o caminho** (Ruling 90). Nada aqui chama
 * `Number()` sobre um id, e nenhum id atravessa `JSON.parse` sem aspas — o
 * caminho perigoso que a migration nao cobre e justamente o JSON, onde um id de
 * 18 digitos sem aspas volta como `number` corrompido, em silencio.
 */
import type { AutomationConfig } from '../../config'
import type { PainelMidiaRecord } from '../../repositories/painel-config-repository'
import {
  type Sobreposicao,
  sobreposicaoDaLinha,
  temRegrasProprias,
} from '../../repositories/painel-midias-repository'
import { ehMediaIdValido } from '../../services/config-validation'
import { MetaApiClient } from '../../services/meta-api'
import { loadAccessToken } from '../../services/token-manager'
import type { Env } from '../../types/env'
import type { MediaListItem, MediaListResponse } from '../../types/meta'
import { type EstadoDeComportamento, estadoDaConfig } from './formulario'

/**
 * Quantas paginas UM toque em "Carregar mais" busca (§12.5).
 *
 * Quatro, e o teto e de SUBREQUESTS: cada pagina e uma chamada. O laco tambem
 * para antes disso quando ja juntou Reels suficientes ou quando `paging.next`
 * some — e essa segunda parada e a unica que significa "acabou".
 */
export const PAGINAS_POR_TOQUE = 4

/** Reels suficientes para um toque parar cedo (§12.5). */
export const REELS_POR_TOQUE = 10

/**
 * Abaixo disto a tela explica em vez de parecer quebrada (§12.5).
 *
 * "Estas ultimas publicacoes nao sao Reels — toque de novo para continuar
 * procurando." Quem posta muita foto pode ter tres Reels em vinte e cinco
 * publicacoes, e uma lista que volta quase vazia sem explicacao parece defeito.
 */
export const POUCOS_REELS = 3

/** O recorte da legenda que cabe na coluna `legenda_curta` (migration `0002`). */
export const LIMITE_DA_LEGENDA = 200

/** O que a tela sabe de um Reel vindo da listagem. */
export interface ReelDaListagem {
  /** STRING sempre. Um id que nao e string simplesmente nao entra na lista. */
  readonly mediaId: string
  readonly legendaCurta: string | null
  readonly permalink: string | null
  readonly mediaProductType: string | null
  readonly postadoEm: number | null
  /** Endereco assinado, so para o `<img>` desta resposta. Nunca vai ao D1. */
  readonly miniatura: string | null
}

/** O resultado de um toque de paginacao. */
export type ResultadoDaListagem =
  | {
      readonly ok: true
      readonly reels: readonly ReelDaListagem[]
      /** O cursor da proxima pagina, ou `null` quando `paging.next` sumiu. */
      readonly proximoCursor: string | null
      /** Quantas paginas foram consumidas. Entra na frase de §12.5. */
      readonly paginas: number
    }
  | { readonly ok: false; readonly motivo: 'sem_conta' | 'falha_meta' }

/** O que a tela injeta para nao tocar a rede em teste (§13.1). */
export interface DependenciasDeMidias {
  readonly criarApi: (env: Env, token: string) => MetaApiClient
}

/** O de producao. O teste passa o duble por parametro; nada de mock de modulo. */
export const DEPENDENCIAS_DE_MIDIAS: DependenciasDeMidias = {
  criarApi: (env, token) => new MetaApiClient(env.META_API_VERSION, token),
}

/**
 * Um Reel de verdade?
 *
 * O filtro roda **no Worker** porque a Meta nao oferece filtro server-side por
 * REELS (§12.5). `media_product_type === 'REELS'` e a resposta boa; quando o
 * campo nao vem, `media_type === 'VIDEO'` e o que sobra, e a tela rotula
 * "video/Reel" em vez de afirmar o que nao sabe (§15.2, pendencia 7).
 */
export function ehReel(item: MediaListItem): boolean {
  if (item.media_product_type === 'REELS') return true
  return item.media_product_type === undefined && item.media_type === 'VIDEO'
}

/** A legenda cortada no tamanho da coluna, ou `null` quando nao ha legenda. */
export function legendaCurta(caption: string | undefined): string | null {
  if (caption === undefined) return null
  const limpa = caption.replace(/\s+/g, ' ').trim()
  if (limpa === '') return null
  return limpa.length <= LIMITE_DA_LEGENDA ? limpa : limpa.slice(0, LIMITE_DA_LEGENDA)
}

/** O `timestamp` ISO da Meta em epoch ms, ou `null` quando ele nao presta. */
function postadoEm(timestamp: string | undefined): number | null {
  if (timestamp === undefined) return null
  const instante = Date.parse(timestamp)
  return Number.isFinite(instante) ? instante : null
}

/**
 * Um item da listagem vira um Reel da tela, ou `null`.
 *
 * `null` em duas situacoes, e as duas sao a mesma decisao: **o id manda**. Sem
 * `id` string, ou com um id que nao tem a forma de `media_id`, a linha nao
 * entra — inventar um id seria casar a configuracao com o Reel errado, que e o
 * dano que a migration `0002` descreve nome por nome.
 */
export function comoReel(item: MediaListItem): ReelDaListagem | null {
  const mediaId = item.id
  if (typeof mediaId !== 'string' || !ehMediaIdValido(mediaId)) return null

  return {
    mediaId,
    legendaCurta: legendaCurta(item.caption),
    permalink: item.permalink ?? null,
    mediaProductType: item.media_product_type ?? null,
    postadoEm: postadoEm(item.timestamp),
    miniatura: item.thumbnail_url ?? null,
  }
}

/**
 * Um toque de paginacao: ate quatro paginas, parando por `paging.next`.
 *
 * **A parada e `paging.next`, e nao a contagem de itens** (§12.5, e e uma das
 * treze garantias MID): receber menos itens que o `limit` NAO significa fim de
 * lista, e parar por contagem deixaria Reels de fora sem ninguem perceber.
 *
 * **O cursor nunca vai para o D1** (§12.5): ele volta num campo escondido do
 * formulario e morre com a tela. Cursores sao temporarios, e guarda-los e bug
 * futuro.
 *
 * Custo: no maximo `PAGINAS_POR_TOQUE` subrequests. O laco para antes quando ja
 * juntou `REELS_POR_TOQUE`, que e o caso comum de quem so posta Reel.
 */
export async function buscarPagina(
  env: Env,
  cursor: string | null,
  deps: DependenciasDeMidias = DEPENDENCIAS_DE_MIDIAS,
): Promise<ResultadoDaListagem> {
  const conta = await loadAccessToken(env)
  if (conta === null) return { ok: false, motivo: 'sem_conta' }

  const api = deps.criarApi(env, conta.token)
  const reels: ReelDaListagem[] = []
  let depois = cursor
  let paginas = 0

  while (paginas < PAGINAS_POR_TOQUE) {
    const resposta = await api.listMedia(depois === null ? {} : { after: depois })
    paginas++

    // Falha da Meta no MEIO de um toque nao vira meia-lista: §9.7 nao deixa
    // salvar a selecao a partir de uma listagem que nao carregou, e entregar
    // as duas primeiras paginas como se fossem a lista inteira seria
    // exatamente isso, sem a tarja que avisa.
    if (!resposta.ok) return { ok: false, motivo: 'falha_meta' }

    reels.push(...reelsDaPagina(resposta.data))

    // **`paging.next` sumiu: acabou.** E o unico fim de lista que existe aqui.
    depois = cursorSeguinte(resposta.data)
    if (depois === null) return { ok: true, reels, proximoCursor: null, paginas }

    if (reels.length >= REELS_POR_TOQUE) break
  }

  return { ok: true, reels, proximoCursor: depois, paginas }
}

// ---------------------------------------------------------------------------
// O cache da listagem (§12.5, §12.1 regra 5)
// ---------------------------------------------------------------------------

/**
 * Quanto tempo a listagem vale antes de a tela buscar de novo (§12.5, `[I]`).
 *
 * §12.1 regra 5 e `[C]`-dura: "sem auto-refresh, sem polling, **sem buscar
 * lista a cada render**. Atualizar e sempre um botao explicito." Ate esta
 * rodada todo `GET /painel/reels` gastava ate quatro chamadas a Meta, e o botao
 * que a spec nomeia nao existia em tela nenhuma — duas frases renderizadas
 * mandavam toca-lo.
 */
export const CACHE_DA_LISTAGEM_MS = 10 * 60 * 1000

/** A listagem guardada, com o instante em que ela foi buscada. */
export interface ListagemGuardada {
  readonly em: number
  readonly listagem: ResultadoDaListagem
}

/**
 * O cache por ISOLATE, como o da configuracao (§9.6).
 *
 * Nao vai para o D1: uma listagem e um retrato temporario da conta, e §12.5 ja
 * proibe guardar `thumbnail_url` e o cursor no banco pela mesma razao.
 */
let guardada: ListagemGuardada | null = null

/**
 * Esquece a listagem guardada.
 *
 * Chamada pelo botao Atualizar — que e o que §12.5 chama de "o botao explicito"
 * — e pelo `beforeEach` das suites, do mesmo jeito que `invalidarCacheDeConfig`.
 */
export function esquecerAListagem(): void {
  guardada = null
}

/**
 * A primeira pagina da listagem, do cache quando ele ainda vale.
 *
 * **A falha da Meta TAMBEM e guardada**, e a escolha e deliberada: uma falha
 * custa a mesma cota que um acerto, e re-buscar a cada render seria exatamente
 * o "buscar lista a cada render" que §12.1 regra 5 proibe — com a instalacao
 * pagando mais justamente quando a Meta esta ruim. A tela nao fica presa: ela
 * diz de quando e a lista e oferece o botao Atualizar, que ignora o cache.
 */
export async function primeiraPagina(
  env: Env,
  now: number,
  deps: DependenciasDeMidias = DEPENDENCIAS_DE_MIDIAS,
  opcoes: { ignorarCache?: boolean } = {},
): Promise<ListagemGuardada> {
  const valida = guardada !== null && now - guardada.em < CACHE_DA_LISTAGEM_MS
  if (opcoes.ignorarCache !== true && valida && guardada !== null) return guardada

  const nova: ListagemGuardada = { em: now, listagem: await buscarPagina(env, null, deps) }
  guardada = nova
  return nova
}

/** Os Reels de UMA pagina, ja filtrados no Worker e com o id em texto. */
function reelsDaPagina(pagina: MediaListResponse): ReelDaListagem[] {
  const achados: ReelDaListagem[] = []
  for (const item of pagina.data ?? []) {
    if (!ehReel(item)) continue
    const reel = comoReel(item)
    if (reel !== null) achados.push(reel)
  }
  return achados
}

/**
 * O cursor da proxima pagina, ou `null` quando acabou.
 *
 * `paging.next` e quem diz que acabou; `paging.cursors.after` e o valor que a
 * proxima chamada usa. Sem `next`, nao ha proxima — mesmo que `after` venha.
 */
function cursorSeguinte(pagina: MediaListResponse): string | null {
  if (pagina.paging?.next === undefined) return null
  return pagina.paging.cursors?.after ?? null
}

// ---------------------------------------------------------------------------
// O estado EFETIVO de um Reel (§9.4, §9.9)
// ---------------------------------------------------------------------------

/**
 * A config efetiva daquele Reel: a global com a sobreposicao por cima.
 *
 * E o `antes`/`depois` que o funil registra quando a gravacao e sobre UM Reel
 * (Ruling 91): §9.9 pede o "estado COMPLETO da entidade afetada", e a entidade
 * afetada aqui e o comportamento daquele Reel, nao a linha da tabela.
 *
 * A mesclagem e a MESMA de `resolveConfigForMedia` — `{ ...global, ...patch }`
 * —, e por isso ela mora ao lado da leitura e nao numa segunda grafia: uma
 * mesclagem propria da tela mostraria ao dono um valor que o webhook nao usa.
 */
export function estadoEfetivo(
  global: AutomationConfig,
  sobreposicao: Sobreposicao,
): EstadoDeComportamento {
  const base = estadoDaConfig(global)
  const patch: Partial<EstadoDeComportamento> = {}

  // Um `if` por coluna, e nunca um laco com `?? undefined`: `{ x: undefined }`
  // num spread ZERA o campo global (§9.3), que e o defeito que o parser do
  // banco mata na leitura e que uma tela nao pode reintroduzir.
  if (sobreposicao.enabled !== null) patch.enabled = sobreposicao.enabled === 1
  if (sobreposicao.case_sensitive !== null) patch.caseSensitive = sobreposicao.case_sensitive === 1
  if (sobreposicao.normalize_accents !== null) {
    patch.normalizeAccents = sobreposicao.normalize_accents === 1
  }
  if (sobreposicao.ignore_punctuation !== null) {
    patch.ignorePunctuation = sobreposicao.ignore_punctuation === 1
  }
  if (sobreposicao.process_only_reels !== null) {
    patch.processOnlyReels = sobreposicao.process_only_reels === 1
  }
  if (sobreposicao.public_reply_enabled !== null) {
    patch.publicReplyEnabled = sobreposicao.public_reply_enabled === 1
  }
  if (sobreposicao.private_reply_enabled !== null) {
    patch.privateReplyEnabled = sobreposicao.private_reply_enabled === 1
  }
  if (sobreposicao.match_mode !== null) {
    patch.matchMode = sobreposicao.match_mode as EstadoDeComportamento['matchMode']
  }
  if (sobreposicao.public_reply_text !== null) {
    patch.publicReplyText = String(sobreposicao.public_reply_text)
  }
  if (sobreposicao.private_reply_text !== null) {
    patch.privateReplyText = String(sobreposicao.private_reply_text)
  }
  if (sobreposicao.destination_url !== null) {
    patch.destinationUrl = String(sobreposicao.destination_url)
  }
  if (sobreposicao.user_cooldown_hours !== null) {
    patch.userCooldownHours = Number(sobreposicao.user_cooldown_hours)
  }
  if (sobreposicao.trigger_keywords !== null) {
    const lista = lerGatilhosGuardados(String(sobreposicao.trigger_keywords))
    if (lista !== null) patch.triggerKeywords = lista
  }

  return { ...base, ...patch }
}

/** A lista de gatilhos guardada na coluna, ou `null` quando ela nao presta. */
function lerGatilhosGuardados(bruto: string): string[] | null {
  try {
    const lido: unknown = JSON.parse(bruto)
    if (!Array.isArray(lido) || lido.some((item) => typeof item !== 'string')) return null
    return lido as string[]
  } catch {
    return null
  }
}

/** O que a tela sabe de UMA linha de `painel_midias`. */
export interface MidiaSalva {
  readonly mediaId: string
  readonly ativo: boolean
  readonly legendaCurta: string | null
  readonly permalink: string | null
  readonly indisponivelDesde: number | null
  readonly sobreposicao: Sobreposicao
  readonly regrasProprias: boolean
}

/** Uma linha do banco no vocabulario da tela. */
export function comoMidiaSalva(linha: PainelMidiaRecord): MidiaSalva {
  const sobreposicao = sobreposicaoDaLinha(linha)
  return {
    mediaId: linha.media_id,
    ativo: linha.ativo === 1,
    legendaCurta: linha.legenda_curta,
    permalink: linha.permalink,
    indisponivelDesde: linha.indisponivel_desde,
    sobreposicao,
    regrasProprias: temRegrasProprias(sobreposicao),
  }
}
