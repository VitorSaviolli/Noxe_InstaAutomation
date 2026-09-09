/**
 * `GET /painel/atividade` — "O que aconteceu", com a lista e o @ ao vivo.
 *
 * §3 quer tres coisas nesta tela: os tres estados grandes, as pendencias com
 * botao, e a lista dos ultimos comentarios atendidos com o @ de quem acionou
 * **buscado ao vivo na Graph API, sem armazenar nada de novo** (§2.3, §12.6).
 * As tres estao aqui.
 *
 * **Armazenamento novo: nenhum.** O `username` nao vai para o D1, nao entra em
 * Cache API, nao entra em cache de isolate — nao existe uma variavel de modulo
 * neste arquivo — e nao vai para o `console` nem para `painel_auditoria`. Ele
 * vive durante a montagem desta resposta e morre com ela. E isso que mantem o
 * cabecalho de `src/index.ts` verdadeiro **sem ressalva**, e e por isso que a
 * promessa e literal e testavel em vez de ser uma intencao.
 *
 * **Esta tela nunca escreve em `processed_comments`, e le uma vez so** (§6: o
 * painel le, nao age; §16.6: nenhum indice novo naquela tabela, nunca). A
 * consulta e a de §12.6, com colunas nomeadas, e ela nao traz
 * `commenter_scoped_id_hash`: o hash do autor existe para o intervalo por
 * pessoa e nao tem nada que fazer numa tela.
 *
 * **O aviso de §12.6 sobe SEMPRE, inclusive com a lista vazia.** Ele nao
 * descreve a lista: descreve o que o programa NAO guarda. Todo `skipped` de
 * `processComment` acontece antes do unico `INSERT` da tabela, e a decisao
 * tomada em §12.6 e nao passar a gravar linha para comentario ignorado — um
 * Reel que viraliza com 5.000 comentarios fora da regra passaria a custar 5.000
 * escritas por nada, no recurso que §5.2 protege. Sem essa frase, quem abre
 * esta tela conclui que a automacao deixou de responder alguem.
 *
 * **Os @ so saem com um toque, e o toque e o de §2.3.** A abertura simples
 * mostra a lista com a data e o resultado de cada linha e **zero** chamada a
 * Meta; o botao "Atualizar" e que gasta a cota — a mesma cota de 24 h que a
 * automacao usa para responder. Sem auto-refresh, sem polling, e teto de 20
 * linhas por pagina. Um @ carregado a cada render transformaria abrir a tela
 * num custo de envio.
 *
 * **A rota continua `GET` unico** (`rotas.ts`: "hoje e sempre: ela so le").
 * §12.6 desenha o "Ver mais" como um POST com o cursor num campo escondido, e
 * aqui ele e um `GET` com o cursor na query string pela razao que a propria
 * tabela de rotas escreve: um POST nesta rota exigiria `csrf: true` e um
 * `escreve` que mentiria — ela nao grava nada. O cursor e a POSICAO da ultima
 * linha da pagina — o `created_at` dela **e** o `comment_id` dela, porque so o
 * instante nao e unico e sozinho ele pulava linha (veja `PosicaoDaPagina`) —,
 * nao e segredo e nao muda estado; `/painel/reel?midia=` ja e o precedente de
 * identificador em query string, e nenhum caminho ganha segmento variavel.
 */
import type { CommentStatus } from '../../repositories/comments-repository'
import { HOST_GRAPH } from '../../services/meta-api'
import { loadAccessToken } from '../../services/token-manager'
import type { Env } from '../../types/env'
import { CAMPO_DA_ACAO } from './campos'
import { dataEmPortugues, resultadoNaTela } from './dicionario'
import { type HtmlSeguro, html } from './html'
import {
  blocoDeAvisos,
  blocoDeEstado,
  blocoDeFabrica,
  blocoDePendencias,
  configDaTela,
  contaConectada,
  molduraCom,
  panorama,
} from './inicio'
import { erro } from './resposta'
import { ROTA_ATIVIDADE } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

// ---------------------------------------------------------------------------
// Os numeros, e a conta que os sustenta (§12.6)
// ---------------------------------------------------------------------------

/**
 * Quantas linhas uma pagina mostra, e quantas chamadas a Meta ela pode gastar.
 *
 * Vinte, e o numero e de PROJETO e nao de plataforma: o teto duro seriam ~44
 * linhas. As 20 existem para deixar folga no orcamento de subrequests e para
 * respeitar a cota de 24 h da Meta, que e a MESMA que a automacao usa para
 * enviar — 20 aberturas num dia ja sao 400 chamadas subtraidas do orcamento de
 * envio (§12.6).
 */
export const LINHAS_POR_PAGINA = 20

/**
 * Quantas chamadas a Meta saem ao mesmo tempo (§12.6).
 *
 * Seis, porque seis e o limite de conexoes simultaneas do runtime. Sequencial,
 * a ~300–800 ms por chamada, a tela levaria mais de dez segundos; todas de uma
 * vez, o runtime enfileiraria as excedentes e o ganho seria imaginario.
 */
export const ARROBAS_POR_BLOCO = 6

/** Teto de subrequests por invocacao. Cada consulta ao D1 tambem conta. */
const TETO_DE_SUBREQUESTS = 50

