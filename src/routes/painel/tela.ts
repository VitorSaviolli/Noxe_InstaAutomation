/**
 * A moldura de toda tela do painel: a barra do topo, a navegacao de baixo e o
 * `<main>` no meio.
 *
 * §12.1 chama a barra do topo de "o UNICO elemento repetido do painel, e a
 * repeticao e proposital: a pessoa nunca precisa procurar como parar". Um
 * elemento que aparece em toda tela precisa de UM dono — cinco copias
 * divergem na primeira vez que uma delas ganha um item, e a que ficar para
 * tras e a tela em que o freio some.
 *
 * **Nada de `<style>`, `onclick=` nem `<script>` inline**, aqui e em qualquer
 * tela: a CSP nao tem `unsafe-inline` (§11.5). Estilo vai no `painel.css`,
 * comportamento no `painel.js`.
 */
import { type HtmlSeguro, html, pagina } from './html'

/** Qual item da barra de baixo esta aceso. Um por tela, sempre. */
export type Aba = 'inicio' | 'palavras' | 'mensagem' | 'atividade' | 'ajustes'

interface ItemDeNavegacao {
  readonly aba: Aba
  readonly para: string
  /** Sempre acompanhado da palavra: §12.1 proibe navegacao so por icone. */
  readonly icone: string
  readonly palavra: string
}

/**
 * Os cinco itens da barra de baixo.
 *
 * §12.1 descreve **Início · Reels · Palavras · Mensagem · Mais**. "Reels" e
 * "Mais" abrem telas que ainda nao existem, e um item que leva a um `404` e
 * pior do que um item a menos: ele ensina a pessoa a desconfiar da barra. A
 * forma de §12.1 esta respeitada — cinco itens, icone E palavra —, e as duas
 * trocas acontecem nas etapas que criam aquelas telas. O laco de teste
 * "nenhum link aponta para fora da tabela de rotas" e o que impede a barra de
 * voltar a prometer o que nao existe.
 */
const NAVEGACAO: readonly ItemDeNavegacao[] = [
  { aba: 'inicio', para: '/painel', icone: '⌂', palavra: 'Início' },
  { aba: 'palavras', para: '/painel/palavras', icone: '✎', palavra: 'Palavras' },
  { aba: 'mensagem', para: '/painel/mensagem', icone: '✉', palavra: 'Mensagem' },
  { aba: 'atividade', para: '/painel/atividade', icone: '◷', palavra: 'O que aconteceu' },
  { aba: 'ajustes', para: '/painel/ajustes', icone: '⚙', palavra: 'Ajustes' },
]

/** O que muda de uma tela para outra. Tudo o mais e igual, e de proposito. */
export interface Moldura {
  readonly titulo: string
  readonly aba: Aba
  /** O estado global, curto, para a barra do topo. Uma frase, sem ponto. */
  readonly resumo: string
  /** O icone daquele estado. Vem sempre ao lado da palavra, nunca sozinho. */
  readonly iconeDoResumo: string
  /** A classe do estado, que da a cor. A palavra vem junto, sempre (§12.9). */
  readonly classeDoResumo: string
  readonly corpo: HtmlSeguro
}

/**
 * A barra do topo: o estado global e o caminho para parar.
 *
 * §3 pede um botao vermelho e grande de **DESLIGAR TUDO**. Ele existe, e um
 * `POST /painel/chave`, e mora na tela de Inicio — que e a tela que o estado
 * dele muda e para onde o `303` dele volta.
 *
 * **O link daqui continua sendo `/painel/parar`, e nao e duplicata.** Um `POST`
 * na barra do topo obrigaria as cinco telas a carregar a ficha CSRF so para
 * pintar um botao, e ainda assim so funcionaria com sessao viva. `/painel/parar`
 * e o freio que funciona SEM sessao, com o codigo anotado no papel — que e o
 * caso em que a barra do topo precisa mesmo estar em toda tela (§12.1).
 */
function barraDoTopo(moldura: Moldura): HtmlSeguro {
  return html`<header class="topo">
<p class="estado ${moldura.classeDoResumo}"><span aria-hidden="true">${
    moldura.iconeDoResumo
  }</span> ${moldura.resumo}</p>
<a class="parar" href="/painel/parar">Desligar a automa&ccedil;&atilde;o</a>
</header>`
}

function navegacao(ativa: Aba): HtmlSeguro {
  const itens = NAVEGACAO.map((item) => {
    // `aria-current="page"` e o que um leitor de tela anuncia; a classe so
    // pinta. Estado nunca so por cor (§12.9).
    const atual = item.aba === ativa
    return html`<a href="${item.para}" class="${atual ? 'item item-atual' : 'item'}"${
      atual ? html` aria-current="page"` : null
    }><span class="icone" aria-hidden="true">${item.icone}</span><span class="palavra">${
      item.palavra
    }</span></a>`
  })

  return html`<nav class="navegacao" aria-label="Telas do painel">${itens}</nav>`
}

/**
 * A tela inteira: topo, conteudo e navegacao.
 *
 * `comScript` fica FORA: nenhuma das telas de leitura le a digital, e carregar
 * o `painel.js` onde ele nao tem trabalho e pedir um arquivo a mais numa
 * conexao ruim (§12.9) sem nada em troca.
 */
export function telaDoPainel(moldura: Moldura): Response {
  return pagina({
    titulo: moldura.titulo,
    corpo: html`${barraDoTopo(moldura)}
<main>
${moldura.corpo}
</main>
${navegacao(moldura.aba)}`,
  })
}
