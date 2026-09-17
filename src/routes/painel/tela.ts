/**
 * A moldura de toda tela do painel: a barra do topo, a navegacao de baixo e o
 * `<main>` no meio.
 *
 * §12.1 chama a barra do topo de "o UNICO elemento repetido do painel, e a
 * repeticao e proposital: a pessoa nunca precisa procurar como parar". Um
 * elemento que aparece em toda tela precisa de UM dono, cinco copias
 * divergem na primeira vez que uma delas ganha um item, e a que ficar para
 * tras e a tela em que o freio some.
 *
 * **Nada de `<style>`, `onclick=` nem `<script>` inline**, aqui e em qualquer
 * tela: a CSP nao tem `unsafe-inline` (§11.5). Estilo vai no `painel.css`,
 * comportamento no `painel.js`.
 */
import { type HtmlSeguro, html, pagina } from './html'

/** Qual item da barra de baixo esta aceso. Um por tela, sempre. */
export type Aba = 'inicio' | 'reels' | 'palavras' | 'mensagem' | 'mais'

interface ItemDeNavegacao {
  readonly aba: Aba
  readonly para: string
  /** Sempre acompanhado da palavra: §12.1 proibe navegacao so por icone. */
  readonly icone: string
  readonly palavra: string
}

/**
 * Os cinco itens da barra de baixo: **Início · Reels · Palavras · Mensagem ·
 * Mais** (§12.1).
 *
 * Histórico, Ajustes e Aparelhos e códigos moram dentro de "Mais", e as tres
 * acendem esse item. O laco de teste "nenhum link aponta para fora da tabela de
 * rotas" e o que impede a barra de prometer uma tela que nao existe.
 */
const NAVEGACAO: readonly ItemDeNavegacao[] = [
  { aba: 'inicio', para: '/painel', icone: '⌂', palavra: 'Início' },
  { aba: 'reels', para: '/painel/reels', icone: '▶', palavra: 'Reels' },
  { aba: 'palavras', para: '/painel/palavras', icone: '✎', palavra: 'Palavras' },
  { aba: 'mensagem', para: '/painel/mensagem', icone: '✉', palavra: 'Mensagem' },
  { aba: 'mais', para: '/painel/mais', icone: '☰', palavra: 'Mais' },
]

/**
 * A aba e a tela de volta de cada rota logada que responde com pagina.
 *
 * Existe para as paginas intermediarias, a recusa e a tela "Confirme a
 * mudanca": elas nascem do POST de uma tela, mantem a mesma barra e voltam para
 * ela. Strings e nao `ROTA_*` porque `rotas.ts` depende de modulos que dependem
 * desta moldura; o teste confere cada caminho contra a tabela de rotas.
 */
export const TELA_DE_ORIGEM: Readonly<Record<string, { aba: Aba; voltar: string }>> = {
  '/painel': { aba: 'inicio', voltar: '/painel' },
  '/painel/chave': { aba: 'inicio', voltar: '/painel' },
  '/painel/reels': { aba: 'reels', voltar: '/painel/reels' },
  '/painel/reel': { aba: 'reels', voltar: '/painel/reels' },
  '/painel/palavras': { aba: 'palavras', voltar: '/painel/palavras' },
  '/painel/mensagem': { aba: 'mensagem', voltar: '/painel/mensagem' },
  '/painel/mais': { aba: 'mais', voltar: '/painel/mais' },
  '/painel/atividade': { aba: 'mais', voltar: '/painel/atividade' },
  '/painel/ajustes': { aba: 'mais', voltar: '/painel/ajustes' },
  '/painel/aparelhos': { aba: 'mais', voltar: '/painel/aparelhos' },
}

/** O que muda de uma tela para outra. Tudo o mais e igual, e de proposito. */
export interface Moldura {
  readonly titulo: string
  readonly aba: Aba
  /**
   * O estado global, curto, para a barra do topo. Uma frase, sem ponto.
   *
   * Vazio nas paginas intermediarias (recusa, conferencia, codigos novos): elas
   * nao leem a configuracao, e a barra nao afirma um estado que nao conferiu.
   */
  readonly resumo: string
  /** O icone daquele estado. Vem sempre ao lado da palavra, nunca sozinho. */
  readonly iconeDoResumo: string
  /** A classe do estado, que da a cor. A palavra vem junto, sempre (§12.9). */
  readonly classeDoResumo: string
  readonly corpo: HtmlSeguro
  /**
   * Carrega o `painel.js`. So as telas que leem a digital pedem: nas outras ele
   * seria um arquivo a mais numa conexao ruim sem trabalho nenhum (§12.9).
   */
  readonly comScript?: boolean
  /** O status HTTP. `200` quando ausente. */
  readonly status?: number
  /** Cabecalhos a mais, como o `set-cookie`. Os de seguranca sempre ganham. */
  readonly extras?: Record<string, string>
}

/**
 * A barra do topo: o estado global e o caminho para a parada de emergencia.
 *
 * O botao que desliga com um toque mora SO no Inicio (`POST /painel/chave`),
 * que e a tela cujo estado ele muda. Aqui fica um link discreto para
 * `/painel/parar`, o freio que funciona SEM sessao, com o codigo de
 * emergencia, que e o caso em que ele precisa estar em toda tela (§12.1). Dois
 * botoes com o mesmo nome e comportamentos diferentes confundiam a pessoa.
 */
function barraDoTopo(moldura: Moldura): HtmlSeguro {
  const estado =
    moldura.resumo === ''
      ? html`<span></span>`
      : html`<p class="estado ${moldura.classeDoResumo}"><span aria-hidden="true">${
          moldura.iconeDoResumo
        }</span> ${moldura.resumo}</p>`
  return html`<header class="topo">
${estado}
<a class="parar" href="/painel/parar">Emerg&ecirc;ncia</a>
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
 * `comScript` so vem ligado nas telas que leem a digital: carregar o
 * `painel.js` onde ele nao tem trabalho e pedir um arquivo a mais numa conexao
 * ruim (§12.9) sem nada em troca.
 */
export function telaDoPainel(moldura: Moldura): Response {
  return pagina({
    titulo: moldura.titulo,
    comScript: moldura.comScript === true,
    ...(moldura.status === undefined ? {} : { status: moldura.status }),
    ...(moldura.extras === undefined ? {} : { extras: moldura.extras }),
    corpo: html`${barraDoTopo(moldura)}
<main>
${moldura.corpo}
</main>
${navegacao(moldura.aba)}`,
  })
}

/**
 * A moldura de uma pagina intermediaria: a barra de baixo com a aba da tela de
 * origem, e a barra do topo sem estado.
 */
export function molduraIntermediaria(titulo: string, aba: Aba, corpo: HtmlSeguro): Moldura {
  return { titulo, aba, resumo: '', iconeDoResumo: '', classeDoResumo: '', corpo }
}
