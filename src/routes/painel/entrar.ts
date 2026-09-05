/**
 * O login: `GET /painel/entrar`, `POST /painel/api/entrar/opcoes` e
 * `POST /painel/api/entrar/verificar` (§10.7).
 *
 * **A sessao nasce aqui, e em nenhum outro lugar.** `registrar/verificar` NAO
 * emite cookie (§15.3, decisao 5): a sessao vem sempre de um `webauthn.get`
 * com `UV = 1` conferido, num ponto unico do codigo — este.
 *
 * **A fronteira colapsa todo motivo em `credencial_invalida`** (§10.3: "a
 * mensagem ao cliente e sempre a mesma"). Envelope malformado, assinatura que
 * nao fecha, prazo estourado, credencial desconhecida, `rp_id` de outro
 * dominio, `UV = 0` — tudo sai igual, e a diferenca fica no `console.warn`, que
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
  prefixoDeCredencial,
  type RespostaDeAssertion,
  verificarAssertion,
} from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import {
  COOKIE_DA_SESSAO,
  COOKIE_DO_DESAFIO,
  cookieDoPainel,
  lerCookie,
  zerarLimite,
} from './guardas'
import { html, pagina } from './html'
import { type ContextoDoErro, erro, json } from './resposta'
import { ROTA_INICIO } from './rotas'
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
 * `login` (§7.4), e quem consome o balde e `despachar`, no passo 5 da escada —
 * ANTES de sortear o desafio, antes do HMAC e antes de qualquer leitura. Uma
 * segunda chamada dentro do handler consumiria o balde duas vezes por
 * requisicao e faria o teto de 10/60 s virar 5/60 s em silencio.
 */

// ---------------------------------------------------------------------------
// GET /painel/entrar — a tela, com 0 consulta ao D1
// ---------------------------------------------------------------------------

/**
 * A tela de entrar.
 *
 * Tres coisas obrigatorias, e cada uma resolve um problema real:
 *
 * 1. O botao da digital, que so funciona dentro de um clique — o Safari exige
 *    gesto do usuario, e chamar `navigator.credentials.get()` no `onload`
 *    quebra em iOS (§10.7).
 * 2. O link **"Continuar"** para `/painel`, que e a mitigacao escrita de
 *    §10.8: com `SameSite=Strict`, abrir o painel por um link vindo de fora
 *    (WhatsApp, atalho de outro app) e navegacao cross-site e o navegador NAO
 *    manda o cookie — o dono cai aqui mesmo tendo sessao viva. Clicar em
 *    "Continuar" e navegacao same-site, o cookie vai junto, e a sessao
 *    aparece. Custa 0 consulta.
 * 3. O `<noscript>` de §12.8, honesto nos dois sentidos: diz o que para de
 *    funcionar e o que continua funcionando.
 *
 * Nenhuma interpolacao: o texto e constante, e e o que o torna seguro.
 */
export function handlePaginaDeEntrar(): Response {
  return pagina({
    titulo: 'Entrar no painel',
    comScript: true,
    corpo: html`<h1>Entrar no painel</h1>
<p>Use a digital, o rosto ou o PIN deste aparelho. N&atilde;o h&aacute; senha para digitar.</p>
<form id="entrar" method="dialog">
<button type="submit">Entrar com a digital</button>
</form>
<p><a href="${DESTINO_DEPOIS_DO_LOGIN}">Continuar</a> &mdash; se voc&ecirc; abriu este painel por um
link de outro aplicativo e j&aacute; estava conectado, este bot&atilde;o leva voc&ecirc; direto ao
in&iacute;cio.</p>
<p><a href="/painel/parar">Parar a automa&ccedil;&atilde;o com o c&oacute;digo do papel</a></p>
<noscript>
<p><strong>Este navegador est&aacute; com o JavaScript desligado.</strong> Funcionam assim mesmo:
entrar com um c&oacute;digo de recupera&ccedil;&atilde;o, a p&aacute;gina de parada de
emerg&ecirc;ncia, e todo salvamento que <strong>n&atilde;o</strong> pede a digital &mdash; marcar
Reels, apagar palavras, testar um coment&aacute;rio, ver a pr&eacute;via e desligar a
automa&ccedil;&atilde;o. O que exige JavaScript &eacute; a leitura da sua digital: cadastrar
aparelho, entrar por digital e confirmar mudan&ccedil;as protegidas.</p>
</noscript>`,
  })
}

// ---------------------------------------------------------------------------
// POST /painel/api/entrar/opcoes — a rota nao autenticada mais exposta
// ---------------------------------------------------------------------------

/**
 * As options do login (§10.7). **Zero consulta ao D1.**
 *
 * Sorteia 32 bytes, assina um envelope de proposito `entrar` com prazo de
 * 120 s e devolve as options. `allowCredentials` sai VAZIA: as credenciais sao
 * descobriveis, e devolver a lista de `credential_id` a quem ainda nao provou
 * nada seria enumeracao de graca.
 *
 * O desafio viaja no COOKIE, assinado — nunca em memoria de servidor e nunca
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
// POST /painel/api/entrar/verificar — o unico lugar que emite sessao
// ---------------------------------------------------------------------------

/** A forma minima da resposta do autenticador. Qualquer outra vira `null`. */
function lerAssertion(corpo: unknown): RespostaDeAssertion | null {
  if (typeof corpo !== 'object' || corpo === null) return null
  const credencial = (corpo as { credencial?: unknown }).credencial
  if (typeof credencial !== 'object' || credencial === null) return null

  const lida = credencial as Record<string, unknown>
  if (
    typeof lida.id !== 'string' ||
    typeof lida.type !== 'string' ||
    typeof lida.clientDataJSON !== 'string' ||
    typeof lida.authenticatorData !== 'string' ||
    typeof lida.signature !== 'string'
  ) {
    return null
  }
  // `userHandle` e o unico opcional: o passo 5 de §10.7 confere os DOIS lados —
  // ausente tambem e uma resposta possivel, e `verificarAssertion` a trata.
  if (lida.userHandle !== null && typeof lida.userHandle !== 'string') return null

  return {
    id: lida.id,
    type: lida.type,
    clientDataJSON: lida.clientDataJSON,
    authenticatorData: lida.authenticatorData,
    signature: lida.signature,
    userHandle: lida.userHandle as string | null,
  }
}

/**
 * O login, na ordem de §10.7.
 *
 *   1. escada de §11.3 (feita pelo roteador) + limitador da familia `login`
 *   2. cookie de desafio: MAC valido, proposito `entrar`, dentro dos 120 s
 *      — **so depois disto o D1 e tocado**                         (0 D1)
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

    const assertion = corpo.familia === 'json' ? lerAssertion(corpo.dados) : null
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
    console.error('painel:', 'indisponivel', cause instanceof Error ? cause.message : cause)
    return erro('indisponivel', contexto)
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
 * curto de vocabulario fechado — nunca um valor, nunca um pedaco do corpo.
 *
 * **UMA linha de log por tentativa recusada**, com o codigo canonico e o motivo
 * interno lado a lado. Duas linhas — uma do motivo e outra do `erro()` — dariam
 * ao atacante o dobro de volume nos Workers Logs do dono a cada tentativa, na
 * rota nao autenticada mais exposta do painel.
 */
function recusar(motivo: string, contexto: ContextoDoErro): Response {
  return erro('credencial_invalida', { ...contexto, motivoInterno: motivo })
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
  // `db.batch()` unico — sessao, credencial e auditoria vivem ou morrem juntas.
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

  return json(
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
}