/**
 * A margem que o orcamento reserva (§12.6: `50 - consultasJaFeitas - 4`).
 *
 * Ela existe porque o numero de consultas ja feitas e uma conta escrita a mao:
 * uma consulta nova em `configDaTela`, ou um lote que vire dois, sairia do
 * radar desta constante. A margem e o que impede que essa defasagem vire um
 * estouro de teto em producao em vez de uma linha a menos com @.
 */
const MARGEM_DO_ORCAMENTO = 4

/**
 * O que esta tela ja gastou ao chegar na busca dos @ (§12.6).
 *
 * A conta de §12.6, tal como ela esta escrita: 1 (sessao) + 2 (configuracao e
 * midias) + 1 (o token da conta) + 1 (a consulta a `processed_comments`). O
 * numero real e **menor** — a configuracao e as midias viajam num unico
 * `db.batch()`, e um lote vale UM subrequest —, e a diferenca fica de proposito:
 * um orcamento que se declarasse mais barato do que a spec o orca so poderia
 * errar para o lado do estouro.
 */
export const CONSULTAS_DA_TELA = 5

/**
 * Quantos @ cabem no que sobrou do teto de subrequests.
 *
 * **O orcamento e conferido ANTES de disparar**, e nao descoberto no meio: com
 * N linhas na pagina, o total fica em `consultasJaFeitas + disponivel`, que
 * nunca passa de 46. As linhas que sobrarem aparecem com "@ indisponivel" — a
 * lista nunca encolhe por causa do orcamento, porque uma linha que some e a
 * unica coisa que esta tela nao pode fazer (§12.6).
 *
 * Funcao exportada e pura para ser afirmada direto, sem montar um cenario de 40
 * linhas: com o teto de 20 por pagina o ramo do clamp nao e alcancavel hoje, e
 * um teste que fingisse alcanca-lo por HTTP estaria medindo outra coisa.
 */
export function orcamentoDeArrobas(consultasJaFeitas: number): number {
  const disponivel = TETO_DE_SUBREQUESTS - consultasJaFeitas - MARGEM_DO_ORCAMENTO
  return disponivel < 0 ? 0 : disponivel
}

// ---------------------------------------------------------------------------
// A leitura do banco (§12.6, §16.6)
// ---------------------------------------------------------------------------

/**
 * Onde uma pagina COMECA: o instante da ultima linha da anterior, e o id dela.
 *
 * **O `comment_id` nao esta aqui para identificar ninguem: ele e o desempate.**
 * §12.6 desenha o cursor como o `created_at` da ultima linha, e sozinho ele
 * PERDE LINHA — `created_at` nao e unico nem de longe. `src/index.ts` calcula
 * `const now = Date.now()` uma vez por invocacao e o passa a todo `claimComment`
 * do laco; `deferForRetry` liga o mesmo `now` ao `created_at` de todas as linhas
 * do mesmo `db.batch()`. Um Reel que viraliza grava dezenas de linhas com
 * `created_at` identico ao milissegundo. Com `WHERE created_at < ?`, toda linha
 * que empatasse com a ultima da pagina ficava estritamente FORA da pagina
 * seguinte, e sumia da tela para sempre — sem aviso, e sem que nada no banco
 * tivesse se perdido. Era o defeito que o cabecalho deste arquivo diz que esta
 * tela existe para nao ter.
 *
 * O par `(created_at, comment_id)` e unico porque `comment_id` e PRIMARY KEY, e
 * a comparacao lexicografica dele e a mesma que ordena — cursor estavel, sem
 * `OFFSET`, sem pular e sem repetir.
 */
export interface PosicaoDaPagina {
  readonly criadoEm: number
  readonly commentId: string
}

/**
 * O comeco da lista: "um valor no futuro" (§12.6).
 *
 * `Number.MAX_SAFE_INTEGER` e nao `now + 1` de proposito. O `created_at` e
 * escrito pelo Worker, e uma linha gravada por um isolate com o relogio um
 * segundo a frente sumiria da primeira pagina em silencio — e a linha que some
 * e exatamente o defeito que esta tela existe para nao ter.
 *
 * O desempate e a string vazia, que e menor que todo `comment_id`: o segundo
 * ramo do `WHERE` nunca casa nada na primeira pagina, e o primeiro traz tudo.
 */
const INICIO_DA_LISTA: PosicaoDaPagina = {
  criadoEm: Number.MAX_SAFE_INTEGER,
  commentId: '',
}

/** O nome do cursor na query string. `created_at <` este valor. */
export const CAMPO_DO_CURSOR = 'desde'

/**
 * O desempate do cursor, na mesma query string.
 *
 * Ele viaja em campo proprio, e nao concatenado ao `desde`, para nao existir o
 * separador que um `comment_id` com aquele mesmo caractere quebraria. As duas
 * metades so valem JUNTAS (§9.2): meia posicao e endereco truncado, e o
 * conserto em silencio seria voltar a mostrar a pagina que pula linhas.
 */
export const CAMPO_DO_DESEMPATE = 'apos'

