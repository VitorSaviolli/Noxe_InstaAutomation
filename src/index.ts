/**
 * ============================================================
 * noxe-insta-automation — ponto de entrada do Worker
 * ============================================================
 *
 * Software SEM FINS LUCRATIVOS.
 *
 * Este projeto nao rouba e nao coleta informacoes de ninguem. Tudo o que ele
 * guarda fica no SEU banco de dados D1, dentro da SUA conta da Cloudflare:
 * o IGSID de quem comentou e gravado apenas como SHA-256, o texto do
 * comentario e o username nao sao armazenados, e o token do Instagram fica
 * cifrado com AES-GCM. Nada e enviado ao autor deste codigo nem a terceiros —
 * nao existe servidor nosso no meio. Os detalhes estao na politica de
 * privacidade servida em /privacy-policy e no SECURITY.md.
 *
 * Desenvolvido por Vitor S. Gonsalez — Noxelora.
 *
 * Se o projeto deu certo para voce, deixe uma estrela no GitHub. E totalmente
 * de graca e ajuda outras pessoas a encontrarem o projeto:
 *   https://github.com/VitorSaviolli/Noxe_InstaAutomation
 *
 * Quer apoiar? PIX: saviolligonsalez@gmail.com
 * Doacoes ajudam a manter projetos como este 100% gratuitos.
 *
 * Licenca MIT — veja o arquivo LICENSE.
 * ============================================================
 */
import {
  type AutomationConfig,
  automationConfig,
  isDestinationUrlConfigured,
  resolveConfigForMedia,
} from './config'
import {
  type CommentRecord,
  CommentsRepository,
  type DeferredComment,
} from './repositories/comments-repository'
import { PainelAuditoriaRepository } from './repositories/painel-auditoria-repository'
import { TokensRepository } from './repositories/tokens-repository'
import { handleHealth } from './routes/health'
import { handleDataDeletion, handlePrivacyPolicy } from './routes/legal'
import {
  CALLBACK_PATH,
  handleAuthorizeStart,
  handleOAuthCallback,
  handleSubscribe,
} from './routes/oauth'
import { handleZerarAcesso } from './routes/painel/aparelhos'
import {
  CAMINHO_DA_PARADA,
  CAMINHO_DO_FORMULARIO,
  handleFormularioDeParada,
  handleGerarCodigos,
  handleParada,
} from './routes/painel/parada'
import { routePainel } from './routes/painel/router'
import { handleWebhookVerification, readWebhookRequest } from './routes/webhook'
import {
  computeNextRetry,
  evaluateComment,
  isReelFromEvent,
  MAX_ATTEMPTS,
  processComment,
} from './services/automation'
import { carregarConfigEfetiva } from './services/config-store'
import { isRetryable, MetaApiClient } from './services/meta-api'
import {
  loadAccessToken,
  refreshLongLivedToken,
  shouldRefresh,
  storeAccessToken,
} from './services/token-manager'
import type { Env } from './types/env'
import type { CommentEvent } from './types/meta'
import { sha256Hex } from './utils/hash'
import { renderTemplate } from './utils/templates'

const WEBHOOK_PATH = '/webhooks/instagram'

/**
 * Teto de comentarios ENTREGUES por invocacao do webhook. (§16.1)
 *
 * Cada comentario entregue custa 5 consultas ao D1 (`findByCommentId`,
 * `isUserInCooldown`, `claimComment`, `markPrivateSent`, `markCompleted`) mais
 * 2 chamadas a Meta (Direct e resposta publica), e o lote inteiro custa outras
 * 2 consultas (token da conta e credencial). Consulta ao D1 e chamada de rede
 * contam no MESMO teto de 50 subrequests por invocacao, entao:
 *
 *   5 x (5 + 2) + 2 + 1 (reagendamento em lote) = 38  <= 50
 *
 * Sobram 12, e o pior caso gasta 5 deles: um `getMediaInfo` de fallback por
 * comentario, quando o webhook nao informa o tipo da midia. Com 6 seriam
 * `6 x 8 + 3 = 51` e o teto ja estouraria — 5 e o maior valor que cabe, e e o
 * numero que a spec cita de exemplo.
 */
