/**
 * O funil UNICO de gravacao da configuracao do painel (§7.1, §11.3, §8.8).
 *
 * Tres rotas gravam a mesma linha — `POST /painel/chave`, `POST
 * /painel/palavras` e `POST /painel/ajustes` — e este arquivo e o unico lugar
 * onde a ordem obrigatoria de §11.3 acontece. Uma copia por tela seriam tres
 * grafias da trava otimista, tres grafias da classificacao de risco e tres
 * chances de esquecer a linha de auditoria; a que esquecesse seria a que
 * ninguem revisou.
 *
 * **Este arquivo nao estava na lista `Modify` do brief.** A alternativa era o
 * funil dentro de `inicio.ts`, que ja hospeda o que as telas compartilham: ele
 * passaria de 338 para perto de 600 linhas e misturaria a tela de Inicio com o
 * motor de escrita do painel inteiro. A decisao esta declarada no relatorio.
 *
 * A ordem, do passo 5 ao 10 de §11.3 (os passos 0 a 4 sao de `despachar`):
 *
 *   5. corpo lido como `URLSearchParams` — pelo roteador, uma vez so
 *   6. **campo desconhecido: recusar** (entrada de humano, estranheza e erro)
 *   7. validacao campo a campo, com a allowlist de HOJE
 *   8. step-up — UMA chamada a `passarPeloStepUp` (`stepup.ts`), que classifica
 *      o lote por §10.10 e, quando ele exige, exerce a cerimonia inteira
 *   9. trava otimista por `versao` e gravacao em lote com a auditoria
 *  10. `303` para `GET <tela>?ok=<codigo>`
 *
 * **Invariante: nenhuma escrita de configuracao acontece antes do passo 9.** A
 * recusa autenticada grava a propria linha de auditoria (§9.9, Ruling 54), e
 * essa e a unica escrita que sai de um caminho que nao muda a configuracao.
 */
import type { AutomationConfig } from '../../config'
import { carregarConfigEfetiva } from '../../services/config-store'
import type { Achado } from '../../services/config-validation'
import {
  CODIGO_DA_RECUSA,
  campoCarregaEndereco,
  lerAllowlist,
  validarConfigComAllowlist,
} from '../../services/link-allowlist'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import { CAMPO_DA_CONFIRMACAO } from './campos'
import {
  type CampoDaConfig,
  type CodigoDeConfirmacao,
  motivoDaRecusa,
  motivoDeCampoForaDaTela,
  RECUSA_SEM_VALOR,
} from './dicionario'
import {
  CONFIRMADO,
  camposQueMudaram,
  ESTRUTURAIS_DE_TODA_ROTA,
  type EstadoDeComportamento,
  estadoDaConfig,
  lerPatchDoCorpo,
  lerVersao,
  type PatchDeEstado,
  religa,
} from './formulario'
import { type HtmlSeguro, html } from './html'
import { aplicarMudanca } from './lote'
import {
  blocoDaRecusa,
  blocoDoRascunho,
  RecusaAuditada,
  recusaComMotivoUnico,
  recusarCorpoMalformado,
} from './recusa'
import { type CodigoDeErro, erro, redirecionar } from './resposta'
import type { EntradaDaRota } from './router'
import { passarPeloStepUp } from './stepup'

// ---------------------------------------------------------------------------
// O estado de comportamento: o que entra em `antes`/`depois` (§9.9)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A classificacao de risco de §10.10
// ---------------------------------------------------------------------------

/**
 * O codigo de erro de uma recusa do validador (§11.4).
 *
 * Achado de dominio e `403 dominio_nao_permitido`; o resto e
 * `400 dados_invalidos`.
 *
 * **O ramo do dominio e alcancavel pela rota desde a etapa do step-up**, e essa
 * e uma das garantias STEP: o link e os dois textos sao gravaveis com a digital.
 * A validacao roda ANTES da cerimonia (§9.7, passos 7 e 8) — entao um link fora
 * da allowlist e barrado **sem que a digital chegue a ser pedida**, e nao depois
 * de ela ter sido conferida com sucesso. A funcao continua
 * exportada e testada direto porque ela e a traducao achado -> codigo, e um
 * teste que so a exercitasse pela rota nao distinguiria "achado de dominio" de
 * "primeiro achado da lista".
 */
export function codigoDaRecusaDeValidacao(achados: readonly Achado[]): CodigoDeErro {
  return achados.some((achado) => achado.codigo === CODIGO_DA_RECUSA)
    ? CODIGO_DA_RECUSA
    : 'dados_invalidos'
}

