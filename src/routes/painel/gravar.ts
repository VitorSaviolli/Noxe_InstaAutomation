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
 *   8. step-up — a classificacao de §10.10 ja mora aqui; o verificador nasce
 *      na etapa dele, e ate la a mudanca protegida e RECUSADA, nunca aceita
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
import { carregarConfigEfetiva, invalidarCacheDeConfig } from '../../services/config-store'
import type { Achado } from '../../services/config-validation'
import { MAX_HORAS_DE_COOLDOWN } from '../../services/config-validation'
import {
  CODIGO_DA_RECUSA,
  lerAllowlist,
  validarConfigComAllowlist,
} from '../../services/link-allowlist'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import {
  type CampoDaConfig,
  type CodigoDeConfirmacao,
  type EscopoDeMidias,
  escopoDeMidias,
  motivoDaRecusa,
  NOME_DO_CAMPO,
  RECUSA_SEM_VALOR,
} from './dicionario'
import { CAMPO_DA_CONFIRMACAO, CAMPO_DA_FICHA, CAMPO_DA_VERSAO } from './guardas'
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

// ---------------------------------------------------------------------------
// O estado de comportamento: o que entra em `antes`/`depois` (§9.9)
// ---------------------------------------------------------------------------

/**
 * O estado COMPLETO da configuracao global, restrito aos campos de
 * comportamento (§9.9).
 *
 * `allowedMediaIds` sai e `mediaScope` entra: o gravavel e o escopo, e a lista
 * de ids e DERIVADA das linhas ativas de `painel_midias` (§9.4). Ficam de fora
 * `versao`, `parado_por_codigo_em`, `criado_em` e `atualizado_em`, que sao
 * carimbo e nao ajuste.
 *
 * O tipo e DERIVADO de `AutomationConfig`, e nao uma lista escrita a mao: um
 * campo novo em `src/config.ts` entra aqui sozinho e quebra o `tsc` em quem
 * esquecer de tratar dele.
 */
export type EstadoDeComportamento = Omit<AutomationConfig, 'allowedMediaIds'> & {
  mediaScope: EscopoDeMidias
}

/** Um pedaco do estado: os campos que aquele formulario enviou. */
export type PatchDeEstado = Partial<EstadoDeComportamento>

/**
 * Os campos de comportamento, em ordem lexicografica, uma vez so.
 *
 * A lista vem das CHAVES de `NOME_DO_CAMPO`, que e um `Record<CampoDaConfig,
 * string>` — ou seja, o TypeScript ja garante que ela esta completa. Uma
 * segunda lista literal aqui seria a que ficaria para tras.
 *
 * A ordem lexicografica nao e enfeite: e ela que torna `antes` e `depois` dois
 * JSON comparaveis como texto, e e a mesma ordem que §10.10 exige do
 * `json_canonico` do step-up, que nasce na etapa seguinte.
 */
export const CAMPOS_DE_COMPORTAMENTO: readonly CampoDaConfig[] = (
  Object.keys(NOME_DO_CAMPO) as CampoDaConfig[]
).sort()

/** O estado de comportamento de uma configuracao efetiva. */
function estadoDaConfig(config: AutomationConfig): EstadoDeComportamento {
  const { allowedMediaIds: _derivado, ...comportamento } = config
  return { ...comportamento, mediaScope: escopoDeMidias(config) }
}

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
 * Os campos que o painel GRAVA hoje (Etapa 10).
 *
 * `userCooldownHours` entra so **para cima**: baixar a janela alarga o alcance,
 * e alargar exige step-up (§10.10). A direcao e conferida em `alargaOAlcance`,
 * e nao aqui, porque ela depende do valor atual.
 */
const CAMPOS_GRAVAVEIS: readonly CampoDaConfig[] = [
  'enabled',
  'triggerKeywords',
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'userCooldownHours',
]

/** Os tres campos que exigem step-up SEMPRE, em qualquer direcao (§10.10). */
const CAMPOS_SEMPRE_PROTEGIDOS: readonly CampoDaConfig[] = [
  'destinationUrl',
  'privateReplyText',
  'publicReplyText',
]

