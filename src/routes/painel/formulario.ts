/**
 * O vocabulario do FORMULARIO do painel: o que a tela escreve e o funil le.
 *
 * Ele nasceu dentro de `gravar.ts` e saiu na etapa do step-up, quando aquele
 * arquivo passou de 843 linhas — 43 acima do teto de 800 deste repositorio.
 * A separacao nao e so de tamanho: sao duas perguntas diferentes, e tres telas
 * ja importavam a segunda sem precisar da primeira.
 *
 *   `gravar.ts`      — "como o painel grava": a ordem de §11.3, a trava
 *                      otimista, a classificacao de risco e o lote atomico
 *   este arquivo     — "que forma tem o corpo daquele formulario": o estado de
 *                      comportamento, os nomes de campo, e o par leitor /
 *                      codificador de cada valor
 *
 * **O par leitor/codificador e a razao de ele ser UM arquivo.** `lerCampo` le e
 * `valorDeFormulario` escreve, e os dois formam um par: um codificador que
 * escrevesse `true`/`false` enquanto o leitor espera `sim`/`nao` faria o botao
 * "Voltar a esta versao" recusar todo restauro, e o defeito apareceria so no dia
 * em que alguem apertasse o botao. Separados em dois arquivos, a divergencia
 * teria onde se esconder.
 *
 * **Nunca conserta.** `null` de um leitor significa RECUSA, e nunca "usa o
 * padrao": um valor que nao casa e cliente adulterado ou erro de digitacao, e
 * §9.2 proibe conserto nas duas hipoteses.
 */
import type { AutomationConfig, MatchMode } from '../../config'
import { MAX_HORAS_DE_COOLDOWN } from '../../services/config-validation'
import {
  type CampoDaConfig,
  type EscopoDeMidias,
  escopoDeMidias,
  NOME_DO_CAMPO,
} from './dicionario'
import { CAMPO_DA_CONFIRMACAO, CAMPO_DA_DIGITAL, CAMPO_DA_FICHA, CAMPO_DA_VERSAO } from './guardas'

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

/**
 * Os campos que a **restauracao** pode reescrever (Ruling 74).
 *
 * §9.9 diz o que o botao "Voltar a esta versao" atravessa, e a lista e fechada:
 * "o mesmo validador, o **mesmo step-up** e a allowlist de hoje", com UMA recusa
 * sancionada — se a allowlist encolheu. A lista de campos por ROTA (Ruling 70)
 * seria um quarto portao que a spec nao nomeia, recusando por um motivo que ela
 * nao sanciona: uma vez que o link tivesse mudado, toda linha de historico
 * anterior aquela mudanca ficava irrestauravel, **inclusive as que eram sobre
 * palavra-gatilho**.
 *
 * Entao a restauracao e uma **operacao declarada** — `acao=restaurar`, como
 * `acao=ligar|desligar` de §7.1 —, e o escopo dela e a uniao gravavel inteira.
 * A protecao continua sendo onde §9.9 a poe: mesmo validador, mesmo step-up
 * preso ao conteudo, allowlist de hoje. Para campo protegido a defesa e a tela
 * de conferencia mais o `op_hash`, que mostram o valor literal antes do gesto;
 * para campo nao protegido, escrever pela tela errada nao ganha privilegio
 * nenhum.
 *
 * **Esta lista tem de ser exatamente a UNIAO das listas das quatro rotas de
 * gravacao**, e um metateste afirma isso (META-10, Ruling 72). Sem ele, a
 * garantia do Ruling 68 — `mediaScope` nao e gravavel nesta etapa — dependeria
 * de as quatro listas a omitirem, e so uma delas estava sob teste.
 */
export const CAMPOS_DA_RESTAURACAO: readonly CampoDaConfig[] = [
  'enabled',
  'triggerKeywords',
  'matchMode',
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'processOnlyReels',
  'publicReplyText',
  'privateReplyText',
  'destinationUrl',
  'userCooldownHours',
]

/**
 * Os campos que NENHUMA rota grava nesta etapa.
 *
 * `mediaScope` espera a tela que e dona dele (Ruling 68); os dois interruptores
 * de canal esperam um formulario que os emita. A lista existe para o botao de
 * restaurar poder ser honesto: uma versao que difere em qualquer um deles nao
 * tem como voltar inteira, e §12.4 nao admite botao que promete e nao cumpre.
 */