// ---------------------------------------------------------------------------
// A gravacao
// ---------------------------------------------------------------------------

/** O que muda de uma rota de gravacao para outra. Tudo o mais e igual. */
export interface PedidoDeGravacao {
  /** A tela para onde o `303` aponta, sem query string (§7.1). */
  readonly para: string
  /** O codigo da faixa verde no caminho de sucesso. */
  readonly confirmacao: CodigoDeConfirmacao
  /**
   * Campos do corpo que nao sao configuracao, alem dos de TODA rota.
   *
   * Uma coisa so, e e importante que seja uma so (Ruling 80): eles atravessam o
   * passo 6 de §11.3 sem virar patch nem `campo_desconhecido`. Isto **nao** diz
   * nada sobre o segundo POST — a tela de conferencia reemite tudo o que nao
   * seja estrutural de TODA rota, `acao` inclusive, porque o botao que declarou
   * a operacao precisa declara-la de novo depois da digital.
   */
  readonly estruturais?: readonly string[]
  /**
   * Os campos de comportamento que ESTA rota pode escrever (Ruling 70).
   *
   * **Nao existe uma lista global de "campos gravaveis", e a ausencia dela e a
   * decisao.** `gravarConfiguracao` e agnostica de rota: sem esta lista,
   * qualquer formulario do painel podia escrever qualquer campo, e a celula de
   * §7.1 que diz "step-up **sempre** no POST" de `/painel/mensagem` era falsa —
   * bastava mandar `triggerKeywords` para aquela rota e gravar sem digital
   * nenhuma.
   *
   * Com a lista, aquela celula vira verdade **por construcao**: os unicos campos
   * que `/painel/mensagem` escreve sao os tres de `CAMPOS_SEMPRE_PROTEGIDOS`.
   *
   * E ela vale mais do que arrumacao. §15.4 manda a tela da mensagem dizer,
   * ANTES do gesto, que aquele toque cobre a tela inteira. Um formulario de
   * `/painel/palavras` que carregasse `destinationUrl` passaria pelo step-up —
   * o lote inteiro exige, §10.10 — e gravaria o link sob uma frase que prometia
   * cobrir outra coisa. A lista por rota e o que impede.
   *
   * Ela mora ao lado do FORMULARIO de cada tela, como `estruturais`: quem emite
   * os campos e quem os declara.
   *
   * **A RESTAURACAO nao e uma tela, e por isso nao e defendida por aqui**
   * (Ruling 74, que emendou o 70). §9.9 diz o que ela atravessa — "o mesmo
   * validador, o MESMO step-up e a allowlist de hoje" — e nomeia UMA recusa
   * sancionada, "se a allowlist encolheu". A lista por rota era um quarto portao
   * que a spec nao sanciona, e com ele toda linha de historico anterior a uma
   * troca de link ficava irrestauravel. Entao `acao=restaurar` e uma OPERACAO
   * declarada cujo escopo e a uniao gravavel inteira, e a defesa dela e outra:
   * a tela de conferencia mostrando literalmente cada campo que muda, mais o
   * `op_hash` recalculado no servidor sobre esse conteudo. Para campo NAO
   * protegido nao ha privilegio a ganhar — a mesma sessao escreve os mesmos
   * campos pela tela dona deles.
   */
  readonly campos: readonly CampoDaConfig[]
  /**
   * A mudanca que o proprio handler traduziu — `acao=ligar` vira `enabled`.
   *
   * **Ela entra na mudanca ASSINADA, e nao so no estado `depois`** (Ruling 86).
   * Ate esta linha o `op_hash` saia so do patch do CORPO, entao um campo
   * produzido aqui era MOSTRADO na tela de conferencia e nao era coberto pela
   * assinatura — o inverso exato da garantia de §10.10, que existe para que o
   * autenticador assine *aquela* mudanca.
   *
   * O caminho de ataque e concreto desde o Ruling 80, que fez `acao` sobreviver
   * ao segundo POST: trocar `acao=ligar` por `acao=desligar` entre os dois
   * envios mantinha o `oh` do envelope valido e mudava o efeito da gravacao. A
   * digital continuava sendo do dono, e cobria outra coisa.
   */
  readonly patchDoHandler?: PatchDeEstado
  /**
   * A parte da gravacao que mora em `painel_midias` (Ruling 91).
   *
   * **Isto e uma EXTENSAO do funil, e a alternativa recusada era um segundo
   * funil.** As quatro garantias caras da branch — trava otimista, lote atomico
   * com a linha de auditoria, step-up preso ao conteudo e "sem log, sem
   * mudanca" — valem para uma escrita por midia palavra por palavra, e a
   * migration `0002` ja diz por que: `painel_config.versao` e "contador
   * monotonico de TODA a configuracao (global + midias)", e `painel_auditoria`
   * ja tem a coluna `alvo` dimensionada para um `media_id`. Escrever direto no
   * repositorio de midias seria a segunda grafia das quatro (Ruling 63).
   *
   * O que NAO cabia no funil de hoje era uma coisa so: `antes`/`depois` sao o
   * estado de comportamento da linha GLOBAL. A extensao resolve isso deixando a
   * tela dizer qual entidade esta mudando — e, para um Reel, o `antes` passa a
   * ser a config EFETIVA daquele Reel: a global com a sobreposicao por cima.
   * Com ela no lugar de `antes`, a classificacao de risco, a tela de
   * conferencia, o `op_hash` e o JSON da auditoria continuam sendo os mesmos,
   * sem uma linha nova em nenhum dos quatro.
   *
   * **E isto e um DESVIO de §9.9, declarado como desvio.** A frase anterior
   * apresentava a config efetiva como se ela FOSSE o "estado completo da
   * entidade afetada" que a spec pede, e nao e. §9.9 e literal sobre o que uma
   * linha de midia registra: "`media_id`, `ativo` e as colunas de
   * sobreposicao". Um `antes` MESCLADO nao distingue "este Reel tem
   * sobreposicao de 24 h" de "este Reel herda 24 h da geral" — as duas produzem
   * o mesmo JSON —, e a diferenca e o que decide se desfazer a sobreposicao
   * muda alguma coisa. A perda e IRREVERSIVEL: o `depois` de ontem nao pode ser
   * desmesclado amanha.
   *
   * O que a extensao ganha em troca e o que fez a escolha: com o efetivo, a
   * classificacao de risco de §10.10, a tela de conferencia e o `op_hash`
   * continuam com UMA grafia, porque as tres falam de `EstadoDeComportamento`.
   * Registrar as colunas cruas exigiria uma segunda forma de `antes`/`depois` e
   * uma segunda classificacao — que e o Ruling 63 outra vez.
   *
   * A saida limpa existe e nao e desta rodada: um par de colunas proprias em
   * `painel_auditoria` para a sobreposicao crua, ao lado do efetivo. Fica
   * registrado aqui, e no relatorio, como divergencia conhecida — e nao como
   * cumprimento.
   */
  readonly midias?: ParteDeMidias
}