/**
 * A mudanca daquele campo ALARGA o envelope de alcance? (§10.10)
 *
 * A enumeracao e fechada e vem da spec, palavra por palavra: `matchMode` para
 * `contains`, cooldown ABAIXO do atual, `mediaScope` para `'todas'`,
 * `processOnlyReels` para `false`. Tudo o mais e estreitar — e estreitar nunca
 * pede a digital, que e a promessa escrita no rodape dos Ajustes (§12.3).
 *
 * **`enabled` nao esta aqui, e a ausencia e a decisao de §10.10**: religar a
 * automacao parece alargamento e nao e, porque nao muda nenhum valor — apenas
 * devolve a chave ao estado anterior, que o dono ja autorizou quando gravou
 * aqueles campos. Exigir biometria aqui puniria justamente quem acabou de usar
 * o freio de emergencia, e a parada de emergencia depende de desligar ser
 * barato nas duas direcoes.
 */
function alargaOAlcance(
  campo: CampoDaConfig,
  antes: EstadoDeComportamento,
  depois: EstadoDeComportamento,
): boolean {
  if (campo === 'matchMode') return depois.matchMode === 'contains'
  if (campo === 'userCooldownHours') return depois.userCooldownHours < antes.userCooldownHours
  if (campo === 'mediaScope') return depois.mediaScope === 'todas'
  if (campo === 'processOnlyReels') return depois.processOnlyReels === false
  return false
}

/**
 * O codigo de erro de uma recusa do validador (§11.4).
 *
 * Achado de dominio e `403 dominio_nao_permitido`; o resto e
 * `400 dados_invalidos`. Funcao separada, e testada direto, porque o ramo do
 * dominio NAO e alcancavel pela rota nesta etapa: os tres campos que produzem
 * esse achado — link e os dois textos — sao sempre protegidos, entao qualquer
 * MUDANCA neles ja para no `403 step_up_necessario` antes da validacao, e um
 * link ja gravado fora da lista derruba a leitura para `parado_por_erro`, que e
 * recusado antes ainda. Sobra o caso da PRIMEIRA gravacao, em que a linha nao
 * existe e o link vem do arquivo — e um teste desse caso dependeria do valor de
 * `src/config.ts`, que muda em cada instalacao. Testar a funcao com achados
 * sinteticos afirma a regra sem fingir uma cobertura de rota que nao existe.
 */
export function codigoDaRecusaDeValidacao(achados: readonly Achado[]): CodigoDeErro {
  return achados.some((achado) => achado.codigo === CODIGO_DA_RECUSA)
    ? CODIGO_DA_RECUSA
    : 'dados_invalidos'
}

/** Os campos do lote que exigem step-up. Um so ja tranca o lote inteiro. */
function camposProtegidos(
  mudados: readonly CampoDaConfig[],
  antes: EstadoDeComportamento,
  depois: EstadoDeComportamento,
): readonly CampoDaConfig[] {
  return mudados.filter(
    (campo) => CAMPOS_SEMPRE_PROTEGIDOS.includes(campo) || alargaOAlcance(campo, antes, depois),
  )
}

// ---------------------------------------------------------------------------
// A leitura do formulario
// ---------------------------------------------------------------------------

/** Os dois valores que um campo de sim/nao aceita. Nada mais casa (§11.3). */
const SIM = 'sim'
const NAO = 'nao'

/** O valor que o campo de confirmacao precisa carregar. */
const CONFIRMADO = 'sim'

/**
 * Os campos do corpo que NAO sao configuracao.
 *
 * A ficha do passo 7 (`CAMPO_DA_FICHA`, de `guardas.ts`, onde ela e conferida),
 * a versao do passo 9 e a confirmacao de §10.12 — que vale para TODA rota, e
 * nao so para `/painel/chave`, porque religar por um formulario de restauracao
 * e religar do mesmo jeito. Cada rota acrescenta os seus: `/painel/chave`
 * acrescenta `acao`.
 */
export const ESTRUTURAIS_DE_TODA_ROTA: readonly string[] = [
  CAMPO_DA_FICHA,
  CAMPO_DA_VERSAO,
  CAMPO_DA_CONFIRMACAO,
]

/** O campo `versao` do formulario, ou `null` quando ele nao presta. */
function lerVersao(campos: URLSearchParams): number | null {
  const bruto = campos.get(CAMPO_DA_VERSAO)
  if (bruto === null || !/^\d{1,10}$/.test(bruto)) return null
  return Number.parseInt(bruto, 10)
}

