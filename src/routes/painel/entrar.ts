/**
 * O login: `GET /painel/entrar`, `POST /painel/api/entrar/opcoes` e
 * `POST /painel/api/entrar/verificar` (§10.7).
 *
 * **A sessao nasce aqui, e em nenhum outro lugar.** `registrar/verificar` NAO
 * emite cookie (§15.3, decisao 5): a sessao vem sempre de um `webauthn.get`
 * com `UV = 1` conferido, num ponto unico do codigo, este.
 *
 * **A fronteira colapsa todo motivo em `credencial_invalida`** (§10.3: "a
 * mensagem ao cliente e sempre a mesma"). Envelope malformado, assinatura que
 * nao fecha, prazo estourado, credencial desconhecida, `rp_id` de outro
 * dominio, `UV = 0`, tudo sai igual, e a diferenca fica no `console.warn`, que
 * so o dono le. Separar os casos daria um oraculo de enumeracao com o codigo
 * publico na mao do atacante. Os motivos distintos continuam existindo DENTRO
 * de `verificar.ts`, que e onde eles sao corretos.
 *
 * `GET /painel/entrar` custa **ZERO consulta ao D1**: e a tela que o dono abre
 * todo dia, e a que um bot abre em rajada.
 */
import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import { PainelCredenciaisRepository } from '../../repositories/painel-credenciais-repository'
import { PainelSessoesRepository } from '../../repositories/painel-sessoes-repository'
import { PRAZO_DE_ENVELOPE_MS } from '../../security/signed-envelope'
import {
  emitirEnvelope,
  emitirSessao,
  lerEnvelope,
  origemDoPainel,
  PRAZO_OCIOSO_DE_SESSAO_MS,
} from '../../services/panel-session'
import { opcoesDeLogin, sortearDesafio } from '../../services/webauthn/opcoes'
import {
  lerRespostaDeAssertion,
  prefixoDeCredencial,
  verificarAssertion,
} from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import { COOKIE_DA_SESSAO, COOKIE_DO_DESAFIO, cookieDoPainel, lerCookie } from './campos'
import { fraseDeConfirmacao } from './dicionario'
import { CAMINHO_DE_ENTRAR, zerarLimite } from './guardas'
import { type HtmlSeguro, html, pagina } from './html'
import { conferirCodigoDeRecuperacao } from './registrar'
import { type ContextoDoErro, erro, json } from './resposta'
import { ROTA_ENTRAR_CODIGO, ROTA_INICIO } from './rotas'
import type { EntradaDaRota } from './router'

/**
 * Para onde o `painel.js` navega depois do login. E a unica navegacao dele.
 *
 * Os CAMINHOS das tres rotas deste arquivo nao moram aqui: eles sao campo da
 * tabela de `rotas.ts`, que e onde o roteador e os metatestes os leem. Uma
 * segunda grafia de `/painel/api/entrar/opcoes` seria uma rota registrada num
 * lugar e despachada de outro.
 */
const DESTINO_DEPOIS_DO_LOGIN = ROTA_INICIO.caminho

/**
 * O `Max-Age` do cookie de desafio, DERIVADO do prazo do envelope.
 *
 * O prazo mora em `PRAZO_DE_ENVELOPE_MS`, indexado pelo proposito, e e de la
 * que `opcoesDeLogin` tira o `timeout` que o navegador recebe. Escrever `120`
 * aqui seria a segunda grafia de um numero so, e a falha seria SILENCIOSA:
 * subir o envelope para 180 s faria o cookie morrer aos 120 e o login passar a
 * falhar com `desafio_invalido` sem nenhum teste reclamar.
 */
const SEGUNDOS_DO_DESAFIO = Math.floor(PRAZO_DE_ENVELOPE_MS.entrar / 1000)

/**
 * **O limitador NAO mora aqui.** As duas rotas de `entrar` correm sob a familia
 * `login` (§7.4), e quem consome o balde e `despachar`, no passo 5 da escada,
 * ANTES de sortear o desafio, antes do HMAC e antes de qualquer leitura. Uma
 * segunda chamada dentro do handler consumiria o balde duas vezes por
 * requisicao e faria o teto de 10/60 s virar 5/60 s em silencio.
 */

// ---------------------------------------------------------------------------
// GET /painel/entrar, a tela, com 0 consulta ao D1
// ---------------------------------------------------------------------------