/**
 * O valor de `acao` que pede os @ (§2.3: "botao Atualizar explicito").
 *
 * So o NOME do campo sobe para `campos.ts`; o valor fica com a rota dona, que e
 * a regra que `CAMPO_DA_ACAO` escreve. `atualizar` e a mesma palavra que a tela
 * de Reels usa para o proprio botao, e nao a mesma constante: elas sao dois
 * espacos de nomes com a mesma grafia, e importar a de la amarraria esta tela a
 * uma decisao da outra.
 */
export const ATUALIZAR = 'atualizar'

/** O cursor so pode ser um inteiro. Qualquer outra coisa e recusa, nao conserto. */
const FORMA_DO_CURSOR = /^[0-9]{1,16}$/

/**
 * A forma do desempate. Um `comment_id` da Meta e digito; aceitamos um pouco
 * mais para nao recusar um id de uma versao futura da API, e nada que nao seja
 * um identificador. Ele vai LIGADO por `?`, nunca interpolado.
 */
const FORMA_DO_DESEMPATE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * A consulta de §12.6, palavra por palavra.
 *
 * **Colunas nomeadas, e nunca `SELECT *`.** A tabela tem
 * `commenter_scoped_id_hash`, que existe para o intervalo por pessoa e que
 * nenhuma consulta do painel pode retornar: um `SELECT *` traria o hash do
 * autor de cada linha para a memoria da tela, e a partir dai seria uma linha de
 * distancia de ele entrar num log de depuracao.
 *
 * **Sem indice, e a ausencia e decisao (§16.6).** Sem indice por `created_at` a
 * consulta varre a tabela — centenas de linhas por abertura numa conta pequena,
 * irrelevante contra os 5.000.000 de linhas lidas por dia do plano. Um indice
 * novo em `processed_comments` encareceria **cada INSERT do caminho quente**,
 * levando o custo de ~3 para ~4 escritas por comentario atendido. Se um dia
 * doer, a saida correta e uma tabela de contadores diarios escrita pelo cron.
 *
 * **O desempate por `comment_id` e o unico desvio do SQL de §12.6, e ele e
 * obrigatorio.** A consulta de la ordena so por `created_at DESC` e pagina com
 * `created_at < ?`; como um lote inteiro do webhook nasce com o MESMO
 * `created_at` (veja `PosicaoDaPagina`), essa forma pulava em silencio todas as
 * linhas empatadas com a ultima da pagina. `ORDER BY created_at DESC, comment_id
 * DESC` com o `WHERE` composto e a mesma pagina, na mesma ordem, sem o buraco. A
 * tabela nao ganhou indice nenhum — a varredura continua sendo a de §16.6.
 *
 * O `LIMIT` e interpolado a partir da constante deste modulo, e nao ligado por
 * `?`, para que o texto do statement diga `LIMIT 20` — e o que permite afirmar o
 * teto olhando o SQL que passou, do mesmo jeito que `comoListaSql` faz em
 * `comments-repository.ts`. Nenhuma entrada externa alcanca esta string: as duas
 * metades do cursor vao LIGADAS por `?`.
 */
const SQL_DAS_LINHAS = `SELECT comment_id, media_id, status, created_at, next_retry_at, last_error_code
  FROM processed_comments
 WHERE created_at < ? OR (created_at = ? AND comment_id < ?)
 ORDER BY created_at DESC, comment_id DESC
 LIMIT ${LINHAS_POR_PAGINA}`

/** Uma linha de `processed_comments` no vocabulario da tela. */
export interface LinhaAtendida {
  readonly commentId: string
  readonly mediaId: string
  /**
   * O `status` CRU da coluna, e nao `CommentStatus`.
   *
   * A coluna e TEXT: prometer o tipo estreito aqui seria afirmar sobre o banco
   * o que so o `INSERT` de hoje garante. Quem traduz e `resultadoNaTela`, que
   * recebe `string` pela mesma razao.
   */
  readonly status: string
  readonly criadoEm: number
  readonly proximaTentativaEm: number | null
  readonly ultimoErro: string | null
}

/** A linha como o D1 a devolve. Sem o hash do autor, porque a consulta nao o pede. */
interface LinhaCrua {
  readonly comment_id: string
  readonly media_id: string
  readonly status: string
  readonly created_at: number
  readonly next_retry_at: number | null
  readonly last_error_code: string | null
}

/**
 * Uma pagina de linhas atendidas, da mais nova para a mais velha.
 *
 * A falha e tratada como pagina vazia com aviso, e nao como `500`: o resto da
 * tela — os tres estados grandes e as pendencias — continua respondendo a
 * pergunta de §3 mesmo sem a lista, e derrubar a tela inteira por causa dela
 * seria trocar uma resposta parcial por nenhuma.
 */
async function lerLinhas(
  db: D1Database,
  posicao: PosicaoDaPagina,
): Promise<{ linhas: readonly LinhaAtendida[]; falhou: boolean }> {
  try {
    const resultado = await db
      .prepare(SQL_DAS_LINHAS)
      .bind(posicao.criadoEm, posicao.criadoEm, posicao.commentId)
      .all<LinhaCrua>()
    const linhas = (resultado.results ?? []).map((crua) => ({
      commentId: crua.comment_id,
      mediaId: crua.media_id,
      status: crua.status,
      criadoEm: crua.created_at,
      proximaTentativaEm: crua.next_retry_at,
      ultimoErro: crua.last_error_code,
    }))
    return { linhas, falhou: false }
  } catch (cause) {
    // §12.7: detalhe tecnico vai para o `console`, nunca para a tela. Uma linha
    // so, no formato de `despachar`, para nao amplificar log.
    console.warn(
      'painel:',
      'indisponivel',
      'atividade_nao_lida',
      cause instanceof Error ? cause.message : cause,
    )
    return { linhas: [], falhou: true }
  }
}

