/**
 * O botao de panico: `POST /painel/parada`, `GET /painel/parar` e o
 * `POST /setup/painel/codigos` que imprime os codigos uma unica vez.
 *
 * As tres rotas moram no mesmo arquivo porque sao **um subsistema so**: a rota
 * de setup existe para criar o codigo que a rota de parada consome, e as duas
 * compartilham a subchave `k_codigos`. Nenhuma delas depende de sessao, de
 * `painel_credenciais`, de `painel_sessoes` nem do `rpId` — se o WebAuthn
 * inteiro estiver quebrado, o freio continua funcionando (§10.12).
 *
 * **Por que a parada e desviada ANTES do portao de sanidade (§11.1).** O
 * portao exige `PANEL_RP_ID`, que e dado do subsistema WebAuthn. Um roteador
 * que o aplicasse a tudo derrubaria com `503` justamente a ultima rota que
 * precisa funcionar. `POST /painel/parada` exige apenas a `PANEL_SESSION_KEY`,
 * que e a raiz de `k_codigos`: sem ela nao ha como comparar codigo nenhum.
 *
 * **Por que e seguro expor a parada sem login** — assimetria de consequencia,
 * nao obscuridade: ela so sabe dizer `enabled = 0`, o efeito e a direcao
 * segura, e a alternativa (o dono trancado para fora sem freio nenhum) e pior.
 *
 * O que este arquivo NUNCA faz: registrar em log o codigo, o corpo da
 * requisicao ou o corpo da resposta de `/setup/painel/codigos`; contar, dizer
 * ou insinuar se existe codigo cadastrado; mostrar link, texto ou qualquer
 * campo de configuracao numa das respostas.
 */
import { type AutomationConfig, automationConfig } from '../../config'
import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import {
  type CodigoParaGravar,
  PainelCodigosRepository,
} from '../../repositories/painel-codigos-repository'
import {
  type LinhaDeFabrica,
  PainelConfigRepository,
} from '../../repositories/painel-config-repository'
import { invalidarCacheDeConfig } from '../../services/config-store'
import {
  conferirCodigo,
  formatarCodigo,
  hashDoCodigo,
  normalizarCodigo,
  sortearConjunto,
  VERSAO_DO_HASH,
} from '../../services/panel-codes'
import { derivarSubchave } from '../../services/panel-session'
import type { Env } from '../../types/env'
import { isAdmin } from '../oauth'
import { type Limitador, lerCorpoCapado, limitar } from './guardas'
import { cabecalhos } from './html'

/** Caminho do formulario. Difere do da acao por uma letra, e de proposito (§11.6). */
export const CAMINHO_DO_FORMULARIO = '/painel/parar'
/** Caminho da acao. Nenhum humano digita este; ele e so o `action` do form. */
export const CAMINHO_DA_PARADA = '/painel/parada'

/**
 * Teto do corpo de `/painel/parada`: **1 KB** (§11.3, passo 4).
 *
 * Um codigo de parada tem 16 caracteres. 1 KB e folga de sobra e mantem o
 * custo de um corpo gigante em zero consulta ao D1.
 *
 * Trava de WA-29 (§13.2): este e o menor dos tres tetos de corpo do painel, e
 * o unico que uma cerimonia WebAuthn nunca alcanca. O irmao de 8 KB de
 * `/painel/api/*` nasce com a etapa do registro; o de 32 KB do formulario, com
 * as telas. Subir este numero derruba o teste de WA-29 e o de STOP.
 *
 * O NUMERO mora aqui, mas quem le o corpo com ele e `lerCorpoCapado` em
 * `guardas.ts`: uma implementacao e tres numeros, nunca tres implementacoes.
 */
export const TETO_DO_CORPO_DA_PARADA = 1024

const FORMULARIO = 'application/x-www-form-urlencoded'