const MAX_COMENTARIOS_POR_INVOCACAO = 5

/**
 * Quantos registros o cron tenta reprocessar por execucao.
 *
 * O mesmo teto de 50 subrequests vale aqui, e a retentativa custa 4 por
 * registro (Direct + `markPrivateSent` + resposta publica + `markCompleted`)
 * mais ate 7 fixos da renovacao do token. Com 10: 10 x 4 + 7 = 47 <= 50. Era
 * 20 — o que ja estourava o teto hoje, e estouraria sempre agora que o
 * excedente do webhook e drenado por aqui. (§16.1)
 */
const RETRY_BATCH_SIZE = 10

/**
 * O que o pipeline de entrega busca fora de si mesmo.
 *
 * Existe para o teste injetar dubles por parametro — o projeto nao usa mock de
 * modulo. Os valores padrao sao exatamente o que roda em producao.
 */
export interface BatchDeps {
  /** Fabrica do cliente da Meta, para o teste nao tocar a rede. */
  createApi: (apiVersion: string, token: string) => MetaApiClient
  /**
   * Resolucao da config, para o teste fixar um cenario sem passar pelo banco.
   *
   * Ausente — que e o caso em producao — o lote carrega o snapshot do D1 UMA
   * vez, antes do laco, e resolve a partir dele (§9.5).
   */
  resolveConfig?: (mediaId: string) => AutomationConfig
}

const DEFAULT_BATCH_DEPS: BatchDeps = {
  createApi: (apiVersion, token) => new MetaApiClient(apiVersion, token),
}

/**
 * UMA carga de configuracao por lote, nunca por comentario.
 *
 * Trava de CFG-11 e de CFG-12 (§9.5).
 *
 * `src/index.ts` chamava `resolveConfigForMedia(event.mediaId)` DENTRO do laco
 * de eventos. Com a config vindo do D1 isso viraria N leituras e — pior — um
 * snapshot inconsistente no meio do lote, com os primeiros comentarios
 * decididos por uma config e os ultimos por outra.
 *
 * `resolveConfigForMedia` continua pura e sincrona: o snapshot e carregado uma
 * vez e passado a ela explicitamente.
 */
