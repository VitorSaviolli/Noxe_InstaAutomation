/**
 * O convite de uso unico e o registro de uma passkey:
 * `GET /painel/convite`, `POST /painel/api/registrar/opcoes` e
 * `POST /painel/api/registrar/verificar` (§10.4, §10.5, §10.6).
 *
 * **Esta rota NAO emite sessao** (§15.3, divergencia 5). Depois de cadastrar,
 * a resposta e `{ ok: true, para: "/painel/entrar" }` e a tela diz "Aparelho
 * cadastrado. Agora entre com ele." Tres razoes: a sessao nasce SEMPRE de uma
 * assertion de login com `UV` conferido, num ponto unico do codigo, o que torna
 * a garantia testavel; a rotacao obrigatoria de identificador no login fecha
 * fixacao de sessao; e e o que faz o codigo de recuperacao nunca virar sessao,
 * nem direta nem indiretamente. O custo e um gesto de biometria a mais, logo
 * depois de outro, aceito, e a tela explica.
 *
 * **As tres, e apenas tres, autorizacoes** (§10.4). Nao existe uma quarta, e
 * em particular NAO existe o ramo `if (credenciais.length === 0) permitir`: o
 * "trust on first use" e exatamente o takeover de primeiro acesso que §10.6
 * prova ser impossivel aqui. O conjunto de instantes em que o registro esta
 * aberto a um estranho e VAZIO, e nao apenas curto, porque as tres
 * autorizacoes dependem de segredos que existem ANTES do deploy.
 *
 * **O convite nao tem rota de emissao, e isso e deliberado** (§10.4): quem o
 * assina e o assistente local, com `k_convite` derivada do `SETUP_ADMIN_TOKEN`,
 * sem rede. Este arquivo so CONFERE. Uma rota de emissao seria um caminho a
 * mais para o Worker produzir autorizacao de cadastro, e o desenho inteiro
 * existe para que exista apenas um.
 */
