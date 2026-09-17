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
 * sem handler faria o metateste passar verde enquanto a rota devolve 404,
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
  /**
   * A rota exige step-up **independentemente do conteudo**?
   *
   * §11.3, passo 8, diz "step-up, quando a rota **ou o conteudo** exige", e
   * desde a etapa do step-up quem manda e a segunda metade: a classificacao de
   * §10.10 mora no funil de gravacao, que e o unico lugar capaz de transformar o
   * corpo daquela rota na mudanca canonica e recalcular o `op_hash`. §10.10 e
   * literal: "a verificacao acontece **dentro** da rota de escrita".
   *
   * `/painel/mensagem` aparece em §7.1 com "**sempre** no POST", e continua
   * `false` AQUI porque e o conteudo que a torna sempre protegida: os tres
   * campos daquela tela estao em `CAMPOS_SEMPRE_PROTEGIDOS`, entao toda mudanca
   * real ali passa pelo step-up. Um `true` no roteador acrescentaria uma segunda
   * grafia da trava, e uma que nem sabe conferir o `op_hash`, e ainda cobraria
   * biometria de um reenvio que nao muda nada, que §9.9 nem grava.
   *
   * O ramo que este campo aciona em `despachar` continua FECHANDO a rota, e essa
   * e a razao de ele existir: uma linha futura que declare `true` tranca em vez
   * de abrir em silencio.
   */
  readonly stepUp: boolean
  /**
   * `true` quando **a ROTA** grava no D1 no caminho de sucesso (§7.1, §15.4).
   *
   * O campo existe por causa dos **POSTs que so renderizam**, a paginacao dos
   * Reels, o teste de palavra e a previa da mensagem. Sem ele, o metateste da
   * regra de forma nasceria contra o proprio desenho.
   *
   * **A palavra "rota" e o recorte, e ela deixou de ser obvia.** O campo fala do
   * que aquele HANDLER faz com o conteudo do produto, `painel_config`,
   * `painel_midias`, `account_tokens`, `painel_auditoria`, uma sessao emitida.
   * Ele NAO fala da **escrituracao de sessao** que a guarda comum executa no
   * passo 9 da escada: o `UPDATE painel_sessoes SET vista_em, ociosa_ate` que
   * §10.8 orca em "no maximo 1 a cada 15 min", e que roda em TODA rota com
   * `sessao: true`, inclusive nas duas que declaram `escreve: false` aqui,
   * `/painel` e `/painel/atividade`. Sem esse recorte, a frase "grava no D1 no
   * caminho de sucesso" tornaria este campo falso nas duas.
   *
   * **Por que o recorte, e nao um `escreve: true` nelas.** O valor deste campo
   * esta na trava que ele arma, **toda rota com `escreve: false` executa zero
   * escritas no D1** (§11.1, com o contador de §13.4). Se a escrituracao da
   * guarda contasse, toda rota autenticada seria obrigada a declarar
   * `escreve: true`, o campo viraria uma segunda grafia de `sessao` e o laco
   * pararia de separar o que existe para separar: a tela que so LE (§6, "o
   * painel le, nao age") da tela que MUDA a instalacao do dono. A trava fica
   * mais forte com o recorte, e nao mais fraca, o que ela passa a exigir e que
   * a unica escrita de uma rota `escreve: false` seja EXATAMENTE aquele
   * `UPDATE`, conferido por statement inteiro, e nao "poucas escritas".
   *
   * Quem prende as duas metades disso hoje e TELA-19 em
   * `tests/painel-telas.test.ts`, que roda as sete telas nos DOIS estados da
   * janela de 15 min: zero escrita com a janela fresca, e uma unica,
   * conferida SQL a SQL, na primeira visita depois dela.
   *
   * O metateste afirma as duas metades, e cada uma no seu tempo: **toda rota
   * com `escreve: false` executa zero escritas no D1** vale desde agora, com o
   * contador de §13.4; **toda rota de PAGINA com `escreve: true` responde
   * `303`** vale a partir do primeiro POST de formulario, que nasce com a etapa
   * das telas. A familia `/painel/api/*` nao responde `303` por construcao:
   * ela devolve `{ ok, para }` e quem navega e o `painel.js` (§10.7 passo 13).
   */
  readonly escreve: boolean
  /**
   * `true` quando a rota chama `gravarConfiguracao`, o funil de §11.3.
   *
   * Ele existe porque `escreve` responde outra pergunta. `escreve` e "grava no
   * D1 no caminho de sucesso", e por isso `/painel/api/verificar` o tem: ela
   * grava sessao, credencial e auditoria. Quem precisa declarar um ESCOPO DE
   * CAMPOS (Ruling 70) e so quem escreve CONFIGURACAO, e o metateste da uniao
   * media a coisa errada enquanto perguntava a `escreve`: §7.1 ja declara
   * `/painel/aparelhos` e `/painel/sair` como POST, e no dia em que elas forem
   * registradas, a Task 13, o teste exigiria escopo de quem nao tem campo
   * nenhum para declarar, o que o contrapositivo "nenhuma lista pode estar
   * vazia" torna insatisfazivel.
   *
   * E `boolean`, e nao opcional, de proposito: uma rota nova e OBRIGADA a
   * responder, e e assim que a Task 13 chega ao metateste da uniao com
   * `/painel/reels` na mao em vez de passar por ele em silencio.
   */
  readonly gravaConfig: boolean
}

