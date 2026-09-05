/**
 * O roteador do painel: o `default:` do `switch` de `src/index.ts` (§11.1).
 *
 * **Por que pelo `default:`, e nunca por um `startsWith` avaliado antes dele.**
 * Com o painel no `default:`, NENHUM caminho do painel pode ser avaliado antes
 * de `case WEBHOOK_PATH`. Um erro de digitacao futuro numa rota do painel deixa
 * de ser uma falha de seguranca capaz de engolir o webhook — cuja assinatura e
 * calculada sobre o corpo cru e nao sobrevive a qualquer codigo que leia o
 * corpo antes. Ordem lexica vira garantia estrutural, e o 404 de hoje e
 * preservado por construcao: `/painelzinho` nao casa, `/painel` sem barra casa.
 *
 * **Despacho por `switch` de string EXATA.** Nenhum caminho tem segmento
 * variavel, em nenhuma rota, para sempre (§7.1): identificador que precisa de
 * URL propria vai na query string, identificador de uma escrita vai no corpo do
 * POST. Um `switch` de strings exatas nao tem como casar o que nao esta escrito
 * nele — e e por isso que ele e o despacho, e nao uma tabela de expressoes.
 *
 * **`/painel/parada` e `/painel/parar` nao passam por aqui.** Elas tem `case`
 * proprio em `src/index.ts`, ANTES do `default:`, e por um motivo que e uma
 * garantia (§11.1, §15.3 decisao 8): o portao de sanidade exige `PANEL_RP_ID`,
 * que e dado do subsistema WebAuthn. Um roteador que aplicasse o portao a tudo
 * derrubaria com `503` justamente o freio que §10.12 chama de "a ultima rota
 * que precisa funcionar". A parada exige apenas `PANEL_SESSION_KEY`, e confere
 * esse pedaco sozinha.
 */
import type { LinhaDeSessao } from '../../repositories/painel-sessoes-repository'
import { painelHabilitado } from '../../services/panel-session'
import type { Env } from '../../types/env'
import { handleAjustes } from './ajustes'
import { handleAtividade } from './atividade'
import { handleOpcoesDeEntrar, handlePaginaDeEntrar, handleVerificarEntrada } from './entrar'
import {
  CORPO_VAZIO,
  type CorpoDaRota,
  exigirCsrf,
  exigirOrigem,
  exigirSessao,
  exigirSessaoViva,
  type FamiliaDeLimite,
  type Limitador,
  lerCorpoCapado,
  limitar,
} from './guardas'
import { handleInicio } from './inicio'
import { handleMensagem } from './mensagem'
import { handlePalavras } from './palavras'
import {
  CAMINHO_DA_VERIFICACAO,
  CAMINHO_DAS_OPCOES,
  CAMINHO_DO_CONVITE,
  handleOpcoesDeRegistro,
  handlePaginaDeConvite,
  handleVerificarRegistro,
} from './registrar'
import { type ContextoDoErro, erro } from './resposta'
import {
  formatoDaRota,
  PREFIXO_DA_API,
  ROTA_AJUSTES,
  ROTA_ATIVIDADE,
  ROTA_ENTRAR,
  ROTA_INICIO,
  ROTA_MENSAGEM,
  ROTA_OPCOES_DE_ENTRAR,
  ROTA_PALAVRAS,
  ROTA_VERIFICAR_ENTRADA,
  type RotaDoPainel,
  tetoDoCorpo,
} from './rotas'

/** O prefixo do painel. `/painel` casa; `/painelzinho` nao (§11.1). */
const RAIZ_DO_PAINEL = '/painel'
const PREFIXO_DO_PAINEL = '/painel/'

const FORMULARIO = 'application/x-www-form-urlencoded'
const JSON_TIPO = 'application/json'

/** Tudo o que um handler de rota recebe. Nada alem disto, e de proposito. */
export interface EntradaDaRota {
  readonly request: Request
  readonly env: Env
  readonly now: number
  readonly rota: RotaDoPainel
  /** Ja pronto para `erro()`: caminho sem query string e a familia da rota. */
  readonly contexto: ContextoDoErro
  /** O corpo, lido UMA vez pelo roteador (o stream nao se le duas vezes). */
  readonly corpo: CorpoDaRota
  /** A linha viva de `painel_sessoes`, ou `null` em rota sem sessao. */
  readonly sessao: LinhaDeSessao | null
}

