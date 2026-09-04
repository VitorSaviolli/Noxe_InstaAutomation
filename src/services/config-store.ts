/**
 * De onde a automacao tira a configuracao efetiva.
 *
 * `src/config.ts` continua sendo a FABRICA e nao muda nada (§9.1): ele e o
 * estado bem definido "o painel ainda nao existe", e e o que torna a
 * atualizacao de quem ja usa o projeto byte-identica ao comportamento de
 * hoje. Este arquivo e a camada que le o D1 por cima dela.
 *
 * A propriedade que este modulo existe para garantir, e que vale em todos os
 * caminhos: **erro nunca alarga, e erro nunca inventa um valor que o dono nao
 * viu na tela.** Configuracao corrompida faz a automacao PARAR — nenhum campo
 * invalido e substituido por valor de fabrica com a automacao rodando (§9.2).
 *
 * Os sete estados possiveis, todos exercitados pelas garantias CFG-01 a
 * CFG-18:
 *
 * | Estado do banco            | Resultado                                     |
 * |----------------------------|-----------------------------------------------|
 * | linha ausente              | fabrica, `origem: 'arquivo'`                  |
 * | tabela inexistente         | idem, mais `console.error`                    |
 * | linha presente e valida    | banco, `origem: 'banco'`                      |
 * | qualquer campo invalido    | fabrica desligada, `origem: 'parado_por_erro'` |
 * | erro de D1                 | idem, cacheado com o TTL longo                |
 * | linha de midia invalida    | aquela midia recebe `{ enabled: false }`      |
 * | linhas de midia orfas      | ignoradas, com aviso                          |
 */
import { type AutomationConfig, automationConfig, type MediaAutomation } from '../config'
import {
  type LeituraDeConfig,
  type PainelConfigRecord,
  PainelConfigRepository,
  type PainelMidiaRecord,
} from '../repositories/painel-config-repository'
import type { Env } from '../types/env'
import { type Achado, ehMediaIdValido, type Validacao, validarConfig } from './config-validation'

/** De onde a configuracao servida neste instante veio. */
export type OrigemConfig = 'arquivo' | 'banco' | 'parado_por_erro'

export interface SnapshotConfig {
  readonly global: AutomationConfig
  readonly overrides: readonly MediaAutomation[]
  readonly origem: OrigemConfig
  /** Carimbo monotonico de TODA a configuracao. `0` quando ela vem do arquivo. */
  readonly versao: number
  /** Achados do validador na leitura. Vao para a tela, nao para o webhook. */
  readonly avisos: readonly string[]
}

/**
 * Ligado: janela curta, porque servir "ligado" desatualizado e a direcao
 * perigosa. E a janela em que uma parada de emergencia ainda pode nao ter
 * alcancado um isolate quente.
 */
export const TTL_LIGADO_MS = 10_000

/**
 * Desligado: janela longa, porque servir "parado" desatualizado nunca causa
 * dano — e economiza exatamente quando o sistema mais precisa. O preco e que
 * religar demora ate um minuto para valer em todos os isolates, e a tela diz
 * isso. E tambem o TTL do snapshot de falha (CFG-18): `parado_por_erro` tem
 * `enabled: false`, entao ele cai neste ramo sem precisar de caso especial —
 * um banco que ja esta caindo nao pode ser martelado a cada invocacao.
 */
export const TTL_DESLIGADO_MS = 60_000

/** Marca de `allowedMediaIds` que libera qualquer midia. */
const CURINGA = '*'

/** Cache do isolate. Vive enquanto o isolate viver; some no proximo deploy. */
let cache: { snapshot: SnapshotConfig; expiraEm: number } | null = null

/**
 * A configuracao efetiva deste instante.
 *
 * Chamada UMA vez por lote (§9.5), nunca por comentario: com o D1 no meio,
 * uma chamada por comentario viraria N leituras e um snapshot inconsistente
 * dentro do mesmo lote.
 *
 * O painel sempre chama com `ignorarCache: true`: salvar e a tela mostrar o
 * valor antigo destroi a confianca de um leigo mais rapido que qualquer bug.
 */