async function resolucaoDoLote(
  env: Env,
  now: number,
  deps: BatchDeps,
): Promise<(mediaId: string) => AutomationConfig> {
  if (deps.resolveConfig !== undefined) return deps.resolveConfig

  const snapshot = await carregarConfigEfetiva(env, now)
  return (mediaId) => resolveConfigForMedia(mediaId, snapshot.global, snapshot.overrides)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const now = Date.now()

    switch (url.pathname) {
      case '/health':
        // O `request` vai junto porque `/health` responde DUAS resolucoes da
        // mesma pergunta sobre o painel: tres valores a quem chega anonimo,
        // seis a quem manda o `SETUP_ADMIN_TOKEN` (§11.9). Sem ele a rota nunca
        // sairia do lado publico, e o assistente perderia o recado exato.
        return handleHealth(env, now, request)

      case '/privacy-policy':
        return handlePrivacyPolicy()

      case '/data-deletion':
        return handleDataDeletion()

      // Trava de RL-07, e ela e uma trava POR AUSENCIA: o limitador do painel
      // NAO entra aqui, nem hoje nem depois. Quem entrega neste caminho e a
      // Meta, ja autenticada pela assinatura do corpo; um 429 devolvido a ela
      // faz a entrega ser reenviada e, no limite, a inscricao ser cancelada.
      // Acrescentar `limitar(...)` nesta linha parece defesa e e perda de
      // comentario. O teste de RL-07 fica vermelho se alguem tentar.
      case WEBHOOK_PATH:
        return handleWebhook(request, env, ctx, url, now)

      case '/setup/authorize':
        return handleAuthorizeStart(request, env, url, now)

      case CALLBACK_PATH:
        return handleOAuthCallback(env, url, now)

      case '/setup/subscribe':
        return handleSubscribe(request, env, () => loadAccessToken(env))

      // A parada de emergencia entra por `case` proprio, e nao pelo `default:`
      // onde o resto do painel vai morar: ela e a ultima rota que precisa
      // funcionar e nao pode passar pelo portao de sanidade do painel, que
      // exige `PANEL_RP_ID` — um dado do subsistema WebAuthn (§11.1).
      case CAMINHO_DA_PARADA:
        return handleParada(request, env, now)

      case CAMINHO_DO_FORMULARIO:
        return handleFormularioDeParada(request)

      // O Worker sorteia os codigos, o assistente so imprime (§10.11).
      // `/setup/painel/codigos` NAO e caminho de painel: ele e do assistente
      // local, autenticado por Bearer, e fica onde sempre esteve.
      case '/setup/painel/codigos':
        return handleGerarCodigos(request, env, now)

      // O ultimo recurso quando o dono perdeu todos os aparelhos E o papel dos
      // codigos (§7.1, §10.8). Ela apaga sessoes e, com `?tudo=1`, tambem as
      // credenciais — e NAO toca `account_tokens`: a conexao com o Instagram nao
      // e acesso ao painel, e derruba-la junto faria uma rota de recuperacao de
      // acesso desligar a automacao. Como a irma acima, ela e do assistente
      // local, autenticada por Bearer, e por isso nao entra no painel.
      case '/setup/painel/zerar':
        return handleZerarAcesso(request, env, now)

      // O painel inteiro entra POR AQUI, e por nenhum outro lugar (§11.1).
      //
      // Nao existe `startsWith('/painel')` avaliado antes deste ponto, e essa
      // ausencia e a garantia: com o painel no `default:`, nenhum caminho dele
      // pode ser avaliado antes de `case WEBHOOK_PATH`, cuja assinatura e
      // calculada sobre o corpo cru e nao sobrevive a qualquer codigo que leia
      // o corpo antes. `routePainel` devolve `null` para quem nao e do painel,
      // e e esse `null` que preserva o 404 de hoje — `/painelzinho` continua
      // caindo aqui, porque `/painel/` e `/painel` sao as unicas grafias que
      // ele reconhece.
      default: {
        const doPainel = await routePainel(request, env, url, now)
        return doPainel ?? new Response('Not Found', { status: 404 })
      }
    }
  },

  /**
   * Cron unico: varre retry_pending e renova o token quando necessario.
   *
   * Um so trigger para as duas tarefas, conforme o limite de um Cron
   * Trigger definido para o projeto.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // O `.catch` nao e decoracao: `runScheduledTasks` isola cada etapa, mas uma
    // rejeicao fora delas viraria unhandled rejection dentro do `waitUntil` e
    // sumiria sem log — a mesma cegueira que este commit existe para fechar.
    ctx.waitUntil(
      runScheduledTasks(env, Date.now()).catch((cause) => {
        console.error('cron:', 'falhou', cause instanceof Error ? cause.message : cause)
      }),
    )
  },
} satisfies ExportedHandler<Env>

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  now: number,
): Promise<Response> {
  if (request.method === 'GET') return handleWebhookVerification(url, env)
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const parsed = await readWebhookRequest(request, env)
  if (!parsed.ok) {
    console.warn('Webhook rejeitado:', parsed.reason)
    return new Response(parsed.reason, { status: parsed.status })
  }

  // A Meta reenvia o evento se demorarmos a responder, entao confirmamos
  // imediatamente e processamos em segundo plano.
  if (parsed.events.length > 0) {
    ctx.waitUntil(processEvents(parsed.events, env, now))
  }

  return new Response('EVENT_RECEIVED', { status: 200 })
}

/** Processa os eventos do lote em sequencia, sem deixar erro escapar. */
export async function processEvents(
  events: readonly CommentEvent[],
  env: Env,
  now: number,
  deps: BatchDeps = DEFAULT_BATCH_DEPS,
): Promise<void> {
  const conta = await new TokensRepository(env.DB).get()
  if (!conta) {
    console.warn('Evento recebido mas nenhuma conta esta conectada. Rode /setup/authorize.')
    return
  }

  const credencial = await loadAccessToken(env)
  if (!credencial) return

  const api = deps.createApi(env.META_API_VERSION, credencial.token)
  const repo = new CommentsRepository(env.DB)
  const accountUsername = conta.username ?? ''

  // UMA carga por lote, antes do laco. Do cache na maioria das invocacoes.
  const resolveConfig = await resolucaoDoLote(env, now, deps)

  for (const event of events.slice(0, MAX_COMENTARIOS_POR_INVOCACAO)) {
    try {
      const resultado = await processComment(event, {
        api,
        repo,
        igUserId: credencial.igUserId,
        accountUsername,
        config: resolveConfig(event.mediaId),
        now,
      })
      console.log(`Comentario ${event.commentId}: ${resultado.kind}`)
    } catch (cause) {
      console.error(
        `Erro inesperado no comentario ${event.commentId}:`,
        cause instanceof Error ? cause.message : cause,
      )
    }
  }

  await reagendarExcedente(events.slice(MAX_COMENTARIOS_POR_INVOCACAO), {
    repo,
    igUserId: credencial.igUserId,
    accountUsername,
    now,
    resolveConfig,
  })
}