/**
 * A tela de entrar.
 *
 * Tres coisas obrigatorias, e cada uma resolve um problema real:
 *
 * 1. O botao da digital, que so funciona dentro de um clique, o Safari exige
 *    gesto do usuario, e chamar `navigator.credentials.get()` no `onload`
 *    quebra em iOS (§10.7).
 * 2. O link **"Continuar"** para `/painel`, que e a mitigacao escrita de
 *    §10.8: com `SameSite=Strict`, abrir o painel por um link vindo de fora
 *    (WhatsApp, atalho de outro app) e navegacao cross-site e o navegador NAO
 *    manda o cookie, o dono cai aqui mesmo tendo sessao viva. Clicar em
 *    "Continuar" e navegacao same-site, o cookie vai junto, e a sessao
 *    aparece. Custa 0 consulta.
 * 3. O `<noscript>` de §12.8, honesto nos dois sentidos: diz o que para de
 *    funcionar e o que continua funcionando.
 *
 * Nenhuma interpolacao: o texto e constante, e e o que o torna seguro.
 */
export function handlePaginaDeEntrar(entrada: EntradaDaRota): Response {
  // A faixa de `?ok=`, e ela existe aqui por UM caso: "sair de todos os
  // aparelhos" (§10.13) apaga a propria sessao de quem apertou, entao o `303`
  // dela nao tem como voltar para `/painel/aparelhos`, a tela seguinte, para
  // aquela pessoa, e esta. A consulta e a uma lista FECHADA de codigos, e e ela,
  // e nao o escape, que impede a query string de virar conteudo da pagina.
  const confirmacao = fraseDeConfirmacao(new URL(entrada.request.url).searchParams.get('ok'))

  return pagina({
    titulo: 'Entrar no painel',
    comScript: true,
    corpo: html`${
      confirmacao === null ? null : html`<p class="faixa faixa-ok" role="status">${confirmacao}</p>`
    }
<h1>Entrar no painel</h1>
<p>Use a digital, o rosto ou o PIN deste aparelho. N&atilde;o h&aacute; senha para digitar.</p>
<form id="entrar" method="dialog">
<button type="submit">Entrar com a digital</button>
</form>
<p><a href="${DESTINO_DEPOIS_DO_LOGIN}">Continuar</a>, se voc&ecirc; abriu este painel por um
link de outro aplicativo e j&aacute; estava conectado, este bot&atilde;o leva voc&ecirc; direto ao
in&iacute;cio.</p>
<p><a href="${ROTA_ENTRAR_CODIGO.caminho}">Entrar com um c&oacute;digo de
recupera&ccedil;&atilde;o</a>, para quando voc&ecirc; n&atilde;o tem nenhum aparelho
cadastrado por perto.</p>
<p><a href="/painel/parar">Parar a automa&ccedil;&atilde;o com o c&oacute;digo do papel</a></p>
<noscript>
<p><strong>Este navegador est&aacute; com o JavaScript desligado.</strong> Funcionam assim mesmo:
entrar com um c&oacute;digo de recupera&ccedil;&atilde;o, a p&aacute;gina de parada de
emerg&ecirc;ncia, e todo salvamento que <strong>n&atilde;o</strong> pede a digital, marcar
Reels, apagar palavras, testar um coment&aacute;rio, ver a pr&eacute;via e desligar a
automa&ccedil;&atilde;o. O que exige JavaScript &eacute; a leitura da sua digital: cadastrar
aparelho, entrar por digital e confirmar mudan&ccedil;as protegidas.</p>
</noscript>`,
  })
}

// ---------------------------------------------------------------------------
// GET + POST /painel/entrar/codigo, a entrada por codigo de recuperacao
// ---------------------------------------------------------------------------

/** O nome do campo do codigo, nos dois lugares em que ele aparece. */
const CAMPO_DO_CODIGO = 'codigo'