// ---------------------------------------------------------------------------
// A busca do @ (§12.6)
// ---------------------------------------------------------------------------

/**
 * O que a Graph API respondeu sobre UMA linha.
 *
 * Tres desfechos, e os tres mantem a linha na tela. `apagado` e o unico que
 * ganha frase propria, porque e o unico com explicacao honesta: o comentario
 * sumiu, o perfil sumiu ou a pessoa bloqueou a conta — as tres se parecem do
 * lado de ca e as tres significam a mesma coisa para quem le.
 */
export type ArrobaDaLinha =
  | { readonly tipo: 'arroba'; readonly username: string }
  | { readonly tipo: 'apagado' }
  | { readonly tipo: 'falhou' }

/** O que a tela injeta para nao tocar a rede em teste (§13.1). */
export interface DependenciasDaAtividade {
  readonly buscarArroba: (env: Env, token: string, commentId: string) => Promise<ArrobaDaLinha>
}

/** Timeout de cada chamada, igual ao de `meta-api.ts`. */
const TEMPO_MAXIMO_MS = 10_000

/**
 * Le o no do comentario e devolve o @ de quem o escreveu.
 *
 * `GET https://graph.instagram.com/{versao}/{comment_id}?fields=username`, com o
 * Bearer da conta. **O host sai da constante `HOST_GRAPH` de `meta-api.ts`, e
 * nao de uma string escrita aqui**: `graph.facebook.com` pertence ao fluxo com
 * Facebook Login e nao existe neste projeto, e uma segunda grafia do host seria
 * o lugar exato onde esse engano nasceria.
 *
 * **Pedimos `username`, e §12.6 escreve `username,timestamp`.** A tela nao
 * renderiza o `timestamp` do no: a data que ela mostra e o `created_at` da nossa
 * propria linha, que e o instante em que a automacao atendeu — e e ele que
 * continua na tela quando o @ nao vem. Pedir um campo que nao se renderiza seria
 * trazer para a memoria do isolate um dado de terceiro sem uso nenhum, e a
 * direcao desta tela inteira, de §2.3 em diante, e pedir menos.
 *
 * **O comentario apagado responde erro e a linha NAO some** (§12.6). A regra que
 * separa "apagado" de "nao deu para falar" e a mesma de `classify` em
 * `meta-api.ts` — `404`, ou `code 100` com `error_subcode 33` —, escrita aqui
 * porque aquela funcao nao e exportada. As duas grafias sao a mesma condicao, e
 * a daqui erra para o lado seguro: o que nao casar vira `falhou`, que mostra a
 * faixa em vez de afirmar que o comentario foi apagado.
 *
 * Nada nesta funcao escreve no `console`. Um `console.warn` com a resposta da
 * Meta publicaria o @ de um terceiro nos Workers Logs do dono — que e
 * exatamente a promessa de §2.3 quebrada pelo caminho mais banal.
 */
async function buscarArrobaNaMeta(
  env: Env,
  token: string,
  commentId: string,
): Promise<ArrobaDaLinha> {
  const url = `${HOST_GRAPH}/${env.META_API_VERSION}/${encodeURIComponent(commentId)}?fields=username`

  try {
    const resposta = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TEMPO_MAXIMO_MS),
    })

    if (!resposta.ok) {
      return (await ehObjetoInexistente(resposta)) ? { tipo: 'apagado' } : { tipo: 'falhou' }
    }

    const corpo = (await resposta.json()) as { username?: unknown }
    // Sem `username` no corpo o no existe mas nao diz quem escreveu — para quem
    // le a tela isso e indistinguivel de perfil apagado, e prometer o contrario
    // seria inventar.
    if (typeof corpo.username !== 'string' || corpo.username === '') return { tipo: 'apagado' }
    return { tipo: 'arroba', username: corpo.username }
  } catch {
    return { tipo: 'falhou' }
  }
}

/** `404`, ou `code 100` com `error_subcode 33` — a regra de `classify`. */
async function ehObjetoInexistente(resposta: Response): Promise<boolean> {
  if (resposta.status === 404) return true
  try {
    const corpo = (await resposta.json()) as {
      error?: { code?: unknown; error_subcode?: unknown }
    }
    return corpo.error?.code === 100 && corpo.error?.error_subcode === 33
  } catch {
    return false
  }
}

/** O de producao. O teste passa o duble por parametro; nada de mock de modulo. */
export const DEPENDENCIAS_DA_ATIVIDADE: DependenciasDaAtividade = {
  buscarArroba: buscarArrobaNaMeta,
}

