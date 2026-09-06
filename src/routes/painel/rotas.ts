/**
 * A tabela declarativa de rotas do painel (§11.1).
 *
 * "Exige sessao", "exige ficha CSRF" e "exige step-up" sao **dado**, e nao `if`
 * espalhado: o roteador le esta tabela e os metatestes leem o conjunto de rotas
 * de um lugar so. Um `if` a menos numa rota nova deixaria de ser um portao
 * esquecido em silencio e passa a ser uma linha desta tabela que o META-01
 * cobra.
 *
 * **A tabela declara APENAS rotas cujo handler ja existe.** Declarar uma rota
 * sem handler faria o metateste passar verde enquanto a rota devolve 404 —
 * teste que finge cobrir, proibido por §13.1. Cada etapa que cria tela
 * acrescenta a propria linha aqui.
 *
 * **Quem NAO esta aqui, e por que:**
 * - `/painel/parada` e `/painel/parar` sao desviadas ANTES do roteador (§11.1):
 *   elas nao podem passar pelo portao de sanidade, que exige `PANEL_RP_ID`. Uma
 *   linha aqui diria que o roteador as despacha, e ele nao as ve.
 * - `/painel/painel.css`, `/painel/painel.js` e `/painel/parar` sao **assets**
 *   (§11.2). Nenhum caminho de `public/` pode colidir com um caminho de
 *   `rotas.ts`, porque o sequestro seria silencioso.
 */
import { CAMINHO_DE_ENTRAR } from './guardas'
import { TETO_DO_CORPO_DA_API } from './registrar'

/** `HEAD` e tratado como `GET`; `OPTIONS` cai em `405` de proposito (§11.1). */
export type MetodoDePainel = 'GET' | 'POST'

/**
 * A familia da rota, que decide `content-type`, teto de corpo e a forma da
 * recusa: `401` em JSON, `303` para `/painel/entrar` em pagina (§11.3, passo 6).
 */
export type FormatoDeRota = 'pagina' | 'json'

export interface RotaDoPainel {
  /** String EXATA. Sem segmento variavel, em nenhuma rota, para sempre (§7.1). */
  readonly caminho: string
  readonly metodos: readonly MetodoDePainel[]
  /** Exige cookie de sessao valido. `false` so na allowlist de §13.2. */
  readonly sessao: boolean
  /** Exige a ficha anti-CSRF. Todo POST autenticado exige (§10.9, camada 3). */
  readonly csrf: boolean
  /** Exige step-up recente. O verificador nasce com a etapa do step-up. */
  readonly stepUp: boolean
  /**
   * `true` quando a rota GRAVA no D1 no caminho de sucesso (§7.1, §15.4).
   *
   * O campo existe por causa dos **POSTs que so renderizam** — a paginacao dos
   * Reels, o teste de palavra e a previa da mensagem. Sem ele, o metateste da
   * regra de forma nasceria contra o proprio desenho.
   *
   * O metateste afirma as duas metades, e cada uma no seu tempo: **toda rota
   * com `escreve: false` executa zero escritas no D1** vale desde agora, com o
   * contador de §13.4; **toda rota de PAGINA com `escreve: true` responde
   * `303`** vale a partir do primeiro POST de formulario, que nasce com a etapa
   * das telas. A familia `/painel/api/*` nao responde `303` por construcao:
   * ela devolve `{ ok, para }` e quem navega e o `painel.js` (§10.7 passo 13).
   */
  readonly escreve: boolean
}

/**
 * Teto do corpo de um formulario: **32 KB** (§7.6, §11.3 passo 4).
 *
 * E o maior dos tres tetos do painel, e ainda assim dezesseis vezes menor que
 * o do webhook — que continua intocado em 512 KB. Uma tela de palavras-gatilho
 * com vinte itens de quarenta caracteres nao passa de 1 KB; 32 KB e folga para
 * o campo de texto do Direct e para a tela de conferencia do step-up, que
 * carrega o rascunho inteiro em campos escondidos.
 *
 * O irmao de 8 KB de `/painel/api/*` e IMPORTADO de `registrar.ts`, onde a
 * Task 8 o escreveu junto do motivo dele (o parser CBOR). Uma segunda constante
 * com o mesmo numero divergiria no dia em que uma das duas mudasse.
 */
export const TETO_DO_CORPO_DE_FORMULARIO = 32 * 1024

/** Prefixo das rotas que falam JSON. Ele decide a familia, e nada mais. */
export const PREFIXO_DA_API = '/painel/api/'

/** `application/json` em `/painel/api/*`; formulario no resto (§10.9, camada 4). */
export function formatoDaRota(rota: RotaDoPainel): FormatoDeRota {
  return rota.caminho.startsWith(PREFIXO_DA_API) ? 'json' : 'pagina'
}

/** O teto do corpo daquela familia. Uma implementacao, dois numeros (§11.3). */
export function tetoDoCorpo(rota: RotaDoPainel): number {
  return formatoDaRota(rota) === 'json' ? TETO_DO_CORPO_DA_API : TETO_DO_CORPO_DE_FORMULARIO
}

// Inicio. E a rota que o `painel.js` abre depois do login, e a primeira das
// cinco telas de leitura.
export const ROTA_INICIO: RotaDoPainel = {
  caminho: '/painel',
  metodos: ['GET'],
  sessao: true,
  csrf: false,
  stepUp: false,
  escreve: false,
}