/**
 * Teto do corpo de um formulario: **32 KB** (§7.6, §11.3 passo 4).
 *
 * E o maior dos tres tetos do painel, e ainda assim dezesseis vezes menor que
 * o do webhook, que continua intocado em 512 KB. Uma tela de palavras-gatilho
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
  gravaConfig: false,
}

/**
 * A chave liga/desliga (§7.1, `acao=ligar|desligar`).
 *
 * **`POST` sem `GET`, e sem tela propria.** §7.1 declara `/painel` como GET,
 * e so: o liga/desliga nao e um POST em `/painel`. A regra de forma continua
 * valendo, a rota grava e responde `303`, e o `303` dela aponta para
 * `/painel?ok=<codigo>`, que e a tela que a acao mudou.
 *
 * **`stepUp: false`, e nas DUAS direcoes.** §10.10 e explicito: desligar e a
 * direcao segura, e ligar de novo tambem nao exige step-up, porque religar nao
 * muda nenhum valor, apenas devolve a chave ao estado anterior, que o dono ja
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
  gravaConfig: true,
}

/**
 * As quatro telas que acompanham o Inicio.
 *
 * §7.1 declara `GET, POST` em `/painel/palavras`, `/painel/mensagem` e
 * `/painel/ajustes`. Palavras e Ajustes ganharam o `POST` na etapa que grava os
 * campos de risco baixo; a Mensagem ganhou o dela na etapa do step-up, que e
 * quando o handler passou a saber grava-los, a regra que abre este arquivo e
 * que a tabela declara apenas o que o handler ja faz.
 *
 * `stepUp: false` nas quatro, e o campo explica por que.
 */
export const ROTA_PALAVRAS: RotaDoPainel = {
  caminho: '/painel/palavras',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: true,
}

export const ROTA_MENSAGEM: RotaDoPainel = {
  caminho: '/painel/mensagem',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: true,
}

export const ROTA_AJUSTES: RotaDoPainel = {
  caminho: '/painel/ajustes',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: true,
}

/**
 * "Meus Reels", a tela que o dono pediu em primeiro lugar (§3, §12.5).
 *
 * `escreve: true` porque o caminho de sucesso do SALVAR grava: o escopo na
 * linha global e a selecao em `painel_midias`, no mesmo lote. A paginacao e o
 * POST-que-so-renderiza que §7.1 nomeia, ela nao grava e devolve `200` com a
 * pagina remontada, porque um `303` perderia o que a pessoa ja marcou.
 *
 * `stepUp: false` pela mesma razao das outras quatro: quem classifica e o
 * CONTEUDO, no funil. `mediaScope` indo para "em todos os meus Reels" e
 * alargamento e pede a digital; marcar e desmarcar Reel, nao, §10.10 lista
 * "remover um Reel da lista" entre o que nao exige.
 */
export const ROTA_REELS: RotaDoPainel = {
  caminho: '/painel/reels',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: true,
}

/**
 * "Este Reel responde diferente" (§3, §12.5).
 *
 * **O Reel vem na QUERY STRING, e nenhum caminho tem segmento variavel**
 * (§7.1, Ruling 93): `?midia=` e o identificador de uma LEITURA, e o `media_id`
 * nao e segredo, ele aparece no permalink publico do Reel. Na escrita ele vai
 * no corpo do POST, como todo identificador de escrita.
 */
export const ROTA_REEL: RotaDoPainel = {
  caminho: '/painel/reel',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: true,
}

/**
 * "O que aconteceu". `GET` unico, hoje e sempre: ela so le (§7.1).
 *
 * "So le" e sobre o CONTEUDO, como em `/painel`: nem esta rota nem o Inicio
 * gravam linha de produto nenhuma. A escrituracao de sessao do passo 9 (§10.8)
 * acontece nas duas, e ela nao e desta rota, e da guarda comum, e o docblock de
 * `escreve` explica por que a diferenca e o que da valor ao campo.
 */