/**
 * Por que os @ nao vieram — e as duas razoes NAO dizem a mesma coisa ao dono.
 *
 * `meta_muda` e transitorio: a ligacao esta de pe, o Instagram e que nao
 * respondeu agora, e a automacao continua enviando com o que ja esta salvo (a
 * linha de §12.7 para `falha_meta`). `ligacao_caida` e o oposto: sem conta
 * ligada, ou com a validade vencida, **nada e enviado** — e escrever ali "a sua
 * automacao continua funcionando normalmente" seria afirmar, na faixa, o
 * contrario do que a secao "A conta do Instagram" diz tres paragrafos acima, na
 * mesma pagina. §12.1 regra 3: a tela nao afirma o que nao e verdade.
 */
type MotivoDeNaoTerArroba = 'meta_muda' | 'ligacao_caida'

/** O que a busca dos @ devolveu para a renderizacao. */
interface BuscaDosArrobas {
  /** Houve toque em "Atualizar"? Sem ele, ZERO chamada a Meta (§2.3). */
  readonly pedida: boolean
  readonly porComentario: ReadonlyMap<string, ArrobaDaLinha>
  /** A faixa de §12.6, e qual das duas frases ela leva. `null` e sem faixa. */
  readonly semArrobas: MotivoDeNaoTerArroba | null
}

/**
 * Nenhum @ buscado: o estado da abertura simples.
 *
 * E uma FUNCAO, e nao uma constante de modulo, por uma razao que so parece
 * cosmetica: uma constante guardaria um `Map` vivo no escopo do modulo pela vida
 * inteira do isolate — a forma exata que um cache de @ tem. Este arquivo nao tem
 * variavel de modulo nenhuma, e ATV-09b afirma isso lendo o proprio fonte,
 * porque um cache so de ESCRITA nao aparece em resposta HTTP nenhuma.
 */
function semBusca(): BuscaDosArrobas {
  return { pedida: false, porComentario: new Map(), semArrobas: null }
}

/**
 * Os @ das linhas, em blocos de `ARROBAS_POR_BLOCO`, com o orcamento conferido
 * antes de a primeira chamada sair.
 *
 * **A falha geral nao quebra a tela** (§12.6): sem conta ligada, ou com a Graph
 * API muda, a lista sobe igual — com a data e o resultado de cada linha — e a
 * faixa explica por que os @ nao vieram. Nunca sem a lista.
 *
 * **Com a ligacao vencida nao sai chamada nenhuma, e a economia e o ponto.**
 * `loadAccessToken` devolve `{token, igUserId, expiresAt}` sem olhar a validade
 * — ele so devolve `null` quando nao existe linha em `account_tokens`. Sem
 * conferir o `expiresAt` aqui, esta tela disparava ate 20 chamadas com um Bearer
 * morto, sabendo que as 20 iam responder 401/190: 20 subrequests e 20 chamadas
 * subtraidas da cota de 24 h que a AUTOMACAO usa para enviar — a cota que o
 * botao explicito de §2.3 e a constante `ARROBAS_POR_BLOCO` existem para
 * racionar. E, como nenhuma delas casa `ehObjetoInexistente`, as 20 viravam
 * `falhou` e a tela terminava afirmando normalidade. A Meta nao renova ligacao
 * vencida: nao ha desfecho em que essas chamadas dessem certo.
 *
 * O `Map` devolvido morre com esta funcao: ele e passado para a montagem do HTML
 * e nada o guarda. Nao existe variavel de modulo neste arquivo, e a ausencia
 * dela e a garantia de §2.3 escrita em codigo.
 */
async function buscarArrobas(
  env: Env,
  deps: DependenciasDaAtividade,
  linhas: readonly LinhaAtendida[],
  now: number,
): Promise<BuscaDosArrobas> {
  const conta = await loadAccessToken(env)
  // O mesmo criterio de `contaConectada` (`expires_at > ?`), para as duas
  // metades desta pagina nao discordarem sobre o mesmo fato.
  if (conta === null || conta.expiresAt <= now) {
    return { pedida: true, porComentario: new Map(), semArrobas: 'ligacao_caida' }
  }

  const quantas = Math.min(linhas.length, orcamentoDeArrobas(CONSULTAS_DA_TELA))
  const alvos = linhas.slice(0, quantas).map((linha) => linha.commentId)

  const porComentario = new Map<string, ArrobaDaLinha>()
  let mudo = false

  for (let inicio = 0; inicio < alvos.length; inicio += ARROBAS_POR_BLOCO) {
    const bloco = alvos.slice(inicio, inicio + ARROBAS_POR_BLOCO)
    const respostas = await Promise.all(
      bloco.map((commentId) => deps.buscarArroba(env, conta.token, commentId)),
    )
    bloco.forEach((commentId, indice) => {
      const resposta = respostas[indice] ?? { tipo: 'falhou' as const }
      if (resposta.tipo === 'falhou') mudo = true
      porComentario.set(commentId, resposta)
    })
  }

  return { pedida: true, porComentario, semArrobas: mudo ? 'meta_muda' : null }
}

// ---------------------------------------------------------------------------
// As frases desta tela
// ---------------------------------------------------------------------------