export type HandlerDoPainel = (entrada: EntradaDaRota) => Promise<Response> | Response

/** O que `despachar` precisa saber alem da tabela. */
interface OpcoesDoDespacho {
  /**
   * A familia do limitador desta rota, quando ela tem uma (§7.4).
   *
   * NAO e campo da tabela de rotas, e a ausencia e decisao: o mapeamento nao e
   * um por rota. `/painel/api/registrar/opcoes` escolhe a familia pelo CORPO —
   * `login` no modo convite, `codigo` no modo recuperacao, nenhuma no modo
   * sessao —, entao um campo booleano ou um nome fixo na tabela estaria certo
   * para algumas linhas e errado para outras. Um campo errado em parte das
   * linhas e pior que nenhum campo.
   */
  readonly limite?: FamiliaDeLimite
  /** Limitador injetado. So o teste usa. */
  readonly limitador?: Limitador
}

/**
 * A porta do painel. Devolve `null` quando o caminho nao e do painel — e e esse
 * `null` que preserva o `404 Not Found` de hoje para todo o resto do Worker.
 */
export async function routePainel(
  request: Request,
  env: Env,
  url: URL,
  now: number,
): Promise<Response | null> {
  if (url.pathname !== RAIZ_DO_PAINEL && !url.pathname.startsWith(PREFIXO_DO_PAINEL)) return null

  // Passo 0 da escada de §11.3. Falha FECHADA: sem segredo forte, o painel nao
  // existe. `painelHabilitado` e `typeof`-safe porque um binding nao cadastrado
  // chega como `undefined` em Workers, e `env.PANEL_RP_ID.length` sozinho
  // lancaria `TypeError` aqui dentro do `default:` de `src/index.ts`.
  const sanidade = painelHabilitado(env)
  if (!sanidade.ok) return erro('painel_desativado', contextoDeCaminho(request, url.pathname))

  switch (url.pathname) {
    case ROTA_INICIO.caminho:
      return despachar(request, env, now, ROTA_INICIO, handleInicio)

    case ROTA_PALAVRAS.caminho:
      return despachar(request, env, now, ROTA_PALAVRAS, handlePalavras)

    case ROTA_MENSAGEM.caminho:
      return despachar(request, env, now, ROTA_MENSAGEM, handleMensagem)

    case ROTA_AJUSTES.caminho:
      return despachar(request, env, now, ROTA_AJUSTES, handleAjustes)

    case ROTA_ATIVIDADE.caminho:
      return despachar(request, env, now, ROTA_ATIVIDADE, handleAtividade)

    case ROTA_ENTRAR.caminho:
      return despachar(request, env, now, ROTA_ENTRAR, handlePaginaDeEntrar)

    case ROTA_OPCOES_DE_ENTRAR.caminho:
      return despachar(request, env, now, ROTA_OPCOES_DE_ENTRAR, handleOpcoesDeEntrar, {
        limite: 'login',
      })

    case ROTA_VERIFICAR_ENTRADA.caminho:
      return despachar(request, env, now, ROTA_VERIFICAR_ENTRADA, handleVerificarEntrada, {
        limite: 'login',
      })

    // As tres rotas do registro vieram do `switch` de `src/index.ts` (§11.1).
    // Elas NAO passam por `despachar`: a Task 8 as entregou com a escada de
    // §11.3 dentro delas — metodo, portao de sanidade, origem, `content-type` e
    // teto de corpo em `portaDaApi` —, e `portaDaApi` consome o
    // `ReadableStream` do corpo. Um `despachar` por cima leria o corpo primeiro
    // e o handler receberia vazio. A tabela declara as tres com `sessao: false`
    // e `csrf: false` porque e isso que o ROTEADOR exige delas; as tres
    // autorizacoes de §10.4 e a ficha do modo `sessao` sao conferidas la dentro.
    case CAMINHO_DO_CONVITE:
      return handlePaginaDeConvite(request, env)

    case CAMINHO_DAS_OPCOES:
      return handleOpcoesDeRegistro(request, env, now)

    case CAMINHO_DA_VERIFICACAO:
      return handleVerificarRegistro(request, env, now)

    default:
      return erro('rota_desconhecida', contextoDeCaminho(request, url.pathname))
  }
}

