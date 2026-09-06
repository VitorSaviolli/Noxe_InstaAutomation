/**
 * O dicionario de traducao do painel: nome tecnico -> frase em portugues.
 *
 * Ele existe porque §12.1 nao pede "linguagem simples" como estilo: pede uma
 * lista fechada de palavras que a tela **nunca** escreve, e o par de cada uma
 * delas. Sem um lugar unico, cada tela inventaria a propria traducao de
 * `matchMode` e o painel falaria cinco portugueses diferentes — que e a mesma
 * classe de defeito que "um nome por conceito" mata do lado do codigo.
 *
 * **A trava mais forte deste arquivo e de tipo, e nao de teste.**
 * `NOME_DO_CAMPO` e um `Record<CampoDaConfig, string>` derivado de
 * `AutomationConfig`: um campo novo em `src/config.ts` quebra o `tsc` aqui,
 * antes de qualquer teste rodar. Um `Record<string, string>` deixaria o campo
 * novo aparecer na tela com o nome tecnico e ninguem saberia.
 *
 * `allowedMediaIds` esta EXCLUIDO de proposito: ele nao e campo gravavel — e
 * derivado das linhas ativas de `painel_midias` (§9.4). O gravavel e
 * `mediaScope`, que nao existe em `AutomationConfig` e por isso entra a mao.
 */
import type { AutomationConfig, MatchMode } from '../../config'
import type { OrigemConfig } from '../../services/config-store'

/**
 * Os campos que o dono ve e edita.
 *
 * `Exclude` e `|` sao a definicao inteira: nada aqui e escrito duas vezes, e o
 * dia em que `AutomationConfig` ganhar um campo este tipo cresce sozinho e o
 * `Record` abaixo para de compilar.
 */
export type CampoDaConfig = Exclude<keyof AutomationConfig, 'allowedMediaIds'> | 'mediaScope'

/** Os dois valores de `media_scope` no banco (§9.4). */
export type EscopoDeMidias = 'todas' | 'selecionadas'

/**
 * O nome de cada campo na lingua do dono.
 *
 * Sao NOMES, e nao frases: eles entram no meio de uma sentenca ("o campo
 * **intervalo por pessoa** esta com um valor que nao da para entender"), entao
 * comecam em minuscula, nao levam artigo e nao levam ponto. Um "o" na frente
 * de "link" viraria "o campo o link" na unica frase que §12.6 escreve inteira.
 */
export const NOME_DO_CAMPO: Record<CampoDaConfig, string> = {
  enabled: 'automação ligada ou desligada',
  triggerKeywords: 'palavras que ligam a automação',
  matchMode: 'como o comentário é comparado',
  caseSensitive: 'maiúsculas e minúsculas',
  normalizeAccents: 'acentos',
  ignorePunctuation: 'pontuação e emojis',
  processOnlyReels: 'onde a automação responde',
  mediaScope: 'em quais Reels a automação responde',
  publicReplyEnabled: 'resposta no comentário',
  publicReplyText: 'texto da resposta no comentário',
  privateReplyEnabled: 'Direct',
  privateReplyText: 'texto do Direct',
  destinationUrl: 'link',
  userCooldownHours: 'intervalo por pessoa',
}

/**
 * Os dois modos de comparacao, com as frases de §3.
 *
 * `exact` e `contains` sao palavras em ingles e §12.1 as proibe na tela. Elas
 * continuam sendo os valores do banco — o dicionario e a fronteira entre os
 * dois vocabularios, e e por isso que ele mora numa rota e nao no `config.ts`.
 */
export const MODO_DE_COMPARACAO: Record<MatchMode, string> = {
  exact: 'O comentário tem que ser só isso',
  contains: 'Basta aparecer no meio do comentário',
}

/** As duas opcoes da tela de Reels, com as frases de §3. */
export const ESCOPO_DE_MIDIAS: Record<EscopoDeMidias, string> = {
  todas: 'Em todos os meus Reels',
  selecionadas: 'Só nos que eu escolher',
}

/**
 * De onde os ajustes que estao valendo vieram.
 *
 * Entra no meio de uma frase ("seus ajustes hoje sao <isto>"), por isso em
 * minuscula. `versao: 0` NAO e usada para distinguir nada: a sentinela e
 * ambigua (Ruling 22) e `origem` e explicita.
 */
export const ORIGEM_DOS_AJUSTES: Record<OrigemConfig, string> = {
  arquivo: 'os que vieram no programa',
  banco: 'os que você salvou por aqui',
  parado_por_erro: 'os de segurança, porque os salvos não puderam ser lidos',
}