/**
 * O que a tela escreve quando o @ nao veio.
 *
 * As tres sao frases de tela e ficam aqui, e nao no dicionario, pelo mesmo
 * criterio que `inicio.ts` e `palavras.ts` seguem: sobe para o dicionario a
 * frase que DUAS telas escrevem. Nenhuma outra tela fala de @.
 */
const SEM_ARROBA = {
  apagado: '@ indisponível — o comentário foi apagado',
  naoVeio: '@ indisponível',
  /** §12.6: a consequencia honesta, escrita na propria tela. */
  envelhece:
    'Quanto mais antiga a linha, maior a chance de o @ aparecer como indisponível: o comentário pode ter sido apagado, o perfil pode não existir mais, ou a pessoa pode ter bloqueado a sua conta. O resultado da linha continua valendo.',
} as const

/** A frase de cada motivo de falha de envio, para o `failed` de §12.6. */
const MOTIVO_DA_FALHA: Record<string, string> = {
  NETWORK: 'não conseguimos falar com o Instagram naquele momento',
  TOKEN_INVALIDO: 'a ligação com o Instagram tinha caído',
  NAO_AUTORIZADO: 'a ligação com o Instagram tinha caído',
  PROIBIDO: 'o Instagram não deixou enviar para essa pessoa',
  RATE_LIMIT: 'o Instagram pediu para esperar um pouco',
  OBJETO_INEXISTENTE: 'o comentário não existia mais',
  REQUISICAO_INVALIDA: 'o Instagram recusou o envio',
}

/**
 * O motivo em portugues, ou `null` quando nao ha motivo que valha a pena dizer.
 *
 * Um codigo desconhecido devolve `null` e a tela mostra so "Não conseguimos
 * enviar" — nunca o codigo cru. §12.7 e literal: detalhe tecnico vai para o
 * `console`, e o que a tela escreve sai de uma tabela fechada.
 */
function motivoDaFalha(codigo: string | null): string | null {
  if (codigo === null) return null
  return MOTIVO_DA_FALHA[codigo] ?? null
}

// ---------------------------------------------------------------------------
// A montagem da tela
// ---------------------------------------------------------------------------

/** O aviso obrigatorio de §12.6. Ele sobe SEMPRE, inclusive com a lista vazia. */
function avisoDoQueNaoAparece(): HtmlSeguro {
  return html`<section>
<h2>Sobre o que aparece aqui</h2>
<p>Aqui aparecem os coment&aacute;rios que a automa&ccedil;&atilde;o <strong>atendeu</strong>.
Coment&aacute;rios que ela ignorou &mdash; por n&atilde;o serem de um Reel da sua lista, por
n&atilde;o terem nenhuma das suas palavras, ou porque a pessoa j&aacute; tinha recebido &mdash;
n&atilde;o deixam registro, e por isso n&atilde;o aparecem aqui.</p>
</section>`
}

/** O `href` desta mesma tela, com o cursor e o pedido de @ que ela precisar. */
function enderecoDaTela(opcoes: { posicao?: PosicaoDaPagina; comArrobas?: boolean }): string {
  const busca = new URLSearchParams()
  if (opcoes.posicao !== undefined) {
    // As duas metades SEMPRE viajam juntas: `cursorPedido` recusa uma sozinha, e
    // um link que levasse so o instante voltaria a ser o cursor que pula linha.
    busca.set(CAMPO_DO_CURSOR, String(opcoes.posicao.criadoEm))
    busca.set(CAMPO_DO_DESEMPATE, opcoes.posicao.commentId)
  }
  if (opcoes.comArrobas === true) busca.set(CAMPO_DA_ACAO, ATUALIZAR)
  const query = busca.toString()
  return query === '' ? ROTA_ATIVIDADE.caminho : `${ROTA_ATIVIDADE.caminho}?${query}`
}

/**
 * O botao que busca os @, e a frase que diz o preco dele (§2.3, §12.6).
 *
 * Ele e um link, e nao um `<form>`, porque a rota e `GET` unico: um POST aqui
 * exigiria uma ficha e um `escreve` que mentiria sobre uma tela que so le. O
 * preco vai escrito ao lado — quem toca precisa saber que esta gastando a mesma
 * cota que a automacao usa para enviar.
 */
function botaoDosArrobas(busca: BuscaDosArrobas, posicao: PosicaoDaPagina | null): HtmlSeguro {
  if (busca.pedida) {
    return html`<p>Os @ desta p&aacute;gina foram buscados agora no Instagram, e n&atilde;o ficam
guardados em lugar nenhum.</p>`
  }

  const destino =
    posicao === null
      ? enderecoDaTela({ comArrobas: true })
      : enderecoDaTela({ posicao, comArrobas: true })

  return html`<p><a class="acao" href="${destino}">Ver quem comentou</a></p>
<p>Buscar os @ custa uma consulta ao Instagram por linha, da mesma cota que a
automa&ccedil;&atilde;o usa para enviar. Por isso ela s&oacute; acontece quando voc&ecirc; pede.</p>`
}

/**
 * A faixa de §12.6 quando os @ nao vieram. A lista continua inteira.
 *
 * Duas frases, porque sao dois fatos diferentes, e a tela nao pode escolher a
 * simpatica: com a ligacao caida **nada esta sendo enviado**, e a frase da Graph
 * API muda ("a sua automacao continua funcionando normalmente") seria uma
 * afirmacao falsa, na mesma pagina em que a secao da conta ja escreveu o
 * contrario. §12.1 regra 3, e a mesma razao pela qual a faixa nao esconde a
 * lista.
 */