export async function carregarConfigEfetiva(
  env: Env,
  now: number,
  opcoes: { ignorarCache?: boolean } = {},
): Promise<SnapshotConfig> {
  if (!opcoes.ignorarCache && cache !== null && now < cache.expiraEm) return cache.snapshot

  const snapshot = await lerEValidar(env)
  const ttl = snapshot.global.enabled ? TTL_LIGADO_MS : TTL_DESLIGADO_MS
  cache = { snapshot: congelarFundo(snapshot), expiraEm: now + ttl }

  return cache.snapshot
}

/**
 * Descarta o cache DESTE isolate.
 *
 * Chamada por toda rota que grava e pelo `beforeEach` dos testes: sem isso um
 * teste que usa `AGORA` deixa um cache "valido ate o futuro" que contamina o
 * teste seguinte.
 */
export function invalidarCacheDeConfig(): void {
  cache = null
}

// ---------------------------------------------------------------------------
// Leitura e julgamento
// ---------------------------------------------------------------------------

async function lerEValidar(env: Env): Promise<SnapshotConfig> {
  let leitura: LeituraDeConfig
  try {
    leitura = await new PainelConfigRepository(env.DB).ler()
  } catch (cause) {
    return doErroDeLeitura(cause)
  }

  if (leitura.config === null) {
    // CFG-01 e CFG-17. Nao e conserto de invalido: e o estado bem definido "o
    // painel ainda nao existe". Linhas de midia sem linha global sao ORFAS — honra-las
    // misturaria global-do-arquivo com sobreposicao-do-banco, e misturar
    // alarga.
    const avisos =
      leitura.midias.length > 0
        ? ['painel_midias: ha midias selecionadas sem configuracao global; elas foram ignoradas.']
        : []
    return daFabrica('arquivo', 0, avisos)
  }

  const global = lerGlobal(leitura.config, leitura.midias)
  if (!global.ok) return doValidadorReprovado(leitura.config, global.achados)

  return {
    global: global.valor,
    overrides: leitura.midias.map((midia) => sobreposicaoDaLinha(midia, global.valor)),
    origem: 'banco',
    versao: leitura.config.versao,
    avisos: [],
  }
}

/**
 * A fabrica, opcionalmente desligada. Trava de CFG-01, CFG-07 e CFG-14.
 *
 * O snapshot degradado continua sendo uma `AutomationConfig` COMPLETA e bem
 * formada: e isso que mantem `processComment` — documentada como funcao que
 * nunca lanca — sem lancar mesmo com a linha do banco corrompida (CFG-07).
 *
 * Os dois arrays sao COPIADOS: o snapshot e congelado em profundidade, e
 * congelar as listas de `automationConfig` mexeria num modulo que a spec
 * manda deixar intacto.
 */
function daFabrica(
  origem: OrigemConfig,
  versao: number,
  avisos: readonly string[],
): SnapshotConfig {
  return {
    global: {
      ...automationConfig,
      triggerKeywords: [...automationConfig.triggerKeywords],
      allowedMediaIds: [...automationConfig.allowedMediaIds],
      ...(origem === 'parado_por_erro' ? { enabled: false } : {}),
    },
    overrides: [],
    origem,
    versao,
    avisos,
  }
}

/**
 * Reconhece a migration que ainda nao foi aplicada. Trava de CFG-15, e a
 * pendencia 14 de §15.2: a defesa principal e a ordem do deploy, nao a string.
 */
const TABELA_INEXISTENTE = /no such table/i

/**
 * Erro na leitura do D1.
 *
 * Duas causas com tratamentos diferentes. Migration nao aplicada e um estado
 * ESPERADO durante um deploy fora de ordem: a automacao segue com a fabrica,
 * exatamente como antes de o painel existir. Qualquer outro erro de D1 e
 * banco caindo, e ai a automacao PARA — nao da para afirmar que a config
 * servida e a que o dono viu na tela.
 *
 * Reconhecer o primeiro caso pela mensagem e frágil e nao e a defesa
 * principal: a defesa e a ordem documentada do deploy, migration antes do
 * codigo. Por isso nada elaborado e construido sobre esta string.
 */