import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import { PainelCodigosRepository } from '../../repositories/painel-codigos-repository'
import {
  type OrigemDeRegistro,
  PainelCredenciaisRepository,
} from '../../repositories/painel-credenciais-repository'
import {
  FALHAS_DE_STEPUP_ATE_APAGAR,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { bytesToBase64Url } from '../../security/base64url'
import { timingSafeEqual } from '../../security/constant-time'
import { hmacSha256 } from '../../security/signed-envelope'
import { conferirCodigo, hashDoCodigo, normalizarCodigo } from '../../services/panel-codes'
import {
  derivarSubchave,
  emitirEnvelope,
  fichaCsrf,
  lerEnvelope,
  origemDoPainel,
  painelHabilitado,
  validarSessao,
} from '../../services/panel-session'
import { opcoesDeRegistro, sortearDesafio } from '../../services/webauthn/opcoes'
import {
  type CredencialRegistrada,
  prefixoDeCredencial,
  type RespostaDeRegistro,
  verificarRegistro,
} from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import {
  CABECALHO_DA_FICHA,
  COOKIE_DA_SESSAO,
  COOKIE_DO_DESAFIO,
  cookieDoPainel,
  lerCookie,
} from './campos'
import {
  CAMINHO_DE_ENTRAR,
  type Limitador,
  lerCorpoCapado,
  limitar,
  origemConfere,
} from './guardas'
import { cabecalhos } from './html'
import { type CodigoDeErro, ERROS } from './resposta'
import { cookieDeStepUpExpirado, exigirStepUp, opHash } from './stepup'

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** A pagina que o link do convite abre. Le o token do fragmento; 0 consulta. */
export const CAMINHO_DO_CONVITE = '/painel/convite'
/** Onde a cerimonia comeca. */
export const CAMINHO_DAS_OPCOES = '/painel/api/registrar/opcoes'
/** Onde ela termina, e a unica porta para `painel_credenciais`. */
export const CAMINHO_DA_VERIFICACAO = '/painel/api/registrar/verificar'

/**
 * Teto do corpo das rotas `/painel/api/*`: **8 KB** (§7.6, §11.3 passo 4).
 *
 * Uma resposta WebAuthn com attestation `none` tem ~1 a 2 KB. O teto pequeno e
 * o que protege os 10 ms de CPU do parser CBOR: o corpo do webhook continua em
 * 512 KB e intocado, e sao numeros de mundos diferentes de proposito.
 */
export const TETO_DO_CORPO_DA_API = 8 * 1024

/** Teto de credenciais por `rp_id` (§7.6, §10.5 passo 9). */
export const TETO_DE_CREDENCIAIS = 10

/** Apelido do aparelho: 1 a 40 caracteres (§7.6). */
export const TAMANHO_DO_APELIDO = 40

/** Validade do convite: 20 minutos (§7.6). */
export const PRAZO_DO_CONVITE_MS = 20 * 60 * 1000

/** O apelido de quem nao digitou nada que sobrevivesse ao saneamento. */
const APELIDO_PADRAO = 'Aparelho'

const JSON_TIPO = 'application/json'

/** Prefixo, nonce, pre, prazo e assinatura (§10.4). */
const PARTES_DO_CONVITE = 5
const VERSAO_DO_CONVITE = 'cv1'

// Os dois cookies e o cabecalho da ficha vivem em `guardas.ts` desde a etapa do
// roteador: sao o vocabulario de §7.2, e uma segunda grafia de qualquer um
// deles seria um cookie que ninguem le ou uma ficha que ninguem confere.

/**
 * As tres autorizacoes de §10.4, e a funcao que as produz tem tres ramos.
 *
 * Lema 4 de §10.6 esta neste tipo: `autorizar()` faz `switch` sobre ele e a
 * exaustividade e conferida pelo compilador. Um quarto ramo exigiria um quarto
 * membro aqui, e um quarto membro nao passa despercebido numa revisao.
 */
type AutorizacaoRegistro =
  | { readonly tipo: 'convite'; readonly nonce: string }
  | { readonly tipo: 'recuperacao'; readonly hashCodigo: string }
  | { readonly tipo: 'sessao'; readonly credencialId: string }

/** O que a rota busca fora de si mesma. Existe para o teste injetar dubles. */
export interface DepsDoRegistro {
  /**
   * Limitador de taxa. O padrao e o da familia da rota, `login` no modo
   * convite, `codigo` no modo recuperacao. O modo `sessao` nao tem limitador
   * porque §7.4 nao lhe da binding: quem chega ali ja provou quem e.
   */
  limitador?: Limitador
  /**
   * O step-up do modo `sessao` (§10.4 passo 1, §10.10, §10.13).
   *
   * Ate a Etapa 12 o padrao RECUSAVA: o verificador de verdade, `op_hash`
   * recalculado no servidor a partir da mudanca canonica
   * `{ acao: "adicionar_passkey" }`, nao existia, e escrever aqui uma segunda
   * versao dele criaria duas especificacoes do mesmo hash. Agora ele existe, e
   * o padrao e ELE: `conferirAdicaoDePasskey`, logo abaixo, chama o MESMO
   * `exigirStepUp` do funil de gravacao, com o `op_hash` calculado pela MESMA
   * `opHash`.
   *
   * O parametro continua existindo porque `painel-convite.test.ts` injeta um
   * duble para exercitar o ramo `sessao` sem montar uma cerimonia inteira.
   */
  conferirStepUp?: (entrada: {
    request: Request
    env: Env
    sidHash: string
    now: number
    /** A assertion serializada, como o corpo JSON a trouxe. */
    digital: string
  }) => Promise<boolean>
}

/**
 * O step-up de `{ acao: "adicionar_passkey" }` (§10.13).
 *
 * **A mudanca canonica nao tem campos, e a ausencia e o desenho**: nao ha
 * conteudo a amarrar, a passkey nova ainda nem foi criada, e o que ela vai ser
 * e decidido pelo autenticador depois. O que o `op_hash` prende aqui e a
 * OPERACAO: uma digital colhida para trocar o link do Direct nao serve para
 * cadastrar um aparelho novo, porque `{"acao":"config",...}` e
 * `{"acao":"adicionar_passkey"}` sao textos diferentes e produzem hashes
 * diferentes (§10.10, o `acao` que entra no JSON canonico existe para isto).
 *
 * Sao **dois** gestos de biometria seguidos, um para autorizar, um para criar
 *, e a tela avisa antes: "confirme que e voce" e depois "crie a chave nova".
 */
async function conferirAdicaoDePasskey(entrada: {
  request: Request
  env: Env
  sidHash: string
  now: number
  digital: string
}): Promise<boolean> {
  if (entrada.digital === '') return false

  const veredito = await exigirStepUp({
    request: entrada.request,
    env: entrada.env,
    now: entrada.now,
    sidHash: entrada.sidHash,
    digital: entrada.digital,
    // Recalculado AQUI, no servidor. Um `op_hash` que chegasse pelo corpo
    // autorizaria qualquer coisa (§10.10).
    opHashDeAgora: await opHash({ acao: 'adicionar_passkey', campos: {} }),
  })

  if (!veredito.ok) {
    // O motivo vai para o log do dono; ao cliente, `step_up_necessario` e mais
    // nada, separar os casos daria um oraculo para descobrir qual metade da
    // trava ainda falta quebrar (§10.10).
    console.warn('painel:', 'registro_recusado', veredito.motivo)
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// As respostas
// ---------------------------------------------------------------------------

// A tabela canonica de §11.4 mora em `resposta.ts` desde a etapa do roteador,
// esta rota tinha uma copia enquanto aquele arquivo nao existia, e a copia
// morreu junto com a promessa que ela carregava no comentario. "Esta tabela e a
// UNICA" nao admite duas grafias do mesmo `status` e da mesma frase.
//
// O construtor de resposta continua local porque a FORMA e outra: estas rotas
// falam so JSON e nasceram com a assinatura `(codigo, request, caminho)`.

/**
 * Um erro de §11.4, com o codigo no log e a frase no corpo.
 *
 * Nunca ha campo `detalhe`, `stack`, `cause` ou mensagem de excecao, a
 * `mensagem` sai da tabela e nao do erro que aconteceu. O `console.warn` segue
 * §11.7: argumentos separados, sem template string com dado variavel dentro.
 */
function erro(
  codigo: CodigoDeErro,
  request: Request,
  caminho: string,
  extras: Record<string, string> = {},
): Response {
  const { status, mensagem } = ERROS[codigo]
  console.warn('painel:', request.method, caminho, status, codigo)

  return Response.json(
    { erro: codigo, mensagem },
    { status, headers: { ...extras, ...cabecalhos('api') } },
  )
}

/** `405` com `Allow`. `OPTIONS` cai aqui de proposito, e nunca em CORS. */
function metodoNaoPermitido(request: Request, caminho: string, permitidos: string): Response {
  return erro('metodo_nao_permitido', request, caminho, { allow: permitidos })
}

/**
 * A excecao nao prevista: `500 falha_interna`, e nunca `503 indisponivel`.
 *
 * §11.4 separa os dois de proposito, e a separacao e sobre O QUE O DONO FAZ ao
 * ler a frase: `indisponivel` e "D1 indisponivel ou cota estourada" e manda
 * conferir o status da Cloudflare; `falha_interna` e "qualquer excecao nao
 * prevista" e e o padrao de todo `try/catch` do projeto. Um `TypeError` em
 * `gravarCredencial` anunciado como "Servico temporariamente indisponivel"
 * mandaria o dono investigar a Cloudflare por um defeito NOSSO.
 *
 * Um `catch` que pega TUDO nao sabe qual dos dois aconteceu, e §11.4 ja decidiu
 * o desempate: o `try/catch` generico devolve `falha_interna`. Quem quiser
 * responder `indisponivel` precisa saber que estava falando com o D1, e ai o
 * `catch` fica estreito, em volta so da chamada que toca o banco, nunca em
 * volta do handler inteiro. (`parada.ts:281-341` NAO e esse exemplo, mesmo
 * parecendo um candidato obvio por ser o outro `catch` largo do painel: o dela
 * e um `catch` de HANDLER inteiro, corpo, limitador e a cadeia de
 * `conferirEParar` por baixo, devolvendo `503` para qualquer excecao de
 * proposito, como divergencia documentada da regra das tres telas canonicas de
 * §10.12. Seguir aquele como modelo de "catch estreito de D1" copiaria a
 * forma errada.)
 *
 * **Por que o `catch` mora aqui, e nao so no roteador.** `router.ts` tem o
 * `catch` canonico, mas ele esta dentro de `despachar()`, e as tres rotas do
 * registro NAO passam por `despachar`, `portaDaApi` ja consome o
 * `ReadableStream` do corpo, e um `despachar` por cima entregaria corpo vazio
 * ao handler. `routePainel` as chama direto, `src/index.ts` nao tem `try` em
 * volta do `fetch`, e sem este `catch` a excecao escaparia ate o workerd: um
 * `500` cru, sem o envelope `{erro, mensagem}` de §11.4 e sem a linha de log.
 * Ele fica, entao, mas devolvendo o MESMO codigo que o roteador devolveria.
 */
function falhaInterna(cause: unknown, request: Request, caminho: string): Response {
  console.error('painel:', 'falha_interna', cause instanceof Error ? cause.message : cause)
  return erro('falha_interna', request, caminho)
}

/**
 * O conflito de chave primaria do passo 8 de §10.5.
 *
 * O `INSERT` da credencial vai sem `ON CONFLICT`, e um `credential_id` repetido
 * derruba o lote inteiro, e essa derrubada E a verificacao do passo 8. Sem
 * esta leitura da excecao ela virava `503`, com o convite ja queimado (o
 * consumo do nonce vai sozinho e ANTES do lote, de proposito).
 *
 * **A recusa e a generica**, `credencial_invalida`, pelo motivo de sempre
 * (§11.4): distinguir "esta credencial ja existe" de "assinatura invalida"
 * daria um oraculo de enumeracao de `credential_id`. Mesmo status, mesma frase,
 * mesmo lugar no fluxo, e nada do valor vai para o log.
 *
 * A unica restricao de unicidade alcancavel neste lote e a PK da credencial: os
 * demais statements sao `UPDATE` e `DELETE`, e o `INSERT` do convite ja saiu
 * antes, com `ON CONFLICT DO NOTHING`. Por isso o regex casa so a CLASSE
 * unicidade/PK, nunca `NOT NULL`, `CHECK` ou `FOREIGN KEY`, sem casar o nome
 * da tabela ou da coluna numa mensagem que e do D1 e nao nossa.
 *
 * **Por que o regex nao e so `/constraint failed/i`.** Confirmado empiricamente
 * neste runtime (`@cloudflare/vitest-pool-workers`): um `credential_id`
 * repetido lanca `D1_ERROR: UNIQUE constraint failed:
 * painel_credenciais.credential_id: SQLITE_CONSTRAINT (extended:
 * SQLITE_CONSTRAINT_PRIMARYKEY)`, mas uma violacao `NOT NULL` lanca
 * `D1_ERROR: NOT NULL constraint failed: painel_credenciais.<coluna>:
 * SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)`, e AS DUAS mensagens
 * contem tanto `constraint failed` quanto `SQLITE_CONSTRAINT`, a bare palavra
 * `SQLITE_CONSTRAINT` e o COARSE result code do SQLite, comum a toda classe de
 * violacao. `painel_credenciais` tem DEZ colunas `NOT NULL` (`migrations/
 * 0004_painel_acesso.sql`); hoje nenhum caminho tipado deixa uma chegar nula
 * neste `INSERT`, isto e robustez e observabilidade, nao um bug ao vivo,
 * mas o regex antigo teria classificado esse "e se" como `credencial_duplicada`
 * (401, generico) em vez de `falha_interna` (500, com o `cause.message` real no
 * log do dono). So a palavra INICIAL do texto ("UNIQUE" / "PRIMARY KEY") ou o
 * result code ESTENDIDO (nao o coarse) distingue as classes.
 */
const CONFLITO_DE_CHAVE = /\b(?:UNIQUE|PRIMARY KEY) constraint failed\b/i

function ehConflitoDeChave(cause: unknown): boolean {
  return cause instanceof Error && CONFLITO_DE_CHAVE.test(cause.message)
}

// ---------------------------------------------------------------------------
// GET /painel/convite, a pagina, com 0 consulta ao D1
// ---------------------------------------------------------------------------

/** Nenhuma interpolacao: o texto e constante, e e o que o torna seguro. */
export const PAGINA_DO_CONVITE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cadastrar este aparelho</title>
<link rel="stylesheet" href="/painel/painel.css">
</head>
<body>
<h1>Cadastrar este aparelho</h1>
<p>Voc&ecirc; abriu o link do convite. Ele vale por 20 minutos e s&oacute; pode ser usado uma vez.</p>
<form id="registrar" method="dialog">
<label for="apelido">Como voc&ecirc; chama este aparelho</label>
<input id="apelido" name="apelido" type="text" maxlength="40" autocomplete="off" enterkeyhint="done" required>
<button type="submit">Cadastrar este aparelho</button>
</form>
<h2>Antes de cadastrar, duas coisas importantes</h2>
<p><strong>O endere&ccedil;o deste painel fica gravado dentro da sua digital.</strong> Se um dia o
endere&ccedil;o mudar, este aparelho precisa ser cadastrado de novo, n&atilde;o d&aacute;
para migrar, e n&atilde;o &eacute; defeito: &eacute; assim que a digital protege voc&ecirc; de um
site falso com outro endere&ccedil;o.</p>
<p><strong>Chave de seguran&ccedil;a sem PIN n&atilde;o entra.</strong> O painel exige
confirma&ccedil;&atilde;o de quem voc&ecirc; &eacute;, digital, rosto ou PIN, em toda
entrada. Uma chavinha USB que apenas "toca" e n&atilde;o pede PIN vai ser recusada.</p>
<noscript>
<p><strong>Este navegador est&aacute; com o JavaScript desligado.</strong> Cadastrar a digital
precisa dele. Continuam funcionando sem JavaScript: entrar com um c&oacute;digo de
recupera&ccedil;&atilde;o e a p&aacute;gina de parada de emerg&ecirc;ncia.</p>
</noscript>
<p class="pequeno"><a href="/painel/entrar">J&aacute; tenho acesso: ir para Entrar</a></p>
<script src="/painel/painel.js" defer></script>
</body>
</html>
`

const PAGINA_DESATIVADA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel ainda nao ativado</title>
</head>
<body>
<h1>O painel ainda n&atilde;o foi ativado.</h1>
<p>Quem instalou precisa terminar de preparar o painel antes do primeiro acesso.</p>
</body>
</html>
`

/** A frase de `metodo_nao_permitido` de §11.4, na tela e sem interpolacao. */
const PAGINA_DE_METODO = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Metodo nao permitido</title>
</head>
<body>
<h1>M&eacute;todo n&atilde;o permitido.</h1>
</body>
</html>
`

/**
 * A pagina que o link do convite abre.
 *
 * **O token vem no FRAGMENTO**, nunca na query string: o fragmento nao e
 * enviado ao servidor, nao entra em log de proxy nem em `Referer`, a mesma
 * regra que `oauth.ts` ja aplica. Quem le `location.hash`, limpa a barra de
 * enderecos com `history.replaceState` e manda o token no CORPO do POST e o
 * `painel.js` (§12.8, trabalho 2). Por isso esta funcao nao recebe `url`: ela
 * nao teria o que fazer com ela, e nao poder ler o token e a garantia.
 *
 * Os dois avisos em portugues claro sao obrigatorios ANTES do primeiro
 * cadastro (§10.14 item 6, §7.8): trocar o endereco do painel e RE-REGISTRO e
 * nao migracao, porque o `rpId` fica gravado dentro da passkey e nao pode ser
 * corrigido depois; e chave de seguranca sem PIN nao entra, porque `UV = 1` e
 * obrigatorio sempre.
 */
export function handlePaginaDeConvite(request: Request, env: Env): Response {
  // Passo 0 ANTES do passo 1, pela mesma razao de `portaDaApi`: e a ordem que
  // §11.3 numera e a que `router.ts` executa antes de chegar aqui.
  const sanidade = painelHabilitado(env)
  if (!sanidade.ok) {
    console.warn('painel:', request.method, CAMINHO_DO_CONVITE, 503, 'painel_desativado')
    return new Response(PAGINA_DESATIVADA, { status: 503, headers: cabecalhos('pagina') })
  }

  // Passo 1. O `Allow` lista os DOIS metodos que a linha acima aceita: um
  // `Allow: GET` num handler que atende `HEAD` e um cabecalho que mente, e
  // `Allow` e exatamente o cabecalho que existe para nao mentir. E o corpo e
  // HTML, como o `content-type` de `cabecalhos('pagina')` promete, a frase e a
  // canonica de §11.4 para `metodo_nao_permitido`.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    console.warn('painel:', request.method, CAMINHO_DO_CONVITE, 405, 'metodo_nao_permitido')
    return new Response(PAGINA_DE_METODO, {
      status: 405,
      headers: { allow: 'GET, HEAD', ...cabecalhos('pagina') },
    })
  }

  return new Response(PAGINA_DO_CONVITE, { status: 200, headers: cabecalhos('pagina') })
}

// ---------------------------------------------------------------------------
// POST /painel/api/registrar/opcoes
// ---------------------------------------------------------------------------

/** O corpo aceito por `/opcoes`. Qualquer outra forma e `null`. */
type PedidoDeOpcoes =
  | { readonly tipo: 'convite'; readonly convite: string }
  | { readonly tipo: 'recuperacao'; readonly codigo: string }
  | { readonly tipo: 'sessao'; readonly digital: string }

function lerPedidoDeOpcoes(corpo: unknown): PedidoDeOpcoes | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const lido = corpo as Record<string, unknown>

  if (lido.tipo === 'convite' && typeof lido.convite === 'string') {
    return { tipo: 'convite', convite: lido.convite }
  }
  if (lido.tipo === 'recuperacao' && typeof lido.codigo === 'string') {
    return { tipo: 'recuperacao', codigo: lido.codigo }
  }
  // A digital do step-up de `{ acao: "adicionar_passkey" }` viaja no CORPO, e
  // nao num cookie: ela e uma assertion, e o cookie desta cerimonia carrega o
  // envelope (o desafio e o `op_hash`), nunca a resposta. Ausente vira `''`, e
  // `''` recusa no passo do step-up, nao ha ramo em que ela "nao precisa".
  if (lido.tipo === 'sessao') {
    return { tipo: 'sessao', digital: typeof lido.digital === 'string' ? lido.digital : '' }
  }

  return null
}

/**
 * Gera as options da cerimonia de registro (§10.4).
 *
 * A ordem e a de §11.3 e ela importa: o que custa zero vem antes do que custa
 * CPU, e o que custa CPU vem antes do que custa D1.
 *
 * **A autorizacao e validada ANTES de gerar qualquer coisa** (passo 3). As
 * options revelam o `usuario_handle` e a lista de `excludeCredentials`, isto e,
 * os `credential_id` ja registrados: devolver isso a um estranho e enumeracao
 * de graca.
 *
 * **Nada e consumido aqui** (passo 4): o convite nao e marcado e o codigo nao e
 * queimado. Se a pessoa cancelar a biometria, o fracasso mais comum, ela
 * tenta de novo com o mesmo convite.
 */
export async function handleOpcoesDeRegistro(
  request: Request,
  env: Env,
  now: number,
  deps: DepsDoRegistro = {},
): Promise<Response> {
  const porta = await portaDaApi(request, env, CAMINHO_DAS_OPCOES, 'POST')
  if (porta.erro !== undefined) return porta.erro

  try {
    const pedido = lerPedidoDeOpcoes(porta.corpo)
    // Trava de CONV-06: registro sem convite e sem codigo e recusado ANTES de
    // gerar as options, e nao depois, e o `null` daqui e o primeiro portao.
    if (pedido === null) return erro('credencial_invalida', request, CAMINHO_DAS_OPCOES)

    // Passo 5 da escada: ZERO consulta ao D1 ate esta linha, entao uma
    // tentativa recusada pelo limitador nao custa banco (RL-05). O modo
    // `sessao` nao passa por aqui porque §7.4 nao lhe da binding.
    if (pedido.tipo !== 'sessao') {
      const familia = pedido.tipo === 'convite' ? 'login' : 'codigo'
      const veredito = await limitar(request, env, familia, now, deps.limitador)
      if (!veredito.permitido) {
        return erro('muitas_tentativas', request, CAMINHO_DAS_OPCOES, {
          'retry-after': String(veredito.esperarSegundos),
        })
      }
    }

    const credenciais = new PainelCredenciaisRepository(env.DB)
    const autorizacao = await autorizar(pedido, request, env, now, credenciais, deps)
    if (autorizacao.recusa !== undefined) {
      return erro(autorizacao.recusa, request, CAMINHO_DAS_OPCOES)
    }

    return await montarOpcoes(autorizacao.autorizacao, request, env, now, credenciais)
  } catch (cause) {
    return falhaInterna(cause, request, CAMINHO_DAS_OPCOES)
  }
}

/**
 * As options, o desafio e o bilhete (§10.4, passos 5 a 7).
 *
 * Duas leituras: as credenciais, que respondem `excludeCredentials`, a regra
 * do `pre=0` e o teto de 10 de uma vez, e o `usuario_handle`. A segunda so
 * grava na primeirissima vez da vida da instalacao.
 */
async function montarOpcoes(
  autorizacao: AutorizacaoRegistro,
  request: Request,
  env: Env,
  now: number,
  credenciais: PainelCredenciaisRepository,
): Promise<Response> {
  const conhecidas = await credenciais.listarTodas()
  const desteEndereco = conhecidas.filter((linha) => linha.rpId === env.PANEL_RP_ID)

  // Teto de 10 por `rp_id`, conferido ja aqui: uma cerimonia que so poderia
  // ser recusada no fim gastaria uma biometria do dono para nada.
  if (desteEndereco.length >= TETO_DE_CREDENCIAIS) {
    return erro('credencial_invalida', request, CAMINHO_DAS_OPCOES)
  }

  const usuarioHandle = await credenciais.lerOuCriarHandle(now)
  const desafio = sortearDesafio()

  // O bilhete: mesmo cookie de todas as cerimonias, distinguido pelo PROPOSITO
  // que entra no texto assinado, na derivacao da chave e no nome do cookie
  // (§10.3). `k` carrega a autorizacao ja provada, para que a verificacao nao
  // precise prova-la de novo nem confiar no corpo.
  const bilhete = await emitirEnvelope(
    env,
    'registrar',
    { c: desafio, a: autorizacao.tipo, k: chaveDaAutorizacao(autorizacao), h: usuarioHandle },
    now,
  )

  const options = opcoesDeRegistro({
    rpId: env.PANEL_RP_ID,
    usuarioHandle,
    nomeDeUsuario: NOME_DE_USUARIO,
    desafio,
    excluir: desteEndereco.map((linha) => linha.credentialId),
  })

  // Dois `Set-Cookie` no ramo `sessao`, e por isso um `Headers` em vez do
  // objeto literal: um `Record<string, string>` so tem uma chave `set-cookie`, e
  // a segunda comeria a primeira em silencio.
  const cabecalhosDaResposta = new Headers(cabecalhos('api'))
  cabecalhosDaResposta.append(
    'set-cookie',
    cookieDoPainel(COOKIE_DO_DESAFIO, bilhete, Math.floor(options.timeout / 1000)),
  )

  // §10.10, fim do passo 4: **expira o cookie** na requisicao que usa o
  // envelope. E o mesmo par de `Set-Cookie` de `lote.ts`, a metade que faltava
  // aqui.
  //
  // O que a ausencia dela causava: `exigirStepUp` e SEM ESTADO (confere MAC,
  // prazo, `sid`, `op_hash` e a assinatura, nada marca o envelope como usado),
  // entao o `Max-Age=0` E o consumo. Sem ele, o par (cookie + assertion)
  // continuava fechando pelo resto dos 120 s; e como a mudanca canonica de
  // `adicionar_passkey` nao tem alvo nem campos (`{"acao":"adicionar_passkey"}`
  // e sempre o mesmo texto), toda repeticao fechava e cada uma emitia um bilhete
  // de registro NOVO, uma digital do dono valendo por ate dez cadastros de
  // passkey, que e literalmente o "modo privilegiado por 120 s" que §10.10
  // recusa por escrito.
  //
  // So no ramo `sessao`: convite e recuperacao nao tem envelope a matar, e um
  // `Max-Age=0` disparado a esmo seria um carimbo cego em vez de um consumo.
  //
  // Custo para quem cancela a biometria da CRIACAO: um step-up a mais. O
  // `painel.js` ja recomeca a cerimonia inteira a cada clique em "cadastrar
  // este aparelho" (`adicionarAparelho` chama `colherDigital` antes de
  // `cadastrar`), entao nao ha beco sem saida, so um toque a mais numa
  // operacao rara, que e exatamente o preco que §10.10 diz aceitar.
  if (autorizacao.tipo === 'sessao') {
    cabecalhosDaResposta.append('set-cookie', cookieDeStepUpExpirado())
  }

  return Response.json(options, { headers: cabecalhosDaResposta })
}

/**
 * O `user.name` que aparece no gerenciador de senhas do celular.
 *
 * Constante, e nao o `@` da conta: o `@` so existe depois do OAuth e custaria
 * uma leitura em `account_tokens` numa rota cujo orcamento e de duas. O
 * `displayName`, "Dono da conta", ja diz o resto, e com dono unico nao ha
 * campo de usuario para escolher.
 */
const NOME_DE_USUARIO = '@painel'

/** O valor de `k` no bilhete: o que cada ramo precisa levar ate a gravacao. */
function chaveDaAutorizacao(autorizacao: AutorizacaoRegistro): string {
  switch (autorizacao.tipo) {
    case 'convite':
      return autorizacao.nonce
    case 'recuperacao':
      return autorizacao.hashCodigo
    case 'sessao':
      return autorizacao.credencialId
  }
}

// ---------------------------------------------------------------------------
// As tres autorizacoes, e nenhuma quarta (§10.4)
// ---------------------------------------------------------------------------

type ResultadoDaAutorizacao =
  | { readonly autorizacao: AutorizacaoRegistro; readonly recusa?: undefined }
  | { readonly autorizacao?: undefined; readonly recusa: CodigoDeErro }

/**
 * Lema 4 de §10.6: a funcao tem exatamente tres ramos.
 *
 * Lema 5: cada ramo exige um segredo, convite (MAC de 256 bits sob chave
 * derivada do admin token), recuperacao (100 bits) e sessao (chave privada em
 * hardware MAIS biometria). Lema 6: nao existe ramo TOFU.
 */
async function autorizar(
  pedido: PedidoDeOpcoes,
  request: Request,
  env: Env,
  now: number,
  credenciais: PainelCredenciaisRepository,
  deps: DepsDoRegistro,
): Promise<ResultadoDaAutorizacao> {
  switch (pedido.tipo) {
    case 'convite':
      return await autorizarPorConvite(pedido.convite, env, now, credenciais)
    case 'recuperacao':
      return await autorizarPorCodigo(pedido.codigo, env)
    case 'sessao':
      return await autorizarPorSessao(pedido.digital, request, env, now, deps)
  }
}

/**
 * O convite: `cv1.<nonce>.<pre>.<expira_em>.<hmac>` (§10.4).
 *
 *   hmac = HMAC-SHA256( k_convite, "cv1|" + nonce + "|" + pre + "|" + expira_em )
 *
 * Ordem IDENTICA a do envelope e a do `state` do OAuth: formato -> assinatura
 * em tempo constante -> prazo. Nunca o contrario. Conferir o prazo antes
 * deixaria um convite forjado se distinguir de um vencido pelo tempo de
 * resposta e pela mensagem.
 *
 * `pre = "0"` so vale enquanto NAO existir nenhuma credencial, defesa em
 * profundidade barata: o convite comum, que pode acabar num print de tutorial,
 * deixa de funcionar no instante em que a primeira passkey existe. `pre = "q"`
 * vale em qualquer estado, e o assistente avisa que ele e mais perigoso.
 *
 * **O consumo NAO acontece aqui** (§10.4, passo 4): esta funcao nem pergunta ao
 * banco se o nonce ja foi usado. Quem responde isso e o `INSERT ... ON CONFLICT
 * DO NOTHING` de `/verificar`, que e ATOMICO, perguntar antes seria uma
 * leitura a mais para uma resposta que a corrida pode invalidar no instante
 * seguinte.
 */
async function autorizarPorConvite(
  token: string,
  env: Env,
  now: number,
  credenciais: PainelCredenciaisRepository,
): Promise<ResultadoDaAutorizacao> {
  const partes = token.split('.')
  if (partes.length !== PARTES_DO_CONVITE) return { recusa: 'credencial_invalida' }

  const [versao, nonce, pre, expiraEmCru, assinatura] = partes as [
    string,
    string,
    string,
    string,
    string,
  ]
  if (versao !== VERSAO_DO_CONVITE) return { recusa: 'credencial_invalida' }
  if (pre !== '0' && pre !== 'q') return { recusa: 'credencial_invalida' }

  const chave = await derivarSubchave(env.SETUP_ADMIN_TOKEN, 'convite')
  const esperada = bytesToBase64Url(
    await hmacSha256(chave, `${VERSAO_DO_CONVITE}|${nonce}|${pre}|${expiraEmCru}`),
  )
  // Trava de CONV-04 e CONV-05: a assinatura cobre o `expira_em` CRU e o `pre`.
  // Um convite assinado com outro segredo, ou com o prazo esticado a mao,
  // morre nesta linha.
  if (!timingSafeEqual(esperada, assinatura)) return { recusa: 'credencial_invalida' }

  const expiraEm = Number.parseInt(expiraEmCru, 10)
  if (!Number.isFinite(expiraEm)) return { recusa: 'credencial_invalida' }
  // Trava de CONV-03: 20 minutos e o suficiente para sair do terminal e pegar
  // o celular, e curto o bastante para que um convite esquecido num print
  // esteja morto.
  if (now > expiraEm) return { recusa: 'credencial_invalida' }

  // Trava de CONV-07, e a PRIMEIRA consulta ao D1 desta rota, depois do HMAC
  // fechar, como manda §11.3. `pre=0` deixa de valer no instante em que existe
  // qualquer credencial, inclusive de um endereco antigo: ela prova que a
  // instalacao ja teve dono, mesmo que nao sirva mais para entrar (§10.14).
  if (pre === '0' && (await credenciais.listarTodas()).length > 0) {
    return { recusa: 'credencial_invalida' }
  }

  return { autorizacao: { tipo: 'convite', nonce } }
}

/**
 * O codigo de recuperacao (§10.11).
 *
 * Uma das tres rotas de §11.3 que recebem codigo digitado: o HMAC que fecha e
 * o **do proprio codigo**, calculado com a pimenta `k_codigos` que o atacante
 * nao tem. O formato exato e validado ANTES (0 consulta), e so entao vem 1
 * leitura e 0 escrita. Nao e excecao a regra: e a regra aplicada a um segredo
 * que nao e cookie.
 *
 * Trava de CONV-11: codigo errado percorre exatamente o mesmo caminho de codigo
 * inexistente, `conferirCodigo` nao sai no primeiro acerto, e a lista vazia
 * passa pelo mesmo laco de uma lista cheia.
 *
 * **Nada e consumido aqui.** O consumo, com `changes === 1`, e de `/verificar`.
 */
async function autorizarPorCodigo(bruto: string, env: Env): Promise<ResultadoDaAutorizacao> {
  const hashCodigo = await conferirCodigoDeRecuperacao(bruto, env)
  if (hashCodigo === null) return { recusa: 'credencial_invalida' }

  return { autorizacao: { tipo: 'recuperacao', hashCodigo } }
}

/**
 * Um codigo de recuperacao confere? Devolve o HMAC dele, ou `null`.
 *
 * **Exportada porque sao DUAS portas para o mesmo segredo, e uma so
 * conferencia.** `GET+POST /painel/entrar/codigo` (§15.3, decisao 1) confere o
 * codigo para RENDERIZAR a tela "crie a chave nova neste aparelho", e esta rota
 * o confere para emitir o bilhete de registro. Duas implementacoes da mesma
 * conferencia divergiriam na primeira vez que uma delas ganhasse um passo, e o
 * passo mais provavel de divergir e a normalizacao, que e o que faz `O` virar
 * `0` no codigo que a pessoa digita do papel sob estresse.
 *
 * **Nada e consumido aqui**, nas duas portas: o consumo, com `changes === 1`, e
 * de `/painel/api/registrar/verificar` e de nenhum outro lugar (§10.11). Uma
 * conferencia que queimasse o codigo faria abrir a tela por engano custar um dos
 * seis codigos do papel.
 *
 * O formato exato e validado ANTES de qualquer consulta (0 leitura), e so entao
 * vem 1 leitura e 0 escrita: `normalizarCodigo` recusa tudo o que nao for 20
 * caracteres do alfabeto, e e por isso que lixo digitado nao toca o D1 (§11.3).
 * `conferirCodigo` nao sai no primeiro acerto e a lista vazia percorre o mesmo
 * laco de uma lista cheia, codigo errado e codigo inexistente sao o mesmo
 * caminho (CONV-11).
 */
export async function conferirCodigoDeRecuperacao(bruto: string, env: Env): Promise<string | null> {
  const normalizado = normalizarCodigo(bruto, 'recuperacao')
  if (normalizado === null) return null

  const chaveDosCodigos = await derivarSubchave(env.PANEL_SESSION_KEY, 'codigos')
  const vivos = await new PainelCodigosRepository(env.DB).hashesVivos('recuperacao')
  if (!(await conferirCodigo(normalizado, 'recuperacao', chaveDosCodigos, vivos))) return null

  return await hashDoCodigo(chaveDosCodigos, 'recuperacao', normalizado)
}

/**
 * A sessao viva com step-up recem feito (§10.4, passo 1).
 *
 * **Este e o unico POST autorizado por cookie de sessao cuja ficha CSRF foi
 * decidida a parte** (§15.4): sem ela, cadastrar uma passkey nova, que e
 * precisamente a operacao que um atacante mais gostaria de executar em nome do
 * dono, seria a unica rota autenticada sem a camada 3 de §10.9.
 *
 * Ordem: sessao (1 HMAC) -> ficha (1 HMAC) -> step-up. Nenhuma consulta ao D1
 * ate o step-up fechar, e por isso um cookie forjado nao custa banco nenhum.
 *
 * A UNICA excecao e a RECUSA de step-up, que paga 1 leitura e 1 escrita em
 * `punirFalhaDeStepUp`, e ela nao contradiz a frase acima: para chegar la o
 * cookie de sessao ja fechou o HMAC e a ficha ja fechou o dela, entao quem
 * provoca a escrita e alguem que apresentou uma sessao NOSSA. E o mesmo
 * desempate que §9.9 usa para permitir a linha de auditoria de fracasso: "a
 * requisicao e autenticada, portanto a escrita ja esta limitada por uma
 * credencial".
 */
async function autorizarPorSessao(
  digital: string,
  request: Request,
  env: Env,
  now: number,
  deps: DepsDoRegistro,
): Promise<ResultadoDaAutorizacao> {
  const cookie = lerCookie(request, COOKIE_DA_SESSAO)
  if (cookie === null) return { recusa: 'sessao_ausente' }

  const sessao = await validarSessao(env, cookie, now)
  if (!sessao.valida) return { recusa: 'sessao_ausente' }

  const ficha = request.headers.get(CABECALHO_DA_FICHA)
  if (ficha === null || !timingSafeEqual(await fichaCsrf(env, sessao.sidHash), ficha)) {
    return { recusa: 'csrf_invalido' }
  }

  const conferir = deps.conferirStepUp ?? conferirAdicaoDePasskey
  if (!(await conferir({ request, env, sidHash: sessao.sidHash, now, digital }))) {
    // A recusa CONTA e deixa rastro (§10.10). Sem estas duas escritas, quem
    // roubou o cookie de sessao, ou um XSS que alcanca a ficha CSRF, martelava
    // assertions forjadas aqui indefinidamente: o contador nunca subia, a sessao
    // nunca era apagada na decima, e nenhuma linha registrava a sequencia. A
    // MESMA sequencia contra /painel/aparelhos derruba a sessao em 10 tentativas
    // e deixa 10 linhas de rastro; era a mesma trava com duas grafias, e uma
    // delas nao gravava nada.
    await punirFalhaDeStepUp(env, sessao.sidHash, now, digital === '')
    return { recusa: 'step_up_necessario' }
  }

  const linha = await new PainelSessoesRepository(env.DB).buscarPorHash(sessao.sidHash)
  // A LINHA e a autoridade, e nao o cookie: apagar a linha invalida a sessao
  // emitida, e e por isso que "sair de todos os aparelhos" funciona (§10.13).
  if (linha === null || now > linha.expiraEm || now > linha.ociosaAte) {
    return { recusa: 'sessao_ausente' }
  }

  return { autorizacao: { tipo: 'sessao', credencialId: linha.credentialId } }
}

/**
 * As duas escritas que §10.10 manda fazer quando o step-up e recusado.
 *
 *   - **linha `stepup_recusado` em `painel_auditoria`**, sempre. "Uma tentativa
 *     de gravacao recusada por step-up ausente ou invalido tambem gera linha de
 *     auditoria." Sem ela, dez tentativas de cadastrar uma passkey em nome do
 *     dono nao aparecem em lugar nenhum que a investigacao alcance.
 *   - **`painel_sessoes.falhas_stepup`**, e na DECIMA a sessao e apagada.
 *
 * A separacao entre as duas recusas e a MESMA de `passarPeloStepUp`
 * (`aparelhos.ts`), de proposito, duas grafias da mesma regra divergem na
 * primeira vez que uma delas ganha um passo: a falha INVALIDA incrementa o
 * contador, a AUSENTE nao. Ausente e o primeiro envio, o caminho normal de quem
 * apertou o botao; punir isso derrubaria a sessao de quem so cancelou a
 * biometria dez vezes.
 *
 * **Sem linha de sessao, nada acontece.** O contador vive NA linha e o `ator` de
 * §9.9 sai do `credential_id` dela: sem a linha nao ha o que incrementar nem
 * como nomear quem tentou, e gravar uma linha anonima seria escrita provocada
 * por quem nao tem sessao, na cota que o painel divide com o webhook. Quem
 * chegou ate aqui com o cookie fechando mas sem linha ja recebe
 * `sessao_ausente` no passo seguinte de `autorizarPorSessao`.
 *
 * A auditoria e o UPDATE viajam no mesmo `db.batch()` pela regra de ouro de
 * §8.8: sem log, sem mudanca. E o `campos` carrega `["adicionar_passkey"]`, o
 * nome da operacao recusada, a mesma grafia que `aparelhos.ts` escreve com
 * `JSON.stringify([mudanca.acao])`.
 */
async function punirFalhaDeStepUp(
  env: Env,
  sidHash: string,
  now: number,
  ausente: boolean,
): Promise<void> {
  const sessoes = new PainelSessoesRepository(env.DB)
  const linha = await sessoes.buscarPorHash(sidHash)
  if (linha === null) return

  const registro = new PainelAuditoriaRepository(env.DB).statementDeRegistro({
    ocorridoEm: now,
    // `0` pelo mesmo motivo de `passkey_registrada`: nenhuma configuracao mudou,
    // e perguntar a versao custaria uma leitura fora do orcamento desta rota.
    versao: 0,
    origem: 'painel',
    // Nunca o `credential_id` cru, os tres destinos veem o prefixo (§10.13).
    ator: `passkey:${await prefixoDeCredencial(linha.credentialId)}`,
    // Recusa nunca e passagem: ou o step-up faltou, ou nao fechou.
    stepUp: false,
    acao: 'stepup_recusado',
    alvo: null,
    campos: JSON.stringify(['adicionar_passkey']),
    antes: null,
    depois: null,
  })

  if (ausente) {
    await registro.run()
    return
  }

  const decima = linha.falhasStepup + 1 >= FALHAS_DE_STEPUP_ATE_APAGAR
  await env.DB.batch([
    registro,
    decima ? sessoes.statementDeApagar(sidHash) : sessoes.statementDeFalhaDeStepup(sidHash),
  ])
}

// ---------------------------------------------------------------------------
// POST /painel/api/registrar/verificar
// ---------------------------------------------------------------------------

/** O bilhete de registro, ja autenticado pelo MAC do envelope. */
interface BilheteDeRegistro {
  readonly desafio: string
  readonly tipo: OrigemDeRegistro
  readonly chave: string
  readonly usuarioHandle: string
}

function lerBilhete(claims: Record<string, string>): BilheteDeRegistro | null {
  const { c, a, k, h } = claims
  if (c === undefined || k === undefined || h === undefined) return null
  if (a !== 'convite' && a !== 'recuperacao' && a !== 'sessao') return null

  return { desafio: c, tipo: a, chave: k, usuarioHandle: h }
}

function lerRespostaDeRegistro(corpo: unknown): RespostaDeRegistro | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const credencial = (corpo as { credencial?: unknown }).credencial
  if (typeof credencial !== 'object' || credencial === null) return null

  const lida = credencial as Record<string, unknown>
  if (
    typeof lida.id !== 'string' ||
    typeof lida.type !== 'string' ||
    typeof lida.clientDataJSON !== 'string' ||
    typeof lida.attestationObject !== 'string'
  ) {
    return null
  }

  return {
    id: lida.id,
    type: lida.type,
    clientDataJSON: lida.clientDataJSON,
    attestationObject: lida.attestationObject,
  }
}

/**
 * Verifica a attestation e grava a credencial (§10.5).
 *
 * **Ordem de gravacao, e o preco dela.** Consumir a autorizacao ANTES de
 * inserir a credencial. Se a insercao falhar, o convite ou o codigo foi
 * queimado por nada, e a pessoa precisa de outro, aceito de proposito. A ordem
 * inversa abre uma corrida em que duas requisicoes com o mesmo convite inserem
 * duas credenciais, e uma delas pode ser do atacante. Perder um convite e
 * aborrecimento; ganhar uma credencial indevida e o fim do jogo.
 */
export async function handleVerificarRegistro(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const porta = await portaDaApi(request, env, CAMINHO_DA_VERIFICACAO, 'POST')
  if (porta.erro !== undefined) return porta.erro

  try {
    // Lema 2 de §10.6: sem bilhete valido, `401` e nenhuma linha do parser CBOR
    // chega a rodar, e o parser e o unico trabalho caro desta rota. Lema 3: o
    // MAC e sob `k_env("registrar")`, derivada da `PANEL_SESSION_KEY`, cuja
    // ausencia ja desligou o painel inteiro la em cima.
    const cookie = lerCookie(request, COOKIE_DO_DESAFIO)
    if (cookie === null) return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)

    const envelope = await lerEnvelope(env, 'registrar', cookie, now)
    if (!envelope.valido) return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)

    const bilhete = lerBilhete(envelope.claims)
    if (bilhete === null) return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)

    const resposta = lerRespostaDeRegistro(porta.corpo)
    if (resposta === null) return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)

    const verificada = await verificarRegistro({
      resposta,
      rpId: env.PANEL_RP_ID,
      origem: origemDoPainel(env),
      // O desafio vem do BILHETE, nunca do corpo (§10.5, passo 4; WA-05).
      // Trocar esta linha por `(corpo as any).desafio ?? bilhete.desafio` e
      // substituicao de desafio: quem envia passaria a escolher o que assina, e
      // o cookie viraria enfeite. WA-05 prova a regra dentro do verificador; o
      // teste homonimo de `painel-convite.test.ts` a prova nesta ROTA, que e
      // onde o `desafioEsperado` e escolhido.
      desafioEsperado: bilhete.desafio,
    })
    if (!verificada.ok) {
      // O motivo vai para o log; ao cliente, sempre a mesma frase (§11.4).
      console.warn('painel:', 'registro_recusado', verificada.motivo)
      return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)
    }

    return await gravarCredencial(bilhete, verificada.credencial, porta.corpo, request, env, now)
  } catch (cause) {
    return falhaInterna(cause, request, CAMINHO_DA_VERIFICACAO)
  }
}

/**
 * Consome a autorizacao, grava a credencial e registra a auditoria.
 *
 * A conta de escritas de §9.10, por ramo: convite = 3 (nonce + credencial +
 * auditoria); sessao = 2 (credencial + auditoria); recuperacao = 5 (consumo +
 * invalidacao dos demais + `DELETE` das sessoes + credencial + auditoria).
 *
 * A leitura do teto e a UNICA consulta desta rota, e ela e a terceira do fluxo
 * inteiro, §9.10 orca duas. Ela existe porque o passo 9 de §10.5 manda
 * conferir o teto na GRAVACAO, e nao so na geracao das options: entre uma
 * requisicao e outra o dono pode ter cadastrado por outro caminho. Uma leitura
 * a mais no caminho que uma instalacao percorre uma vez na vida e o preco de um
 * teto que vale nas duas metades da cerimonia.
 */
async function gravarCredencial(
  bilhete: BilheteDeRegistro,
  credencial: CredencialRegistrada,
  corpo: unknown,
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const repositorio = new PainelCredenciaisRepository(env.DB)

  if ((await repositorio.contarPorRpId(env.PANEL_RP_ID)) >= TETO_DE_CREDENCIAIS) {
    return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)
  }

  const consumo = await consumirAutorizacao(bilhete, env, now)
  if (!consumo.ok) return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)

  const auditoria = new PainelAuditoriaRepository(env.DB)

  // Trava de §8.8, a regra de ouro: sem log, sem mudanca. UM `db.batch()` so, e
  // o `INSERT` da credencial sem `ON CONFLICT`, um `credential_id` repetido
  // derruba o lote inteiro e nao deixa nem a linha de auditoria para tras
  // (§10.5, passo 8). Trava de CONV-08: registro recusado nao deixa linha.
  const lote = [
    ...consumo.statements,
    repositorio.statementDeInsercao({
      credentialId: credencial.credentialId,
      rpId: env.PANEL_RP_ID,
      usuarioHandle: bilhete.usuarioHandle,
      chavePublicaJwk: JSON.stringify(credencial.jwk),
      algoritmo: credencial.algoritmo,
      transportes: lerTransportes(corpo),
      signCount: credencial.signCount,
      backupElegivel: credencial.backupElegivel,
      backupAtivo: credencial.backupAtivo,
      apelido: sanearApelido(corpo),
      origemRegistro: bilhete.tipo,
      criadoEm: now,
    }),
    auditoria.statementDeRegistro({
      ocorridoEm: now,
      // `0` porque registrar passkey nao muda configuracao nenhuma: perguntar a
      // versao atual custaria uma leitura que esta rota nao tem no orcamento.
      versao: 0,
      origem: 'painel',
      // Nunca o `credential_id` cru, em nenhum dos tres destinos (§10.13).
      ator: `passkey:${await prefixoDeCredencial(credencial.credentialId)}`,
      // O gesto de biometria do REGISTRO nao e step-up: step-up e
      // reautenticacao presa a uma mudanca, e so o ramo `sessao` a teve.
      stepUp: bilhete.tipo === 'sessao',
      // No ramo da recuperacao a linha e `recuperacao_usada`, que e o evento
      // que §10.11 manda registrar, e o que a investigacao precisa ver, com a
      // invalidacao em bloco e o fim das sessoes no mesmo lote.
      acao: bilhete.tipo === 'recuperacao' ? 'recuperacao_usada' : 'passkey_registrada',
      alvo: null,
      campos: '[]',
      // `antes` e `depois` ficam `NULL`: o evento nao muda campo de
      // configuracao nenhum que valha historico (§9.9).
      antes: null,
      depois: null,
    }),
  ]

  try {
    await env.DB.batch(lote)
  } catch (cause) {
    // Passo 8 de §10.5: `credential_id` ja presente e recusa GENERICA, e nao o
    // `503` que este `catch` nao existia para impedir. Qualquer outra excecao
    // segue sendo excecao nao prevista e sobe para o `catch` do handler.
    if (!ehConflitoDeChave(cause)) throw cause
    console.warn('painel:', 'registro_recusado', 'credencial_duplicada')
    return erro('credencial_invalida', request, CAMINHO_DA_VERIFICACAO)
  }

  // Trava de §15.3, decisao 5: a resposta sai SEM cookie de sessao. O bilhete e
  // expirado aqui porque ja cumpriu o papel, um bilhete que sobrevive ao
  // proprio uso e uma autorizacao pendurada esperando uma segunda requisicao.
  return Response.json(
    { ok: true, para: CAMINHO_DE_ENTRAR },
    { headers: { ...cabecalhos('api'), 'set-cookie': cookieDoPainel(COOKIE_DO_DESAFIO, '', 0) } },
  )
}

/** O consumo de cada ramo, na ordem que §10.5 exige. */
async function consumirAutorizacao(
  bilhete: BilheteDeRegistro,
  env: Env,
  now: number,
): Promise<{ ok: boolean; statements: D1PreparedStatement[] }> {
  switch (bilhete.tipo) {
    case 'convite': {
      // Trava de CONV-02 e de CONV-12: `ON CONFLICT DO NOTHING` mais
      // `meta.changes` e o mesmo claim atomico do `claimComment`. Duas
      // requisicoes simultaneas com o mesmo convite NAO podem ambas ver 1, o
      // D1 e SQLite com escritor unico. Vai sozinho e ANTES do lote: se
      // viajasse dentro, uma falha na credencial devolveria o convite ao mundo.
      const gravado = await env.DB.prepare(
        `INSERT INTO painel_convites_usados (nonce, consumido_em, expira_em)
         VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      )
        // `expira_em` so serve a uma faxina futura do cron, e o bilhete nao
        // carrega o prazo do convite (§10.4 fixa as claims em quatro). O teto
        // de 20 minutos a partir de agora e sempre >= o prazo real, entao a
        // linha nunca some antes do convite que ela bloqueia.
        .bind(bilhete.chave, now, now + PRAZO_DO_CONVITE_MS)
        .run()

      return { ok: (gravado.meta.changes ?? 0) === 1, statements: [] }
    }

    case 'recuperacao': {
      const codigos = new PainelCodigosRepository(env.DB)
      // Trava de CONV-10: `usado_em IS NULL` no `WHERE` e `changes === 1` sao o
      // uso unico, e sao atomicos pelo mesmo motivo do convite.
      const consumido = await codigos.statementDeConsumo(bilhete.chave, now).run()
      if ((consumido.meta.changes ?? 0) !== 1) return { ok: false, statements: [] }

      // Invalidacao em bloco (§10.11): se um codigo foi usado por quem nao
      // devia, os outros estao na mesma lista vazada, e qualquer sessao aberta
      // pode ser dele.
      return {
        ok: true,
        statements: [
          codigos.statementDeInvalidacaoDosDemais(bilhete.chave, now),
          new PainelSessoesRepository(env.DB).statementDeApagarTodas(),
        ],
      }
    }

    case 'sessao':
      // Nada a consumir: a autorizacao ja foi o step-up, e ele e consumido na
      // mesma requisicao em que autoriza (§10.10).
      return { ok: true, statements: [] }
  }
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

