/**
 * `GET /painel/atividade` — "O que aconteceu", na versao SEM lista.
 *
 * §3 quer tres coisas nesta tela: os tres estados grandes, as pendencias com
 * botao, e a lista dos ultimos comentarios atendidos com o @ ao vivo. As duas
 * primeiras estao aqui; a terceira nasce na etapa que busca o @ na Graph API,
 * com o orcamento de subrequests conferido antes de disparar.
 *
 * **O aviso de §12.6 ja sobe junto, e nao depois.** Ele nao descreve a lista:
 * descreve o que o programa NAO guarda. Comentario ignorado nao deixa linha
 * nenhuma em `processed_comments` — e uma decisao de custo, tomada e escrita —,
 * e quem abrir esta tela precisa ler isso antes de concluir que a
 * automacao deixou de responder alguem.
 *
 * **Esta tela nunca escreve em `processed_comments`, e nao le nada dela nesta
 * etapa.** Ela le `painel_config`, `painel_midias` e `account_tokens`, e mais
 * nada (§6: o painel le, nao age).
 */
import { html } from './html'
import {
  blocoDeAvisos,
  blocoDeEstado,
  blocoDeFabrica,
  blocoDePendencias,
  configDaTela,
  contaConectada,
  molduraCom,
  panorama,
} from './inicio'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

export async function handleAtividade(entrada: EntradaDaRota): Promise<Response> {
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const conta = await contaConectada(entrada.env.DB)
  const visao = panorama(snapshot, conta)

  const corpo = html`<h1>O que aconteceu</h1>
${blocoDeEstado(visao)}
${blocoDeAvisos(visao)}
${blocoDeFabrica(visao)}
${blocoDePendencias(visao)}
<section>
<h2>A conta do Instagram</h2>
<p>${
    conta
      ? 'Conectada. A automação consegue falar com o Instagram para enviar.'
      : 'Não está conectada. Enquanto estiver assim, nada é enviado. Quem conecta é o assistente, no computador onde o projeto foi publicado.'
  }</p>
</section>
<section>
<h2>Sobre o que aparece aqui</h2>
<p>Aqui aparecem os coment&aacute;rios que a automa&ccedil;&atilde;o <strong>atendeu</strong>.
Coment&aacute;rios que ela ignorou &mdash; por n&atilde;o serem de um Reel da sua lista, por
n&atilde;o terem nenhuma das suas palavras, ou porque a pessoa j&aacute; tinha recebido &mdash;
n&atilde;o deixam registro, e por isso n&atilde;o aparecem aqui.</p>
<p>A lista com o @ de quem comentou chega na pr&oacute;xima parte do painel. Ela custa uma consulta
ao Instagram por linha, e por isso vai ter um bot&atilde;o de atualizar &mdash; nunca sozinha, nunca
autom&aacute;tica.</p>
</section>`

  return telaDoPainel(molduraCom('atividade', 'O que aconteceu', visao, corpo))
}
