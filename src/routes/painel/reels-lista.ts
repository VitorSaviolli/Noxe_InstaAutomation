/**
 * O DESENHO da tela "Meus Reels": o que ela mostra, e os campos que ela reemite.
 *
 * **A separacao nao e de tamanho, e o corte tem uma regra.** `reels.ts` e a
 * ROTA, le o corpo, decide qual das tres operacoes e aquela, revalida os ids
 * novos e grava pelo funil. Este arquivo nao decide nada e nao conhece `Env`,
 * `Response`, o D1 nem a tabela de erros: ele recebe o que ja foi lido e
 * devolve `HtmlSeguro`. E por isso que ele pode ser lido de cima a baixo para
 * responder "o que a pessoa ve nesta tela?" sem passar por uma linha de
 * gravacao.
 *
 * O corte aconteceu quando `reels.ts` passou das 800 linhas do teto deste
 * repositorio. O teto existe para forcar SEPARACAO, e nao para apagar
 * explicacao: na rodada 1 alguem cortou a propria prosa de `stepup.ts` ate
 * caber, e nesta branch a explicacao escrita e metade do valor entregue.
 *
 * **Os nomes dos campos escondidos moram aqui**, com quem os EMITE. Quem os le
 * `lerEscolha`, e a lista de estruturais que os deixa passar pelo passo 6 de
 * §11.3, importa daqui. A direcao unica (`reels.ts` -> este arquivo) e o que
 * mantem o projeto sem ciclo de import; a direcao contraria nasceria no dia em
 * que um `<input>` daqui precisasse do valor de uma acao de la, e por isso
 * `carregar` e `atualizar` tambem vieram junto.
 *
 * A particao por RESPONSABILIDADE de §7.7 continua devendo: `reels.ts` ainda
 * carrega a leitura do corpo, o handler e a gravacao, e a Task 13b termina o
 * servico junto com `stepup.ts`.
 */
import { AVISO_DE_TETO_DE_MIDIAS } from '../../repositories/painel-midias-repository'
import { CAMPO_DA_ACAO } from './campos'
import { dataEmPortugues, ESCOPO_DE_MIDIAS, NOME_DO_CAMPO, TELA_DOS_REELS } from './dicionario'
import { type HtmlSeguro, html } from './html'
import { camposDoFormulario, seloProtegido } from './inicio'
import { type buscarPagina, type MidiaSalva, POUCOS_REELS, type ReelDaListagem } from './midias'
import { ROTA_REEL, ROTA_REELS } from './rotas'

/** A operacao de paginacao. Ela nao grava e nao responde `303` (§7.1). */
export const CARREGAR = 'carregar'

/**
 * O botao Atualizar de §12.5. Ele nao grava e nao responde `303`.
 *
 * **Ele e a outra metade do cache de 10 minutos** (Ruling 98): o cache e o que
 * cumpre §12.1 regra 5, "sem buscar lista a cada render", e este botao e o
 * unico jeito de a pessoa sair dele. Sem o botao, o cache prenderia a tela; sem
 * o cache, cada render gastaria ate quatro chamadas a Meta. Entregar um sem o
 * outro seria trocar um defeito por outro, e duas frases da tela ja mandavam
 * "toque em Atualizar" para um botao que nao existia em lugar nenhum.
 */
export const ATUALIZAR = 'atualizar'

/** O nome do campo de cada Reel marcado. Repetido, um por caixa marcada. */
export const CAMPO_DA_MIDIA = 'midia'

/** Os ids que a tela MOSTROU, para desmarcar so o que a pessoa podia ver. */
export const CAMPO_DO_VISTO = 'visto'

/** O cursor da proxima pagina. Campo escondido; **nunca** vai para o D1. */
export const CAMPO_DO_CURSOR = 'depois'

/**
 * A conta do Instagram esta ligada? A listagem ja respondeu.
 *
 * `sem_conta` e o unico motivo que significa "nao ha linha em
 * `account_tokens`"; `falha_meta` acontece **com** a conta ligada, o token
 * existe e foi a Meta que nao respondeu, e dizer "nao conectada" ali seria a
 * afirmacao falsa que §12.1 regra 3 proibe.
 */
export function contaDaListagem(listagem: Awaited<ReturnType<typeof buscarPagina>>): boolean {
  return listagem.ok || listagem.motivo !== 'sem_conta'
}