/** A parte de `painel_midias` de uma gravacao (Ruling 91). */
export interface ParteDeMidias {
  /**
   * O `alvo` da linha de auditoria.
   *
   * Um `media_id` quando a gravacao e sobre UM Reel; `null` quando ela e sobre
   * o CONJUNTO — marcar e desmarcar nao tem um alvo, tem um conjunto novo.
   */
  readonly alvo: string | null
  /**
   * O estado EFETIVO da entidade hoje, quando ela nao e a linha global.
   *
   * Ausente, o funil usa o estado da configuracao global, que e o que as
   * quatro rotas anteriores sempre fizeram.
   */
  readonly antes?: EstadoDeComportamento
  /** Nomes que entram em `campos` da auditoria alem dos campos globais. */
  readonly campos?: readonly string[]
  /**
   * Os statements de `painel_midias`, que entram no MESMO `db.batch()`.
   *
   * Cada um carrega a trava de versao na propria clausula `WHERE`
   * (`TRAVA_DE_VERSAO`, em `painel-midias-repository.ts`) e por isso eles vao
   * no COMECO do lote: dentro da transacao, `versao` ainda e a de antes da
   * bump, entao as duas travas casam juntas ou falham juntas.
   */
  readonly statements: readonly D1PreparedStatement[]
  /**
   * Estes statements mudam alguma coisa de fato?
   *
   * O funil responde `?ok=sem_mudanca` quando nada mudou, e um formulario de
   * Reels reenviado igual nao pode virar gravacao (§9.9). Quem sabe comparar
   * dois conjuntos de midia e a tela, nao o funil.
   */
  readonly mudou: boolean
}

/**
 * A ordem obrigatoria de §11.3, do passo 5 ao 10. Uma implementacao, tres rotas.
 */