/**
 * Passa o que sobrou da fatia para a fila que o cron ja varre. (§16.1)
 *
 * Reagendar so pode acontecer para o comentario que HOJE seria entregue, senao
 * o cron mandaria Direct para quem nunca digitou a palavra-gatilho. Os portoes
 * gratuitos ficam aqui: o veredito de `evaluateComment` e a confirmacao de Reel
 * que veio no proprio webhook. Os dois que custam consulta — dedup e cooldown —
 * viajam dentro do proprio INSERT, em `deferForRetry`.
 *
 * Quando `processOnlyReels` esta ligado e o webhook NAO informou o tipo da
 * midia, o comentario nao e reagendado. Perguntar a Meta custaria uma chamada
 * por comentario, que e o gasto que a fatia existe para evitar, e a alternativa
 * seria reagendar sem saber — o `retryPending` entrega sem consultar nada, e ai
 * o Direct sairia numa publicacao que talvez nao seja Reel. Na duvida NAO
 * processamos, que e a mesma escolha do caminho inline (`isReel`): e melhor
 * perder um acionamento do que responder na publicacao errada. Na pratica o
 * webhook de comentarios da Meta sempre traz `media_product_type`.
 */
async function reagendarExcedente(
  events: readonly CommentEvent[],
  deps: {
    repo: CommentsRepository
    igUserId: string
    accountUsername: string
    now: number
    resolveConfig: (mediaId: string) => AutomationConfig
  },
): Promise<void> {
  if (events.length === 0) return

  const pendentes: DeferredComment[] = []
  /** Autores ja reagendados neste lote, para o cooldown valer dentro dele. */
  const jaReagendados = new Set<string>()

  for (const event of events) {
    const config = deps.resolveConfig(event.mediaId)

    const veredito = evaluateComment(event, config, deps.igUserId, deps.accountUsername)
    if (!veredito.process) continue

    if (config.processOnlyReels && isReelFromEvent(event) !== true) continue

    // O `WHERE NOT EXISTS` do INSERT enxerga o que ja esta gravado, mas nao o
    // que entra no MESMO lote: dois comentarios do mesmo autor no excedente
    // renderiam dois Directs. Hoje o segundo cai em `usuario_em_cooldown` e nao
    // vira linha nenhuma, e e isso que precisa continuar acontecendo.
    const commenterHash = await sha256Hex(event.fromId)
    if (jaReagendados.has(commenterHash)) continue
    jaReagendados.add(commenterHash)

    pendentes.push({
      commentId: event.commentId,
      mediaId: event.mediaId,
      commenterHash,
      cooldownSince: deps.now - config.userCooldownHours * 60 * 60 * 1000,
    })
  }

  // `processEvents` roda dentro de `ctx.waitUntil`: uma rejeicao aqui sumiria
  // em silencio, e junto com ela o excedente inteiro. O laco de entrega acima
  // ja trata do mesmo jeito.
  try {
    const reagendados = await deps.repo.deferForRetry(pendentes, deps.now)
    if (reagendados > 0) {
      console.log(`Lote fatiado: ${reagendados} comentario(s) reagendado(s) para o cron`)
    }
  } catch (cause) {
    console.error(
      `Falha ao reagendar ${pendentes.length} comentario(s) do lote:`,
      cause instanceof Error ? cause.message : cause,
    )
  }
}