/** A faixa que explica o estado da listagem (§12.5, os quatro especiais). */
export function faixaDaListagem(
  listagem: Awaited<ReturnType<typeof buscarPagina>>,
  quantos: number,
): HtmlSeguro {
  if (!listagem.ok) {
    return html`<p class="faixa faixa-aviso" role="status">${
      listagem.motivo === 'sem_conta'
        ? 'A conta do Instagram não está conectada. Quem conecta é o assistente, no computador onde o projeto foi publicado.'
        : TELA_DOS_REELS.metaMuda
    }</p>
<p>${TELA_DOS_REELS.salvoPorVoce}</p>`
  }

  if (quantos === 0) {
    return html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.semReels}</p>`
  }

  // §12.5: quatro paginas que rendem menos de tres Reels ganham explicacao, em
  // vez de a tela parecer quebrada para quem posta muita foto.
  if (quantos < POUCOS_REELS && listagem.proximoCursor !== null) {
    return html`<p class="faixa" role="status">${TELA_DOS_REELS.poucosReels}</p>`
  }

  return html``
}

/** §12.5: escolhas de Reels sem configuracao salva estao sendo ignoradas. */
export function faixaDeOrfas(avisos: readonly string[]): HtmlSeguro {
  const temOrfas = avisos.some((aviso) => aviso.startsWith('painel_midias:'))
  if (!temOrfas) return html``
  return html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.orfas}</p>`
}

/** §12.5: o aviso a partir de 197 Reels escolhidos. */
export function faixaDoTeto(quantos: number): HtmlSeguro {
  if (quantos < AVISO_DE_TETO_DE_MIDIAS) return html``
  return html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.quaseNoTeto}</p>`
}

/**
 * As duas opcoes de §3, com as frases do dicionario.
 *
 * **"Em todos os meus Reels" leva cadeado** (§12.3): ir para `todas` alarga o
 * envelope de alcance, e §10.10 lista o alargamento entre o que pede a digital.
 * Voltar para "so nos que eu escolher" estreita, e estreitar nunca pede.
 */
export function escolhaDoEscopo(escopo: 'todas' | 'selecionadas'): HtmlSeguro {
  return html`<fieldset>
<legend>${NOME_DO_CAMPO.mediaScope}</legend>
<p><label><input type="radio" name="mediaScope" value="todas"${
    escopo === 'todas' ? html` checked` : null
  }> ${ESCOPO_DE_MIDIAS.todas} ${seloProtegido()}</label></p>
<p><label><input type="radio" name="mediaScope" value="selecionadas"${
    escopo === 'selecionadas' ? html` checked` : null
  }> ${ESCOPO_DE_MIDIAS.selecionadas}</label></p>
</fieldset>`
}

/** O cartao de UM Reel: a area de toque e o cartao inteiro (§3). */
function cartao(reel: ReelDaListagem, salva: MidiaSalva | undefined, marcado: boolean): HtmlSeguro {
  const rotulo = reel.mediaProductType === 'REELS' ? 'Reel' : TELA_DOS_REELS.videoOuReel

  return html`<li class="cartao-reel">
<label class="cartao">
<input type="checkbox" name="${CAMPO_DA_MIDIA}" value="${reel.mediaId}"${
    marcado ? html` checked` : null
  }>
