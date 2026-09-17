/**
 * A tela "Mais": `GET /painel/mais`.
 *
 * So uma lista de links, cada um com uma frase. E a porta de entrada das tres
 * telas que nao cabem na barra de baixo (Historico, Ajustes, Aparelhos e
 * codigos), e por isso as tres acendem o item "Mais".
 *
 * Custo: a sessao, a configuracao e a conta, as mesmas leituras que as outras
 * telas pagam para pintar o estado na barra do topo. Nenhuma escrita.
 */
import { html } from './html'
import { configDaTela, contaConectada, molduraCom, panorama } from './inicio'
import { ROTA_AJUSTES, ROTA_APARELHOS, ROTA_ATIVIDADE } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

export async function handleMais(entrada: EntradaDaRota): Promise<Response> {
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const conta = await contaConectada(entrada.env.DB, entrada.now)
  const visao = panorama(snapshot, conta)

  const corpo = html`<h1>Mais</h1>
<ul class="lista-mais">
<li><a href="${ROTA_ATIVIDADE.caminho}"><strong>Hist&oacute;rico</strong>
<span>Os coment&aacute;rios que a automa&ccedil;&atilde;o atendeu.</span></a></li>
<li><a href="${ROTA_AJUSTES.caminho}"><strong>Ajustes</strong>
<span>Mai&uacute;sculas, acentos, onde responde e intervalo por pessoa.</span></a></li>
<li><a href="${ROTA_APARELHOS.caminho}"><strong>Aparelhos e c&oacute;digos</strong>
<span>Quem pode entrar neste painel e os c&oacute;digos de recupera&ccedil;&atilde;o.</span></a></li>
</ul>`

  return telaDoPainel(molduraCom('mais', 'Mais', visao, corpo))
}