function faixaDoInstagramMudo(busca: BuscaDosArrobas): HtmlSeguro {
  if (busca.semArrobas === null) return html``

  if (busca.semArrobas === 'ligacao_caida') {
    return html`<p class="faixa faixa-aviso" role="status" aria-live="polite">A
liga&ccedil;&atilde;o com o Instagram caiu, ent&atilde;o os @ n&atilde;o vieram. A lista continua
aqui, com a data e o resultado de cada um. Enquanto a liga&ccedil;&atilde;o estiver assim, nada
&eacute; enviado: quem reconecta &eacute; o assistente, no computador onde o projeto foi
publicado.</p>`
  }

  return html`<p class="faixa faixa-aviso" role="status" aria-live="polite">N&atilde;o conseguimos
falar com o Instagram agora, ent&atilde;o alguns @ n&atilde;o vieram. A lista continua aqui, com a
data e o resultado de cada um, e a sua automa&ccedil;&atilde;o continua funcionando normalmente.</p>`
}

/** O @ daquela linha, ou a frase que explica por que ele nao esta ali. */
function arrobaDaLinha(linha: LinhaAtendida, busca: BuscaDosArrobas): string {
  if (!busca.pedida) return ''
  const achada = busca.porComentario.get(linha.commentId)
  if (achada === undefined) return SEM_ARROBA.naoVeio
  if (achada.tipo === 'apagado') return SEM_ARROBA.apagado
  if (achada.tipo === 'falhou') return SEM_ARROBA.naoVeio
  // O `@` e escrito por NOS; o `username` e interpolado e a tag `html` o escapa
  // sozinha. E o que faz um @ chamado `<script>` sair como texto.
  return `@${achada.username}`
}

/** A segunda linha do cartao: o resultado, e o que mais houver a dizer sobre ele. */
function resultadoDaLinha(linha: LinhaAtendida): string {
  const resultado = resultadoNaTela(linha.status)
  const partes = [`${resultado.icone} ${resultado.frase}`]

  if (linha.status === ('failed' satisfies CommentStatus)) {
    const motivo = motivoDaFalha(linha.ultimoErro)
    partes.push(motivo === null ? '.' : `: ${motivo}.`)
  } else {
    partes.push('.')
  }

  if (
    linha.status === ('retry_pending' satisfies CommentStatus) &&
    linha.proximaTentativaEm !== null
  ) {
    partes.push(` A próxima tentativa é a partir de ${dataEmPortugues(linha.proximaTentativaEm)}.`)
  }

  return partes.join('')
}

/**
 * A lista, ou a frase de lista vazia.
 *
 * O `<li>` traz o @ como rotulo e o resultado como valor — as duas classes que o
 * painel ja tem — e a data por ultimo. Sem o toque em "Atualizar" o rotulo some
 * e a data sobe para o lugar dele: a linha continua dizendo o que aconteceu e
 * quando, que e o desfecho que §12.6 fixa para o caso em que o @ nao existe.
 */
function listaDasLinhas(
  linhas: readonly LinhaAtendida[],
  busca: BuscaDosArrobas,
  falhouALeitura: boolean,
): HtmlSeguro {
  if (falhouALeitura) {
    return html`<p class="faixa faixa-aviso" role="status" aria-live="polite">N&atilde;o conseguimos
ler o registro dos coment&aacute;rios atendidos agora. Nada foi alterado, e a sua
automa&ccedil;&atilde;o continua funcionando.</p>`
  }

  if (linhas.length === 0) {
    return html`<p>Ainda n&atilde;o h&aacute; nenhum coment&aacute;rio atendido para mostrar.</p>`
  }

  const itens = linhas.map((linha) => {
    const arroba = arrobaDaLinha(linha, busca)
    return html`<li class="linha-de-ajuste">
${arroba === '' ? null : html`<p class="rotulo">${arroba}</p>`}
<p class="valor">${resultadoDaLinha(linha)}</p>
<p class="valor">Em ${dataEmPortugues(linha.criadoEm)}.</p>
</li>`
  })

  return html`<ul class="pendencias">${itens}</ul>`
}

/**
 * "Ver mais": outra invocacao, com outro cursor e outro orcamento (§12.6).
 *
 * Ele aparece enquanto a pagina veio CHEIA. Com `LIMIT 20` fixo — que e o teto
 * que §13.2 afirma — nao ha como saber se existe uma vigesima primeira linha sem
 * uma consulta a mais, e uma consulta por abertura para adiantar um "Ver mais"
 * que quase nunca some custaria mais do que a pagina vazia que ele pode abrir.
 *
 * O link **nao** carrega o pedido de @: cada pagina e um toque proprio, e um
 * "Ver mais" que ja viesse com os @ gastaria 20 chamadas a Meta por rolagem.
 *
 * A posicao leva o `comment_id` da ultima linha junto com o instante dela — sem
 * o desempate, um lote gravado no mesmo milissegundo perderia no "Ver mais"
 * todas as linhas empatadas com essa ultima. O id vai no LINK, e continua nao
 * indo para a lista: o que a tela mostra de cada linha e o @ e o resultado.
 */
