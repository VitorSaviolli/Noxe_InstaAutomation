/**
 * `GET, POST /painel/reels`, "Meus Reels", a tela que o dono pediu primeiro.
 *
 * Ela cabe numa frase (§3): **em quais Reels a automacao responde**. Duas
 * opcoes, "Em todos os meus Reels" ou "So nos que eu escolher", e, embaixo, a
 * lista com miniatura, legenda cortada, data e uma caixa de marcar, com a area
 * de toque sendo o **cartao inteiro**.
 *
 * **Tres operacoes, uma rota** (§7.1: nenhuma rota nova, e o identificador de
 * uma escrita vai no corpo do POST):
 *
 *   - `GET`                 , a primeira pagina da listagem
 *   - `POST` sem `acao`     , SALVA: o escopo na linha global e a selecao em
 *                              `painel_midias`, no MESMO lote (Ruling 91)
 *   - `POST acao=carregar`  , a paginacao, que **so renderiza**: zero escrita,
 *                              `200` com a pagina remontada. Um `303` perderia o
 *                              que a pessoa ja marcou (§7.1, §12.5)
 *
 * **`acao` que nao casa e recusa, e nao silencio** (Ruling 85): §11.3, passo 6,
 * trata campo que nao casa como erro de digitacao ou cliente adulterado.
 *
 * **Custo: os 3 subrequests que §12.10 orca, e o desvio acabou.** A linha de
 * sessao, o lote da configuracao e `account_tokens`, mais as chamadas a Meta
 * **so quando o cache de 10 minutos de §12.5 esta frio**. §12.1 regra 5 e
 * `[C]`-dura: "sem buscar lista a cada render; Atualizar e sempre um botao
 * explicito", e o botao existe desde a rodada 1.
 *
 * Os dois consertos que tiraram esta tela de 5 para 3:
 *
 *   1. a pergunta sobre a conta saiu da propria listagem. `buscarPagina` ja le
 *      `account_tokens` para carregar o token, e `contaConectada` lia a MESMA
 *      tabela de novo na mesma renderizacao;
 *   2. `painel_midias` INTEIRA, com as inativas, que §12.5 manda esta tela
 *      mostrar, viaja no `db.batch()` da configuracao, e um `batch` vale UM
 *      subrequest. Ate a rodada 1 ela era uma consulta propria, declarada como
 *      desvio de §12.10; o desvio saiu do TELA-20 junto com a consulta.
 *
 * **O argumento que sustentava o desvio nao se sustentava.** Ele dizia que
 * juntar as leituras "acoplaria a falha do `account_tokens` a listagem, virando
 * `500` onde hoje ha tela degradada". A re-revisao mediu: ja era `500`,
 * `buscarPagina` sempre chamou `loadAccessToken`, que nao tem `try/catch`. A
 * tela degradada e a de `/painel/atividade`. E juntar `painel_midias` ao lote
 * nao acopla falha nova: e a mesma transacao e o mesmo modo de falha que a
 * configuracao ja tinha, que cai em `parado_por_erro`, melhor do que o `500`
 * que `lerTodas` produzia.
 *
 * A paginacao usa as MESMAS linhas: ela precisa saber o que ja esta salvo para
 * o cartao dizer a verdade, e o snapshot dela e o mesmo da renderizacao.
 */
import {
  IDS_NOVOS_POR_GRAVACAO,
  type MetadadosDeMidia,
  PainelMidiasRepository,
  TETO_DE_MIDIAS,
} from '../../repositories/painel-midias-repository'
import { ehMediaIdValido } from '../../services/config-validation'
import { loadAccessToken } from '../../services/token-manager'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import { CAMPO_DA_ACAO } from './campos'
import { type CampoDaConfig, escopoDeMidias, motivoDaRecusa, TELA_DOS_REELS } from './dicionario'
import { gravarConfiguracao } from './gravar'
import { html } from './html'
import {
  blocoDeConfirmacao,
  camposDoFormulario,
  configDaTela,
  fichaDaTela,
  molduraCom,
  panorama,
} from './inicio'
import {
  buscarPagina,
  DEPENDENCIAS_DE_MIDIAS,
  type DependenciasDeMidias,
  midiasSalvasDo,
  primeiraPagina,
} from './midias'
import { blocoDaRecusa, RecusaAuditada } from './recusa'
import {
  ATUALIZAR,
  botaoDeAtualizar,
  CAMPO_DA_MIDIA,
  CAMPO_DO_CURSOR,
  CAMPO_DO_VISTO,
  CARREGAR,
  cartoesSumidos,
  contaDaListagem,
  escolhaDoEscopo,
  escondidosPreservados,
  faixaDaListagem,
  faixaDeOrfas,
  faixaDoTeto,
  listaDeReels,
  maisPagina,
} from './reels-lista'
import { erro } from './resposta'
import { ROTA_REELS } from './rotas'
import type { EntradaDaRota } from './router'
import { telaDoPainel } from './tela'

