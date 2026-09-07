/**
 * `GET, POST /painel/reels` — "Meus Reels", a tela que o dono pediu primeiro.
 *
 * Ela cabe numa frase (§3): **em quais Reels a automacao responde**. Duas
 * opcoes — "Em todos os meus Reels" ou "So nos que eu escolher" — e, embaixo, a
 * lista com miniatura, legenda cortada, data e uma caixa de marcar, com a area
 * de toque sendo o **cartao inteiro**.
 *
 * **Tres operacoes, uma rota** (§7.1: nenhuma rota nova, e o identificador de
 * uma escrita vai no corpo do POST):
 *
 *   - `GET`                  — a primeira pagina da listagem
 *   - `POST` sem `acao`      — SALVA: o escopo na linha global e a selecao em
 *                              `painel_midias`, no MESMO lote (Ruling 91)
 *   - `POST acao=carregar`   — a paginacao, que **so renderiza**: zero escrita,
 *                              `200` com a pagina remontada. Um `303` perderia o
 *                              que a pessoa ja marcou (§7.1, §12.5)
 *
 * **`acao` que nao casa e recusa, e nao silencio** (Ruling 85): §11.3, passo 6,
 * trata campo que nao casa como erro de digitacao ou cliente adulterado.
 *
 * **Custo.** `GET`: a linha de sessao, o lote da configuracao, a pergunta sobre
 * a conta, a leitura de `painel_midias` e ate quatro chamadas a Meta — o teto de
 * §12.5, que e o mesmo do toque de "Carregar mais". A paginacao nao le
 * `painel_midias` de novo por acaso: ela precisa saber o que ja esta salvo para
 * o cartao dizer a verdade.
 */
import {
  AVISO_DE_TETO_DE_MIDIAS,
  IDS_NOVOS_POR_GRAVACAO,
  type MetadadosDeMidia,
  PainelMidiasRepository,
  TETO_DE_MIDIAS,
} from '../../repositories/painel-midias-repository'
import { ehMediaIdValido } from '../../services/config-validation'
import { loadAccessToken } from '../../services/token-manager'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import { CAMPO_DA_ACAO } from './campos'
import {
  type CampoDaConfig,
  dataEmPortugues,
  ESCOPO_DE_MIDIAS,
  escopoDeMidias,
  motivoDaRecusa,
  NOME_DO_CAMPO,
  TELA_DOS_REELS,
} from './dicionario'
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
  seloProtegido,
} from './inicio'
import {
  buscarPagina,
  comoMidiaSalva,
  DEPENDENCIAS_DE_MIDIAS,
  type DependenciasDeMidias,
  type MidiaSalva,
  POUCOS_REELS,
  type ReelDaListagem,
} from './midias'
import { blocoDaRecusa, RecusaAuditada } from './recusa'
import { erro } from './resposta'
import { ROTA_REEL, ROTA_REELS } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/**
 * Os campos que ESTA rota grava na linha global (Ruling 70).
 *
 * UM campo, e ele e a razao de a tela existir: `mediaScope`. `allowedMediaIds`
 * NAO esta aqui e nunca vai estar — ele e derivado das linhas ativas de
 * `painel_midias` (§9.4), e a selecao entra pela extensao do funil, nao pelo
 * patch de estado.
 */
export const CAMPOS_DOS_REELS: readonly CampoDaConfig[] = ['mediaScope']

/** A operacao de paginacao. Ela nao grava e nao responde `303` (§7.1). */
export const CARREGAR = 'carregar'

/** O nome do campo de cada Reel marcado. Repetido, um por caixa marcada. */
export const CAMPO_DA_MIDIA = 'midia'

/** Os ids que a tela MOSTROU, para desmarcar so o que a pessoa podia ver. */
export const CAMPO_DO_VISTO = 'visto'

/** O cursor da proxima pagina. Campo escondido; **nunca** vai para o D1. */
export const CAMPO_DO_CURSOR = 'depois'

/** Os campos do corpo que nao sao configuracao, nesta rota (§11.3, passo 6). */
const ESTRUTURAIS_DOS_REELS: readonly string[] = [
  CAMPO_DA_ACAO,
  CAMPO_DA_MIDIA,
  CAMPO_DO_VISTO,
  CAMPO_DO_CURSOR,
]