export async function gravarConfiguracao(
  entrada: EntradaDaRota,
  pedido: PedidoDeGravacao,
): Promise<Response> {
  const { env, now, contexto, corpo, sessao } = entrada

  // Nenhuma das tres rotas chega aqui sem sessao nem sem formulario:
  // `despachar` so entrega ao handler depois do passo 9 da escada. O `if`
  // existe porque o TIPO admite os dois casos, e um `!` calaria justamente o
  // dia em que a tabela de rotas mudasse.
  if (corpo.familia !== 'formulario' || sessao === null) return erro('corpo_invalido', contexto)

  const ator = `passkey:${await prefixoDeCredencial(sessao.credentialId)}`

  const versaoEnviada = lerVersao(corpo.campos)
  if (versaoEnviada === null) {
    return await recusarCorpoMalformado(env, now, contexto, ator, 'versao_ausente')
  }

  // Passos 5 e 6, e eles vem antes de qualquer leitura da CONFIGURACAO: campo
  // desconhecido e erro de digitacao ou cliente adulterado, e nenhum dos dois
  // merece uma consulta na cota que o painel divide com o webhook.
  const patchDoCorpo = lerPatchDoCorpo(corpo.campos, pedido.estruturais ?? [])
  if ('recusa' in patchDoCorpo) {
    return await recusarCorpoMalformado(env, now, contexto, ator, patchDoCorpo.recusa)
  }

  // A configuracao de HOJE, sempre fresca: a trava otimista compara a versao do
  // formulario com a que esta no banco AGORA, e um cache de ate um minuto
  // transformaria a trava numa comparacao com o passado.
  const snapshot = await carregarConfigEfetiva(env, now, { ignorarCache: true })

  // **O estado GLOBAL e o estado da ENTIDADE sao dois** (Ruling 91). Nas
  // quatro rotas anteriores eles coincidem, e e por isso que ate aqui havia um
  // so. Numa gravacao por midia, `antes` e a config EFETIVA daquele Reel — a
  // global com a sobreposicao por cima, que e o "estado completo da entidade
  // afetada" que §9.9 manda registrar —, e `estadoGlobal` continua sendo o que
  // a linha de `painel_config` guarda: ela nao muda, so a `versao` anda.
  const estadoGlobal = estadoDaConfig(snapshot.global)
  const { antes, daLinhaGlobal } = entidadeDaGravacao(pedido, estadoGlobal)
  const recusa = new RecusaAuditada(env, now, contexto, snapshot, ator)

  // A configuracao salva nao pode ser lida, e o snapshot em vigor e a FABRICA
  // desligada — nao a linha do dono. Gravar aqui escreveria valores de fabrica
  // por cima do que o dono salvou, que e exatamente o "inventar um substituto
  // para o valor recusado" que §12.6 proibe na tela e §9.2 proibe no validador.
  // A tela ja nomeia o campo a consertar.
  if (snapshot.origem === 'parado_por_erro') {
    return await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: [],
      codigo: 'dados_invalidos',
      motivoInterno: 'config_ilegivel',
      explicacao: html`<p>${RECUSA_SEM_VALOR.configIlegivel}</p>`,
    })
  }

  /**
   * O rascunho que a pessoa acabou de enviar, pronto para voltar na tela.
   *
   * `paraOPost` e o caminho da ROTA, e nao `pedido.para`: em `/painel/chave` o
   * `303` aponta para `/painel`, que e `GET` e so `GET` (§7.1) — o botao de
   * recuperacao morreria em `405` justamente na rota que desliga a automacao.
   *
   * `excluir` sao os estruturais, `confirmar` incluso: carregar o gesto de
   * §10.12 pelo rascunho seria o unico caminho em que ele e **carregado** em vez
   * de **feito**.
   */
  const rascunho = async (reenviavel: boolean): Promise<HtmlSeguro> =>
    await blocoDoRascunho(entrada, corpo.campos, {
      paraOPost: entrada.rota.caminho,
      excluir: ESTRUTURAIS_DE_TODA_ROTA,
      versaoDeAgora: snapshot.versao,
      reenviavel,
    })

  // §8.8: a pagina do `409` traz a mensagem E o formulario preenchido com o que
  // a pessoa digitou. Sem ele, quem escreveu vinte palavras-gatilho num celular
  // as perde por causa de uma aba aberta em outro aparelho — e a proxima coisa
  // que essa pessoa aprende e a nao confiar no botao Salvar. E o unico lugar em
  // que reenviar FUNCIONA: a trava era de concorrencia, e o rascunho volta com a
  // versao de agora.
  if (snapshot.versao !== versaoEnviada) {
    return erro('versao_desatualizada', { ...contexto, explicacao: await rascunho(true) })
  }

  // A mudanca que ESTE POST aplica: o que o corpo carregou mais o que o handler
  // traduziu. **UM objeto, e ele alimenta os dois** — o estado `depois` que a
  // tela de conferencia mostra e a mudanca canonica que o `op_hash` assina
  // (Ruling 86). Duas expressoes separadas eram o defeito: a tela mostrava o
  // campo do handler e a assinatura nao o cobria.
  //
  // A ordem e a mesma nos dois usos, e ela importa: o handler vem por ultimo,
  // entao ele vence um campo de mesmo nome vindo do corpo.
  const patch: PatchDeEstado = { ...patchDoCorpo.patch, ...pedido.patchDoHandler }
  const depois: EstadoDeComportamento = { ...antes, ...patch }
  const mudados = camposQueMudaram(antes, depois)

  // Nada mudou: zero escrita e zero linha de auditoria. §9.9 registra GRAVACAO,
  // e um formulario reenviado igual nao e uma. A pergunta ganhou uma segunda
  // metade com a extensao: um formulario de Reels pode nao mexer em campo
  // nenhum e ainda assim trocar o CONJUNTO de midias marcadas, e quem sabe
  // comparar dois conjuntos e a tela.
  if (!mudouAlgumaCoisa(mudados, pedido)) return redirecionar(`${pedido.para}?ok=sem_mudanca`)

  // **A recusa de ESCOPO vem ANTES da cerimonia** (Ruling 73). O escopo de uma
  // rota e estatico e conhecido antes de qualquer gesto: pedir a digital para
  // uma operacao que nao podia dar certo — `403` com a tela de conferencia
  // mostrando o link literal, e `400` depois do toque — ensina o dono que
  // digital as vezes nao faz nada, e isso corroi a unica trava que depende de
  // ele prestar atencao.
  //
  // Isto NAO afrouxa o tudo-ou-nada do Ruling 66: aquele e sobre a
  // CLASSIFICACAO — se qualquer campo do lote exige step-up, o lote inteiro
  // exige —, e recusar o lote inteiro mais cedo continua sendo tudo-ou-nada.
  const recusaDeEscopo = await recusarForaDoEscopo(recusa, mudados, pedido.campos, rascunho)
  if (recusaDeEscopo !== null) return recusaDeEscopo

  // §10.12: religar exige sessao, ficha E confirmacao explicita na tela. A
  // conferencia mora aqui, e nao em `handleChave`, porque `enabled` chega ao
  // funil por DOIS veiculos nomeados: `POST /painel/chave`, que o declara em
  // `CAMPOS_DA_CHAVE`, e `acao=restaurar`, cujo escopo e a uniao gravavel
  // inteira (Ruling 74). Conferir so no handler da chave deixaria a restauracao
  // desfazer a parada de emergencia com um clique. A frase antiga dizia
  // "qualquer formulario do painel pode carrega-lo", e ela so era verdadeira
  // quando toda rota escrevia todo campo — Rulings 79 e 83.
  //
  // **Ela roda ANTES da cerimonia, pela razao do Ruling 73.** Ate esta linha
  // rodava depois, e a combinacao existia: restaurar uma versao que religa E
  // difere num campo protegido mostrava a tela de conferencia, colhia a digital
  // e so entao devolvia `400 confirmacao_ausente`. O gesto era gasto numa
  // operacao que nao podia dar certo, que e a patologia exata que aquele ruling
  // proibiu. O portao e conhecivel aqui: `antes`, `depois` e o campo
  // `confirmar` ja estao todos na mao, e nada abaixo os muda.
  //
  // Reemitir `confirmar` na tela de conferencia seria a outra saida, e ela e
  // proibida: um gesto que o servidor recarrega sozinho no formulario seguinte
  // deixa de ser um gesto (§10.12). Por isso ele e estrutural de TODA rota.
  //
  // **So na linha GLOBAL** (Ruling 91): §10.12 e sobre a chave da automacao, e
  // `enabled` numa linha de midia so pode ser `0` ou ausente — tirar a pausa de
  // um Reel devolve aquele Reel a regra geral, que continua sendo a que o dono
  // ja autorizou. Exigir a caixa de confirmacao ali pediria o gesto da parada de
  // emergencia para desfazer uma pausa de um Reel so.
  if (faltaConfirmarOReligar(daLinhaGlobal, antes, depois, corpo.campos)) {
    return await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: ['enabled'],
      codigo: 'dados_invalidos',
      motivoInterno: 'confirmacao_ausente',
      explicacao: html`<p>Para ligar a automa&ccedil;&atilde;o de novo, use o bot&atilde;o do
In&iacute;cio: ele mostra desde quando ela est&aacute; desligada e pede a sua
confirma&ccedil;&atilde;o.</p>${await rascunho(false)}`,
    })
  }

  // Passo 7, com a allowlist de HOJE — inclusive na restauracao (§9.9).
  //
  // **Ele vem ANTES da cerimonia, e §9.7 numera assim de proposito** (Ruling
  // 73, terceira instancia). A propria linha do passo 8 da spec antecipa a
  // objecao: o hash e sobre a mudanca canonica, que **ja existe aqui** — o
  // corpo foi lido no passo 5 e traduzido campo a campo —, e ate esta linha
  // nada foi gravado. Ate a etapa 12b a ordem era a inversa, e a combinacao
  // existia: uma mudanca que o validador nunca aceitaria renderizava a tela de
  // conferencia, colhia a digital, VERIFICAVA a assertion com sucesso e so
  // entao era recusada. O gesto era gasto numa operacao que nao podia dar
  // certo — e atingia justamente a unica recusa que §9.9 sanciona para a
  // restauracao, "se a allowlist encolheu".
  //
  // O portao e conhecivel aqui e nada entre as duas posicoes o move:
  // `passarPeloStepUp` so LE `mudados`, `antes`, `depois` e `patch`, e tudo o
  // que ele escreve (a linha de auditoria da recusa e `falhas_stepup`) sai por
  // um `return`. Mover uma recusa para antes nao pode conceder nada: o conjunto
  // de gravacoes bem-sucedidas e identico, porque este mesmo validador ja
  // rodava antes de `aplicarMudanca` com exatamente estas entradas.
  const recusaDoValidador = await validarOuRecusar({
    env,
    recusa,
    mudados,
    depois,
    idsDeMidia: snapshot.global.allowedMediaIds,
    rascunho,
  })
  if (recusaDoValidador !== null) return recusaDoValidador

  // Passo 8. A classificacao e a cerimonia sao UMA chamada, em `stepup.ts`:
  // separa-las daria duas coisas para desencontrar.
  //
  // §10.10 quer que o objeto hasheado seja "o mapa de campos **ja validado e
  // normalizado** pelo mesmo `config-validation.ts`". As duas metades fecham
  // exatamente aqui: "ja validado" e a linha acima, e "normalizado" e o
  // `normalizar` de `jsonCanonico`, que aplica a `limparTexto` do proprio
  // `config-validation.ts` a cada string — a MESMA funcao nos dois caminhos, e
  // e por isso que os vetores congelados de §13.2 fecham. Limpar o `patch`
  // aqui, antes de entrega-lo, seria uma segunda grafia da mesma normalizacao.
  const passagem = await passarPeloStepUp({
    entrada,
    sessao,
    recusa,
    campos: corpo.campos,
    patch,
    // **So os estruturais de TODA ROTA** (Ruling 80), e nao os desta rota. A
    // lista tinha dois significados fundidos num so: "nao e campo de
    // configuracao, entao atravessa o passo 6 de §11.3" — que e o que
    // `lerPatchDoCorpo` acima pergunta — e "nao pode ser reemitido no segundo
    // POST", que e o que a tela de conferencia pergunta aqui. `confirmar` e do
    // segundo tipo: reemiti-lo faria o gesto de §10.12 virar carimbo. `acao` e
    // do primeiro, e exclui-lo quebrava o botao "Voltar a esta versao" —
    // a operacao declarada sumia do segundo POST, o escopo caia para o do
    // formulario comum de Ajustes, e a resposta era `400 dados_invalidos`
    // DEPOIS da digital, que e exatamente o que o Ruling 73 proibe.
    //
    // E a inversao e o que fazia daquilo o pior tipo de falha: um cliente que
    // monta o proprio corpo inclui `acao` nos dois POSTs e passa. So o botao
    // honesto, que depende do HTML que o servidor emitiu, quebrava.
    estruturais: ESTRUTURAIS_DE_TODA_ROTA,
    mudados,
    antes,
    depois,
    versaoEnviada,
    // **O alvo entra na assinatura e na tela de conferencia** (Ruling 96, que
    // emendou o 90). Sem ele o `patch` de `/painel/reel` era identico para
    // qualquer Reel: o `media_id` viajava so no campo escondido `midia`, que a
    // tela reemite e que ficava fora do `op_hash` — a forma exata do Ruling 86,
    // com o `oh` do envelope continuando valido depois de a entidade trocar.
    ...(pedido.midias?.alvo == null ? {} : { alvo: pedido.midias.alvo }),
  })
  if ('resposta' in passagem) return passagem.resposta
  const credencialDoStepUp = passagem.credentialId

  // Passos 9 e 10.
  return await aplicarMudanca({
    entrada,
    sessao,
    pedido,
    // A linha de `painel_config` recebe o `depois` so quando a gravacao E dela.
    // Numa gravacao por midia ela e reescrita com os PROPRIOS valores, e o
    // efeito util e a `versao` — que a migration `0002` define como o contador
    // de toda a configuracao, global e midias. Escrever `depois` aqui gravaria a
    // config efetiva de UM Reel por cima da global de todos.
    ...(daLinhaGlobal ? {} : { linhaGlobal: estadoGlobal }),
    // §9.9: o `ator` e a credencial que AUTORIZOU aquela gravacao, e nao a que
    // abriu a sessao. Hoje as duas coincidem — so ha uma passkey cadastrada nos
    // cenarios de teste —, e e justamente por isso que a distincao tem de estar
    // no codigo antes de a Task 14 fazer duas passkeys existirem de verdade: o
    // dia em que o dono confirmar com o aparelho novo uma mudanca de uma sessao
    // aberta pelo antigo, a linha tem de nomear o aparelho que encostou o dedo.
    ator:
      credencialDoStepUp === null
        ? recusa.ator
        : `passkey:${await prefixoDeCredencial(credencialDoStepUp)}`,
    antes,
    depois,
    mudados,
    versaoEnviada,
    versaoResultante: snapshot.versao + 1,
    comStepUp: credencialDoStepUp !== null,
  })
}