/**
 * Piso da `PANEL_SESSION_KEY`, o mesmo de `painelHabilitado` (§10.2).
 *
 * A parada confere so este pedaco do portao: ela nao usa `rpId` nem
 * `SETUP_ADMIN_TOKEN`, e exigir os dois aqui e que derrubaria o freio junto
 * com o subsistema que ele existe para contornar.
 */
const MINIMO_DA_CHAVE_DE_SESSAO = 32

// ---------------------------------------------------------------------------
// As paginas
// ---------------------------------------------------------------------------

/**
 * O formulario, sem script e sem interpolacao nenhuma.
 *
 * Este texto e o MESMO de `public/painel/parar/index.html`: em producao o
 * arquivo estatico responde primeiro, e o Worker serve a copia para que a
 * pagina exista mesmo antes de os assets estarem publicados. Sem script,
 * porque a `require-trusted-types-for 'script'` da CSP torna qualquer
 * `innerHTML` um erro de runtime, e porque uma pagina de emergencia que
 * depende de JavaScript e uma pagina que pode nao abrir.
 */
export const PAGINA_DO_FORMULARIO = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parar a automacao</title>
</head>
<body>
<h1>Parar a automa&ccedil;&atilde;o</h1>
<p>Digite abaixo o c&oacute;digo de parada que est&aacute; no seu papel.</p>
<form method="post" action="/painel/parada">
<label for="codigo">C&oacute;digo de parada</label>
<input id="codigo" name="codigo" type="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="32" required>
<button type="submit">Parar a automa&ccedil;&atilde;o</button>
</form>
</body>
</html>
`

/**
 * As TRES respostas da parada, e nada alem disso (§10.12).
 *
 * Distinguir "conferiu" de "nao conferiu" contraria a convencao de erro
 * generico do projeto, e a excecao e deliberada: a convencao generica existe
 * onde ha **credencial a enumerar**, e aqui nao ha nada a enumerar; e uma
 * pessoa que acredita ter parado a automacao e nao parou e exatamente a falha
 * que a regra de falha segura existe para impedir.
 */
const FRASES = {
  parada: 'Pronto. A automação está desligada.',
  codigoIncorreto: 'Esse código não confere. Confira e digite de novo.',
  indisponivel: 'Não foi possível confirmar agora. Em caso de erro a automação para sozinha.',
} as const

/**
 * O unico cabecalho que esta rota acrescenta por conta propria.
 *
 * Escrito como tipo fechado, e nao como `Record<string, string>`: um mapa
 * aberto deixaria um chamador futuro passar `content-security-policy` para o
 * construtor de resposta da rota que §11.5 mais protege.
 */
type ExtrasDaPagina = { 'retry-after'?: string }

/**
 * Uma das tres respostas, montada sem interpolar NADA que venha de fora.
 *
 * Nenhuma delas contem campo de configuracao, link, contagem ou estado da
 * conta — e nenhuma delas diz se existe codigo cadastrado. Trava de STOP-05,
 * STOP-11 e STOP-12.
 *
 * Trava de STOP-01 e de STOP-09: a `Response` sai SEM `set-cookie`, em todas
 * as tres. Parar nao e entrar — o codigo de parada nao vira sessao, e por isso
 * ele nao serve para logar, ler nem editar. A ausencia do cabecalho e a trava,
 * e ela mora aqui porque este e o unico construtor de resposta desta rota.
 */
function pagina(frase: string, status: number, extras: ExtrasDaPagina = {}): Response {
  const corpo = `<!doctype html>
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

  // Os cabecalhos de §11.5 vem DEPOIS dos extras, e a ordem e a trava: fosse
  // o contrario, um chamador futuro sobrescreveria a CSP desta pagina passando
  // uma chave com o mesmo nome. O tipo estreito de `extras` ja impede isso; a
  // ordem impede tambem quando o tipo for alargado um dia.
  return new Response(corpo, { status, headers: { ...extras, ...cabecalhos('pagina') } })
}

// ---------------------------------------------------------------------------
// GET /painel/parar — o formulario
// ---------------------------------------------------------------------------