/**
 * O contexto de erro de um caminho que NAO tem linha na tabela — o `404` e o
 * `503` do portao.
 *
 * A familia vem do prefixo e nao da tabela, porque a tabela nao tem essa linha:
 * quem chamou `/painel/api/qualquer-coisa` e o `painel.js`, e uma pagina HTML
 * de erro no lugar de um JSON viraria "erro de parse" no cliente.
 */
function contextoDeCaminho(request: Request, caminho: string): ContextoDoErro {
  return {
    request,
    caminho,
    formato: caminho.startsWith(PREFIXO_DA_API) ? 'json' : 'pagina',
  }
}

/**
 * A escada de §11.3, do mais barato ao mais caro, num lugar so.
 *
 *   1. metodo exato; `OPTIONS` -> `405` com `Allow`               (0 D1)
 *   2. `Origin` / `Sec-Fetch-Site`, so em POST                    (0 D1)
 *   3. `content-type` por familia                                 (0 D1)
 *   4. teto do corpo: 8 KB em `/painel/api/*`, 32 KB em formulario (0 D1)
 *   5. limitador de taxa, se a rota tiver familia                 (0 D1)
 *   6. cookie presente e HMAC valido                              (0 D1)
 *   7. ficha CSRF, em todo POST autenticado                       (0 D1)
 *   8. step-up, quando a rota exige                               (0 D1)
 *   9. **so agora: D1** — a linha viva da sessao
 *
 * **Ate o passo 8, inclusive, nenhuma consulta ao D1 acontece.** Lixo em
 * cookie, cookie forjado, corpo enorme, origem errada — tudo recusado sem tocar
 * no banco, que e a cota compartilhada com o webhook.
 *
 * **Nao ha `sleep` em lugar nenhum**, e a ausencia e decisao (§11.3): um atraso
 * no Worker consome tempo de execucao e prende uma das seis conexoes
 * simultaneas; ele nao desacelera um atacante distribuido e vira ferramenta de
 * DoS a favor dele.
 */
export async function despachar(
  request: Request,
  env: Env,
  now: number,
  rota: RotaDoPainel,
  handler: HandlerDoPainel,
  opcoes: OpcoesDoDespacho = {},
): Promise<Response> {
  const contexto: ContextoDoErro = {
    request,
    caminho: rota.caminho,
    formato: formatoDaRota(rota),
  }

  try {
    return await escada(request, env, now, rota, contexto, handler, opcoes)
  } catch (cause) {
    // O padrao de `oauth.ts`: o codigo vai para o log, o valor nunca, e o corpo
    // nao carrega `detalhe`, `stack` nem mensagem de excecao (§11.4).
    console.error('painel:', 'falha_interna', cause instanceof Error ? cause.message : cause)
    return erro('falha_interna', contexto)
  }
}