export const ROTA_ATIVIDADE: RotaDoPainel = {
  caminho: '/painel/atividade',
  metodos: ['GET'],
  sessao: true,
  csrf: false,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
}

/**
 * "Mais": a lista de links para Historico, Ajustes e Aparelhos e codigos.
 *
 * `GET` unico e so le, como o Inicio: a unica leitura e a do estado global
 * para a barra do topo. Nao existe acao nesta tela, entao nao ha ficha CSRF.
 */
export const ROTA_MAIS: RotaDoPainel = {
  caminho: '/painel/mais',
  metodos: ['GET'],
  sessao: true,
  csrf: false,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
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
  gravaConfig: false,
}

/**
 * A entrada por codigo de recuperacao (§7.1, §10.11, §15.3 decisao 1).
 *
 * **`escreve: false`, e esse `false` E o contrato desta rota.** O POST daqui
 * faz **1 leitura** e **nao consome** o codigo: ele so confere e renderiza a
 * tela "crie a chave nova neste aparelho". Um codigo de recuperacao **nunca
 * vira sessao**, nem direta nem indiretamente, quem consome o codigo, com
 * `changes === 1`, e `POST /painel/api/registrar/verificar`, e quem emite
 * sessao continua sendo so o login. Um `escreve: true` aqui seria a primeira
 * pista de que alguem passou a gravar nesta rota.
 *
 * `sessao: false` porque ela existe justamente para quem NAO consegue entrar; o
 * caminho esta na allowlist de §13.2, escrita dentro do metateste. `csrf: false`
 * pela consequencia direta: nao ha sessao de onde derivar a ficha. As camadas 1,
 * 2, 4 e 5 de §10.9 continuam valendo, origem exata, `content-type` de
 * formulario, zero CORS, e a camada 3 nao tem o que proteger num POST que nao
 * grava e nao autentica.
 */