/**
 * Serve o formulario. Em producao o asset responde antes; esta e a copia do
 * Worker, para que a URL do papel funcione com ou sem os assets publicados.
 */
export function handleFormularioDeParada(request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    console.warn('painel:', request.method, CAMINHO_DO_FORMULARIO, 405, 'metodo_nao_permitido')
    return metodoNaoPermitido('GET')
  }

  return new Response(PAGINA_DO_FORMULARIO, { status: 200, headers: cabecalhos('pagina') })
}

// ---------------------------------------------------------------------------
// POST /painel/parada — a acao
// ---------------------------------------------------------------------------

/** O que a rota busca fora de si mesma. Existe para o teste injetar dubles. */
export interface DepsDaParada {
  /**
   * Comparador de hashes. O padrao e `timingSafeEqual`, e trocar isto em
   * producao nao e o objetivo: o parametro existe para o teste de STOP-10
   * provar que nao ha um segundo caminho de comparacao escondido na rota.
   */
  comparar?: (a: string, b: string) => boolean
  /**
   * Limitador de taxa. O padrao e o da familia `parada` — o binding
   * `PANEL_LIMITER_STOP` quando ele existe, a janela por isolate quando nao.
   * O parametro existe para o teste forcar a recusa sem depender de contagem.
   */
  limitador?: Limitador
}

/**
 * A acao da parada de emergencia.
 *
 * Ordem obrigatoria, do mais barato ao mais caro (§10.12, §11.3):
 *
 *   1. metodo — `GET` redireciona, o resto que nao e `POST` vira `405`  (0 D1)
 *   2. `content-type` de formulario                                     (0 D1)
 *   3. teto de 1 KB: `content-length` antes, e corte DURANTE a leitura (0 D1)
 *   4. limitador de taxa por IP, se o binding existir                   (0 D1)
 *   5. normalizacao e formato exato do codigo                           (0 D1)
 *   6. hashes vivos do tipo 'parada'                            (1 leitura)
 *   7. `timingSafeEqual` contra cada hash; nao bateu, acabou   (0 escritas)
 *   8. estado da automacao                                      (1 leitura)
 *   9. ja desligada? "Pronto", sem gravar                       (0 escritas)
 *  10. senao: 1 lote com o `UPDATE` e a linha de auditoria       (2 escritas)
 *
 * Nunca lanca — e a promessa vale porque TUDO o que pode estourar mora dentro
 * do `try`, inclusive a leitura do corpo. A entrada vem de qualquer pessoa na
 * internet, por uma rede que pode cair no meio do POST, e uma excecao aqui
 * viraria `500` numa rota cuja terceira resposta ja existe exatamente para
 * dizer "nao deu para confirmar".
 */