/**
 * Religar a automacao, e so isso.
 *
 * `false -> true` e a UNICA transicao que §10.12 obriga a confirmar. A
 * conferencia mora no FUNIL, e nao no handler de `/painel/chave`, e a diferenca
 * e a falha que a primeira grafia tinha: `enabled` e campo gravavel, entao
 * `POST /painel/ajustes` com `enabled=sim` — que o proprio botao "Voltar a esta
 * versao" emite, porque ele reenvia todos os campos — desfazia a parada de
 * emergencia com um clique, sem confirmacao e sem a data na tela.
 */
function religa(antes: EstadoDeComportamento, depois: EstadoDeComportamento): boolean {
  return antes.enabled === false && depois.enabled === true
}

/**
 * Um valor de formulario vira o pedaco tipado daquele campo, ou `null`.
 *
 * `null` significa RECUSA, e nunca "usa o padrao": um valor que nao casa e
 * cliente adulterado ou erro de digitacao, e §9.2 proibe conserto nas duas
 * hipoteses.
 */
function lerCampo(campo: CampoDaConfig, bruto: string): PatchDeEstado | null {
  switch (campo) {
    case 'enabled':
    case 'caseSensitive':
    case 'normalizeAccents':
    case 'ignorePunctuation':
    case 'processOnlyReels':
    case 'publicReplyEnabled':
    case 'privateReplyEnabled': {
      const valor = lerSimOuNao(bruto)
      return valor === null ? null : { [campo]: valor }
    }

    case 'matchMode':
      return bruto === 'exact' || bruto === 'contains' ? { matchMode: bruto } : null

    case 'mediaScope':
      return bruto === 'todas' || bruto === 'selecionadas' ? { mediaScope: bruto } : null

    case 'userCooldownHours': {
      const horas = lerHoras(bruto)
      return horas === null ? null : { userCooldownHours: horas }
    }

    case 'triggerKeywords':
      return { triggerKeywords: lerGatilhos(bruto) }

    default:
      // Os tres campos de texto e de link chegam CRUS: quem os julga e o
      // validador unico, que ja mede tamanho, placeholder e dominio. Um
      // `trim()` aqui seria um segundo validador, e o pior tipo — o que
      // conserta.
      return { [campo]: bruto }
  }
}

function lerSimOuNao(bruto: string): boolean | null {
  if (bruto === SIM) return true
  if (bruto === NAO) return false
  return null
}

/**
 * As horas do intervalo por pessoa.
 *
 * A faixa e conferida aqui APENAS para nao deixar `NaN` nem `Infinity`
 * chegarem ao banco — o julgamento de produto continua em `validarConfig`, que
 * e quem devolve a frase. Sem o teto, `"1e400"` viraria `Infinity` e
 * `.bind(Infinity)` derrubaria a consulta do intervalo la no webhook.
 */
function lerHoras(bruto: string): number | null {
  if (!/^\d{1,6}$/.test(bruto)) return null
  const horas = Number.parseInt(bruto, 10)
  return horas <= MAX_HORAS_DE_COOLDOWN ? horas : null
}

/**
 * As palavras-gatilho, uma por linha da caixa de texto.
 *
 * Linha em branco NAO e um item vazio: e o Enter que a pessoa deu antes de
 * escrever a proxima. Descartar a linha vazia e ler o formato da caixa de
 * texto, e nao consertar um valor — um item que fica vazio DEPOIS da
 * normalizacao (so pontuacao, so emoji) continua chegando inteiro ao
 * validador, que o recusa com `gatilho_vazio`.
 */
function lerGatilhos(bruto: string): string[] {
  return bruto
    .split('\n')
    .map((linha) => linha.trim())
    .filter((linha) => linha.length > 0)
}

/** As palavras-gatilho de volta ao formato da caixa de texto. */
export function comoLinhas(gatilhos: readonly string[]): string {
  return gatilhos.join('\n')
}

/** Um booleano de volta ao formato do formulario. */
function comoSimOuNao(valor: boolean): string {
  return valor ? SIM : NAO
}