/**
 * Qual entidade esta gravacao altera (Ruling 91).
 *
 * `antes` e o estado EFETIVO da entidade, e `daLinhaGlobal` diz se ela e a linha
 * de `painel_config`. As quatro rotas anteriores caem sempre no ramo global, que
 * e por que ate a Task 13 esta pergunta nao existia.
 */
function entidadeDaGravacao(
  pedido: PedidoDeGravacao,
  estadoGlobal: EstadoDeComportamento,
): { antes: EstadoDeComportamento; daLinhaGlobal: boolean } {
  const daEntidade = pedido.midias?.antes
  if (daEntidade === undefined) return { antes: estadoGlobal, daLinhaGlobal: true }
  return { antes: daEntidade, daLinhaGlobal: false }
}

/**
 * Esta gravacao muda alguma coisa?
 *
 * Duas metades desde a extensao: os campos da linha que mudaram, e o conjunto de
 * midias, que a tela compara porque so ela sabe compara-lo. Um reenvio identico
 * nao e uma gravacao (§9.9), e vale para os dois.
 */
function mudouAlgumaCoisa(mudados: readonly CampoDaConfig[], pedido: PedidoDeGravacao): boolean {
  if (mudados.length > 0) return true
  return pedido.midias?.mudou === true
}

/**
 * Os campos do lote que ESTA rota nao grava viram a recusa pronta, ou `null`.
 *
 * Extraida do funil para a funcao caber no teto de complexidade do Biome. O
 * comportamento nao mudou de lugar: continua sendo a UNICA recusa de escopo, e
 * continua acontecendo antes da cerimonia (Ruling 73).
 */