export async function handleParada(
  request: Request,
  env: Env,
  now: number,
  deps: DepsDaParada = {},
): Promise<Response> {
  // §11.6: `GET /painel/parada` nao e beco sem saida. Difere de `/painel/parar`
  // por uma letra, e a pessoa vai digitar do papel, no celular, no pior dia do
  // projeto. Trava de STOP-02.
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Response(null, { status: 303, headers: { location: CAMINHO_DO_FORMULARIO } })
  }
  if (request.method !== 'POST') {
    console.warn('painel:', request.method, CAMINHO_DA_PARADA, 405, 'metodo_nao_permitido')
    return metodoNaoPermitido('GET, POST')
  }

  // Ruling 20 — o TERCEIRO caso de "a frase de §10.12 vence a letra de §11.4",
  // declarado como os outros dois em vez de decidido em silencio.
  //
  // O status e o codigo de log sao os exatos de `painel_desativado`, mas a
  // FRASE na tela e a terceira, e nao a mensagem daquela linha da tabela: §10.12
  // diz "as tres respostas, e nada alem disso", e a lista e exaustiva — nao
  // existe quarta pagina nesta rota. E e a frase certa pelo conteudo tambem:
  // sem a raiz de `k_codigos` a rota nao consegue confirmar coisa nenhuma, que
  // e literalmente o que ela diz. Decisao silenciosa nao vira precedente.
  if (!chaveDeSessaoPresente(env)) {
    console.warn('painel:', 'POST', CAMINHO_DA_PARADA, 503, 'painel_desativado')
    return pagina(FRASES.indisponivel, 503)
  }

  // O STATUS e o codigo de log sao os exatos de §11.3/§11.4 —
  // `tipo_nao_suportado` e `corpo_grande_demais` —, mas a FRASE na tela e a da
  // segunda linha de §10.12, que cobre "codigo incorreto **ou malformado**".
  // Esta rota mostra tres frases e nada alem disso, e um corpo que nao pode ser
  // lido e, para quem esta do outro lado, exatamente um envio que nao conferiu.
  //
  // `toLowerCase()` porque media type e case-INSENSITIVE por RFC 9110:
  // `Application/x-www-form-urlencoded` e o mesmo tipo que o minusculo, e
  // recusa-lo mostraria "Esse codigo nao confere" para um codigo que confere —
  // a mentira que o argumento (c) de §10.12 existe para impedir. O
  // `trimStart()` cobre o espaco a esquerda que um cliente pode mandar antes do
  // tipo.
  const tipo = (request.headers.get('content-type') ?? '').toLowerCase().trimStart()
  if (!tipo.startsWith(FORMULARIO)) {
    console.warn('painel:', 'POST', CAMINHO_DA_PARADA, 415, 'tipo_nao_suportado')
    return pagina(FRASES.codigoIncorreto, 415)
  }

  try {
    // A LEITURA DO CORPO MORA AQUI DENTRO, e nao antes do `try`.
    //
    // `lerCorpoCapado` nao lanca por conta propria, mas o corpo chega pela rede:
    // um 3G que cai no meio do POST estoura no `ReadableStream`, e fora do
    // `try` isso virava `500 Internal Server Error`. Celular com sinal ruim e
    // justamente o cenario que §10.12 nomeia — o dono precisa ler a terceira
    // frase, que diz o que aconteceu, e nao um erro de servidor que nao diz se
    // a automacao parou.
    const corpo = await lerCorpoCapado(request, TETO_DO_CORPO_DA_PARADA)
    if (corpo === null) {
      console.warn('painel:', 'POST', CAMINHO_DA_PARADA, 413, 'corpo_grande_demais')
      return pagina(FRASES.codigoIncorreto, 413)
    }

    // O limitador entra AQUI, e a posicao e das duas pontas: depois do teto do
    // corpo (§11.3, passos 4 e 5) e antes da normalizacao (§10.12, passo 1).
    // Nenhuma consulta ao D1 aconteceu ate esta linha, entao uma tentativa
    // recusada custa zero banco — trava de RL-05.
    //
    // O QUARTO caso de "a frase de §10.12 vence a letra de §11.4", declarado
    // como os tres anteriores em vez de decidido em silencio. O status e o
    // codigo de log sao os exatos de `muitas_tentativas`, com o `Retry-After`
    // que §11.3 manda; a FRASE na tela e a terceira, e nao a "Muitas
    // tentativas" da tabela, porque §10.12 diz "as tres respostas, e nada alem
    // disso" e a lista e exaustiva. E e a frase certa pelo conteudo: o que
    // aconteceu foi que nao deu para confirmar agora, e a automacao para
    // sozinha em caso de erro, que e literalmente o que ela diz.
    //
    // Por que o botao de panico e limitado: §10.12 poe o limitador no passo 1 e
    // §13.2 escreve "a parada tem limite proprio, mais generoso". O balde e so
    // dela (`parada:`) com teto de 30/60 s, entao nenhum bot martelando o login
    // consome a cota de que o dono precisa; e uma falha do binding cai no
    // limitador de reserva (§13.4), nunca em porta trancada.
    const veredito = await limitar(request, env, 'parada', now, deps.limitador)
    // Trava de RL-01: passado o teto da familia, a resposta e 429 com
    // `Retry-After` — inclusive para um codigo malformado, porque o limitador
    // esta ANTES da normalizacao e nao depois.
    if (!veredito.permitido) {
      console.warn('painel:', 'POST', CAMINHO_DA_PARADA, 429, 'muitas_tentativas')
      return pagina(FRASES.indisponivel, 429, {
        'retry-after': String(veredito.esperarSegundos),
      })
    }

    // Trava de STOP-03: o codigo sai do CORPO, e a `url` nem e parametro desta
    // funcao. Query string vaza em log de proxy, historico e `Referer`, e um
    // `GET` com o codigo na URL e exatamente o que §10.12 proibe.
    const digitado = new URLSearchParams(corpo).get('codigo')
    const normalizado = digitado === null ? null : normalizarCodigo(digitado, 'parada')

    // Formato errado nao custa consulta nenhuma: e o que faz um bot mandando
    // lixo sair daqui com zero leitura no D1 (§10.12, passo 2).
    if (normalizado === null) return recusa()

    return await conferirEParar(normalizado, env, now, deps)
  } catch (cause) {
    // Mesmo padrao de `oauth.ts`: o codigo vai para o log, o valor nunca.
    console.error('painel:', 'indisponivel', cause instanceof Error ? cause.message : cause)
    return pagina(FRASES.indisponivel, 503)
  }
}

