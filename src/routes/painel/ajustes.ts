/**
 * `GET /painel/ajustes` — os ajustes finos, em modo leitura.
 *
 * A tela cabe numa frase: **onde, com que frequencia e por quais canais a
 * automacao responde**. Sao os ajustes que mudam o ALCANCE da automacao, e por
 * isso ela termina com a regra escrita de §12.3, que e a promessa que o painel
 * inteiro faz sobre quando a digital vai ser pedida.
 *
 * O historico das ultimas mudancas, com o botao "Voltar a esta versao", nasce
 * junto com a escrita: sem gravacao nenhuma pelo painel, o historico estaria
 * sempre vazio e a tela prometeria o que nao tem.
 */
import type { AutomationConfig } from '../../config'
import {
  ESCOPO_DE_MIDIAS,
  escopoDeMidias,
  FRASE_DO_AJUSTE,
  MODO_DE_COMPARACAO,
  ORIGEM_DOS_AJUSTES,
} from './dicionario'
import { type HtmlSeguro, html } from './html'
import { configDaTela, contaConectada, molduraCom, panorama } from './inicio'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/** Uma linha "nome do ajuste / o que ele quer dizer hoje". */
function linha(rotulo: string, valor: string): HtmlSeguro {
  return html`<div class="linha-de-ajuste">
<p class="rotulo">${rotulo}</p>
<p class="valor">${valor}</p>
</div>`
}

/**
 * O intervalo por pessoa, escrito como frase.
 *
 * `0` nao e "sem intervalo escrito como zero": e "a mesma pessoa pode acionar
 * quantas vezes quiser", e essa e a leitura que muda a decisao de quem esta na
 * tela.
 */
function frasedoIntervalo(horas: number): string {
  if (horas === 0) return 'A mesma pessoa pode acionar quantas vezes quiser, sem espera.'
  if (horas === 1) return 'A mesma pessoa só aciona de novo depois de 1 hora.'
  return `A mesma pessoa só aciona de novo depois de ${horas} horas.`
}

function blocoDeCanais(config: AutomationConfig): HtmlSeguro {
  return html`<section>
<h2>O que a automa&ccedil;&atilde;o envia</h2>
${linha(
  'Direct',
  config.privateReplyEnabled
    ? 'Ligado: quem comenta recebe o Direct com o link.'
    : 'Desligado: ninguém recebe Direct.',
)}
${linha(
  'Resposta no comentário',
  config.publicReplyEnabled
    ? 'Ligada: a automação responde embaixo do Reel.'
    : 'Desligada: nada é escrito embaixo do Reel.',
)}
${
  config.privateReplyEnabled || config.publicReplyEnabled
    ? null
    : html`<p class="faixa faixa-aviso" role="status">Com os dois desligados, a
automa&ccedil;&atilde;o n&atilde;o envia nada &mdash; nem no Direct, nem embaixo do Reel.</p>`
}
</section>`
}

export async function handleAjustes(entrada: EntradaDaRota): Promise<Response> {
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const visao = panorama(snapshot, await contaConectada(entrada.env.DB))
  const { global } = snapshot

  const corpo = html`<h1>Ajustes finos</h1>
<section>
<h2>Onde a automa&ccedil;&atilde;o responde</h2>
${linha(
  'Tipo de publicação',
  global.processOnlyReels
    ? FRASE_DO_AJUSTE.processOnlyReels.sim
    : FRASE_DO_AJUSTE.processOnlyReels.nao,
)}
${linha('Quais Reels', ESCOPO_DE_MIDIAS[escopoDeMidias(global)])}
${linha('Intervalo por pessoa', frasedoIntervalo(global.userCooldownHours))}
</section>
<section>
<h2>Como o coment&aacute;rio &eacute; comparado</h2>
${linha('Modo', MODO_DE_COMPARACAO[global.matchMode])}
${linha(
  'Maiúsculas e minúsculas',
  global.caseSensitive ? FRASE_DO_AJUSTE.caseSensitive.sim : FRASE_DO_AJUSTE.caseSensitive.nao,
)}
${linha(
  'Acentos',
  global.normalizeAccents
    ? FRASE_DO_AJUSTE.normalizeAccents.nao
    : FRASE_DO_AJUSTE.normalizeAccents.sim,
)}
${linha(
  'Pontuação e emojis',
  global.ignorePunctuation
    ? FRASE_DO_AJUSTE.ignorePunctuation.nao
    : FRASE_DO_AJUSTE.ignorePunctuation.sim,
)}
</section>
${blocoDeCanais(global)}
<footer>
<p>Os ajustes que est&atilde;o valendo agora s&atilde;o ${ORIGEM_DOS_AJUSTES[snapshot.origem]}.</p>
<p><strong>Diminuir o alcance da automa&ccedil;&atilde;o nunca pede a sua digital ou o seu rosto.
Aumentar, sim.</strong></p>
</footer>`

  return telaDoPainel(molduraCom('ajustes', 'Ajustes finos', visao, corpo))
}