${
  reel.miniatura === null
    ? html`<span class="miniatura-vazia" aria-hidden="true"></span>`
    : html`<img class="miniatura" src="${reel.miniatura}" alt="">`
}
<span class="legenda">${reel.legendaCurta ?? rotulo}</span>
<span class="data">${reel.postadoEm === null ? '' : dataEmPortugues(reel.postadoEm)}</span>
</label>
${
  salva?.regrasProprias === true
    ? html`<p class="selo-proprias"><span aria-hidden="true">&#9881;</span> ${
        TELA_DOS_REELS.regrasProprias
      }</p>`
    : null
}
<p><a href="${ROTA_REEL.caminho}?midia=${reel.mediaId}">${TELA_DOS_REELS.tituloDoReel}</a></p>
</li>`
}

/**
 * A lista de cartoes.
 *
 * **O botao "Marcar os N desta lista" saiu, e a saida e uma remocao de defeito,
 * nao de funcionalidade entregue.** Ele era um `<button type="button"
 * class="marcar-lote">`, a classe era a UNICA ocorrencia dela no repositorio e
 * `painel.js` nao a conhecia: o botao nao fazia absolutamente nada. Pela regra
 * desta branch (R-6, §12.4) um controle que nao faz o que promete e defeito, e
 * §12.1 regra 4 diz que o que a tela mostra e o que o Worker faz.
 *
 * §3 pede o botao, e a divida fica REGISTRADA e nao apagada. Faze-lo funcionar
 * nao e cosmetica: ou `painel.js` ganha um sexto trabalho (§12.8 fecha a lista
 * em cinco) e esta tela passa a carregar o script, que `telaDoPainel` nao
 * carrega nas telas de leitura de proposito (§12.9, conexao ruim); ou ele vira
 * um `acao=` a mais que so re-renderiza, o desenho que funciona SEM
 * JavaScript, como "Carregar mais" e "Atualizar", e ai ele precisa saber
 * quais ids estao na tela depois do re-render, o que interage com o teto de
 * HTML de §12.9. As duas saidas sao decisao de desenho, e vao com o resto de §3
 * para a Task 13b.
 */
export function listaDeReels(
  reels: readonly ReelDaListagem[],
  salvas: readonly MidiaSalva[],
  marcados: readonly string[],
  listagemVeio: boolean,
): HtmlSeguro {
  if (!listagemVeio) return listaSalva(salvas, marcados)
  if (reels.length === 0) return html``

  const porId = new Map(salvas.map((midia) => [midia.mediaId, midia]))

  return html`<ul class="reels">${reels.map((reel) =>
    cartao(reel, porId.get(reel.mediaId), marcados.includes(reel.mediaId)),
  )}</ul>`
}

/**
 * A lista salva, quando o Instagram nao respondeu (§12.5).
 *
 * Ela sai de `painel_midias`, marcada como "salvo por voce", e o botao de
 * salvar fica desabilitado: gravar a partir de uma lista que nao carregou
 * apagaria a selecao existente, que e a recusa que §9.7 nomeia.
 */
function listaSalva(salvas: readonly MidiaSalva[], marcados: readonly string[]): HtmlSeguro {
  const ativas = salvas.filter((midia) => marcados.includes(midia.mediaId))
  if (ativas.length === 0) return html``

  return html`<ul class="reels reels-salvos">${ativas.map(
    (midia) => html`<li class="cartao-reel">
<span class="legenda">${midia.legendaCurta ?? midia.mediaId}</span>
<span class="salvo">${TELA_DOS_REELS.salvoPorVoce}</span>
<p><a href="${ROTA_REEL.caminho}?midia=${midia.mediaId}">${TELA_DOS_REELS.tituloDoReel}</a></p>
</li>`,
  )}</ul>`
}

/** §3: o Reel apagado fica cinza, com o botao de tirar da lista. */
export function cartoesSumidos(
  sumidos: readonly MidiaSalva[],
  marcados: readonly string[],
): HtmlSeguro {
  if (sumidos.length === 0) return html``

  return html`<ul class="reels reels-sumidos">${sumidos.map(
    (midia) => html`<li class="cartao-reel cartao-cinza">
<label class="cartao">
<input type="checkbox" name="${CAMPO_DA_MIDIA}" value="${midia.mediaId}"${
      marcados.includes(midia.mediaId) ? html` checked` : null
    }>
<span class="legenda">${midia.legendaCurta ?? midia.mediaId}</span>
</label>
<p class="faixa faixa-aviso">${TELA_DOS_REELS.reelApagado}</p>
<p>Desmarque para ${TELA_DOS_REELS.tirarDaLista.toLowerCase()}.</p>
</li>`,
  )}</ul>`
}

/**
 * Os ids marcados que NAO estao na tela, reemitidos escondidos (§12.5).
 *
 * Sem eles, salvar depois de "Carregar mais" desmarcaria tudo o que ficou na
 * pagina anterior. Junto vao os `visto`, que dizem ao funil o que a pessoa
 * PODIA desmarcar, e e essa lista, e nao a de marcados, que impede a tela de
 * apagar o que ela nunca mostrou.
 */
export function escondidosPreservados(
  marcados: readonly string[],
  reels: readonly ReelDaListagem[],
  sumidos: readonly MidiaSalva[],
  vistos: readonly string[],
): HtmlSeguro {
  const naTela = new Set([
    ...reels.map((reel) => reel.mediaId),
    ...sumidos.map((midia) => midia.mediaId),
  ])
  const fora = marcados.filter((id) => !naTela.has(id))
  const todosVistos = [...new Set([...vistos, ...naTela])]

  return html`${fora.map(
    (id) => html`<input type="hidden" name="${CAMPO_DA_MIDIA}" value="${id}">`,
  )}${todosVistos.map((id) => html`<input type="hidden" name="${CAMPO_DO_VISTO}" value="${id}">`)}`
}

/**
 * "Esta lista foi buscada ha N minutos. [Atualizar]" (§12.5).
 *
 * Ele mora FORA do formulario de salvar porque HTML nao aninha `<form>`, e vem
 * antes dele porque §12.5 poe a idade da lista no topo, junto do estado dela.
 * Carrega os mesmos escondidos de "Carregar mais": o que a pessoa ja marcou e
 * nao salvou sobrevive ao toque, que e o que a frase do cursor vencido promete.
 */
export function botaoDeAtualizar(
  buscadaEm: number,
  agora: number,
  ficha: string,
  versao: number,
  marcados: readonly string[],
  ativos: readonly string[],
): HtmlSeguro {
  const minutos = Math.floor((agora - buscadaEm) / 60_000)
  // **So o que o banco ainda NAO sabe**, e nao a selecao inteira. Reemitir os
  // ativos aqui seria a terceira copia de ate 200 campos escondidos na mesma
  // pagina; o que este formulario precisa preservar e o que se perderia de
  // verdade, as marcacoes que a pessoa fez e ainda nao salvou.
  //
  // **Quem devolve os ativos e `marcadosDesta`, no servidor, e nao este
  // formulario.** O docblock anterior afirmava que um Reel ativo "volta marcado
  // sozinho porque `marcados` cai em `ativos`": ele cai em `ativos` SO quando a
  // tela nao carrega nada, e o corpo deste POST carrega um array vazio, que o
  // `??` nao trata como ausencia. A frase confiante e errada sustentou a
  // otimizacao ate a re-revisao medir a perda, tres Reels salvos, dois
  // desativados em silencio.
  //
  // A perda que sobra esta declarada, e agora e verdadeira: DESmarcar um Reel
  // salvo e tocar em Atualizar devolve ele marcado. Atualizar e o botao que
  // joga fora o retrato velho, e o retrato do banco e o que fica.
  const naoSalvos = marcados.filter((id) => !ativos.includes(id))

  return html`<form method="post" action="${ROTA_REELS.caminho}" class="atualizar">