/** O nome que entra em `campos` da auditoria quando a SELECAO muda (§9.9). */
const CAMPO_DA_SELECAO = 'mediaIds'

// ---------------------------------------------------------------------------
// A leitura do corpo
// ---------------------------------------------------------------------------

/** O que o formulario desta tela carrega, alem do escopo. */
interface EscolhaDaTela {
  /** Os ids marcados, sem repeticao e em ordem estavel. */
  readonly marcados: readonly string[]
  /** Os ids que a tela mostrou — o que a pessoa podia desmarcar. */
  readonly vistos: readonly string[]
  readonly cursor: string | null
  /** `true` quando algum id do corpo nao tem a forma de `media_id`. */
  readonly temIdInvalido: boolean
  /** `true` quando o mesmo id veio duas vezes marcado. */
  readonly temRepetido: boolean
}

/**
 * Le os ids do corpo SEM nunca chamar `Number()` (Ruling 90).
 *
 * `ehMediaIdValido` e a mesma funcao que a leitura do banco usa: `^[0-9]{5,25}$`
 * sobre a STRING. Um id que nao casa e recusado, e nunca corrigido — §9.2
 * proibe conserto, e aqui o conserto casaria a configuracao com outro Reel.
 */
function lerEscolha(campos: URLSearchParams): EscolhaDaTela {
  const marcados: string[] = []
  const vistos: string[] = []
  let temIdInvalido = false
  let temRepetido = false

  for (const bruto of campos.getAll(CAMPO_DA_MIDIA)) {
    if (!ehMediaIdValido(bruto)) {
      temIdInvalido = true
      continue
    }
    if (marcados.includes(bruto)) {
      temRepetido = true
      continue
    }
    marcados.push(bruto)
  }

  for (const bruto of campos.getAll(CAMPO_DO_VISTO)) {
    if (!ehMediaIdValido(bruto)) {
      temIdInvalido = true
      continue
    }
    if (!vistos.includes(bruto)) vistos.push(bruto)
  }

  const cursor = campos.get(CAMPO_DO_CURSOR)
  return {
    marcados,
    vistos,
    cursor: cursor === null || cursor === '' ? null : cursor,
    temIdInvalido,
    temRepetido,
  }
}

/**
 * O conjunto que fica salvo depois desta gravacao.
 *
 * `marcados` mais o que **ja estava ativo e a tela nao mostrou**. A segunda
 * parte e o que impede a paginacao de apagar escolhas: a tela so viu uma
 * pagina, entao ela so pode desmarcar o que estava nela. Sem isso, salvar
 * depois de rolar uma pagina apagaria os Reels das outras.
 */
function conjuntoFinal(escolha: EscolhaDaTela, ativosHoje: readonly string[]): readonly string[] {
  const preservados = ativosHoje.filter(
    (id) => !escolha.vistos.includes(id) && !escolha.marcados.includes(id),
  )
  return [...escolha.marcados, ...preservados].sort()
}

// ---------------------------------------------------------------------------
// GET e a paginacao
// ---------------------------------------------------------------------------

/** Tudo o que a tela precisa para se desenhar. */
interface DesenhoDaTela {
  readonly entrada: EntradaDaRota
  readonly deps: DependenciasDeMidias
  readonly cursor: string | null
  /** Ids ja marcados nesta sessao de tela, alem dos que vem do banco. */
  readonly marcadosNaTela: readonly string[] | null
  readonly vistos: readonly string[]
}

/**
 * A tela inteira, do `GET` e da paginacao.
 *
 * **Uma funcao para os dois**, e nao duas: §12.5 manda a paginacao
 * "re-renderizar a pagina inteira no servidor", e duas montagens divergiriam na
 * primeira faixa que so uma delas ganhasse — e a que ficasse para tras seria a
 * do caminho que a pessoa usa quando tem muitos Reels.
 */
