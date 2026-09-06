/**
 * `GET, POST /painel/mensagem` — a mensagem e o link.
 *
 * A tela cabe numa frase: **o que a pessoa recebe quando comenta**. Os tres
 * campos levam cadeado e a palavra "protegido" (§12.3), e desde a etapa do
 * step-up eles sao GRAVAVEIS: trocar qualquer um deles pede a digital, sempre,
 * em qualquer direcao (§10.10).
 *
 * **Esta e a unica tela em que TODOS os campos sao protegidos**, e por isso ela
 * e a unica que diz, antes do gesto, que aquele toque cobre a tela inteira
 * (§15.4). O botao diz o que vai acontecer — "Salvar (vai pedir a sua digital)"
 * — porque §12.3 e literal: nunca uma surpresa biometrica.
 *
 * **A previa usa `renderTemplate`, a funcao de producao** (§12.1 regra 4). Ela
 * mostra os efeitos reais da limpeza de texto: quem colar algo de um editor
 * com caracteres invisiveis ve o resultado limpo aqui, e nao depois de um
 * cliente reclamar.
 *
 * O link e o unico campo que a allowlist trava, e a lista vem de
 * `ALLOWED_LINK_DOMAINS` — que o painel NAO altera, por construcao: mudar a
 * lista exige o repositorio mais a credencial de publicacao, as duas coisas
 * que um painel invadido nao tem. Um link fora dela e barrado **mesmo com a
 * digital correta**: a validacao roda depois do step-up, nunca no lugar dele.
 */
import type { AutomationConfig } from '../../config'
import { MAX_CARACTERES_DO_TEXTO } from '../../services/config-validation'
import { lerAllowlist } from '../../services/link-allowlist'
import { renderTemplate } from '../../utils/templates'
import { gravarConfiguracao } from './gravar'
import { type HtmlSeguro, html } from './html'
import {
  blocoDeConfirmacao,
  camposDoFormulario,
  configDaTela,
  contaConectada,
  fichaDaTela,
  molduraCom,
  panorama,
} from './inicio'
import { ROTA_MENSAGEM } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/**
 * O @ que a previa usa no lugar de `{username}`.
 *
 * Nao e o @ de ninguem: e a descricao do que entra ali. Buscar o @ real
 * custaria uma chamada a Meta numa tela que §12.10 fixa em zero, e inventar um
 * nome de pessoa faria a previa parecer uma mensagem ja enviada.
 */
const APELIDO_DE_EXEMPLO = 'quem comentou'

/** Os tres sinais de §12.3, sempre juntos: cadeado, palavra e borda. */
function protegido(): HtmlSeguro {
  return html`<span class="selo-protegido"><span aria-hidden="true">&#128274;</span> protegido</span>`
}

/**
 * Um campo protegido, editavel.
 *
 * O rotulo carrega o cadeado e a palavra; a borda ambar vem da classe. Os tres
 * sinais **sempre juntos**, nunca so cor (§12.3).
 */
function campoDeTexto(campo: string, rotulo: string, valor: string, linhas: number): HtmlSeguro {
  return html`<div class="campo-protegido">
<p class="rotulo"><label for="${campo}">${rotulo}</label> ${protegido()}</p>
<textarea id="${campo}" name="${campo}" rows="${String(linhas)}"
maxlength="${String(MAX_CARACTERES_DO_TEXTO)}">${valor}</textarea>
</div>`
}

function campoDeLink(valor: string): HtmlSeguro {
  return html`<div class="campo-protegido">
<p class="rotulo"><label for="destinationUrl">Link de destino</label> ${protegido()}</p>
<input type="url" id="destinationUrl" name="destinationUrl" value="${valor}">
</div>`
}

/**
 * O formulario dos tres campos, com o aviso de §15.4 ANTES do botao.
 *
 * §15.4 recusou separar `publicReplyText` numa tela propria — a premissa estava
 * errada, porque aqui **todos** os campos ja exigem step-up sempre e nao ha lote
 * a arrastar. O que ela acolheu foi a metade certa da objecao: a tela precisa
 * dizer, antes do gesto, que aquele toque cobre a tela inteira. E o paragrafo
 * abaixo, e ele vem antes do botao — nao depois, e nao numa tela seguinte.
 */