export const CAMPOS_FORA_DA_RESTAURACAO: readonly CampoDaConfig[] = CAMPOS_DE_COMPORTAMENTO.filter(
  (campo) => !CAMPOS_DA_RESTAURACAO.includes(campo),
)

/** O estado de comportamento de uma configuracao efetiva. */
export function estadoDaConfig(config: AutomationConfig): EstadoDeComportamento {
  const { allowedMediaIds: _derivado, ...comportamento } = config
  return { ...comportamento, mediaScope: escopoDeMidias(config) }
}

/**
 * Aquela versao guardada volta INTEIRA pelo botao? (Ruling 74, R-6)
 *
 * Ela volta quando nao difere de hoje em nenhum campo que ninguem grava. Se
 * diferir, o botao **nao sai** — e a linha diz por que —, porque um botao que
 * restaura pela metade e o mesmo tipo de promessa quebrada que §12.4 recusa.
 */
export function restauracaoPossivel(
  guardado: EstadoDeComportamento,
  hoje: EstadoDeComportamento,
): boolean {
  return CAMPOS_FORA_DA_RESTAURACAO.every((campo) => guardado[campo] === hoje[campo])
}

// ---------------------------------------------------------------------------
// A leitura do formulario
// ---------------------------------------------------------------------------
/** Os dois valores que um campo de sim/nao aceita. Nada mais casa (§11.3). */
const SIM = 'sim'
const NAO = 'nao'

/** O valor que o campo de confirmacao precisa carregar. */
export const CONFIRMADO = 'sim'

/**
 * Os dois valores de `matchMode` NO FORMULARIO.
 *
 * `exact` e `contains` sao as palavras do BANCO, e §12.1 as proibe na tela —
 * proibicao que alcanca o atributo `value`, porque ele esta no HTML que o
 * metateste das palavras proibidas varre. E exatamente a mesma razao de os
 * booleanos viajarem como `sim`/`nao` em vez de `true`/`false`.
 *
 * A conferencia deixou de ser teorica quando `matchMode` virou campo editavel
 * (Ruling 65): antes dele, a unica ocorrencia de `exact` no HTML vinha dos
 * campos escondidos do botao "Voltar a esta versao", e so aparecia quando havia
 * historico — uma armadilha que o metateste nao alcancava.
 *
 * O par leitor/codificador e um so, como o de `sim`/`nao`: `lerModo` le e
 * `valorDeFormulario` escreve, os dois a partir desta tabela.
 */
export const MODO_NO_FORMULARIO = {
  exact: 'so_isso',
  contains: 'no_meio',
} as const satisfies Record<MatchMode, string>

/**
 * Os campos do corpo que NAO sao configuracao.
 *
 * A ficha do passo 7 (`CAMPO_DA_FICHA`, de `guardas.ts`, onde ela e conferida),
 * a versao do passo 9, a confirmacao de §10.12 — que vale para TODA rota, e nao
 * so para `/painel/chave`, porque religar por um formulario de restauracao e
 * religar do mesmo jeito — e a digital do passo 8. Cada rota acrescenta os seus:
 * `/painel/chave` acrescenta `acao`.
 *
 * `digital` esta aqui por duas razoes que se somam: sem ela o funil recusaria o
 * proprio formulario da tela de conferencia como campo desconhecido, e com ela
 * o rascunho que volta numa recusa **nao** carrega a assertion ja usada.
 */
export const ESTRUTURAIS_DE_TODA_ROTA: readonly string[] = [
  CAMPO_DA_FICHA,
  CAMPO_DA_VERSAO,
  CAMPO_DA_CONFIRMACAO,
  CAMPO_DA_DIGITAL,
]

/** O campo `versao` do formulario, ou `null` quando ele nao presta. */
export function lerVersao(campos: URLSearchParams): number | null {
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
export function religa(antes: EstadoDeComportamento, depois: EstadoDeComportamento): boolean {
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
      return lerModo(bruto)

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

/** O modo de comparacao que aquele valor de formulario nomeia, ou `null`. */
function lerModo(bruto: string): PatchDeEstado | null {
  for (const [modo, valor] of Object.entries(MODO_NO_FORMULARIO)) {
    if (bruto === valor) return { matchMode: modo as MatchMode }
  }
  return null
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
  if (campo === 'matchMode') return MODO_NO_FORMULARIO[estado.matchMode]
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
export function lerPatchDoCorpo(
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