async function montarTela(desenho: DesenhoDaTela): Promise<Response> {
  const { entrada, deps } = desenho
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const visao = panorama(snapshot, await contaConectada(entrada.env.DB))
  const salvas = (await new PainelMidiasRepository(entrada.env.DB).lerTodas()).map(comoMidiaSalva)
  const ficha = await fichaDaTela(entrada)

  const listagem = await buscarPagina(entrada.env, desenho.cursor, deps)
  const ativos = salvas.filter((midia) => midia.ativo).map((midia) => midia.mediaId)
  const marcados = desenho.marcadosNaTela ?? ativos

  const escopo = escopoDeMidias(snapshot.global)
  const reels = listagem.ok ? listagem.reels : []
  const naListagem = new Set(reels.map((reel) => reel.mediaId))

  // §12.5: o Reel apagado no Instagram NAO some da lista — ele fica cinza, com
  // "Este Reel nao existe mais". Sumir em silencio faria a pessoa achar que
  // continua ativo. So vale quando a listagem VEIO: com a Meta muda, ausencia
  // nao e prova de nada.
  const sumidos = listagem.ok
    ? salvas.filter((midia) => midia.ativo && !naListagem.has(midia.mediaId))
    : []

  const corpo = html`<h1>${TELA_DOS_REELS.titulo}</h1>
${blocoDeConfirmacao(entrada.request)}
${faixaDaListagem(listagem, reels.length)}
${faixaDeOrfas(snapshot.avisos)}
${faixaDoTeto(ativos.length)}
<form method="post" action="${ROTA_REELS.caminho}">
${camposDoFormulario(ficha, snapshot.versao)}
${escolhaDoEscopo(escopo)}
${listaDeReels(reels, salvas, marcados, listagem.ok)}
${cartoesSumidos(sumidos, marcados)}
${escondidosPreservados(marcados, reels, sumidos, desenho.vistos)}
${
  listagem.ok
    ? html`<p><button type="submit">Salvar</button></p>`
    : html`<p><button type="submit" disabled>Salvar</button></p>
<p>${TELA_DOS_REELS.metaMuda}</p>`
}
</form>
${listagem.ok && listagem.proximoCursor !== null ? maisPagina(listagem.proximoCursor, ficha, snapshot.versao, marcados, desenho.vistos, reels) : null}`

  return telaDoPainel(molduraCom('reels', TELA_DOS_REELS.titulo, visao, corpo))
}