/**
 * `GET+POST /painel/entrar/codigo` (§7.1, §10.11, §15.3 decisao 1).
 *
 * **Esta rota NAO emite sessao, e esse "nao" e o contrato inteiro dela.** Um
 * codigo de recuperacao so permite CADASTRAR UMA CHAVE NOVA, ele nunca vira
 * senha, nem direta nem indiretamente. O POST daqui faz **1 leitura**, **nao
 * consome** o codigo e renderiza a tela "crie a chave nova neste aparelho"; a
 * sessao continua nascendo em um lugar so, de uma assertion de login com `UV`
 * conferido (§10.7), e o consumo do codigo, com `changes === 1`, continua sendo
 * de `POST /painel/api/registrar/verificar`.
 *
 * Se o codigo fosse queimado aqui, abrir a tela por engano, ou um F5 no
 * caminho errado, custaria um dos seis codigos do papel, e o dono descobriria
 * isso no pior dia possivel.
 *
 * **Custo do fracasso: 0 escritas.** Codigo malformado nem chega ao banco
 * (`normalizarCodigo` recusa antes); codigo errado custa a mesma 1 leitura de
 * um codigo inexistente e percorre o mesmo laco (CONV-11). A rota corre sob a
 * familia `codigo` do limitador, que o roteador aplica no passo 5, e como a
 * linha da tabela e uma so para os dois metodos, abrir a tela tambem conta no
 * balde. Cabe: sao 30 por minuto por IP (§7.4), e a pessoa abre a tela uma vez
 * e digita o codigo do papel.
 */
export async function handleEntrarPorCodigo(entrada: EntradaDaRota): Promise<Response> {
  const { request, env, corpo, contexto } = entrada

  if (request.method !== 'POST') return paginaDoCodigo()

  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)

  const digitado = corpo.campos.get(CAMPO_DO_CODIGO) ?? ''
  const hashCodigo = await conferirCodigoDeRecuperacao(digitado, env)

  if (hashCodigo === null) {
    // A frase e a canonica de §11.4 e a `explicacao` traz o formulario de volta:
    // uma recusa que obriga a pessoa a achar o caminho outra vez, com o papel na
    // mao, e a hora errada para cobrar navegacao. O `motivoInterno` e um codigo
    // fechado, nunca o que foi digitado (§11.7).
    return erro('codigo_incorreto', {
      ...contexto,
      motivoInterno: 'codigo_de_recuperacao_recusado',
      explicacao: formularioDoCodigo(),
    })
  }

  return paginaDaChaveNova(digitado)
}

/** O formulario do codigo. Ele aparece na tela limpa e dentro da recusa. */
function formularioDoCodigo(): HtmlSeguro {
  return html`<form method="post" action="${ROTA_ENTRAR_CODIGO.caminho}">
<label for="${CAMPO_DO_CODIGO}">Digite um dos c&oacute;digos do papel</label>
<input id="${CAMPO_DO_CODIGO}" name="${CAMPO_DO_CODIGO}" type="text" autocomplete="off"
autocapitalize="characters" spellcheck="false" enterkeyhint="done" required
inputmode="text" maxlength="40">
<button type="submit">Continuar</button>
</form>
<p>Os h&iacute;fens n&atilde;o fazem diferen&ccedil;a, e mai&uacute;sculas e min&uacute;sculas
tamb&eacute;m n&atilde;o. Pode digitar do jeito que estiver escrito no papel.</p>`
}

/**
 * A tela do codigo. **Zero consulta ao D1** e nenhuma interpolacao: o texto e
 * constante, e e o que o torna seguro.
 */
function paginaDoCodigo(): Response {
  return pagina({
    titulo: 'Entrar com um código de recuperação',
    corpo: html`<h1>Entrar com um c&oacute;digo de recupera&ccedil;&atilde;o</h1>
<p>Use isto quando voc&ecirc; n&atilde;o tiver nenhum aparelho cadastrado por perto, celular
perdido, quebrado ou formatado.</p>
${formularioDoCodigo()}
<p><strong>O c&oacute;digo n&atilde;o abre o painel sozinho.</strong> Ele serve para cadastrar
<strong>este</strong> aparelho; depois voc&ecirc; entra com a digital dele, como sempre. Cada
c&oacute;digo vale uma vez s&oacute;, e usar um deles <strong>cancela todos os
outros</strong>, se algu&eacute;m mais viu a sua lista, ela para de valer nesse
instante.</p>
<p><a href="${CAMINHO_DE_ENTRAR}">Voltar</a></p>`,
  })
}

/**
 * "Crie a chave nova neste aparelho", a tela que o codigo VALIDO abre.
 *
 * O codigo volta num campo escondido porque a cerimonia de §10.4 precisa dele
 * no CORPO do POST para `/painel/api/registrar/opcoes`, e la ele e conferido de
 * novo, do zero: nada nesta pagina autoriza coisa alguma, e um campo escondido
 * adulterado so consegue um codigo que nao confere. **Ele nunca vai para a URL**
 * (§7.1: codigo de recuperacao e material de sessao, e material de sessao nao
 * entra em query string nem em `Referer`), e a resposta carrega `private,
 * no-store` como toda pagina do painel.
 *
 * Os dois avisos de §10.14 sao os MESMOS da pagina do convite, e sao
 * obrigatorios antes de todo cadastro: trocar o endereco do painel e
 * re-registro e nao migracao, e chave de seguranca sem PIN nao entra.
 */