/**
 * Uma etapa do cron, isolada das outras.
 *
 * Sem isto a primeira rejeicao derruba as etapas seguintes em silencio, porque
 * `scheduled` entrega o conjunto a `ctx.waitUntil` e ninguem observa a promessa.
 * Desde §16.1 o cron nao e mais faxina: ele e o caminho de entrega de todo
 * comentario a partir do sexto de cada lote, entao um soluco do D1 na renovacao
 * do token nao pode levar a fila de pendentes junto.
 *
 * O log segue a forma de §11.7 — argumentos separados, NUNCA template string
 * com dado variavel dentro.
 */
async function executarEtapa(nome: string, etapa: () => Promise<void>): Promise<void> {
  try {
    await etapa()
  } catch (cause) {
    console.error('cron:', nome, cause instanceof Error ? cause.message : cause)
  }
}

/**
 * Tarefas do cron: renovacao do token e reprocessamento de pendentes.
 *
 * A ORDEM e load-bearing e nao pode virar `Promise.allSettled`: `retryPending`
 * le o token que `maybeRefreshToken` pode ter acabado de rotacionar. O que se
 * ganha aqui e tolerancia a falha por etapa, nao paralelismo.
 */
export async function runScheduledTasks(
  env: Env,
  now: number,
  deps: BatchDeps = DEFAULT_BATCH_DEPS,
): Promise<void> {
  await executarEtapa('token', () => maybeRefreshToken(env, now))
  await executarEtapa('pendentes', () => retryPending(env, now, deps))
  await executarEtapa('auditoria', () => podarAuditoria(env))
}

/**
 * A unica poda de `painel_auditoria` do projeto (§8.9).
 *
 * Mora no cron para NUNCA entrar no caminho de gravacao do painel: quem salva
 * uma tela nao pode pagar a varredura de retencao. Custa uma leitura barata de
 * no maximo 501 linhas pelo rowid e so escreve quando ha o que apagar — sem
 * `COUNT(*)`, que varreria a tabela inteira e contaria tudo na cota.
 *
 * Por ultimo, e num `try` proprio: a poda e higiene de armazenamento, e uma
 * falha nela nao pode derrubar a renovacao do token nem a fila de pendentes.
 *
 * Os dois `console` daqui seguem o formato de §11.7 — argumentos separados,
 * **sem template string com dado variavel dentro**. O numero de linhas
 * apagadas e inofensivo; o que a regra impede e o PRECEDENTE: enquanto nao
 * existir no painel um `console` que interpole valor, nao existe o caminho em
 * que alguem interpola por engano um `destinationUrl` ou um username.
 */
async function podarAuditoria(env: Env): Promise<void> {
  try {
    const apagadas = await new PainelAuditoriaRepository(env.DB).podar()
    if (apagadas > 0) {
      console.log('painel:', 'auditoria_podada', apagadas)
    }
  } catch (cause) {
    console.error('painel:', 'indisponivel', cause instanceof Error ? cause.message : cause)
  }
}

