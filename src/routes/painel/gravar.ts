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
import { PainelAuditoriaRepository } from '../../repositories/painel-auditoria-repository'
import {
  type LinhaGravavel,
  PainelConfigRepository,
} from '../../repositories/painel-config-repository'
import {
  type LinhaDeSessao,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../../services/config-store'
import type { Achado } from '../../services/config-validation'
import {
  CODIGO_DA_RECUSA,
  campoCarregaEndereco,
  lerAllowlist,
  validarConfigComAllowlist,
} from '../../services/link-allowlist'
import { rotacionarSessao } from '../../services/panel-session'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import {
  type CampoDaConfig,
  type CodigoDeConfirmacao,
  motivoDaRecusa,
  motivoDeCampoForaDaTela,
  RECUSA_SEM_VALOR,
} from './dicionario'
import {
  CAMPOS_DE_COMPORTAMENTO,
  CONFIRMADO,
  ESTRUTURAIS_DE_TODA_ROTA,
  type EstadoDeComportamento,
  estadoDaConfig,
  lerPatchDoCorpo,
  lerVersao,
  type PatchDeEstado,
  religa,
} from './formulario'
import { CAMPO_DA_CONFIRMACAO, COOKIE_DA_SESSAO, cookieDoPainel } from './guardas'
import { type HtmlSeguro, html } from './html'
import {
  blocoDaRecusa,
  blocoDoRascunho,
  RecusaAuditada,
  recusaComMotivoUnico,
  recusarCorpoMalformado,
} from './recusa'
import { type CodigoDeErro, erro, redirecionar } from './resposta'
import type { EntradaDaRota } from './router'
import { cookieDeStepUpExpirado, passarPeloStepUp } from './stepup'

// ---------------------------------------------------------------------------
// O estado de comportamento: o que entra em `antes`/`depois` (§9.9)
// ---------------------------------------------------------------------------
/**
 * O JSON de `antes`/`depois`, com as chaves em ordem fixa.
 *
 * **Nenhum metadado de exibicao entra aqui, nem hoje nem quando as linhas de
 * midia chegarem** (§9.9, §15.4): `legenda_curta` e recorte da `caption` do
 * Reel, e `caption` esta na lista de proibidos dos DOIS destinos — a proibicao
 * vence a regra do "estado completo". A protecao e estrutural: a funcao copia
 * de `CAMPOS_DE_COMPORTAMENTO`, e nao do objeto que recebeu, entao um campo a
 * mais na origem nao vaza por descuido.
 */
function comoJson(estado: EstadoDeComportamento): string {
  const ordenado: Record<string, unknown> = {}
  for (const campo of CAMPOS_DE_COMPORTAMENTO) ordenado[campo] = estado[campo]
  return JSON.stringify(ordenado)
}

// ---------------------------------------------------------------------------
// A classificacao de risco de §10.10
// ---------------------------------------------------------------------------

/**
 * O codigo de erro de uma recusa do validador (§11.4).
 *
 * Achado de dominio e `403 dominio_nao_permitido`; o resto e
 * `400 dados_invalidos`.
 *
 * **O ramo do dominio passou a ser alcancavel pela rota nesta etapa**, e essa e
 * uma das garantias STEP: o link e os dois textos agora sao gravaveis com a
 * digital, e a validacao roda DEPOIS da verificacao do step-up — entao um link
 * fora da allowlist e barrado **mesmo com a digital correta**. A funcao continua
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
  /** A mudanca que o proprio handler traduziu — `acao=ligar` vira `enabled`. */
  readonly patchDoHandler?: PatchDeEstado
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
  const antes = estadoDaConfig(snapshot.global)
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

  const depois: EstadoDeComportamento = {
    ...antes,
    ...patchDoCorpo.patch,
    ...pedido.patchDoHandler,
  }
  const mudados = CAMPOS_DE_COMPORTAMENTO.filter((campo) => mudou(antes[campo], depois[campo]))

  // Nada mudou: zero escrita e zero linha de auditoria. §9.9 registra GRAVACAO,
  // e um formulario reenviado igual nao e uma.
  if (mudados.length === 0) return redirecionar(`${pedido.para}?ok=sem_mudanca`)

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
  const foraDoEscopo = mudados.filter((campo) => !pedido.campos.includes(campo))
  if (foraDoEscopo.length > 0) {
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
  if (religa(antes, depois) && corpo.campos.get(CAMPO_DA_CONFIRMACAO) !== CONFIRMADO) {
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

  // Passo 8. A classificacao e a cerimonia sao UMA chamada, em `stepup.ts`:
  // separa-las daria duas coisas para desencontrar.
  const passagem = await passarPeloStepUp({
    entrada,
    sessao,
    recusa,
    campos: corpo.campos,
    patch: patchDoCorpo.patch,
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
  })
  if ('resposta' in passagem) return passagem.resposta
  const credencialDoStepUp = passagem.credentialId

  // Passo 7, com a allowlist de HOJE — inclusive na restauracao (§9.9).
  const recusaDoValidador = await validarOuRecusar({
    env,
    recusa,
    mudados,
    depois,
    idsDeMidia: snapshot.global.allowedMediaIds,
    rascunho,
  })
  if (recusaDoValidador !== null) return recusaDoValidador

  // Passos 9 e 10.
  return await aplicarMudanca({
    entrada,
    sessao,
    pedido,
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

/** O que os passos 9 e 10 precisam do funil. */
interface AplicacaoDeMudanca {
  readonly entrada: EntradaDaRota
  readonly sessao: LinhaDeSessao
  readonly pedido: PedidoDeGravacao
  readonly ator: string
  readonly antes: EstadoDeComportamento
  readonly depois: EstadoDeComportamento
  readonly mudados: readonly CampoDaConfig[]
  readonly versaoEnviada: number
  readonly versaoResultante: number
  /** A gravacao passou pelo step-up? Decide a coluna, a rotacao e os cookies. */
  readonly comStepUp: boolean
}

/**
 * Passo 9 e passo 10: UM `db.batch()` e o `303`.
 *
 * O lote tem duas ou tres linhas — configuracao, auditoria e, so quando houve
 * step-up, a rotacao do `sid` (§10.8). Se qualquer parte falhar, todas falham:
 * sem log, sem mudanca, e nada de "grava e depois tenta logar".
 */
async function aplicarMudanca(aplicacao: AplicacaoDeMudanca): Promise<Response> {
  const { entrada, sessao, pedido, antes, depois, mudados, comStepUp } = aplicacao
  const { env, now, contexto } = entrada

  // §10.8: o `sid` rotaciona em exatamente dois momentos, e este e o segundo —
  // a sessao muda de "conseguiu ler" para "acabou de autorizar". O prazo
  // absoluto e o que JA estava valendo: SES-01 diz que ele nunca e estendido.
  // Como a rotacao acontece na mesma requisicao que grava e devolve o `303`, o
  // cookie novo chega junto com o redirect.
  const sessaoNova = comStepUp ? await rotacionarSessao(env, sessao.expiraEm) : null

  const lote = [
    new PainelConfigRepository(env.DB).statementDeGravacao(
      now,
      comoLinha(depois),
      aplicacao.versaoEnviada,
    ),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro(
      {
        ocorridoEm: now,
        versao: aplicacao.versaoResultante,
        origem: 'painel',
        ator: aplicacao.ator,
        // §9.9: a coluna diz se AQUELA gravacao passou por step-up. Um `false`
        // fixo faria a auditoria nao distinguir a troca do link — que so
        // acontece com a digital — de uma troca de palavra-gatilho.
        stepUp: comStepUp,
        acao: 'config_alterada',
        alvo: null,
        campos: JSON.stringify(mudados),
        antes: comoJson(antes),
        depois: comoJson(depois),
      },
      // A metade contraria de "sem log, sem mudanca": a linha de auditoria so
      // entra se o `UPDATE` acima tiver mesmo alterado a linha de config.
      { presoAMudanca: true },
    ),
  ]

  // TERCEIRA posicao, e `presoAMudanca` diz por que a posicao importa: sem ele,
  // o `sid` rotacionaria numa gravacao que a trava otimista recusou, e o dono
  // seria deslogado sem receber o cookie novo. A opcao esta escrita aqui, no
  // call site, e nao escondida no SQL.
  if (sessaoNova !== null) {
    lote.push(
      new PainelSessoesRepository(env.DB).statementDeRotacao(sessao.sidHash, sessaoNova.sidHash, {
        presoAMudanca: true,
      }),
    )
  }

  const resultado = await env.DB.batch(lote)

  // §8.8: `meta.changes === 0` e a trava otimista tendo agido entre a leitura e
  // o lote. Divergencia vira erro duro na tela, nunca sucesso silencioso.
  if ((resultado[0]?.meta.changes ?? 0) === 0) return erro('versao_desatualizada', contexto)

  // Sem isto o isolate que acabou de gravar continuaria servindo o snapshot
  // antigo ate o TTL vencer, e a tela mostraria o valor de ANTES logo depois de
  // o dono salvar — o jeito mais rapido de destruir a confianca dele.
  invalidarCacheDeConfig()

  // §10.10, fim do passo 4: aplica, **expira o cookie**, rotaciona o `sid`,
  // responde `303`. Os dois `Set-Cookie` juntos sao o que garante que o mesmo
  // step-up nao serve para duas gravacoes: o envelope morre, e o `sid` que ele
  // nomeia deixa de existir.
  const cookies =
    sessaoNova === null
      ? []
      : [
          cookieDoPainel(
            COOKIE_DA_SESSAO,
            sessaoNova.valor,
            Math.floor((sessaoNova.expiraEm - now) / 1000),
          ),
          cookieDeStepUpExpirado(),
        ]

  return redirecionar(`${pedido.para}?ok=${pedido.confirmacao}`, {}, cookies)
}

/** Dois valores do estado sao diferentes? Listas comparam item a item. */
function mudou(antes: unknown, depois: unknown): boolean {
  if (Array.isArray(antes) && Array.isArray(depois)) {
    return antes.length !== depois.length || antes.some((item, i) => item !== depois[i])
  }
  return antes !== depois
}

/** O estado de comportamento no formato das colunas de `painel_config`. */
function comoLinha(estado: EstadoDeComportamento): LinhaGravavel {
  return {
    enabled: estado.enabled ? 1 : 0,
    trigger_keywords: JSON.stringify(estado.triggerKeywords),
    match_mode: estado.matchMode,
    case_sensitive: estado.caseSensitive ? 1 : 0,
    normalize_accents: estado.normalizeAccents ? 1 : 0,
    ignore_punctuation: estado.ignorePunctuation ? 1 : 0,
    process_only_reels: estado.processOnlyReels ? 1 : 0,
    media_scope: estado.mediaScope,
    public_reply_enabled: estado.publicReplyEnabled ? 1 : 0,
    public_reply_text: estado.publicReplyText,
    private_reply_enabled: estado.privateReplyEnabled ? 1 : 0,
    private_reply_text: estado.privateReplyText,
    destination_url: estado.destinationUrl,
    user_cooldown_hours: estado.userCooldownHours,
  }
}