async function recusarForaDoEscopo(
  recusa: RecusaAuditada,
  mudados: readonly CampoDaConfig[],
  gravaveis: readonly CampoDaConfig[],
  rascunho: (reenviavel: boolean) => Promise<HtmlSeguro>,
): Promise<Response | null> {
  const foraDoEscopo = mudados.filter((campo) => !gravaveis.includes(campo))
  if (foraDoEscopo.length === 0) return null

  return await recusa.registrar({
    acao: 'mudanca_recusada',
    campos: foraDoEscopo,
    codigo: 'dados_invalidos',
    motivoInterno: 'campo_nao_gravavel',
    explicacao: html`${blocoDaRecusa(
      foraDoEscopo.map((campo) => ({ campo, motivo: motivoDeCampoForaDaTela(campo) })),
    )}${await rascunho(false)}`,
  })
}

/**
 * A transicao `desligada -> ligada` chegou sem o gesto de §10.12?
 *
 * Extraida do funil para a funcao caber no teto de complexidade do Biome — e a
 * pergunta continua sendo UMA, com os tres pedacos juntos, porque separar
 * "religa" de "veio confirmado" daria dois lugares para desencontrar.
 */
function faltaConfirmarOReligar(
  daLinhaGlobal: boolean,
  antes: EstadoDeComportamento,
  depois: EstadoDeComportamento,
  campos: URLSearchParams,
): boolean {
  if (!daLinhaGlobal) return false
  if (!religa(antes, depois)) return false
  return campos.get(CAMPO_DA_CONFIRMACAO) !== CONFIRMADO
}