/**
 * A chave liga/desliga (§7.1, `acao=ligar|desligar`).
 *
 * **`POST` sem `GET`, e sem tela propria.** §7.1 declara `/painel` como GET,
 * e so: o liga/desliga nao e um POST em `/painel`. A regra de forma continua
 * valendo — a rota grava e responde `303` —, e o `303` dela aponta para
 * `/painel?ok=<codigo>`, que e a tela que a acao mudou.
 *
 * **`stepUp: false`, e nas DUAS direcoes.** §10.10 e explicito: desligar e a
 * direcao segura, e ligar de novo tambem nao exige step-up, porque religar nao
 * muda nenhum valor — apenas devolve a chave ao estado anterior, que o dono ja
 * autorizou quando gravou aqueles campos. Exigir biometria aqui puniria
 * justamente quem acabou de usar o freio de emergencia.
 */
export const ROTA_CHAVE: RotaDoPainel = {
  caminho: '/painel/chave',
  metodos: ['POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
}

/**
 * As quatro telas que acompanham o Inicio.
 *
 * §7.1 declara `GET, POST` em `/painel/palavras`, `/painel/mensagem` e
 * `/painel/ajustes`. Palavras e Ajustes ganharam o `POST` na etapa que grava
 * os campos delas, junto do `csrf: true` e do `escreve: true` que ele exige;
 * a Mensagem continua so com `GET` pela regra que abre este arquivo — a tabela
 * declara apenas o que o handler ja faz, e os tres campos daquela tela exigem
 * step-up SEMPRE (§10.10), entao o `POST` dela nasce com o verificador.
 *
 * `stepUp: false` nas quatro: o verificador de step-up nasce na etapa dele, e
 * `despachar` TRANCA — nao abre — uma rota que declare `stepUp: true` antes
 * disso. A classificacao de §10.10 ja existe, em `gravar.ts`, e o que ela faz
 * hoje e RECUSAR a mudanca protegida com `403`, nunca aceita-la.
 */
export const ROTA_PALAVRAS: RotaDoPainel = {
  caminho: '/painel/palavras',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
}

export const ROTA_MENSAGEM: RotaDoPainel = {
  caminho: '/painel/mensagem',
  metodos: ['GET'],
  sessao: true,
  csrf: false,
  stepUp: false,
  escreve: false,
}

export const ROTA_AJUSTES: RotaDoPainel = {
  caminho: '/painel/ajustes',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
}

/** "O que aconteceu". `GET` unico, hoje e sempre: ela so le (§7.1). */
export const ROTA_ATIVIDADE: RotaDoPainel = {
  caminho: '/painel/atividade',
  metodos: ['GET'],
  sessao: true,
  csrf: false,
  stepUp: false,
  escreve: false,
}

/** Entrar. Renderiza com ZERO consulta ao D1 (§14, etapa 8). */
export const ROTA_ENTRAR: RotaDoPainel = {
  // O caminho vem de `guardas.ts`, que precisa dele para o `303` do passo 6.
  // Uma segunda grafia aqui seria um redirecionamento para uma tela que nao
  // existe no dia em que uma das duas mudasse.
  caminho: CAMINHO_DE_ENTRAR,
  metodos: ['GET'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
}

/** A pagina do convite, que le o token do fragmento. 0 consulta. */
export const ROTA_CONVITE: RotaDoPainel = {
  caminho: '/painel/convite',
  metodos: ['GET'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
}

/** A rota nao autenticada mais exposta do painel, e ela custa 0 consulta. */
export const ROTA_OPCOES_DE_ENTRAR: RotaDoPainel = {
  caminho: '/painel/api/entrar/opcoes',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
}

/** O login. `escreve: true` — sessao, credencial e auditoria, num lote so. */
export const ROTA_VERIFICAR_ENTRADA: RotaDoPainel = {
  caminho: '/painel/api/entrar/verificar',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
}

/**
 * `escreve: true` pela UNICA escrita que ela pode provocar: o `usuario_handle`
 * de `painel_estado`, sorteado uma vez na vida da instalacao (§10.4, passo 7).
 * Nao e o caminho comum, mas o campo diz o que a rota PODE gravar — um `false`
 * aqui seria falso na primeirissima cerimonia.
 */
export const ROTA_OPCOES_DE_REGISTRO: RotaDoPainel = {
  caminho: '/painel/api/registrar/opcoes',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
}

export const ROTA_VERIFICAR_REGISTRO: RotaDoPainel = {
  caminho: '/painel/api/registrar/verificar',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
}

/**
 * As rotas do painel que o roteador despacha hoje.
 *
 * `/painel/convite`, `/painel/api/registrar/opcoes` e
 * `/painel/api/registrar/verificar` vieram do `switch` de `src/index.ts` na
 * etapa do roteador. Elas carregam `sessao: false` porque **o roteador** nao
 * exige sessao delas: as tres autorizacoes de §10.4 (convite, recuperacao,
 * sessao+step-up) sao conferidas DENTRO de `registrar.ts`, e a ficha CSRF do
 * modo `sessao` tambem — e uma condicional, e nao um booleano, entao ela nao
 * cabe nesta tabela sem mentir.
 */
export const ROTAS: readonly RotaDoPainel[] = [
  ROTA_INICIO,
  ROTA_CHAVE,
  ROTA_PALAVRAS,
  ROTA_MENSAGEM,
  ROTA_AJUSTES,
  ROTA_ATIVIDADE,
  ROTA_ENTRAR,
  ROTA_CONVITE,
  ROTA_OPCOES_DE_ENTRAR,
  ROTA_VERIFICAR_ENTRADA,
  ROTA_OPCOES_DE_REGISTRO,
  ROTA_VERIFICAR_REGISTRO,
]