function paginaDaChaveNova(codigo: string): Response {
  return pagina({
    titulo: 'Cadastrar este aparelho',
    comScript: true,
    corpo: html`<h1>Cadastrar este aparelho</h1>
<p>O c&oacute;digo confere. Agora crie a chave <strong>deste</strong> aparelho: o telefone vai pedir
a sua digital, o rosto ou o PIN.</p>
<form id="registrar" method="dialog" data-tipo="recuperacao">
<input type="hidden" name="${CAMPO_DO_CODIGO}" value="${codigo}">
<label for="apelido">Como voc&ecirc; chama este aparelho</label>
<input id="apelido" name="apelido" type="text" maxlength="40" autocomplete="off"
enterkeyhint="done" required>
<button type="submit">Cadastrar este aparelho</button>
</form>
<p><strong>Ao terminar, todos os outros c&oacute;digos da sua lista deixam de valer</strong> e
qualquer sess&atilde;o aberta &eacute; encerrada. Gere um conjunto novo de c&oacute;digos assim que
entrar.</p>
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
precisa dele. Abra esta p&aacute;gina num navegador com JavaScript ligado e digite o c&oacute;digo
de novo, ele continua valendo, porque nada foi gasto at&eacute; aqui.</p>
</noscript>`,
  })
}

// ---------------------------------------------------------------------------
// POST /painel/api/entrar/opcoes, a rota nao autenticada mais exposta
// ---------------------------------------------------------------------------

/**
 * As options do login (§10.7). **Zero consulta ao D1.**
 *
 * Sorteia 32 bytes, assina um envelope de proposito `entrar` com prazo de
 * 120 s e devolve as options. `allowCredentials` sai VAZIA: as credenciais sao
 * descobriveis, e devolver a lista de `credential_id` a quem ainda nao provou
 * nada seria enumeracao de graca.
 *
 * O desafio viaja no COOKIE, assinado, nunca em memoria de servidor e nunca
 * no corpo. Um desafio que voltasse pelo corpo seria escolhido por quem
 * responde, e a cerimonia inteira perderia o sentido.
 */
export async function handleOpcoesDeEntrar(entrada: EntradaDaRota): Promise<Response> {
  const { env, now } = entrada

  const desafio = sortearDesafio()
  const envelope = await emitirEnvelope(env, 'entrar', { c: desafio }, now)

  return json(opcoesDeLogin({ rpId: env.PANEL_RP_ID, desafio }), {
    extras: { 'set-cookie': cookieDoPainel(COOKIE_DO_DESAFIO, envelope, SEGUNDOS_DO_DESAFIO) },
  })
}

// ---------------------------------------------------------------------------
// POST /painel/api/entrar/verificar, o unico lugar que emite sessao
// ---------------------------------------------------------------------------

/**
 * O login, na ordem de §10.7.
 *
 *   1. escada de §11.3 (feita pelo roteador) + limitador da familia `login`
 *   2. cookie de desafio: MAC valido, proposito `entrar`, dentro dos 120 s
 *      **so depois disto o D1 e tocado**                         (0 D1)
 *   3. forma da resposta do autenticador                           (0 D1)
 *   4/5. credencial por `credential_id` E o dono, numa consulta   (1 leitura)
 *   6-11. `verificarAssertion`: clientData, flags, assinatura      (0 D1)
 *   12. sessao + credencial + auditoria, num lote so           (3 escritas)
 *   13. `{ ok: true, para: "/painel" }` e o cookie de sessao
 *
 * **Custo do fracasso: 1 verificacao de MAC, 1 leitura e ZERO escritas.** E o
 * numero que sustenta a regra de nao gravar por tentativa: o teto passa a ser a
 * cota de requisicoes do Worker, e a automacao nao cai junto por consumo de
 * escrita.
 */