/**
 * Os campos que ESTA rota grava na linha global (Ruling 70).
 *
 * UM campo, e ele e a razao de a tela existir: `mediaScope`. `allowedMediaIds`
 * NAO esta aqui e nunca vai estar, ele e derivado das linhas ativas de
 * `painel_midias` (§9.4), e a selecao entra pela extensao do funil, nao pelo
 * patch de estado.
 */
export const CAMPOS_DOS_REELS: readonly CampoDaConfig[] = ['mediaScope']

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
  /** Os ids que a tela mostrou, o que a pessoa podia desmarcar. */
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
 * sobre a STRING. Um id que nao casa e recusado, e nunca corrigido, §9.2
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
  /** O toque em Atualizar ignora o cache de 10 minutos de §12.5. */
  readonly atualizar: boolean
}

/**
 * A tela inteira, do `GET` e da paginacao.
 *
 * **Uma funcao para os dois**, e nao duas: §12.5 manda a paginacao
 * "re-renderizar a pagina inteira no servidor", e duas montagens divergiriam na
 * primeira faixa que so uma delas ganhasse, e a que ficasse para tras seria a
 * do caminho que a pessoa usa quando tem muitos Reels.
 */
async function montarTela(desenho: DesenhoDaTela): Promise<Response> {
  const { entrada, deps } = desenho
  const snapshot = await configDaTela(entrada.env, entrada.now)
  const salvas = midiasSalvasDo(snapshot)
  const ficha = await fichaDaTela(entrada)

  // A primeira pagina vem do cache de §12.5; a paginacao, nao, "Carregar mais"
  // e um toque explicito, e §12.10 ja orca as chamadas a Meta dele.
  const buscada =
    desenho.cursor === null
      ? await primeiraPagina(entrada.env, entrada.now, deps, { ignorarCache: desenho.atualizar })
      : { em: entrada.now, listagem: await buscarPagina(entrada.env, desenho.cursor, deps) }
  const listagem = buscada.listagem

  // **A pergunta sobre a conta sai da PROPRIA listagem, e nao de uma segunda
  // consulta.** `buscarPagina` ja carregou o token, e `sem_conta` e o que ele
  // devolve quando nao existe linha em `account_tokens`. Chamar
  // `contaConectada` aqui lia a MESMA tabela duas vezes na mesma renderizacao,
  // e o segundo subrequest saia do orcamento de §12.10 sem responder nada que
  // o primeiro ja nao tivesse respondido.
  const visao = panorama(snapshot, contaDaListagem(listagem))
  const ativos = salvas.filter((midia) => midia.ativo).map((midia) => midia.mediaId)
  const marcados = marcadosDesta(desenho, ativos)

  const escopo = escopoDeMidias(snapshot.global)
  const reels = listagem.ok ? listagem.reels : []
  const naListagem = new Set(reels.map((reel) => reel.mediaId))

  // §12.5: o Reel apagado no Instagram NAO some da lista, ele fica cinza, com
  // "Este Reel nao existe mais". Sumir em silencio faria a pessoa achar que
  // continua ativo. So vale quando a listagem VEIO: com a Meta muda, ausencia
  // nao e prova de nada.
  //
  // **E so quando ela ACABOU**, e esta metade faltava. Uma pagina traz ate 25
  // publicacoes e um toque para em quatro paginas (§12.5); com `paging.next`
  // ainda de pe, o Reel que nao apareceu simplesmente nao chegou a ser
  // perguntado. Sem esta condicao, um dono com trinta Reels escolhidos abria a
  // tela e lia "Este Reel nao existe mais" em vinte deles, uma afirmacao FALSA
  // sobre o Instagram dele, que e o que §12.1 regra 6 proibe, e o cartao vinha
  // com o botao de tirar da lista ao lado. Era tambem o que mais pesava no
  // orcamento de HTML de §12.9: um `<li>` inteiro por Reel nunca perguntado.
  const sumidos =
    listagem.ok && listagem.proximoCursor === null
      ? salvas.filter((midia) => midia.ativo && !naListagem.has(midia.mediaId))
      : []

  const corpo = html`<h1>${TELA_DOS_REELS.titulo}</h1>
${blocoDeConfirmacao(entrada.request)}
${faixaDaListagem(listagem, reels.length)}
${faixaDeOrfas(snapshot.avisos)}
${faixaDoTeto(ativos.length)}
${botaoDeAtualizar(buscada.em, entrada.now, ficha, snapshot.versao, marcados, ativos)}
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

/**
 * Quais Reels aparecem marcados nesta renderizacao.
 *
 * Tres origens, e a do meio custou um Critical:
 *
 *   - `GET`: a tela nao carrega escolha nenhuma (`marcadosNaTela` e `null`), e
 *     o que vale e o banco;
 *   - **`ATUALIZAR`: a UNIAO do que a tela carregou com o que ja esta ativo.**
 *     O formulario daquele botao so reemite o que o banco ainda nao sabe, entao
 *     numa tela recem-aberta ele carrega um array VAZIO, e `[] ?? ativos` e
 *     `[]`, porque o `??` nao dispara em array vazio. Sem a uniao, tocar
 *     Atualizar desmarcava os Reels salvos e, junto, descartava os campos
 *     escondidos que preservavam os que estao fora da pagina: o Salvar seguinte
 *     gravava `ativo = 0` neles, com `303 ?ok=salvo` e faixa verde;
 *   - `CARREGAR`: exatamente o que a tela carregou, e nada mais. Ali o
 *     formulario reemite a escolha INTEIRA (`escondidosDaEscolha`), entao um
 *     array vazio significa mesmo "a pessoa desmarcou tudo", e uniao ali
 *     desfaria a desmarcacao dela.
 *
 * **Por que a uniao, e nao emitir a escolha inteira no formulario do
 * Atualizar.** A segunda saida tambem consertaria as marcas, mas mudaria o
 * SENTIDO do botao: desmarcar um Reel salvo e tocar em Atualizar passaria a
 * levar a desmarcacao junto, e o botao deixaria de ser "joga fora o retrato
 * velho, o retrato do banco e o que fica". O custo em bytes nao decide nada
 * aqui, a pagina inteira no teto de 200 Reels sao 39 KB crus e ~2,5 KB
 * comprimidos (MID-27), quem decide e o que o botao promete.
 */
function marcadosDesta(desenho: DesenhoDaTela, ativos: readonly string[]): readonly string[] {
  const daTela = desenho.marcadosNaTela
  if (daTela === null) return ativos
  if (!desenho.atualizar) return daTela
  return [...new Set([...daTela, ...ativos])]
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
    return await montarTela({
      entrada,
      deps,
      cursor: null,
      marcadosNaTela: null,
      vistos: [],
      atualizar: false,
    })
  }

  const { contexto, corpo } = entrada
  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)

  const acao = corpo.campos.get(CAMPO_DA_ACAO)
  if (acao !== null && acao !== CARREGAR && acao !== ATUALIZAR) {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }

  const escolha = lerEscolha(corpo.campos)

  // A paginacao **so renderiza**: zero escrita, `200`, a pagina remontada com o
  // que a pessoa ja marcou. E o POST que §7.1 declara como excecao a regra de
  // forma, e ele existe para o desenho funcionar sem JavaScript.
  if (acao === CARREGAR || acao === ATUALIZAR) {
    return await montarTela({
      entrada,
      deps,
      // O Atualizar volta a primeira pagina de proposito: ele e o botao que
      // joga fora o retrato velho, e um cursor de dentro do retrato velho nao
      // sobrevive a ele.
      cursor: acao === ATUALIZAR ? null : escolha.cursor,
      marcadosNaTela: escolha.marcados,
      vistos: escolha.vistos,
      atualizar: acao === ATUALIZAR,
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
  // As linhas vem do MESMO lote da configuracao (§12.10): o repositorio aqui
  // existe para os STATEMENTS da gravacao, e nao para uma segunda leitura.
  const salvas = midiasSalvasDo(snapshot)
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
      // vazio que `getMediaInfo` devolve apagaria a legenda salva, que e
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
 * Um id que a conta nao conhece nao vira `null`, ele simplesmente nao entra no
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