function doErroDeLeitura(cause: unknown): SnapshotConfig {
  const mensagem = cause instanceof Error ? cause.message : String(cause)

  if (TABELA_INEXISTENTE.test(mensagem)) {
    console.error(
      'Tabelas do painel ausentes: aplique as migrations antes de publicar o codigo. ' +
        'A automacao segue com a configuracao do arquivo.',
    )
    return daFabrica('arquivo', 0, [
      'banco: as tabelas do painel ainda nao existem; a automacao esta usando a configuracao do arquivo.',
    ])
  }

  console.error('Falha ao ler a configuracao no D1. A automacao esta parada por seguranca.')
  return daFabrica('parado_por_erro', 0, [
    'banco: nao foi possivel ler a configuracao; a automacao esta parada por seguranca.',
  ])
}

/**
 * A linha existe e o validador reprovou. Trava de CFG-02 e de CFG-14.
 *
 * A automacao para com a fabrica DESLIGADA, e nenhum campo da linha e
 * aproveitado: um unico campo invalido significa que a tela e o webhook podem
 * discordar, e entregar um link diferente do que a tela mostra e pior que nao
 * entregar nada. Os codigos vao para o log; os valores, nunca.
 */
function doValidadorReprovado(
  linha: PainelConfigRecord,
  achados: readonly Achado[],
): SnapshotConfig {
  console.warn(
    'Configuracao do painel recusada na leitura:',
    achados.map((achado) => `${achado.campo}/${achado.codigo}`).join(', '),
  )

  const versao = Number.isInteger(linha.versao) && linha.versao >= 1 ? linha.versao : 0
  return daFabrica('parado_por_erro', versao, achados.map(comoAviso))
}

function comoAviso(achado: Achado): string {
  return `${achado.campo}: ${achado.mensagem}`
}

// ---------------------------------------------------------------------------
// O parser: nenhuma conversao pode "consertar" um valor
// ---------------------------------------------------------------------------

/**
 * `0` e `1` viram booleano; QUALQUER outra coisa vira `null`. Trava de CFG-03.
 *
 * Um `row.x === 1` solto transformaria um `2` em `false` — um conserto
 * silencioso, e justamente na direcao que ninguem pediu.
 */
function lerBooleano(valor: unknown): boolean | null {
  if (valor === 0) return false
  if (valor === 1) return true
  return null
}

/** Texto JSON que precisa ser uma lista. Devolve `null` quando nao e. */
function lerListaJson(texto: string): unknown[] | null {
  try {
    const valor: unknown = JSON.parse(texto)
    return Array.isArray(valor) ? valor : null
  } catch {
    return null
  }
}

/**
 * Le os sete booleanos da linha global.
 *
 * Devolve o nome do primeiro campo que nao e `0` nem `1`, porque a mensagem
 * na tela precisa NOMEAR o campo. Escrito campo a campo, sem laco e sem
 * cast: este e o arquivo em que o banco vira comportamento, e cada conversao
 * precisa ser legivel numa leitura.
 */
function lerBooleanosGlobais(
  linha: PainelConfigRecord,
): { ok: true; valor: BooleanosDaConfig } | { ok: false; campo: string } {
  const lidos = {
    enabled: lerBooleano(linha.enabled),
    caseSensitive: lerBooleano(linha.case_sensitive),
    normalizeAccents: lerBooleano(linha.normalize_accents),
    ignorePunctuation: lerBooleano(linha.ignore_punctuation),
    processOnlyReels: lerBooleano(linha.process_only_reels),
    publicReplyEnabled: lerBooleano(linha.public_reply_enabled),
    privateReplyEnabled: lerBooleano(linha.private_reply_enabled),
  }

  for (const [campo, valor] of Object.entries(lidos)) {
    if (valor === null) return { ok: false, campo }
  }

  return { ok: true, valor: lidos as BooleanosDaConfig }
}