export async function handleVerificarEntrada(entrada: EntradaDaRota): Promise<Response> {
  const { request, env, now, contexto, corpo } = entrada

  try {
    const desafio = await desafioDoCookie(request, env, now)
    if (desafio === null) return recusar('desafio_invalido', contexto)

    const assertion = corpo.familia === 'json' ? lerRespostaDeAssertion(corpo.dados) : null
    if (assertion === null) return recusar('corpo_invalido', contexto)

    // A PRIMEIRA e UNICA leitura do caminho de fracasso.
    const leitura = await new PainelCredenciaisRepository(env.DB).buscarParaLogin(assertion.id)
    if (leitura === null) return recusar('sem_dono', contexto)

    const resultado = await verificarAssertion({
      resposta: assertion,
      rpId: env.PANEL_RP_ID,
      origem: origemDoPainel(env),
      desafioEsperado: desafio,
      credencial: leitura.credencial,
      usuarioHandleEsperado: leitura.handleDoDono,
    })

    // Ruling 33 / §10.3: o motivo interno vai para o log do dono, e o cliente
    // recebe sempre a mesma frase. Um `switch` aqui seria o oraculo.
    if (!resultado.ok) return recusar(resultado.motivo, contexto)

    return await abrirSessao(resultado.assertion, request, env, now)
  } catch (cause) {
    return falhaInterna(cause, contexto)
  }
}

/**
 * O desafio que o cookie carrega, ou `null`.
 *
 * O cookie e a UNICA fonte: um desafio vindo do corpo seria escolhido por quem
 * responde. O envelope e assinado com `k_env('entrar')`, entao um envelope de
 * registro ou de step-up nao fecha a assinatura nem se o campo do proposito
 * for reescrito (§10.3).
 */
async function desafioDoCookie(request: Request, env: Env, now: number): Promise<string | null> {
  const envelope = lerCookie(request, COOKIE_DO_DESAFIO)
  if (envelope === null) return null

  const leitura = await lerEnvelope(env, 'entrar', envelope, now)
  if (!leitura.valido) return null

  const desafio = leitura.claims.c
  return desafio === undefined || desafio === '' ? null : desafio
}

/**
 * A recusa unica da fronteira do login (Ruling 33, §10.3, §11.4).
 *
 * O `motivo` entra no `console.warn` e **nunca** no corpo. Ele e um codigo
 * curto de vocabulario fechado, nunca um valor, nunca um pedaco do corpo.
 *
 * **UMA linha de log por tentativa recusada**, com o codigo canonico e o motivo
 * interno lado a lado. Duas linhas, uma do motivo e outra do `erro()`, dariam
 * ao atacante o dobro de volume nos Workers Logs do dono a cada tentativa, na
 * rota nao autenticada mais exposta do painel.
 */
function recusar(motivo: string, contexto: ContextoDoErro): Response {
  return erro('credencial_invalida', { ...contexto, motivoInterno: motivo })
}

/**
 * A excecao nao prevista da fronteira: `500 falha_interna`, nunca `503
 * indisponivel` e nunca `401 credencial_invalida` (§11.4).
 *
 * Mesmo defeito corrigido em `registrar.ts` (commit `75a5312`): §11.4 separa
 * `indisponivel` ("D1 indisponivel ou cota estourada", que manda o dono
 * conferir o status da Cloudflare) de `falha_interna` ("qualquer excecao nao
 * prevista", o padrao de todo `try/catch` do projeto). Um `catch` que pega
 * TUDO nao sabe qual dos dois aconteceu, um `TypeError` em `buscarParaLogin`
 * ou no lote de `abrirSessao` anunciado como "Servico temporariamente
 * indisponivel" mandaria o dono investigar a Cloudflare por um defeito NOSSO.
 *
 * **Nunca `recusar()`.** `recusar()` e o oraculo fechado de `credencial_invalida`
 * (Ruling 33, §10.3): existe para os motivos CONHECIDOS de fracasso da
 * assertion, um vocabulario fechado que vira `motivoInterno` na MESMA linha de
 * log, para nao dobrar o log por tentativa na rota nao autenticada mais
 * exposta do painel. Uma excecao nao e um desses motivos. Chamar
 * `recusar('falha_interna', contexto)` pareceria certo e erraria em dois
 * sentidos: o cliente receberia `credencial_invalida` para um bug nosso, e a
 * mensagem da excecao arriscaria vazar por `motivoInterno`, que so deveria
 * carregar os codigos curtos e fechados de `resultado.motivo`.
 *
 * **Por que este `catch` continua aqui, com `despachar` por cima.** Diferente
 * das rotas de `registrar.ts`, que respondem direto ao roteador e por isso
 * SAO a ultima linha de defesa contra uma excecao crua, `handleVerificarEntrada`
 * roda dentro de `despachar()` (`router.ts`), cujo proprio `catch` ja devolve o
 * mesmo `falha_interna` com o mesmo `contexto`. A rede aqui e proposital, nao
 * a unica: os testes desta rota chamam `despachar` diretamente, nunca
 * `SELF.fetch` (convencao da suite), e manter a garantia local, ao lado de
 * `recusar()`, deixa visivel NESTA fronteira, e nao emprestado do chamador,
 * que uma excecao jamais vira `credencial_invalida`.
 */