/** O que a porta comum devolve: ou um erro pronto, ou o corpo ja lido. */
type PortaDaApi = { erro: Response; corpo?: undefined } | { erro?: undefined; corpo: unknown }

/**
 * Os passos 0 a 4 da escada de §11.3, iguais nas duas rotas `/painel/api/*`.
 *
 * Nenhuma consulta ao D1 acontece aqui: metodo, origem, `content-type` e teto
 * de corpo custam zero banco, e e por isso que lixo de qualquer tipo sai do
 * painel sem tocar na cota compartilhada com o webhook.
 *
 * `OPTIONS` cai em `405`, nunca em CORS: nenhuma rota do painel emite
 * `Access-Control-*`, em nenhuma hipotese (§10.9, camada 5).
 */
async function portaDaApi(
  request: Request,
  env: Env,
  caminho: string,
  metodo: string,
): Promise<PortaDaApi> {
  // Passo 0, e ele vem ANTES do metodo porque e assim que §11.3 numera a
  // escada, e porque `router.ts` copia essa ordem: la o portao de sanidade
  // roda antes do `switch` de caminhos, entao um `OPTIONS` contra um deploy sem
  // `PANEL_RP_ID` ja responde `503` pelo roteador. Se aqui fosse `405`, a mesma
  // requisicao teria duas respostas conforme quem chamasse o handler, e a
  // ordem da escada e artefato de especificacao, nao detalhe de implementacao.
  //
  // Falha FECHADA: sem `PANEL_RP_ID` nao ha `rpId` nem origem, e uma credencial
  // criada com `rpId` errado e IRRECUPERAVEL (§10.14).
  const sanidade = painelHabilitado(env)
  if (!sanidade.ok) return { erro: erro('painel_desativado', request, caminho) }

  // Passo 1.
  if (request.method !== metodo) return { erro: metodoNaoPermitido(request, caminho, metodo) }

  if (!origemConfere(request, env)) return { erro: erro('origem_invalida', request, caminho) }

  // `toLowerCase()` porque media type e case-INSENSITIVE por RFC 9110, e
  // `startsWith` porque o `; charset=utf-8` que os navegadores anexam e
  // legitimo.
  const tipo = (request.headers.get('content-type') ?? '').toLowerCase().trimStart()
  if (!tipo.startsWith(JSON_TIPO)) return { erro: erro('tipo_nao_suportado', request, caminho) }

  let cru: string | null
  try {
    // A leitura mora dentro do `try` porque o corpo chega pela rede: um 3G que
    // cai no meio do POST estoura no `ReadableStream`, e fora do `try` isso
    // viraria `500`.
    cru = await lerCorpoCapado(request, TETO_DO_CORPO_DA_API)
  } catch {
    return { erro: erro('corpo_invalido', request, caminho) }
  }
  if (cru === null) return { erro: erro('corpo_grande_demais', request, caminho) }

  try {
    return { corpo: JSON.parse(cru) as unknown }
  } catch {
    return { erro: erro('corpo_invalido', request, caminho) }
  }
}