/**
 * A recusa, com o codigo exclusivo desta rota (§11.4). Zero escritas, sempre.
 *
 * Trava de STOP-04: `codigo_incorreto` e o codigo desta rota e so dela.
 * `credencial_invalida` NAO se aplica aqui — a convencao de erro generico existe
 * onde ha credencial a enumerar, e um codigo de parada nao enumera nada.
 */
function recusa(): Response {
  console.warn('painel:', 'POST', CAMINHO_DA_PARADA, 403, 'codigo_incorreto')
  return pagina(FRASES.codigoIncorreto, 403)
}

/** Do codigo ja normalizado ate o lote. Separada so para caber numa leitura. */
async function conferirEParar(
  normalizado: string,
  env: Env,
  now: number,
  deps: DepsDaParada,
): Promise<Response> {
  const chaveDosCodigos = await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos')
  const codigos = new PainelCodigosRepository(env.DB)

  // Trava de STOP-06: `hashesVivos` vem ANTES de `lerEstadoDaAutomacao`, e o
  // `return` do meio e o que fixa o preco. Codigo errado custa 1 leitura e 0
  // escrita porque quem nao confere sai daqui sem nunca chegar a segunda
  // consulta; inverter as duas linhas faria todo palpite errado da internet
  // custar duas leituras na cota do dono, sem mudar uma unica resposta (§9.10).
  const vivos = await codigos.hashesVivos('parada')
  // Trava de STOP-10 e de STOP-12: a comparacao passa por `timingSafeEqual`, e
  // a lista vazia percorre o mesmo caminho de uma lista cheia que nao bate — a
  // pagina nao pode revelar se existe codigo cadastrado.
  const confere = await conferirCodigo(normalizado, 'parada', chaveDosCodigos, vivos, deps.comparar)
  if (!confere) return recusa()

  const config = new PainelConfigRepository(env.DB)
  const estado = await config.lerEstadoDaAutomacao()

  // Linha ausente NAO e "ja desligada": sem linha quem manda e a fabrica, que
  // nasce ligada. Por isso o caminho sem linha grava — e a `INSERT` do
  // statement e que materializa a configuracao (§8.3).
  if (estado !== null && estado.enabled === 0) {
    // Trava de STOP-08: acionar duas vezes e idempotente, e a segunda vez nao
    // custa escrita nenhuma.
    return pagina(FRASES.parada, 200)
  }

  const auditoria = new PainelAuditoriaRepository(env.DB)
  const versaoResultante = estado === null ? 1 : estado.versao + 1

  // Trava de STOP-13, e a regra de ouro de §8.8: sem log, sem mudanca.
  //
  // UM `db.batch()` so, com o `UPDATE` e a linha de auditoria dentro, nesta
  // ordem. Se qualquer metade falhar, as duas falham e a pessoa ve a terceira
  // resposta — nunca um sucesso silencioso, e nunca a variante "grava a config,
  // depois tenta logar", que e o que um segundo `batch()` aqui significaria.
  await env.DB.batch([
    config.statementDeParada(now, fabricaDaConfig(automationConfig)),
    auditoria.statementDeRegistro({
      ocorridoEm: now,
      versao: versaoResultante,
      origem: 'parada',
      ator: 'parada',
      stepUp: false,
      acao: 'parada_acionada',
      alvo: null,
      campos: '[]',
      // `antes` e `depois` ficam `NULL`: este evento nao muda campo de
      // configuracao nenhum que valha historico — ele desliga (§9.9).
      antes: null,
      depois: null,
    }),
  ])

  // Sem isto, o isolate que acabou de parar a automacao continuaria servindo o
  // snapshot "ligado" ate o TTL vencer. Trava de STOP-07.
  invalidarCacheDeConfig()

  return pagina(FRASES.parada, 200)
}