/** O que o passo 7 precisa do funil. */
interface PedidoDeValidacao {
  readonly env: Env
  readonly recusa: RecusaAuditada
  readonly mudados: readonly CampoDaConfig[]
  readonly depois: EstadoDeComportamento
  /** Derivado e nao gravavel (§9.4): passa intacto para o validador. */
  readonly idsDeMidia: readonly string[]
  readonly rascunho: (reenviavel: boolean) => Promise<HtmlSeguro>
}

/**
 * Passo 7 de §11.3: a configuracao candidata contra o validador UNICO e a
 * allowlist de HOJE. Devolve a recusa pronta, ou `null` quando tudo passa.
 *
 * Sao DUAS recusas, e a primeira nao esta no validador de proposito.
 *
 * **Allowlist vazia nao "passa tudo": ela recusa qualquer endereco** (§9.8,
 * §12.7, LNK-12). O validador devolve zero achados nesse estado por decisao —
 * §9.8 nao pune, na LEITURA, quem tem um `destinationUrl` no arquivo e ainda nao
 * preencheu a variavel nova —, e a recusa acontece aqui, na ESCRITA, perguntando
 * a `configurada`. Ate a etapa do step-up a promessa era verdadeira por
 * acidente: os tres campos de endereco paravam no `403 step_up_necessario` antes
 * de chegar a validacao. Com eles gravaveis (Ruling 65), esta pergunta passou a
 * ser a unica coisa entre "sem lista configurada" e "o painel aceita qualquer
 * link" — o oposto do que a allowlist existe para fazer.
 *
 * Desde a etapa 12b esta recusa acontece no PRIMEIRO POST, e nao no segundo: a
 * ordem de §9.7 poe o passo 7 antes do 8, entao a pessoa cujo deploy nao tem a
 * variavel le a tarja em vez de encostar o dedo para ouvir um "nao" que ja
 * estava decidido.
 */