function formularioDaMensagem(config: AutomationConfig, ficha: string, versao: number): HtmlSeguro {
  return html`<form method="post" action="${ROTA_MENSAGEM.caminho}" class="protegidos">
${camposDoFormulario(ficha, versao)}
${campoDeTexto('privateReplyText', 'Texto do Direct', config.privateReplyText, 4)}
${campoDeLink(config.destinationUrl)}
${campoDeTexto('publicReplyText', 'Resposta no comentário', config.publicReplyText, 3)}
<p>Estes tr&ecirc;s campos s&atilde;o salvos juntos: <strong>um toque s&oacute; confirma a tela
inteira</strong>. Se voc&ecirc; mudar s&oacute; um deles, o toque continua valendo pelos tr&ecirc;s
que est&atilde;o aqui.</p>
<p><button type="submit">Salvar (vai pedir a sua digital)</button></p>
</form>`
}

/**
 * A frase da lista de enderecos liberados (§12.7).
 *
 * Lista vazia NAO e "libera tudo": e o estado em que o painel nao altera link
 * nem texto, e a entrega segue com o que ja esta valendo (§9.8). Dizer isso e
 * o que impede o dono de achar que o campo esta editavel e que o salvamento
 * falhou por outro motivo.
 */
function blocoDaLista(bruto: string | undefined): HtmlSeguro {
  const lista = lerAllowlist(bruto)

  if (!lista.configurada) {
    return html`<p class="faixa faixa-aviso" role="status">Nenhum endere&ccedil;o foi liberado nesta
instala&ccedil;&atilde;o. Enquanto estiver assim, o painel n&atilde;o altera o link nem o texto do
Direct, e a entrega segue com o que j&aacute; est&aacute; valendo.</p>`
  }

  return html`<p>S&oacute; d&aacute; para usar links destes endere&ccedil;os: ${lista.dominios.join(
    ', ',
  )}. Isso &eacute; uma trava do pr&oacute;prio programa, e &eacute; proposital: se um dia
algu&eacute;m invadir o seu painel, essa pessoa n&atilde;o consegue apontar o seu link para um site
de golpe.</p>`
}

/** A previa, em formato de balao de conversa (§3). */
function blocoDePrevia(config: AutomationConfig): HtmlSeguro {
  const direto = renderTemplate(config.privateReplyText, {
    username: APELIDO_DE_EXEMPLO,
    link: config.destinationUrl,
  })

  return html`<section>
<h2>Como vai chegar</h2>
<div class="balao balao-direto">
<p class="quem">No Direct${config.privateReplyEnabled ? null : html` &mdash; hoje desligado`}</p>
<p>${direto}</p>
</div>
<div class="balao balao-publico">
<p class="quem">Embaixo do Reel${
    config.publicReplyEnabled ? null : html` &mdash; hoje desligado`
  }</p>
<p>${config.publicReplyText}</p>
</div>
<p>No lugar de <code>{username}</code> entra o @ de quem comentou, e no lugar de
<code>{link}</code> entra o seu link. S&atilde;o os dois &uacute;nicos apelidos que o programa
conhece.</p>
</section>`
}

export async function handleMensagem(entrada: EntradaDaRota): Promise<Response> {
  if (entrada.request.method === 'POST') {
    return await gravarConfiguracao(entrada, {
      para: ROTA_MENSAGEM.caminho,
      confirmacao: 'salvo',
    })
  }

  const snapshot = await configDaTela(entrada.env, entrada.now)
  const visao = panorama(snapshot, await contaConectada(entrada.env.DB))
  const { global } = snapshot

  const corpo = html`<h1>A mensagem e o link</h1>
${blocoDeConfirmacao(entrada.request)}
<p>Estes tr&ecirc;s campos s&atilde;o os que decidem o que a pessoa recebe. Trocar qualquer um deles
vai pedir a sua digital ou o seu rosto, sempre.</p>
${formularioDaMensagem(global, await fichaDaTela(entrada), snapshot.versao)}
${blocoDaLista(entrada.env.ALLOWED_LINK_DOMAINS)}
${blocoDePrevia(global)}`

  return telaDoPainel(molduraCom('mensagem', 'A mensagem e o link', visao, corpo))
}