/** Caracteres de controle e de formatacao, os mesmos que §7.6 manda remover. */
const INVISIVEIS = /[\p{Cc}\p{Cf}]/gu

/**
 * O apelido saneado (§10.5, passo 10).
 *
 * NFKC, fora os invisiveis, sem espaco nas pontas e cortado em 40. Ele **nao**
 * e escapado na gravacao; e escapado na renderizacao, automaticamente, pela tag
 * `html` que nasce com a etapa do roteador, escapar aqui gravaria `&amp;` no
 * banco e o dono veria a propria escapatoria na tela.
 *
 * Saneia em vez de recusar: §10.5 diz "saneado", e um apelido longo demais
 * digitado num celular nao merece uma cerimonia de biometria perdida.
 */
function sanearApelido(corpo: unknown): string {
  const bruto = (corpo as { apelido?: unknown } | null)?.apelido
  if (typeof bruto !== 'string') return APELIDO_PADRAO

  const limpo = bruto.normalize('NFKC').replace(INVISIVEIS, '').trim().slice(0, TAMANHO_DO_APELIDO)
  return limpo === '' ? APELIDO_PADRAO : limpo
}

/**
 * Os `transports` que o navegador informou. **So dica de interface** (§8.6).
 *
 * Nenhuma decisao do painel olha para este campo, e e por isso que ele pode vir
 * de um corpo nao confiavel: guardamos no maximo uma lista curta de strings do
 * proprio vocabulario da WebAuthn, e qualquer outra coisa vira `NULL`.
 */
const TRANSPORTES_CONHECIDOS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']

function lerTransportes(corpo: unknown): string | null {
  const lista = (corpo as { transportes?: unknown } | null)?.transportes
  if (!Array.isArray(lista)) return null

  const limpos = lista.filter(
    (item): item is string => typeof item === 'string' && TRANSPORTES_CONHECIDOS.includes(item),
  )

  return limpos.length === 0 ? null : JSON.stringify(limpos)
}