${camposDoFormulario(ficha, versao)}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${ATUALIZAR}">
${naoSalvos.map((id) => html`<input type="hidden" name="${CAMPO_DA_MIDIA}" value="${id}">`)}
<p>${
    minutos < 1
      ? TELA_DOS_REELS.listaBuscadaAgora
      : `${TELA_DOS_REELS.listaBuscadaHa} ${String(minutos)} ${
          minutos === 1 ? TELA_DOS_REELS.listaBuscadaHaFimUm : TELA_DOS_REELS.listaBuscadaHaFim
        }`
  }</p>
<button type="submit">${TELA_DOS_REELS.atualizar}</button>
</form>`
}

/** Os escondidos que um botao de re-render carrega: o marcado e o visto. */
function escondidosDaEscolha(
  marcados: readonly string[],
  vistos: readonly string[],
  reels: readonly ReelDaListagem[],
): HtmlSeguro {
  const todosVistos = [...new Set([...vistos, ...reels.map((reel) => reel.mediaId)])]

  return html`${marcados.map(
    (id) => html`<input type="hidden" name="${CAMPO_DA_MIDIA}" value="${id}">`,
  )}${todosVistos.map((id) => html`<input type="hidden" name="${CAMPO_DO_VISTO}" value="${id}">`)}`
}

/** O formulario de "Carregar mais": o cursor num campo escondido (§12.5). */
export function maisPagina(
  cursor: string,
  ficha: string,
  versao: number,
  marcados: readonly string[],
  vistos: readonly string[],
  reels: readonly ReelDaListagem[],
): HtmlSeguro {
  return html`<form method="post" action="${ROTA_REELS.caminho}" class="mais">
${camposDoFormulario(ficha, versao)}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${CARREGAR}">
<input type="hidden" name="${CAMPO_DO_CURSOR}" value="${cursor}">
${escondidosDaEscolha(marcados, vistos, reels)}
<button type="submit">${TELA_DOS_REELS.carregarMais}</button>
</form>`
}