// ---------------------------------------------------------------------------
// POST /setup/painel/codigos — os codigos, uma unica vez
// ---------------------------------------------------------------------------

/**
 * Sorteia 6 codigos de recuperacao e 1 de parada, grava so os HMAC e devolve
 * o texto UMA UNICA VEZ (§10.11).
 *
 * **O corpo desta resposta nunca e registrado em log**, em nenhum nivel:
 * `console.log`/`warn`/`error` do corpo desta rota e proibido, e a varredura
 * do `verificar-antes-de-publicar` cobre este arquivo. Trava de REG-21.
 *
 * Gerar um conjunto novo apaga o antigo inteiro: uma lista impressa que a
 * pessoa acha que substituiu nao pode continuar valendo.
 */
export async function handleGerarCodigos(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  if (request.method !== 'POST') return metodoNaoPermitido('POST')

  // Bearer, nunca cookie e nunca query string — a mesma porta das outras
  // rotas `/setup/*`, com o mesmo comparador em tempo constante.
  //
  // Ruling 19: esta rota e da familia `/setup/*`, e nao do painel. Ela responde
  // texto e `401` como as irmas (`oauth.ts:52`, `oauth.ts:149`) e, como elas,
  // NAO registra nada em log — §11.4 e a tabela do painel, e quem nao e painel
  // nao se anuncia como `painel:`. A grafia `nao_autorizado`, que nao existe em
  // §11.4, saiu daqui por isso.
  if (!isAdmin(request, env)) {
    return new Response('Nao autorizado', {
      status: 401,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    })
  }

  if (!chaveDeSessaoPresente(env)) {
    return new Response('PANEL_SESSION_KEY nao configurado', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    })
  }

  const sorteados = sortearConjunto()
  const chaveDosCodigos = await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos')

  const paraGravar: CodigoParaGravar[] = []
  for (const codigo of sorteados.recuperacao) {
    paraGravar.push({
      hash: await hashDoCodigo(chaveDosCodigos, 'recuperacao', codigo),
      tipo: 'recuperacao',
      versaoHash: VERSAO_DO_HASH,
    })
  }
  paraGravar.push({
    hash: await hashDoCodigo(chaveDosCodigos, 'parada', sorteados.parada),
    tipo: 'parada',
    versaoHash: VERSAO_DO_HASH,
  })

  // UM lote: o `DELETE` do conjunto antigo, os sete `INSERT` e a linha de
  // auditoria. Se qualquer parte falhar, nao sobra meio conjunto no banco.
  await env.DB.batch([
    ...new PainelCodigosRepository(env.DB).statementsDeSubstituicao(paraGravar, now),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro({
      ocorridoEm: now,
      // `0` porque este evento nao muda a configuracao: perguntar a versao
      // atual custaria a leitura que §9.10 fixa em zero para esta rota.
      versao: 0,
      origem: 'assistente',
      ator: 'assistente',
      stepUp: false,
      acao: 'codigos_gerados',
      alvo: null,
      campos: '[]',
      antes: null,
      depois: null,
    }),
  ])

  return Response.json(
    {
      recuperacao: sorteados.recuperacao.map(formatarCodigo),
      parada: formatarCodigo(sorteados.parada),
      instrucoes:
        'Anote estes codigos no papel agora. Eles nao serao mostrados de novo, e gerar um ' +
        'conjunto novo invalida este.',
    },
    { headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } },
  )
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/**
 * O pedaco do portao de sanidade de que o subsistema de emergencia depende.
 *
 * So a `PANEL_SESSION_KEY`, que e a raiz de `k_codigos`. `PANEL_RP_ID` e
 * `SETUP_ADMIN_TOKEN` ficam de fora de proposito: exigi-los aqui derrubaria o
 * freio junto com o subsistema WebAuthn que ele existe para contornar
 * (§11.1). Trava de STOP-14.
 *
 * O `typeof` na frente nao e estilo: um binding nao cadastrado chega como
 * `undefined` em Workers, e `env.PANEL_SESSION_KEY.length` sozinho lancaria
 * `TypeError`.
 */