async function validarOuRecusar(pedido: PedidoDeValidacao): Promise<Response | null> {
  const { env, recusa, mudados, depois, rascunho } = pedido
  const allowlist = lerAllowlist(env.ALLOWED_LINK_DOMAINS)

  const comEndereco = mudados.filter((campo) => campoCarregaEndereco(campo))
  if (!allowlist.configurada && comEndereco.length > 0) {
    return await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: comEndereco,
      codigo: CODIGO_DA_RECUSA,
      motivoInterno: 'allowlist_nao_configurada',
      explicacao: html`${recusaComMotivoUnico(
        comEndereco,
        motivoDaRecusa(CODIGO_DA_RECUSA),
      )}${await rascunho(false)}`,
    })
  }

  const { mediaScope: _escopo, ...semEscopo } = depois
  const candidata: AutomationConfig = { ...semEscopo, allowedMediaIds: [...pedido.idsDeMidia] }
  const validacao = validarConfigComAllowlist(candidata, allowlist)
  if (validacao.ok) return null

  return await recusa.registrar({
    acao: 'mudanca_recusada',
    campos: validacao.achados.map((achado) => achado.campo),
    codigo: codigoDaRecusaDeValidacao(validacao.achados),
    motivoInterno: validacao.achados[0]?.codigo,
    // A frase de §12.4 de CADA achado, e nao a `mensagem` do validador: aquela
    // e escrita para quem instala o projeto e usa palavras que a tela nao
    // escreve. O dicionario traduz pelo `codigo`.
    // O rascunho volta aqui tambem, e este e o caso que mais dói: perder vinte
    // palavras digitadas num celular porque uma delas ficou curta demais e pior
    // do que perde-las por causa de uma aba aberta em outro aparelho.
    explicacao: html`${blocoDaRecusa(
      validacao.achados.map((achado) => ({
        campo: achado.campo,
        motivo: motivoDaRecusa(achado.codigo),
      })),
    )}${await rascunho(false)}`,
  })
}