async function escada(
  request: Request,
  env: Env,
  now: number,
  rota: RotaDoPainel,
  contexto: ContextoDoErro,
  handler: HandlerDoPainel,
  opcoes: OpcoesDoDespacho,
): Promise<Response> {
  // Passo 1. `HEAD` e tratado como `GET`; `OPTIONS` cai aqui de proposito e
  // NUNCA em CORS — nenhuma rota do painel emite `Access-Control-*` (§10.9,
  // camada 5).
  const metodo = request.method === 'HEAD' ? 'GET' : request.method
  if (!(rota.metodos as readonly string[]).includes(metodo)) {
    return erro('metodo_nao_permitido', { ...contexto, extras: { allow: rota.metodos.join(', ') } })
  }

  // Passo 2.
  const recusaDeOrigem = exigirOrigem(request, env, contexto)
  if (recusaDeOrigem !== null) return recusaDeOrigem

  // Passos 3 e 4.
  const corpo = await lerCorpo(request, rota, contexto)
  if (corpo instanceof Response) return corpo

  // Passo 5.
  if (opcoes.limite !== undefined) {
    const veredito = await limitar(request, env, opcoes.limite, now, opcoes.limitador)
    if (!veredito.permitido) {
      return erro('muitas_tentativas', {
        ...contexto,
        extras: { 'retry-after': String(veredito.esperarSegundos) },
      })
    }
  }

  // Passo 8, e ele vem ANTES do curto-circuito de propósito.
  //
  // Nenhuma rota declara `stepUp: true` ainda, e o ramo FALHA FECHADO: o
  // verificador — `op_hash` recalculado no servidor a partir da mudanca
  // canonica — nasce com a etapa do step-up, e uma autorizacao que nao da para
  // verificar nao pode ser concedida. Declarar `stepUp: true` numa rota antes
  // disso tem de TRANCAR a rota, nunca abri-la em silencio.
  //
  // **Por que aqui e nao depois do portao de sessao.** Enquanto ele mora depois
  // do `if (!rota.sessao)`, a trava vale so no ramo autenticado: uma linha com
  // `stepUp: true` e `sessao: false` passava direto para o handler — que e
  // exatamente a abertura silenciosa que este ramo existe para impedir. O
  // metateste META-02 fecha a outra metade, proibindo a combinacao na tabela.
  //
  // Quando a etapa do step-up trouxer `exigirStepUp()`, esta linha vira aquela
  // chamada e volta para a posicao 8 da escada de §11.3, depois da ficha: um
  // verificador de verdade precisa do `sid` que o passo 6 produz.
  if (rota.stepUp) return erro('step_up_necessario', contexto)

  if (!rota.sessao) {
    return await handler({ request, env, now, rota, contexto, corpo, sessao: null })
  }

  // Passo 6: 1 HMAC, 0 consulta.
  const porta = await exigirSessao(request, env, now, contexto)
  if ('recusa' in porta) return porta.recusa

  // Passo 7: todo POST autenticado. `GET` nao exige ficha — ele nao muda estado,
  // e exigir ficha num link tornaria o proprio link impossivel de escrever.
  if (rota.csrf && metodo === 'POST') {
    const recusaDeFicha = await exigirCsrf(request, env, porta.sidHash, corpo, contexto)
    if (recusaDeFicha !== null) return recusaDeFicha
  }

  // Passo 9: a PRIMEIRA consulta ao D1 do caminho autenticado.
  const viva = await exigirSessaoViva(env.DB, porta.sidHash, now, contexto)
  if ('recusa' in viva) return viva.recusa

  return await handler({ request, env, now, rota, contexto, corpo, sessao: viva.linha })
}

/**
 * Passos 3 e 4: `content-type` por familia e o teto do corpo.
 *
 * Devolve a `Response` de recusa quando falha, para que o chamador nao precise
 * de um terceiro estado. `GET` e `HEAD` nao tem corpo e saem por cima.
 *
 * A leitura mora dentro do `try` de `despachar` porque o corpo chega pela rede:
 * um 3G que cai no meio do POST estoura no `ReadableStream`, e fora do `try`
 * isso viraria uma excecao nao tratada.
 */
async function lerCorpo(
  request: Request,
  rota: RotaDoPainel,
  contexto: ContextoDoErro,
): Promise<CorpoDaRota | Response> {
  if (request.method !== 'POST') return CORPO_VAZIO

  const formato = formatoDaRota(rota)
  const esperado = formato === 'json' ? JSON_TIPO : FORMULARIO

  // `toLowerCase()` porque media type e case-INSENSITIVE por RFC 9110, e
  // `startsWith` porque o `; charset=utf-8` que os navegadores anexam e
  // legitimo.
  const tipo = (request.headers.get('content-type') ?? '').toLowerCase().trimStart()
  if (!tipo.startsWith(esperado)) return erro('tipo_nao_suportado', contexto)

  let cru: string | null
  try {
    cru = await lerCorpoCapado(request, tetoDoCorpo(rota))
  } catch {
    return erro('corpo_invalido', contexto)
  }
  if (cru === null) return erro('corpo_grande_demais', contexto)

  if (formato === 'pagina') {
    return { familia: 'formulario', campos: new URLSearchParams(cru) }
  }

  try {
    return { familia: 'json', dados: JSON.parse(cru) as unknown }
  } catch {
    return erro('corpo_invalido', contexto)
  }
}