type BooleanosDaConfig = Pick<
  AutomationConfig,
  | 'enabled'
  | 'caseSensitive'
  | 'normalizeAccents'
  | 'ignorePunctuation'
  | 'processOnlyReels'
  | 'publicReplyEnabled'
  | 'privateReplyEnabled'
>

/**
 * Monta a config global a partir da linha, e a submete ao validador unico.
 *
 * `allowedMediaIds` e DERIVADO aqui (§9.4): `'todas'` vira `['*']`,
 * `'selecionadas'` vira a uniao dos `media_id` ativos. Nao existe campo
 * gravavel com esse nome, e e isso que mata por construcao a armadilha da
 * sobreposicao que nunca dispara porque o Reel ficou de fora da lista global.
 *
 * Colunas que este codigo nao conhece nao aparecem aqui: elas sao descartadas
 * em silencio (CFG-04), para que uma migration futura possa acrescentar
 * coluna sem derrubar um Worker antigo que ainda esteja no ar.
 */
function lerGlobal(
  linha: PainelConfigRecord,
  midias: readonly PainelMidiaRecord[],
): Validacao<AutomationConfig> {
  const gatilhos = lerListaJson(linha.trigger_keywords)
  if (gatilhos === null) {
    return recusa(
      'triggerKeywords',
      'gatilhos_ilegiveis',
      'A lista de palavras-gatilho gravada no banco nao pode ser lida.',
    )
  }

  if (linha.media_scope !== 'todas' && linha.media_scope !== 'selecionadas') {
    return recusa(
      'mediaScope',
      'escopo_desconhecido',
      'O alcance das midias precisa ser "todas" ou "selecionadas".',
    )
  }

  const booleanos = lerBooleanosGlobais(linha)
  if (!booleanos.ok) {
    return recusa(
      booleanos.campo,
      'nao_e_booleano',
      `O campo ${booleanos.campo} gravado no banco nao e sim nem nao.`,
    )
  }

  return validarConfig({
    ...booleanos.valor,
    triggerKeywords: gatilhos as string[],
    matchMode: linha.match_mode as AutomationConfig['matchMode'],
    allowedMediaIds:
      linha.media_scope === 'todas' ? [CURINGA] : midias.map((midia) => midia.media_id),
    publicReplyText: linha.public_reply_text,
    privateReplyText: linha.private_reply_text,
    destinationUrl: linha.destination_url,
    userCooldownHours: linha.user_cooldown_hours,
  })
}

function recusa(campo: string, codigo: string, mensagem: string): Validacao<AutomationConfig> {
  return { ok: false, achados: [{ campo, codigo, mensagem }] }
}

/**
 * Uma linha de midia vira UMA entrada com UM `mediaId`. Trava de CFG-16.
 *
 * `resolveConfigForMedia` nao muda de assinatura e o `.find()` dela passa a
 * ser deterministico por construcao — `media_id` e PRIMARY KEY, entao duas
 * entradas citando o mesmo Reel deixam de ser representaveis (CFG-10).
 *
 * Linha invalida NAO e descartada: descartar ALARGARIA, porque a linha podia
 * ser justamente o que estreitava. Ela vira `{ enabled: false }`, que pausa
 * aquela midia e deixa as outras seguirem.
 */
function sobreposicaoDaLinha(linha: PainelMidiaRecord, global: AutomationConfig): MediaAutomation {
  const pausada: MediaAutomation = { mediaIds: [linha.media_id], enabled: false }

  if (!ehMediaIdValido(linha.media_id)) return pausada

  const patch = patchDaLinha(linha)
  if (patch === null) return pausada

  // A sobreposicao e julgada JA MESCLADA sobre a global: e a config mesclada
  // que decide o comportamento, e um `contains` com gatilho curto so aparece
  // depois da mesclagem.
  if (!validarConfig({ ...global, ...patch }).ok) return pausada

  return { mediaIds: [linha.media_id], ...patch }
}