/**
 * Uma data em portugues, `dd/mm/aaaa`, a partir do epoch em milissegundos.
 *
 * **So a data, sem a hora, e a ausencia e decisao.** O Worker roda em UTC e o
 * fuso da instalacao nao esta em lugar nenhum do contrato de ambiente: uma hora
 * escrita em UTC estaria tres horas errada para quem le no Brasil, e uma hora
 * errada numa tela que existe para explicar e pior que nenhuma hora. A data
 * responde a pergunta que a tela faz — "desde quando?" — e so erra na virada da
 * meia-noite. Quando a tela de "O que aconteceu" precisar de hora, o fuso vira
 * dado de ambiente e esta funcao ganha o par dela.
 */
export function dataEmPortugues(epochMs: number): string {
  const data = new Date(epochMs)
  const dia = String(data.getUTCDate()).padStart(2, '0')
  const mes = String(data.getUTCMonth() + 1).padStart(2, '0')
  return `${dia}/${mes}/${data.getUTCFullYear()}`
}

/**
 * As frases da faixa verde, e a lista FECHADA de codigos de `?ok=` (§7.1).
 *
 * `POST /painel/<tela>` grava e responde `303` para `GET
 * /painel/<tela>?ok=<codigo>`; a faixa verde nasce desse `?ok=`. A tela NUNCA
 * escreve na pagina o que veio da query string — ela procura o codigo AQUI e
 * mostra a frase daqui. Um `?ok=` desconhecido nao mostra faixa nenhuma, e e
 * essa consulta a uma tabela fechada, e nao um escape, que impede a query
 * string de virar conteudo da pagina.
 *
 * `sem_mudanca` existe porque reenviar o mesmo formulario NAO grava (§9.9
 * registra gravacao, e um reenvio identico nao e uma) e a pessoa precisa saber
 * que o botao funcionou.
 */
export const CONFIRMACOES = {
  salvo: 'Pronto, salvo. Já está valendo.',
  ligada: 'A automação está ligada de novo.',
  desligada: 'A automação está desligada. Nada do que você salvou foi perdido.',
  sem_mudanca: 'Nada mudou: o que você enviou já era o que estava salvo.',
} as const

export type CodigoDeConfirmacao = keyof typeof CONFIRMACOES

/** A frase daquele `?ok=`, ou `null` quando o codigo nao e da lista. */
export function fraseDeConfirmacao(codigo: string | null): string | null {
  if (codigo === null) return null
  return Object.hasOwn(CONFIRMACOES, codigo) ? CONFIRMACOES[codigo as CodigoDeConfirmacao] : null
}

/** Os quatro campos booleanos que a tela explica com uma frase inteira. */
export type CampoDeComparacao =
  | 'caseSensitive'
  | 'normalizeAccents'
  | 'ignorePunctuation'
  | 'processOnlyReels'

/**
 * A frase que descreve o valor ATUAL de cada chave de comparacao.
 *
 * Duas frases por campo, e nao um "Ligado"/"Desligado": `caseSensitive: false`
 * quer dizer "tanto faz maiuscula ou minuscula", e escrever "desligado" ao
 * lado de "maiusculas e minusculas" deixaria a pessoa adivinhando o que fica
 * desligado. Estado NUNCA so por cor, e tambem nunca so por um sim/nao que
 * exige interpretar o nome do campo (§12.9).
 *
 * **As chaves sao `verdadeiro` e `falso`, e nao `sim` e `nao`.** A primeira
 * grafia deste dicionario usava `sim`/`nao` com um significado que MUDAVA de
 * campo para campo: em `caseSensitive`, `sim` era a frase de `true`; em
 * `normalizeAccents` e `ignorePunctuation`, era a de `false`, e cada tela
 * compensava com um ternario invertido. A saida saia certa e a FORMA era uma
 * armadilha — quem escrevesse o obvio, `config.X ? sim : nao`, imprimiria o
 * contrario da verdade em dois dos quatro campos. Numa tela que existe para
 * explicar a automacao, "uma explicacao que mente e pior do que nenhuma".
 * Agora a chave e o proprio booleano, e o ternario sumiu de todas as telas:
 * quem le usa `fraseDoAjuste(campo, config)`.
 */
export const FRASE_DO_AJUSTE: Record<
  CampoDeComparacao,
  { readonly verdadeiro: string; readonly falso: string }
> = {
  caseSensitive: {
    verdadeiro: 'A automação diferencia maiúscula de minúscula.',
    falso: 'Tanto faz escrever com maiúscula ou com minúscula.',
  },
  normalizeAccents: {
    verdadeiro: 'Escrever sem acento conta igual: “querô” vale por “quero”.',
    falso: 'Um comentário sem acento não conta como um com acento.',
  },
  ignorePunctuation: {
    verdadeiro: 'Pontuação e emojis são ignorados na comparação.',
    falso: 'A pontuação e os emojis contam na comparação.',
  },
  processOnlyReels: {
    verdadeiro: 'A automação responde só nos Reels.',
    falso: 'A automação responde em qualquer publicação.',
  },
}