/** A faixa que explica o estado da listagem (§12.5, os quatro especiais). */
function faixaDaListagem(
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
function faixaDeOrfas(avisos: readonly string[]): HtmlSeguro {
  const temOrfas = avisos.some((aviso) => aviso.startsWith('painel_midias:'))
  if (!temOrfas) return html``
  return html`<p class="faixa faixa-aviso" role="status">${TELA_DOS_REELS.orfas}</p>`
}

/** §12.5: o aviso a partir de 197 Reels escolhidos. */
function faixaDoTeto(quantos: number): HtmlSeguro {
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
function escolhaDoEscopo(escopo: 'todas' | 'selecionadas'): HtmlSeguro {
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

/** A lista, mais o botao de marcar em lote com o numero que a tela promete. */
function listaDeReels(
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
  )}</ul>
<p><button type="button" class="marcar-lote">${TELA_DOS_REELS.marcarOsDesta} ${String(
    reels.length,
  )} ${TELA_DOS_REELS.marcarOsDestaFim}</button></p>`
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
function cartoesSumidos(sumidos: readonly MidiaSalva[], marcados: readonly string[]): HtmlSeguro {
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
 * PODIA desmarcar — e e essa lista, e nao a de marcados, que impede a tela de
 * apagar o que ela nunca mostrou.
 */
function escondidosPreservados(
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

/** O formulario de "Carregar mais": o cursor num campo escondido (§12.5). */
function maisPagina(
  cursor: string,
  ficha: string,
  versao: number,
  marcados: readonly string[],
  vistos: readonly string[],
  reels: readonly ReelDaListagem[],
): HtmlSeguro {
  const todosVistos = [...new Set([...vistos, ...reels.map((reel) => reel.mediaId)])]

  return html`<form method="post" action="${ROTA_REELS.caminho}" class="mais">
${camposDoFormulario(ficha, versao)}
<input type="hidden" name="${CAMPO_DA_ACAO}" value="${CARREGAR}">
<input type="hidden" name="${CAMPO_DO_CURSOR}" value="${cursor}">
${marcados.map((id) => html`<input type="hidden" name="${CAMPO_DA_MIDIA}" value="${id}">`)}
${todosVistos.map((id) => html`<input type="hidden" name="${CAMPO_DO_VISTO}" value="${id}">`)}
<button type="submit">${TELA_DOS_REELS.carregarMais}</button>
</form>`
}

// ---------------------------------------------------------------------------
// POST: a gravacao
// ---------------------------------------------------------------------------

/** O handler da rota. `deps` existe para o teste nao tocar a rede (§13.1). */
export async function handleReels(
  entrada: EntradaDaRota,
  deps: DependenciasDeMidias = DEPENDENCIAS_DE_MIDIAS,
): Promise<Response> {
  if (entrada.request.method !== 'POST') {
    return await montarTela({ entrada, deps, cursor: null, marcadosNaTela: null, vistos: [] })
  }

  const { contexto, corpo } = entrada
  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)

  const acao = corpo.campos.get(CAMPO_DA_ACAO)
  if (acao !== null && acao !== CARREGAR) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }

  const escolha = lerEscolha(corpo.campos)

  // A paginacao **so renderiza**: zero escrita, `200`, a pagina remontada com o
  // que a pessoa ja marcou. E o POST que §7.1 declara como excecao a regra de
  // forma, e ele existe para o desenho funcionar sem JavaScript.
  if (acao === CARREGAR) {
    return await montarTela({
      entrada,
      deps,
      cursor: escolha.cursor,
      marcadosNaTela: escolha.marcados,
      vistos: escolha.vistos,
    })
  }

  return await salvarSelecao(entrada, deps, escolha)
}

/**
 * O SALVAR: o escopo pela linha global e a selecao por `painel_midias`, num
 * lote so (Ruling 91).
 *
 * As recusas de §12.5 acontecem AQUI, antes do funil, pela razao do Ruling 73:
 * elas sao conheciveis sem nenhum gesto, e pedir a digital para uma operacao
 * que nao podia dar certo ensina o dono que digital as vezes nao faz nada.
 */
async function salvarSelecao(
  entrada: EntradaDaRota,
  deps: DependenciasDeMidias,
  escolha: EscolhaDaTela,
): Promise<Response> {
  const { env, now, contexto, sessao } = entrada
  if (sessao === null) return erro('sessao_ausente', contexto)

  const snapshot = await configDaTela(env, now)
  const midias = new PainelMidiasRepository(env.DB)
  const salvas = (await midias.lerTodas()).map(comoMidiaSalva)
  const ativosHoje = salvas.filter((midia) => midia.ativo).map((midia) => midia.mediaId)

  const recusa = new RecusaAuditada(
    env,
    now,
    contexto,
    snapshot,
    `passkey:${await prefixoDeCredencial(sessao.credentialId)}`,
  )
  const recusar = async (codigo: string): Promise<Response> =>
    await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: [CAMPO_DA_SELECAO],
      codigo: 'dados_invalidos',
      motivoInterno: codigo,
      explicacao: html`${blocoDaRecusa([{ campo: 'mediaScope', motivo: motivoDaRecusa(codigo) }])}`,
    })

  if (escolha.temIdInvalido) return await recusar('reel_desconhecido')
  if (escolha.temRepetido) return await recusar('reel_repetido')

  const finais = conjuntoFinal(escolha, ativosHoje)
  if (finais.length > TETO_DE_MIDIAS) return await recusar('reels_demais')

  const conhecidos = new Set(salvas.map((midia) => midia.mediaId))
  const novos = finais.filter((id) => !conhecidos.has(id))
  if (novos.length > IDS_NOVOS_POR_GRAVACAO) return await recusar('reels_novos_demais')

  // §12.5: **cada id novo e revalidado contra a conta** com `getMediaInfo`. E o
  // que torna verdadeira a garantia "id que nao veio da listagem e recusado":
  // os campos escondidos vem do cliente, e a unica coisa que o servidor pode
  // conferir e se aquele Reel e mesmo desta conta.
  const revalidados = await revalidar(env, deps, novos)
  if (revalidados === null) return await recusar('listagem_indisponivel')

  // Um id novo que a conta nao confirmou e RECUSADO, e nao ignorado (Ruling 93,
  // e e uma das treze garantias MID). Ignorar deixaria o formulario "salvar" e
  // a tela voltar sem aquele Reel, sem nunca dizer por que.
  if (revalidados.size !== novos.length) return await recusar('reel_desconhecido')

  const escopoNovo = escopoPedido(
    entrada.corpo.familia === 'formulario' ? entrada.corpo.campos : null,
  )
  const escopoFinal = escopoNovo ?? escopoDeMidias(snapshot.global)

  // §9.7, as duas recusas que nao sao sobre campo isolado: "so nos que eu
  // escolher" com lista vazia e a automacao ligada nao pode ser salvo.
  if (escopoFinal === 'selecionadas' && finais.length === 0 && snapshot.global.enabled) {
    return await recusar('selecao_vazia_com_automacao_ligada')
  }

  // Os dois conjuntos comparados como TEXTO ordenado. `finais` ja sai ordenado
  // de `conjuntoFinal`; `ativosHoje` vem do `ORDER BY media_id` do repositorio.
  const mudouASelecao = finais.join(',') !== ativosHoje.join(',')

  const statements = [
    midias.statementDeDesmarcarTodas(now, snapshot.versao),
    ...finais.map((id) => {
      const metadados = revalidados.get(id)
      // Reel que ja tinha linha: so volta a ficar ativo. Os metadados de tela
      // dele continuam sendo os que a listagem gravou, e sobrescreve-los com o
      // vazio que `getMediaInfo` devolve apagaria a legenda salva — que e
      // justamente o que a tela mostra quando o Instagram nao responde.
      return metadados === undefined
        ? midias.statementDeReativar(now, snapshot.versao, id)
        : midias.statementDeMarcar(now, snapshot.versao, id, metadados)
    }),
  ]

  return await gravarConfiguracao(entrada, {
    para: ROTA_REELS.caminho,
    confirmacao: 'salvo',
    estruturais: ESTRUTURAIS_DOS_REELS,
    campos: CAMPOS_DOS_REELS,
    midias: {
      // A mudanca e sobre o CONJUNTO, e nao sobre um Reel: nao ha alvo.
      alvo: null,
      campos: mudouASelecao ? [CAMPO_DA_SELECAO] : [],
      statements: mudouASelecao ? statements : [],
      mudou: mudouASelecao,
    },
  })
}

/** O `mediaScope` que o corpo pediu, ou `null` quando ele nao veio. */
function escopoPedido(campos: URLSearchParams | null): 'todas' | 'selecionadas' | null {
  const bruto = campos?.get('mediaScope') ?? null
  if (bruto === 'todas' || bruto === 'selecionadas') return bruto
  return null
}

/**
 * Revalida cada id NOVO contra a conta (§12.5), e devolve os metadados.
 *
 * `null` significa "nao deu para falar com o Instagram", e ai a gravacao e
 * recusada: salvar um Reel que nao se conseguiu confirmar e escrever no banco
 * um id que pode nao ser da conta.
 *
 * Um id que a conta nao conhece nao vira `null` — ele simplesmente nao entra no
 * mapa, e quem chama grava a linha sem metadados. **Isso nao afrouxa nada**: a
 * unica forma de um id chegar aqui e por um campo escondido, e o Reel que a
 * pessoa marcou de verdade sempre volta com a resposta da conta dela.
 */
async function revalidar(
  env: EntradaDaRota['env'],
  deps: DependenciasDeMidias,
  novos: readonly string[],
): Promise<Map<string, MetadadosDeMidia> | null> {
  const encontrados = new Map<string, MetadadosDeMidia>()
  if (novos.length === 0) return encontrados

  const conta = await loadAccessToken(env)
  if (conta === null) return null

  const api = deps.criarApi(env, conta.token)
  for (const id of novos) {
    const resposta = await api.getMediaInfo(id)
    if (!resposta.ok) continue
    encontrados.set(id, {
      legendaCurta: null,
      permalink: null,
      mediaProductType: resposta.data.media_product_type ?? null,
      postadoEm: null,
    })
  }

  return encontrados
}