/**
 * O valor daquele campo no formato que `lerCampo` sabe ler de volta.
 *
 * Mora ao lado do leitor, e nao na tela, porque os dois formam UM par: um
 * codificador que escrevesse `true`/`false` enquanto o leitor espera
 * `sim`/`nao` faria o botao "Voltar a esta versao" recusar todo restauro, e o
 * defeito apareceria so no dia em que alguem apertasse o botao.
 */
export function valorDeFormulario(campo: CampoDaConfig, estado: EstadoDeComportamento): string {
  const valor = estado[campo]
  if (typeof valor === 'boolean') return comoSimOuNao(valor)
  if (Array.isArray(valor)) return comoLinhas(valor)
  return String(valor)
}

/**
 * Um `antes` guardado na auditoria de volta a um estado utilizavel.
 *
 * O texto vem do D1, que e entrada NAO confiavel (uma linha pode ter entrado
 * por `wrangler d1 execute`). Devolve `null` a qualquer estranheza, e a tela
 * simplesmente nao oferece o botao daquela linha — nunca um botao que posta um
 * corpo meio montado.
 */
export function lerEstadoGuardado(bruto: string): EstadoDeComportamento | null {
  let cru: unknown
  try {
    cru = JSON.parse(bruto)
  } catch {
    return null
  }

  if (typeof cru !== 'object' || cru === null || Array.isArray(cru)) return null
  const objeto = cru as Record<string, unknown>

  // **Todos os campos, e a exigencia e por campo AUSENTE, nunca por campo a
  // mais.** Faltando um, o formulario sairia sem ele — e campo ausente
  // significa "nao mexe nisso" na gravacao, entao a restauracao ficaria pela
  // metade sem ninguem perceber. Chave desconhecida, ao contrario, e descartada
  // em silencio: e leitura de dado guardado, e ali a regra e a oposta a da
  // entrada vinda de humano (§11.3, passo 6), para que uma versao futura possa
  // acrescentar campo sem quebrar o botao de quem ainda nao atualizou.
  const estado: Record<string, unknown> = {}
  for (const campo of CAMPOS_DE_COMPORTAMENTO) {
    const valor = objeto[campo]
    if (valor === undefined) return null
    if (campo === 'triggerKeywords') {
      if (!Array.isArray(valor) || valor.some((item) => typeof item !== 'string')) return null
    }
    estado[campo] = valor
  }

  // O julgamento de VALOR continua sendo do validador unico, no momento da
  // gravacao, com a allowlist de hoje: aqui so se confere a FORMA.
  return estado as unknown as EstadoDeComportamento
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
  /** Campos do corpo que nao sao configuracao, alem de `csrf` e `versao`. */
  readonly estruturais?: readonly string[]
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

  // Passo 8. Enquanto nao existe verificador de step-up, a mudanca protegida e
  // RECUSADA — nunca aceita em silencio. Ela vem ANTES da recusa por campo nao
  // gravavel porque §10.10 e explicito: se qualquer campo do lote exige
  // step-up, o lote inteiro exige.
  const protegidos = camposProtegidos(mudados, antes, depois)
  if (protegidos.length > 0) {
    return await recusa.registrar({
      acao: 'stepup_recusado',
      campos: protegidos,
      codigo: 'step_up_necessario',
      motivoInterno: 'campo_protegido',
      explicacao: html`${recusaComMotivoUnico(protegidos, RECUSA_SEM_VALOR.protegido)}${await rascunho(
        false,
      )}`,
    })
  }

  const foraDoEscopo = mudados.filter((campo) => !CAMPOS_GRAVAVEIS.includes(campo))
  if (foraDoEscopo.length > 0) {
    return await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: foraDoEscopo,
      codigo: 'dados_invalidos',
      motivoInterno: 'campo_nao_gravavel',
      explicacao: html`${recusaComMotivoUnico(foraDoEscopo, RECUSA_SEM_VALOR.naoGravavel)}${await rascunho(
        false,
      )}`,
    })
  }

  // §10.12: religar exige sessao, ficha E confirmacao explicita na tela. A
  // conferencia mora aqui, e nao em `handleChave`, porque `enabled` e campo
  // gravavel e qualquer formulario do painel pode carrega-lo.
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

  // Passo 7, com a allowlist de HOJE — inclusive na restauracao (§9.9).
  const { mediaScope: _escopo, ...semEscopo } = depois
  const candidata: AutomationConfig = {
    ...semEscopo,
    // `allowedMediaIds` e derivado e nao gravavel (§9.4): ele passa intacto.
    allowedMediaIds: [...snapshot.global.allowedMediaIds],
  }
  const validacao = validarConfigComAllowlist(candidata, lerAllowlist(env.ALLOWED_LINK_DOMAINS))
  if (!validacao.ok) {
    return await recusa.registrar({
      acao: 'mudanca_recusada',
      campos: validacao.achados.map((achado) => achado.campo),
      codigo: codigoDaRecusaDeValidacao(validacao.achados),
      motivoInterno: validacao.achados[0]?.codigo,
      // A frase de §12.4 de CADA achado, e nao a `mensagem` do validador: aquela
      // e escrita para quem instala o projeto e usa palavras que a tela nao
      // escreve. O dicionario traduz pelo `codigo`.
      // O rascunho volta aqui tambem, e este e o caso que mais dói: perder vinte
      // palavras digitadas num celular porque uma delas ficou curta demais e
      // pior do que perde-las por causa de uma aba aberta em outro aparelho.
      explicacao: html`${blocoDaRecusa(
        validacao.achados.map((achado) => ({
          campo: achado.campo,
          motivo: motivoDaRecusa(achado.codigo),
        })),
      )}${await rascunho(false)}`,
    })
  }

  // Passo 9. UM `db.batch()`, com a linha global e a auditoria dentro, nesta
  // ordem (§8.8). Se qualquer metade falhar, as duas falham: sem log, sem
  // mudanca — e nada de "grava e depois tenta logar".
  const versaoResultante = snapshot.versao + 1
  const resultado = await env.DB.batch([
    new PainelConfigRepository(env.DB).statementDeGravacao(now, comoLinha(depois), versaoEnviada),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro(
      {
        ocorridoEm: now,
        versao: versaoResultante,
        origem: 'painel',
        ator: recusa.ator,
        stepUp: false,
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
  ])

  // §8.8: `meta.changes === 0` e a trava otimista tendo agido entre a leitura e
  // o lote. Divergencia vira erro duro na tela, nunca sucesso silencioso.
  if ((resultado[0]?.meta.changes ?? 0) === 0) return erro('versao_desatualizada', contexto)

  // Sem isto o isolate que acabou de gravar continuaria servindo o snapshot
  // antigo ate o TTL vencer, e a tela mostraria o valor de ANTES logo depois de
  // o dono salvar — o jeito mais rapido de destruir a confianca dele.
  invalidarCacheDeConfig()

  return redirecionar(`${pedido.para}?ok=${pedido.confirmacao}`)
}

/** O nome veio do corpo e e um campo de comportamento conhecido? */
function ehCampoDeComportamento(nome: string): nome is CampoDaConfig {
  return (CAMPOS_DE_COMPORTAMENTO as readonly string[]).includes(nome)
}

/**
 * Passos 5 e 6 de §11.3: o corpo vira o pedaco de estado que ele carrega.
 *
 * **Campo ausente NAO e campo apagado**: ele significa "esta gravacao nao mexe
 * nisso". E o que permite tres formularios diferentes usarem o mesmo funil sem
 * que a tela de Palavras apague os ajustes de quem nunca abriu Ajustes.
 *
 * Campo DESCONHECIDO, ao contrario, e recusa: na entrada vinda de humano,
 * estranheza e erro de digitacao ou cliente adulterado (§11.3, passo 6). Na
 * leitura do banco a regra e a oposta — coluna desconhecida e descartada em
 * silencio, para compatibilidade com versoes futuras.
 */
function lerPatchDoCorpo(
  campos: URLSearchParams,
  estruturaisDaRota: readonly string[],
): { patch: PatchDeEstado } | { recusa: string } {
  const estruturais = new Set([...ESTRUTURAIS_DE_TODA_ROTA, ...estruturaisDaRota])
  let patch: PatchDeEstado = {}

  for (const [nome, bruto] of campos) {
    if (estruturais.has(nome)) continue
    if (!ehCampoDeComportamento(nome)) return { recusa: 'campo_desconhecido' }

    const pedaco = lerCampo(nome, bruto)
    if (pedaco === null) return { recusa: 'valor_invalido' }
    patch = { ...patch, ...pedaco }
  }

  return { patch }
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