function chaveDeSessaoPresente(env: Env): boolean {
  return (
    typeof env.PANEL_SESSION_KEY === 'string' &&
    env.PANEL_SESSION_KEY.length >= MINIMO_DA_CHAVE_DE_SESSAO
  )
}

/**
 * `405` com `Allow`. `OPTIONS` cai aqui de proposito, e nunca em CORS.
 *
 * Nao registra nada: o `console.warn('painel:', ...)` de `metodo_nao_permitido`
 * fica nos DOIS chamadores do painel, e nao aqui. `/setup/painel/codigos` usa a
 * mesma resposta e nao loga, porque ela e da familia `/setup/*` (Ruling 19) —
 * um log dentro desta funcao daria prefixo de painel a uma rota que nao e.
 */
function metodoNaoPermitido(permitidos: string): Response {
  return new Response('Metodo nao permitido', {
    status: 405,
    headers: {
      allow: permitidos,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
      vary: 'Cookie',
    },
  })
}

/**
 * A fabrica de `src/config.ts`, no formato das colunas de `painel_config`.
 *
 * E o que materializa a linha quando ela ainda nao existe (§8.3). `src/config.ts`
 * continua sendo a fabrica e nao muda nada; este arquivo so a le.
 *
 * `allowedMediaIds` nao vira coluna: o gravavel e `mediaScope`, e a lista e
 * derivada das linhas ativas de `painel_midias` (§9.4).
 */
function fabricaDaConfig(config: AutomationConfig): LinhaDeFabrica {
  return {
    trigger_keywords: JSON.stringify(config.triggerKeywords),
    match_mode: config.matchMode,
    case_sensitive: config.caseSensitive ? 1 : 0,
    normalize_accents: config.normalizeAccents ? 1 : 0,
    ignore_punctuation: config.ignorePunctuation ? 1 : 0,
    process_only_reels: config.processOnlyReels ? 1 : 0,
    media_scope: config.allowedMediaIds.includes('*') ? 'todas' : 'selecionadas',
    public_reply_enabled: config.publicReplyEnabled ? 1 : 0,
    public_reply_text: config.publicReplyText,
    private_reply_enabled: config.privateReplyEnabled ? 1 : 0,
    private_reply_text: config.privateReplyText,
    destination_url: config.destinationUrl,
    user_cooldown_hours: config.userCooldownHours,
  }
}