async function maybeRefreshToken(env: Env, now: number): Promise<void> {
  try {
    // Esta leitura ficava FORA do try: uma falha do D1 aqui escapava da funcao
    // inteira e, antes de `executarEtapa`, levava junto a fila e a poda.
    const record = await new TokensRepository(env.DB).get()
    if (!record) return

    // O prazo VENCIDO nao e "nada a fazer": `shouldRefresh` responde `false`
    // aos dois casos opostos — "ainda cedo" e "tarde demais" —, e o segundo e o
    // fim da linha. A Meta nao renova token expirado, entao o cron nunca mais
    // tenta e a conta fica morta em silencio. O `console.warn` e o unico rastro
    // que existe disso, e e por ele que o dono descobre que precisa reconectar
    // pelo assistente. Formato de §11.7: argumentos separados.
    if (now >= record.expires_at) {
      console.warn('cron:', 'token_vencido', 'reconecte a conta pelo assistente')
      return
    }

    if (!shouldRefresh(record.expires_at, record.last_refreshed_at, record.created_at, now)) {
      return
    }

    const credencial = await loadAccessToken(env)
    if (!credencial) return

    const renovado = await refreshLongLivedToken(credencial.token)
    await storeAccessToken(env, {
      igUserId: record.ig_user_id,
      username: record.username,
      accessToken: renovado.accessToken,
      expiresInSeconds: renovado.expiresInSeconds,
      now,
    })
    console.log('Token renovado com sucesso')
  } catch (cause) {
    console.error('Falha ao renovar o token:', cause instanceof Error ? cause.message : cause)
  }
}

/**
 * Falhas que sao da CONTA, e nao daquele comentario.
 *
 * A diferenca decide o que se escreve no banco. `isRetryable` responde "vale
 * outra tentativa AGORA?", e para estes tres a resposta e nao — o que levava
 * `reentregar` a marcar `failed`, que e TERMINAL. Com o token morto, a
 * varredura marcava failed os dez pendentes do tique e os apagava do mundo por
 * um problema que nao era deles: quem digitou a palavra-gatilho nunca receberia
 * o Direct, nem depois de o dono reconectar a conta.
 *
 * Sao os mesmos codigos que `classify` produz para 190, 401 e 403
 * (`src/services/meta-api.ts`) — token revogado por troca de senha, checkpoint
 * ou conta restringida. Todos passam quando o dono reconecta, e nenhum melhora
 * por insistir: continuar o laco martelando uma conta ja sinalizada e como um
 * aviso vira bloqueio.
 */
const FALHAS_DE_CONTA: readonly string[] = ['TOKEN_INVALIDO', 'NAO_AUTORIZADO', 'PROIBIDO']

function ehFalhaDeConta(shortCode: string): boolean {
  return FALHAS_DE_CONTA.includes(shortCode)
}

async function retryPending(env: Env, now: number, deps: BatchDeps): Promise<void> {
  const repo = new CommentsRepository(env.DB)
  const pendentes = await repo.findRetryPending(now, RETRY_BATCH_SIZE)
  if (pendentes.length === 0) return

  console.log(`Reprocessando ${pendentes.length} comentario(s) pendente(s)`)

  const conta = await new TokensRepository(env.DB).get()
  const credencial = await loadAccessToken(env)
  if (!conta || !credencial) return

  const api = deps.createApi(env.META_API_VERSION, credencial.token)

  // Depois da saida antecipada por fila vazia, de proposito: uma varredura
  // que nao tem o que entregar nao paga a leitura da configuracao.
  const resolveConfig = await resolucaoDoLote(env, now, deps)

  let barrados = 0

  for (const registro of pendentes) {
    const config = resolveConfig(registro.media_id)

    // Trava de CFG-02 e CFG-14: "em nenhum caminho".
    //
    // `reentregar` renderiza e envia SEM consultar a config — e o cron drena,
    // desde §16.1, todo comentario a partir do sexto de cada lote. Sem este
    // portao, o dono corromperia `destination_url` a mao, veria `processEvents`
    // parar como prometido, e cinco minutos depois o cron entregaria os
    // pendentes com o texto e o link DE FABRICA. A automacao rodando em vez de
    // parar, e o valor de fabrica no lugar do campo invalido: as duas metades
    // da restricao furadas de uma vez.
    //
    // O registro fica exatamente como esta — `retry_pending`, sem gastar
    // tentativa e sem custar consulta. Parar e REVERSIVEL: o dono conserta o
    // link e a fila drena na varredura seguinte. Marcar `ignored` seria
    // irreversivel e apagaria, por um erro NOSSO, o comentario de quem digitou
    // a palavra-gatilho.
    if (!config.enabled || !isDestinationUrlConfigured(config)) {
      barrados++
      continue
    }

    const falhaDaConta = await reentregar(registro, {
      api,
      repo,
      config,
      igUserId: credencial.igUserId,
      now,
    })

    // Mesmo enquadramento do portao de configuracao acima: parar e REVERSIVEL.
    // O resto de `pendentes` fica exatamente como esta — `retry_pending`, sem
    // gastar tentativa e sem custar consulta — e a proxima varredura entrega
    // quando o dono reconectar.
    if (falhaDaConta !== null) {
      console.warn('cron:', 'conta_parada', falhaDaConta)
      break
    }
  }

  if (barrados > 0) {
    console.warn(
      `${barrados} pendente(s) nao entregue(s): a configuracao esta parada ou sem link. ` +
        'Eles continuam na fila e saem quando a configuracao voltar a ser valida.',
    )
  }
}