/**
 * A frase daquele campo, para a configuracao que esta valendo.
 *
 * Existe para que NENHUMA tela escreva o ternario: um ternario por chamada e
 * uma chance por chamada de inverter, e foi exatamente o que aconteceu antes.
 */
export function fraseDoAjuste(campo: CampoDeComparacao, config: AutomationConfig): string {
  return config[campo] ? FRASE_DO_AJUSTE[campo].verdadeiro : FRASE_DO_AJUSTE[campo].falso
}

/**
 * Os prefixos de `avisos` que NAO sao campo de configuracao.
 *
 * `carregarConfigEfetiva` devolve avisos no formato `"<prefixo>: <frase
 * tecnica>"`. Quase todo prefixo e um campo, e cai em `NOME_DO_CAMPO`; estes
 * dois sao o resto, e sem eles a tela mostraria o nome de uma tabela do banco.
 */
const AVISO_SEM_CAMPO: Record<string, string> = {
  banco: 'Não conseguimos ler os seus ajustes salvos agora.',
  painel_midias:
    'Encontramos escolhas de Reels sem ajustes salvos. Elas estão sendo ignoradas até você salvar seus ajustes uma vez.',
}

/** O prefixo de um aviso, que e o que vem antes do primeiro `:`. */
function prefixoDoAviso(aviso: string): string {
  const corte = aviso.indexOf(':')
  return corte === -1 ? aviso : aviso.slice(0, corte)
}

/**
 * O nome do campo que aquele aviso acusa, ou `null` quando o aviso nao e sobre
 * um campo.
 *
 * E o que permite a tela **nomear o campo** no estado cinza de parada por erro
 * (§12.6) em vez de dizer "algum ajuste".
 */
export function nomeDoCampoDoAviso(aviso: string): string | null {
  const prefixo = prefixoDoAviso(aviso)
  return Object.hasOwn(NOME_DO_CAMPO, prefixo) ? NOME_DO_CAMPO[prefixo as CampoDaConfig] : null
}

/**
 * Um aviso do validador vira uma frase que o dono entende.
 *
 * A `mensagem` tecnica do achado NAO vai para a tela, e a omissao e decisao:
 * ela carrega "placeholders", "palavras-gatilho" e "normalizacao", tres
 * palavras que §12.1 proibe. O que a tela precisa e o CAMPO — e §12.6 escreve
 * exatamente esta frase. O detalhe tecnico continua no `console`, onde
 * `config-store.ts` ja o publica, e e la que quem instalou vai ler.
 */
export function traduzirAviso(aviso: string): string {
  const campo = nomeDoCampoDoAviso(aviso)
  if (campo !== null) {
    return `O campo ${campo} está com um valor que não dá para entender. Corrija esse campo e a automação volta.`
  }

  const generico = AVISO_SEM_CAMPO[prefixoDoAviso(aviso)]
  return generico ?? 'Um dos seus ajustes está com um valor que não dá para entender.'
}

/**
 * As palavras que a tela NUNCA escreve (§12.1 regra 1, §12.7).
 *
 * A lista e o lado esquerdo do glossario obrigatorio, mais as tres de §7.8 que
 * sao proibidas no projeto inteiro. Ela existe em codigo, e nao so no
 * documento, porque um laco de teste consegue percorrer as cinco telas e
 * falhar no dia em que uma delas escrever "cooldown" — e nenhuma revisao
 * humana faz isso toda vez.
 *
 * Sao comparadas com fronteira de palavra: proibir a SUBSTRING "api" reprovaria
 * "rapidamente", e um teste que reprova portugues correto e um teste que a
 * equipe aprende a desligar.
 */
export const PALAVRAS_PROIBIDAS: readonly string[] = [
  'override',
  'overrides',
  'config',
  'endpoint',
  'endpoints',
  'media id',
  'media ids',
  'media scope',
  'placeholder',
  'placeholders',
  'step-up',
  'stepup',
  'rate limit',
  'fallback',
  'payload',
  'token',
  'tokens',
  'hash',
  'envelope',
  'assinatura',
  'passkey',
  'passkeys',
  'webauthn',
  'credencial',
  'credenciais',
  'allowlist',
  'cooldown',
  'auditoria',
  'log',
  'logs',
  'api',
  'deploy',
  'exact',
  'contains',
]

/**
 * Qual das duas opcoes de Reels esta valendo, lida do snapshot.
 *
 * `mediaScope` NAO existe em `AutomationConfig`: o que existe la e
 * `allowedMediaIds`, que e o campo DERIVADO (§9.4). A traducao de volta mora
 * aqui, num lugar so, porque tres telas precisam dela e cada uma escrevendo o
 * proprio `includes('*')` seria a mesma regra em tres grafias.
 */
export function escopoDeMidias(config: AutomationConfig): EscopoDeMidias {
  return config.allowedMediaIds.includes('*') ? 'todas' : 'selecionadas'
}