/**
 * `NULL` vira CHAVE AUSENTE, nunca `undefined` (§9.3). Trava de CFG-05 e CFG-06.
 *
 * `{ destinationUrl: undefined }` num spread ZERA o campo global e leva
 * `isDestinationUrlConfigured` a lancar `TypeError` dentro de
 * `processComment`, documentada como funcao que nunca lanca. Por isso e um
 * `if` por coluna, sem excecao — e nunca um `?? undefined`.
 *
 * Devolve `null` quando alguma coluna tem valor que este codigo nao sabe
 * converter sem inventar. `enabled` so pode chegar como `0`: o `CHECK` da
 * migration recusa `1`, para que uma sobreposicao nunca derrote a parada de
 * emergencia.
 */
function patchDaLinha(linha: PainelMidiaRecord): Partial<AutomationConfig> | null {
  const patch: Partial<AutomationConfig> = {}

  const booleanosOk =
    aplicarBooleano(patch, 'enabled', linha.enabled) &&
    aplicarBooleano(patch, 'caseSensitive', linha.case_sensitive) &&
    aplicarBooleano(patch, 'normalizeAccents', linha.normalize_accents) &&
    aplicarBooleano(patch, 'ignorePunctuation', linha.ignore_punctuation) &&
    aplicarBooleano(patch, 'processOnlyReels', linha.process_only_reels) &&
    aplicarBooleano(patch, 'publicReplyEnabled', linha.public_reply_enabled) &&
    aplicarBooleano(patch, 'privateReplyEnabled', linha.private_reply_enabled)
  if (!booleanosOk) return null

  if (linha.trigger_keywords !== null) {
    const gatilhos = lerListaJson(linha.trigger_keywords)
    if (gatilhos === null) return null
    patch.triggerKeywords = gatilhos as string[]
  }
  if (linha.match_mode !== null) patch.matchMode = linha.match_mode as AutomationConfig['matchMode']
  if (linha.public_reply_text !== null) patch.publicReplyText = linha.public_reply_text
  if (linha.private_reply_text !== null) patch.privateReplyText = linha.private_reply_text
  if (linha.destination_url !== null) patch.destinationUrl = linha.destination_url
  if (linha.user_cooldown_hours !== null) patch.userCooldownHours = linha.user_cooldown_hours

  return patch
}

/**
 * Uma coluna booleana de sobreposicao.
 *
 * `null` na coluna nao escreve chave nenhuma — e o `if` por coluna de §9.3,
 * so que num lugar so. Devolve `false` quando o valor nao e `0` nem `1`, para
 * o chamador recusar a linha inteira em vez de inventar um booleano.
 */
function aplicarBooleano(
  patch: Partial<AutomationConfig>,
  campo: keyof BooleanosDaConfig,
  bruto: number | null,
): boolean {
  if (bruto === null) return true

  const valor = lerBooleano(bruto)
  if (valor === null) return false

  Object.assign(patch, { [campo]: valor })
  return true
}

// ---------------------------------------------------------------------------
// Congelamento
// ---------------------------------------------------------------------------

/**
 * Congelamento em profundidade, obrigatorio antes de entrar no cache.
 *
 * `{ ...global }` de `resolveConfigForMedia` e copia RASA: os arrays continuam
 * sendo a mesma referencia do cache. Sem `Object.freeze` nos arrays, um
 * consumidor que fizesse `config.triggerKeywords.push(...)` envenenaria o
 * isolate inteiro. Hoje ninguem muta — o congelamento e o que garante que
 * continue assim.
 */
function congelarFundo(snapshot: SnapshotConfig): SnapshotConfig {
  Object.freeze(snapshot.global.triggerKeywords)
  Object.freeze(snapshot.global.allowedMediaIds)
  Object.freeze(snapshot.global)

  for (const override of snapshot.overrides) {
    Object.freeze(override.mediaIds)
    if (override.triggerKeywords !== undefined) Object.freeze(override.triggerKeywords)
    Object.freeze(override)
  }
  Object.freeze(snapshot.overrides)
  Object.freeze(snapshot.avisos)

  return Object.freeze(snapshot)
}