/**
 * Reenvia o Direct de UM pendente e atualiza o estado.
 *
 * O texto do comentario e o username nao sao guardados (coleta minima), entao
 * a nova tentativa reenvia so o Direct — a etapa que faltou.
 *
 * Devolve o `shortCode` quando a falha e da CONTA e o registro foi deixado
 * intacto, para quem chama abandonar o resto da fila. `null` em todo o resto,
 * inclusive na falha deste comentario, que ja foi gravada aqui.
 */
async function reentregar(
  registro: CommentRecord,
  deps: {
    api: MetaApiClient
    repo: CommentsRepository
    config: AutomationConfig
    igUserId: string
    now: number
  },
): Promise<string | null> {
  const { api, repo, config, now } = deps

  // Aqui havia um `.replace('{link}', ...)` cru: trocava so a PRIMEIRA
  // ocorrencia e nao sanitizava. `renderTemplate` usa `replaceAll` e limpa
  // caracteres de controle — e e o unico ponto de renderizacao do projeto.
  // (§16.3)
  const texto = renderTemplate(config.privateReplyText, {
    username: '',
    link: config.destinationUrl,
  })

  const envio = await api.sendPrivateReply(deps.igUserId, registro.comment_id, texto)

  if (!envio.ok) {
    const { shortCode } = envio.error

    // A conta parou: NAO e falha deste comentario e nao pode virar `failed`,
    // que e terminal. Sai sem escrever nada — o registro segue `retry_pending`.
    if (ehFalhaDeConta(shortCode)) return shortCode

    // Mesma escada do caminho inline: ate MAX_ATTEMPTS com espera exponencial.
    // Antes de §16.1 so chegava aqui quem ja tinha falhado uma entrega; agora
    // chega todo comentario a partir do sexto de cada lote, e um 500
    // transitorio da Meta perderia o comentario de vez. (§16.1)
    if (isRetryable(shortCode) && registro.attempt_count < MAX_ATTEMPTS) {
      const nextRetryAt = computeNextRetry(registro.attempt_count, now)
      await repo.scheduleRetry(registro.comment_id, nextRetryAt, shortCode, now)
    } else {
      await repo.markStatus(registro.comment_id, 'failed', now, shortCode)
    }
    return null
  }

  await repo.markPrivateSent(registro.comment_id, envio.data.message_id ?? null, now)

  const resposta = await api.replyToComment(registro.comment_id, config.publicReplyText)
  if (resposta.ok) {
    await repo.markCompleted(registro.comment_id, resposta.data.id, now)
    return null
  }

  await repo.markStatus(registro.comment_id, 'uncertain', now, resposta.error.shortCode)

  // O Direct DESTE registro ja saiu e o estado ja foi gravado, entao nao ha o
  // que preservar aqui — mas se a conta parou, o proximo da fila sofreria a
  // mesma coisa. Avisa quem chama para abandonar o resto.
  return ehFalhaDeConta(resposta.error.shortCode) ? resposta.error.shortCode : null
}

export { automationConfig }