function verMais(linhas: readonly LinhaAtendida[]): HtmlSeguro {
  if (linhas.length < LINHAS_POR_PAGINA) return html``
  const ultima = linhas[linhas.length - 1]
  if (ultima === undefined) return html``

  const posicao: PosicaoDaPagina = { criadoEm: ultima.criadoEm, commentId: ultima.commentId }
  return html`<p><a class="acao" href="${enderecoDaTela({ posicao })}">Ver mais</a></p>`
}

// ---------------------------------------------------------------------------
// O handler
// ---------------------------------------------------------------------------

/**
 * A posicao pedida na query string, ou `null` quando nao ha cursor nenhum.
 *
 * `{ ok: false }` e RECUSA, e nao "usa o padrao" (§9.2): um valor que nao casa e
 * cliente adulterado ou endereco truncado, e nos dois casos consertar em
 * silencio mostraria uma pagina que a pessoa nao pediu. Mesmo desenho de
 * `?midia=` em `/painel/reel`.
 *
 * **Meia posicao tambem e recusa.** As duas metades identificam UMA linha; o
 * instante sozinho e exatamente o cursor sem desempate que pulava as linhas
 * empatadas, e aceita-lo seria manter o defeito vivo por um endereco digitado a
 * mao.
 */
function cursorPedido(url: URL): { ok: true; posicao: PosicaoDaPagina | null } | { ok: false } {
  const instante = url.searchParams.get(CAMPO_DO_CURSOR)
  const desempate = url.searchParams.get(CAMPO_DO_DESEMPATE)

  const semInstante = instante === null || instante === ''
  const semDesempate = desempate === null || desempate === ''
  if (semInstante && semDesempate) return { ok: true, posicao: null }
  if (semInstante || semDesempate) return { ok: false }

  if (!FORMA_DO_CURSOR.test(instante)) return { ok: false }
  if (!FORMA_DO_DESEMPATE.test(desempate)) return { ok: false }

  const criadoEm = Number(instante)
  if (!Number.isSafeInteger(criadoEm)) return { ok: false }
  return { ok: true, posicao: { criadoEm, commentId: desempate } }
}

/**
 * A tela.
 *
 * Custo em subrequests: **4 na abertura simples** — a sessao, o lote da
 * configuracao e das midias, a pergunta sobre a conta e a consulta a
 * `processed_comments` — e **5 com o toque em "Atualizar"**, que acrescenta a
 * leitura do token, mais uma chamada a Meta por linha. Com o teto de 20 linhas
 * o pior caso fica em 25 subrequests, metade do limite da plataforma.
 *
 * `deps` existe para o teste nao tocar a rede (§13.1), do mesmo jeito que
 * `DEPENDENCIAS_DE_MIDIAS` nas duas telas de Reels.
 */
export async function handleAtividade(
  entrada: EntradaDaRota,
  deps: DependenciasDaAtividade = DEPENDENCIAS_DA_ATIVIDADE,
): Promise<Response> {
  const url = new URL(entrada.request.url)
  const pedido = cursorPedido(url)
  if (!pedido.ok) {
    return erro('dados_invalidos', { ...entrada.contexto, motivoInterno: 'cursor_invalido' })
  }

  const snapshot = await configDaTela(entrada.env, entrada.now)
  const conta = await contaConectada(entrada.env.DB, entrada.now)
  const visao = panorama(snapshot, conta)

  const { linhas, falhou } = await lerLinhas(entrada.env.DB, pedido.posicao ?? INICIO_DA_LISTA)

  // **Sem toque em "Atualizar", nenhuma chamada a Meta acontece** (§2.3). E
  // tambem nao ha o que buscar numa pagina sem linha nenhuma: disparar a leitura
  // do token para uma lista vazia gastaria um subrequest para nada.
  const querArrobas = url.searchParams.get(CAMPO_DA_ACAO) === ATUALIZAR
  const busca =
    querArrobas && linhas.length > 0
      ? await buscarArrobas(entrada.env, deps, linhas, entrada.now)
      : semBusca()

  const corpo = html`<h1>O que aconteceu</h1>
${blocoDeEstado(visao)}
${blocoDeAvisos(visao)}
${blocoDeFabrica(visao)}
${blocoDePendencias(visao)}
<section>
<h2>A conta do Instagram</h2>
<p>${
    conta
      ? 'Conectada. A automação consegue falar com o Instagram para enviar.'
      : 'Não está conectada. Enquanto estiver assim, nada é enviado. Quem conecta é o assistente, no computador onde o projeto foi publicado.'
  }</p>
</section>
${avisoDoQueNaoAparece()}
<section>
<h2>Os &uacute;ltimos coment&aacute;rios atendidos</h2>
${faixaDoInstagramMudo(busca)}
${botaoDosArrobas(busca, pedido.posicao)}
${listaDasLinhas(linhas, busca, falhou)}
${verMais(linhas)}
<p>${SEM_ARROBA.envelhece}</p>
</section>`

  return telaDoPainel(molduraCom('atividade', 'O que aconteceu', visao, corpo))
}