function falhaInterna(cause: unknown, contexto: ContextoDoErro): Response {
  console.error('painel:', 'falha_interna', cause instanceof Error ? cause.message : cause)
  return erro('falha_interna', contexto)
}

/**
 * O passo 12 e o 13: a sessao nasce, e ela nasce num lote so (§9.10).
 *
 * **Sempre linha nova**, mesmo que o dono ja tivesse sessao: e o que fecha
 * fixacao de sessao (§10.8). O cookie carrega o `sid` em claro; o banco recebe
 * so o `sha256(sid)`, pelo mesmo raciocinio que ja levou o projeto a guardar
 * hash do IGSID em vez do IGSID.
 *
 * `zerarLimite` fecha o RL-08: quem provou quem e nao continua pagando pelas
 * tentativas de quem nao provou.
 */
async function abrirSessao(
  assertion: { credentialId: string; signCount: number; backupAtivo: boolean },
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const sessao = await emitirSessao(env, now)
  const credenciais = new PainelCredenciaisRepository(env.DB)
  const sessoes = new PainelSessoesRepository(env.DB)
  const auditoria = new PainelAuditoriaRepository(env.DB)

  // Trava de §8.8: sem log, sem mudanca. As tres escritas de §9.10 num
  // `db.batch()` unico, sessao, credencial e auditoria vivem ou morrem juntas.
  await env.DB.batch([
    sessoes.statementDeCriacao({
      sidHash: sessao.sidHash,
      credentialId: assertion.credentialId,
      // Copiado da credencial, e nao lido por JOIN: trocar o endereco do painel
      // invalida as sessoes por `rp_id` sem tocar em `painel_credenciais`.
      rpId: env.PANEL_RP_ID,
      criadaEm: now,
      expiraEm: sessao.expiraEm,
      ociosaAte: now + PRAZO_OCIOSO_DE_SESSAO_MS,
      vistaEm: now,
      falhasStepup: 0,
    }),
    credenciais.statementDeUsoNoLogin({
      credentialId: assertion.credentialId,
      signCount: assertion.signCount,
      backupAtivo: assertion.backupAtivo,
      usadoEm: now,
    }),
    auditoria.statementDeRegistro({
      ocorridoEm: now,
      // `0` porque entrar nao muda configuracao nenhuma, e perguntar a versao
      // atual custaria uma leitura que esta rota nao tem no orcamento.
      versao: 0,
      origem: 'painel',
      // Nunca o `credential_id` cru, em nenhum dos tres destinos (§9.9, §10.13).
      ator: `passkey:${await prefixoDeCredencial(assertion.credentialId)}`,
      // Entrar nao e step-up: step-up e reautenticacao presa a uma mudanca.
      stepUp: false,
      acao: 'login',
      alvo: null,
      campos: '[]',
      antes: null,
      depois: null,
    }),
  ])

  zerarLimite(request, env, 'login')

  const resposta = json(
    { ok: true, para: DESTINO_DEPOIS_DO_LOGIN },
    {
      extras: {
        // `Max-Age` = o RESTANTE do prazo absoluto (§7.2), derivado do proprio
        // `expira_em` do cookie. Escrever "12 h" aqui daria dois numeros para
        // divergirem no dia em que a sessao passasse a nascer de outro lugar.
        'set-cookie': cookieDoPainel(
          COOKIE_DA_SESSAO,
          sessao.valor,
          Math.floor((sessao.expiraEm - now) / 1000),
        ),
      },
    },
  )

  // O desafio ja foi gasto: expira o cookie, como `registrar.ts` e `stepup.ts`
  // ja fazem com os deles. O envelope e sem estado, entao sem isto o navegador
  // seguia guardando um desafio que ainda fechava outro login pelo resto dos
  // 120 s. Vai por `append` pelo mesmo motivo de `aparelhos.ts`: `extras` e um
  // `Record` e nao comporta dois `Set-Cookie`.
  resposta.headers.append('set-cookie', cookieDoPainel(COOKIE_DO_DESAFIO, '', 0))
  return resposta
}