export const ROTA_ENTRAR_CODIGO: RotaDoPainel = {
  caminho: '/painel/entrar/codigo',
  metodos: ['GET', 'POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
}

/**
 * Aparelhos e codigos de recuperacao (§3, §7.1, §10.13).
 *
 * `escreve: true` porque as tres acoes do POST gravam: `remover_passkey` apaga
 * a credencial e as sessoes dela, `sair_de_tudo` apaga `painel_sessoes` inteira
 * e `gerar_codigos` substitui o conjunto de codigos, as tres com a linha de
 * auditoria no MESMO lote (§8.8).
 *
 * `gravaConfig: false` e a resposta a OUTRA pergunta (Ruling 84): nenhuma delas
 * chama `gravarConfiguracao`, e nenhuma tem escopo de campos de configuracao
 * para declarar. E por isso que `/painel/aparelhos` esta nomeado na lista
 * `SEM_CONFIGURACAO` do META-15 desde antes de existir.
 *
 * **`stepUp: false`, e as tres acoes tem exigencias DIFERENTES**, que e
 * exatamente por que o campo da tabela nao serve aqui. §7.1: step-up "sim em
 * `remover_passkey` e `gerar_codigos`; **nao** em `sair_de_tudo`". Quem
 * classifica e o CONTEUDO, dentro do handler, pelo mesmo desenho de §10.10 que
 * ja vale nas telas de configuracao: desligar e barato, e cobrar biometria de
 * quem esta se protegendo puniria o uso correto (§15.4).
 */
export const ROTA_APARELHOS: RotaDoPainel = {
  caminho: '/painel/aparelhos',
  metodos: ['GET', 'POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: false,
}

/**
 * "Sair deste aparelho" (§7.1, §10.8, §10.13).
 *
 * **`POST` sem `GET`, e sem tela propria**, como a chave liga/desliga: ela e
 * uma acao, e a tela que a oferece e a de Aparelhos, §10.13 lista os tres
 * formularios daquela pagina, e este e um deles. Um `GET` aqui seria uma tela
 * que so pode dizer "clique para sair", e um logout alcancavel por link seria
 * um logout que qualquer `<img src>` de terceiro dispara.
 *
 * **`escreve: true` pela unica escrita dela**: o `DELETE` da linha desta
 * sessao, mais a linha de auditoria, no MESMO lote (§8.8). E o `303` dela
 * aponta para `/painel/entrar`, e nao para a tela que a chamou: a acao apaga a
 * sessao de quem apertou, e §7.1 ja abre essa excecao para `sair_de_tudo`.
 *
 * **`stepUp: false`, e §7.1 escreve o `nao` na tabela dela.** Sair e a direcao
 * segura de §10.10, junto de desligar a automacao e de "sair de todos os
 * aparelhos": cobrar biometria de quem esta se protegendo puniria o uso
 * correto, e o pior abuso possivel e derrubar uma sessao que o dono reabre
 * com a digital.
 *
 * `gravaConfig: false` responde a OUTRA pergunta (Ruling 84): esta rota nao
 * chama `gravarConfiguracao` e nao tem campo de configuracao nenhum para
 * declarar. E por isso que `/painel/sair` ja estava nomeada na lista
 * `SEM_CONFIGURACAO` do META-15 desde antes de existir.
 */
export const ROTA_SAIR: RotaDoPainel = {
  caminho: '/painel/sair',
  metodos: ['POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: true,
  gravaConfig: false,
}

/** A pagina do convite, que le o token do fragmento. 0 consulta. */
export const ROTA_CONVITE: RotaDoPainel = {
  caminho: '/painel/convite',
  metodos: ['GET'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
}

/** A rota nao autenticada mais exposta do painel, e ela custa 0 consulta. */
export const ROTA_OPCOES_DE_ENTRAR: RotaDoPainel = {
  caminho: '/painel/api/entrar/opcoes',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
}

/** O login. `escreve: true`, sessao, credencial e auditoria, num lote so. */
export const ROTA_VERIFICAR_ENTRADA: RotaDoPainel = {
  caminho: '/painel/api/entrar/verificar',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
  gravaConfig: false,
}

/**
 * `escreve: true` pela UNICA escrita que ela pode provocar: o `usuario_handle`
 * de `painel_estado`, sorteado uma vez na vida da instalacao (§10.4, passo 7).
 * Nao e o caminho comum, mas o campo diz o que a rota PODE gravar, um `false`
 * aqui seria falso na primeirissima cerimonia.
 */
export const ROTA_OPCOES_DE_REGISTRO: RotaDoPainel = {
  caminho: '/painel/api/registrar/opcoes',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
  gravaConfig: false,
}

export const ROTA_VERIFICAR_REGISTRO: RotaDoPainel = {
  caminho: '/painel/api/registrar/verificar',
  metodos: ['POST'],
  sessao: false,
  csrf: false,
  stepUp: false,
  escreve: true,
  gravaConfig: false,
}

/**
 * O passo 2 da cerimonia de §10.10. **Sessao sim, ficha sim** (§7.1, §7.2).
 *
 * `escreve: false` e `stepUp: false`: ela nao grava nada, sorteia, assina e
 * devolve um envelope no cookie, e pedir step-up para comecar um step-up seria
 * uma recursao sem base. Quem autoriza a mudanca e a rota de ESCRITA, que
 * recalcula o `op_hash` do corpo que recebeu.
 *
 * Nao existe `/painel/api/stepup/verificar`, e a ausencia e o desenho (§7.1,
 * nomes deletados): uma rota de verificacao separada seria uma autorizacao
 * pendurada esperando uma segunda requisicao.
 */
export const ROTA_OPCOES_DE_STEPUP: RotaDoPainel = {
  caminho: '/painel/api/stepup/opcoes',
  metodos: ['POST'],
  sessao: true,
  csrf: true,
  stepUp: false,
  escreve: false,
  gravaConfig: false,
}

/**
 * As rotas do painel que o roteador despacha hoje.
 *
 * `/painel/convite`, `/painel/api/registrar/opcoes` e
 * `/painel/api/registrar/verificar` vieram do `switch` de `src/index.ts` na
 * etapa do roteador. Elas carregam `sessao: false` porque **o roteador** nao
 * exige sessao delas: as tres autorizacoes de §10.4 (convite, recuperacao,
 * sessao+step-up) sao conferidas DENTRO de `registrar.ts`, e a ficha CSRF do
 * modo `sessao` tambem, e uma condicional, e nao um booleano, entao ela nao
 * cabe nesta tabela sem mentir.
 */
export const ROTAS: readonly RotaDoPainel[] = [
  ROTA_INICIO,
  ROTA_CHAVE,
  ROTA_PALAVRAS,
  ROTA_MENSAGEM,
  ROTA_AJUSTES,
  ROTA_REELS,
  ROTA_REEL,
  ROTA_ATIVIDADE,
  ROTA_MAIS,
  ROTA_APARELHOS,
  ROTA_SAIR,
  ROTA_ENTRAR,
  ROTA_ENTRAR_CODIGO,
  ROTA_CONVITE,
  ROTA_OPCOES_DE_ENTRAR,
  ROTA_VERIFICAR_ENTRADA,
  ROTA_OPCOES_DE_REGISTRO,
  ROTA_VERIFICAR_REGISTRO,
  ROTA_OPCOES_DE_STEPUP,
]
