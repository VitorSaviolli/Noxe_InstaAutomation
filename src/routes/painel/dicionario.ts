/**
 * O dicionario de traducao do painel: nome tecnico -> frase em portugues.
 *
 * Ele existe porque §12.1 nao pede "linguagem simples" como estilo: pede uma
 * lista fechada de palavras que a tela **nunca** escreve, e o par de cada uma
 * delas. Sem um lugar unico, cada tela inventaria a propria traducao de
 * `matchMode` e o painel falaria cinco portugueses diferentes, que e a mesma
 * classe de defeito que "um nome por conceito" mata do lado do codigo.
 *
 * **A trava mais forte deste arquivo e de tipo, e nao de teste.**
 * `NOME_DO_CAMPO` e um `Record<CampoDaConfig, string>` derivado de
 * `AutomationConfig`: um campo novo em `src/config.ts` quebra o `tsc` aqui,
 * antes de qualquer teste rodar. Um `Record<string, string>` deixaria o campo
 * novo aparecer na tela com o nome tecnico e ninguem saberia.
 *
 * `allowedMediaIds` esta EXCLUIDO de proposito: ele nao e campo gravavel, e
 * derivado das linhas ativas de `painel_midias` (§9.4). O gravavel e
 * `mediaScope`, que nao existe em `AutomationConfig` e por isso entra a mao.
 */
import type { AutomationConfig, MatchMode } from '../../config'
import type { CommentStatus } from '../../repositories/comments-repository'
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
  triggerKeywords: 'palavras',
  matchMode: 'como o comentário é comparado',
  caseSensitive: 'maiúsculas e minúsculas',
  normalizeAccents: 'acentos',
  ignorePunctuation: 'pontuação e emojis',
  processOnlyReels: 'tipo de publicação',
  mediaScope: 'quais Reels',
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
 * continuam sendo os valores do banco, o dicionario e a fronteira entre os
 * dois vocabularios, e e por isso que ele mora numa rota e nao no `config.ts`.
 */
export const MODO_DE_COMPARACAO: Record<MatchMode, string> = {
  exact: 'O comentário tem que ser só a palavra',
  contains: 'Basta a palavra aparecer no comentário',
}

/** As duas opcoes da tela de Reels, com as frases de §3. */
export const ESCOPO_DE_MIDIAS: Record<EscopoDeMidias, string> = {
  todas: 'Todos os meus Reels',
  selecionadas: 'Só os que eu marcar',
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
 * responde a pergunta que a tela faz, "desde quando?", e so erra na virada da
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
 * escreve na pagina o que veio da query string, ela procura o codigo AQUI e
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
  // Os tres da Etapa 13. `saiu_de_tudo` e `saiu` sao os dois `?ok=` que NAO sao
  // lidos pela tela que recebeu o POST: as duas acoes de sair apagam a propria
  // sessao de quem apertou, entao um `303` para `/painel/aparelhos` cairia no
  // `303` do passo 6 da escada e a frase morreria no caminho. Os dois apontam
  // para `/painel/entrar`, que e a tela onde a pessoa esta a partir daquele
  // instante, e e la que a frase precisa aparecer para o gesto nao parecer
  // uma falha (§10.13).
  //
  // As frases sao DIFERENTES de proposito: quem sai deste aparelho precisa
  // saber que os outros continuam dentro, e quem saiu de todos precisa saber
  // que derrubou tambem o proprio celular. Uma frase so para as duas acoes
  // apagaria justamente a diferenca entre elas (§10.8, §10.13).
  aparelho_removido: 'Pronto, o aparelho foi removido. Ele não entra mais neste painel.',
  saiu: 'Você saiu deste aparelho. Os outros aparelhos continuam entrando normalmente.',
  saiu_de_tudo: 'Você saiu de todos os aparelhos. Entre de novo quando quiser.',
  // O unico `?ok=` que e um AVISO, e nao uma confirmacao: religar pelo Inicio
  // sem marcar a caixa volta para o Inicio com esta faixa (§10.12).
  marque_a_caixa: 'Marque a caixa antes de ligar.',
} as const

/** Os codigos de `?ok=` que pintam a faixa de aviso em vez da verde. */
export const AVISOS_DE_RESULTADO: readonly CodigoDeConfirmacao[] = ['marque_a_caixa']

export type CodigoDeConfirmacao = keyof typeof CONFIRMACOES

/** A frase daquele `?ok=`, ou `null` quando o codigo nao e da lista. */
export function fraseDeConfirmacao(codigo: string | null): string | null {
  if (codigo === null) return null
  return Object.hasOwn(CONFIRMACOES, codigo) ? CONFIRMACOES[codigo as CodigoDeConfirmacao] : null
}

/**
 * Por que aquele campo foi recusado, na lingua do dono (§12.4).
 *
 * A chave e o `codigo` do achado do validador, e nao a `mensagem` dele. A
 * diferenca importa: a `mensagem` do validador e escrita para quem instala o
 * projeto, ela diz "no modo contains", "placeholders", "normalizacao", e
 * `contains` e `placeholder` estao na lista de palavras que a tela NUNCA
 * escreve. Traduzir pelo codigo mantem o validador com uma linguagem so, a tela
 * com outra, e o dicionario como a unica fronteira entre as duas.
 *
 * Os textos sao os da tabela de §12.4, palavra por palavra. Onde §12.4 escreve
 * a palavra do dono entre aspas, a frase aqui e generica: o valor recusado NAO
 * volta para a tela por este caminho, ele volta no formulario, que e onde a
 * pessoa o ve no contexto em que o digitou.
 */
export const MOTIVO_DA_RECUSA: Record<string, string> = {
  gatilho_curto:
    'Esta palavra é curta demais para o modo que está valendo. Escreva mais letras, no modo “basta a palavra aparecer no comentário”, pelo menos duas palavras.',
  gatilho_longo: 'Esta frase é longa demais. Use no máximo 40 letras.',
  gatilho_vazio:
    'Isto não vai funcionar nunca. A automação ignora emojis e pontuação ao comparar, então esta palavra fica vazia e é pulada em silêncio.',
  gatilho_duplicado: 'Duas palavras ficam iguais na hora de comparar. Apague uma delas.',
  gatilhos_demais: 'Você chegou a 20 palavras, o máximo. Apague uma para adicionar outra.',
  lista_vazia_com_automacao_ligada:
    'Sem nenhuma palavra a automação nunca responde. Ou escreva pelo menos uma, ou desligue, as duas são seguras, mas só uma fica clara no seu painel.',
  nao_e_lista_de_texto: 'Não conseguimos entender a lista de palavras que chegou.',
  cooldown_fora_da_faixa: 'A espera precisa ser um número inteiro de horas, de 0 até 8760.',
  nao_e_booleano: 'Este ajuste só aceita sim ou não.',
  // A frase antiga escrevia "na lista liberada no deploy", e "deploy" esta em
  // `PALAVRAS_PROIBIDAS`. Ela atravessou tres etapas porque DIC-02 varria cinco
  // das dez tabelas do dicionario e esta ficava na metade nao varrida.
  dominio_nao_permitido:
    'Este endereço não está na lista de endereços liberados. Quem muda essa lista é quem publicou o projeto, no computador.',
  // --- Os Reels (§12.5) ---
  reel_desconhecido:
    'Este Reel não é da sua conta, ou não existe mais. Toque em Atualizar lista e escolha de novo.',
  reel_repetido: 'Você marcou o mesmo Reel duas vezes. Marque uma só.',
  reels_demais: 'Você chegou a 200 Reels, o máximo. Desmarque algum para escolher outro.',
  reels_novos_demais:
    'Marque até 20 Reels novos por vez. Salve estes e continue, o que já estava escolhido continua valendo.',
  selecao_vazia_com_automacao_ligada:
    'Você escolheu “só os que eu marcar” e não marcou nenhum Reel. Ou marque pelo menos um, ou desligue a automação, as duas são seguras, mas só uma fica clara no seu painel.',
  listagem_indisponivel:
    'Não conseguimos falar com o Instagram agora, então não dá para salvar a sua escolha de Reels. A sua automação continua funcionando normalmente com os Reels que você já tinha escolhido.',
  reel_nao_pode_ligar:
    'Um Reel só pode ficar parado, nunca ligado por conta própria: quem manda é o botão Desligar a automação, no Início, e é ele que desliga tudo de uma vez.',
}

/** O motivo daquele codigo, ou a frase geral quando ele nao esta na tabela. */
export function motivoDaRecusa(codigo: string): string {
  return (
    MOTIVO_DA_RECUSA[codigo] ??
    'Este valor não é aceito. Confira o que você escreveu e tente de novo.'
  )
}

/**
 * O crachá dos tres sinais de §12.3: cadeado, a palavra "protegido" e a classe
 * que pinta a borda ambar do grupo.
 *
 * **Uma grafia, e as tres telas a usam.** Ele nasceu em `/painel/mensagem` e foi
 * copiado a mao para `/painel/ajustes` e `/painel/palavras` quando aquelas
 * ganharam campo protegido, tres copias sao tres chances de uma delas perder um
 * dos tres sinais, e §12.3 os exige **sempre juntos, nunca so cor**.
 *
 * Aqui mora so a PALAVRA, porque `dicionario.ts` nao conhece a tag `html`. Quem
 * a transforma nos tres sinais e `seloProtegido()`, em `inicio.ts`, a mesma
 * divisao de sempre: a frase no dicionario, a marcacao na tela.
 */
export const SELO_PROTEGIDO = 'protegido'

/**
 * As duas frases que explicam uma recusa que NAO e de valor invalido.
 *
 * Elas moram aqui pelo mesmo motivo que todas as outras: nenhuma frase de tela
 * nasce fora do dicionario. `protegido` e a promessa de §12.3 dita ao
 * contrario, a pessoa tentou aumentar o alcance, e aumentar pede a digital.
 *
 * **`protegido` mudou nesta etapa, e a mudanca e uma divida quitada.** Enquanto
 * o verificador nao existia, ela terminava em "Essa parte do painel chega em
 * seguida", uma frase que prometia uma continuacao que o `403` nao tinha. Agora
 * a continuacao existe logo abaixo dela, na tela de conferencia, e a frase diz
 * o que de fato acontece.
 */
/**
 * Onde cada campo E editavel, para a recusa poder dizer o caminho (Ruling 75).
 *
 * `RECUSA_SEM_VALOR.naoGravavel` dizia "Este ajuste **ainda** nao pode ser
 * mudado por aqui" para tudo o que caia fora da lista da rota, e depois do
 * Ruling 70 isso passou a alcancar campo que ja e editavel, so que em outra
 * tela. "Ainda" e falso para o que existe hoje, e mandar a pessoa esperar por
 * uma tela que ja esta pronta e pior do que nao dizer nada.
 *
 * Quem nao esta em NENHUM dos dois mapas daqui nao e editavel nem visivel em
 * lugar nenhum, e ai a frase com "ainda" e verdadeira.
 */
export const TELA_DO_CAMPO: Partial<Record<CampoDaConfig, string>> = {
  enabled: 'no bot\u00e3o do In\u00edcio',
  triggerKeywords: 'na tela de Palavras',
  matchMode: 'na tela de Palavras',
  caseSensitive: 'em Ajustes',
  normalizeAccents: 'em Ajustes',
  ignorePunctuation: 'em Ajustes',
  processOnlyReels: 'em Ajustes',
  userCooldownHours: 'em Ajustes',
  // A Etapa 12 quitou esta divida: ate ela, `mediaScope` caia na frase que
  // promete "a tela que cuida dele chega em uma proxima parte", e a tela chegou.
  // Frase que mente e defeito, e nao cosmetica (Rulings 75 e 82).
  mediaScope: 'na tela Reels',
  destinationUrl: 'na tela Mensagem',
  privateReplyText: 'na tela Mensagem',
  publicReplyText: 'na tela Mensagem',
}

/**
 * Os campos que uma tela JA MOSTRA, mas ainda so em leitura (Ruling 82).
 *
 * A terceira frase existe porque as outras duas mentiam para estes dois.
 * `RECUSA_SEM_VALOR.naoGravavel` promete que "a tela que cuida dele chega em uma
 * proxima parte", verdade para `mediaScope`, que e a Etapa 12 de §14. Para
 * `publicReplyEnabled` e `privateReplyEnabled` e falso nas duas metades: §3 os
 * poe em "Ajustes finos", tela que JA existe e que ja os mostra ("Direct:
 * Ligado", "Resposta no comentario: Desligada"), e nenhuma etapa de §14 os
 * nomeia. Mandar esperar por uma tela pronta e prometer uma parte que ninguem
 * planejou sao dois enganos diferentes, e quem le a recusa nao tem como
 * descobrir nenhum dos dois.
 *
 * Po-los em `TELA_DO_CAMPO` seria a terceira mentira: o caminho existiria e o
 * botao nao. Eles ficam aqui ate ganharem o interruptor, e ai mudam de mapa.
 */
export const TELA_QUE_SO_MOSTRA: Partial<Record<CampoDaConfig, string>> = {
  publicReplyEnabled: 'em Ajustes',
  privateReplyEnabled: 'em Ajustes',
}

/**
 * Por que aquele campo nao pode ser gravado POR ESTA rota (Ruling 75).
 *
 * Tres frases, e a diferenca importa para quem esta na tela: um campo que mora
 * em outra tela pede o CAMINHO; um campo que uma tela ja MOSTRA sem deixar mudar
 * pede que se diga isso, senao a pessoa vai procurar o botao onde ele nao esta;
 * e um campo que nao aparece em lugar nenhum pede a verdade, que ele ainda nao
 * da para mudar.
 */
export function motivoDeCampoForaDaTela(campo: string): string {
  const naTela = (mapa: Partial<Record<CampoDaConfig, string>>): string | undefined =>
    Object.hasOwn(mapa, campo) ? mapa[campo as CampoDaConfig] : undefined

  const editavel = naTela(TELA_DO_CAMPO)
  if (editavel !== undefined) return `Este ajuste \u00e9 mudado ${editavel}, e n\u00e3o por aqui.`

  // A frase dos que uma tela ja mostra sem deixar mudar (Ruling 82).
  const mostrada = naTela(TELA_QUE_SO_MOSTRA)
  if (mostrada !== undefined) {
    return `Este ajuste aparece ${mostrada}, mas por enquanto s\u00f3 para leitura: ainda n\u00e3o d\u00e1 para lig\u00e1-lo ou deslig\u00e1-lo pelo painel.`
  }

  return RECUSA_SEM_VALOR.naoGravavel
}

export const RECUSA_SEM_VALOR = {
  protegido:
    'Esta mudança pede a sua digital ou o seu rosto: ou ela aumenta o alcance da automação, ou ela troca o que a pessoa recebe. Confira abaixo o que vai mudar e confirme.',
  naoGravavel:
    'Este ajuste ainda não pode ser mudado pelo painel. A tela que cuida dele chega em uma próxima parte.',
  configIlegivel:
    'Não conseguimos ler os seus ajustes salvos, então nada pode ser gravado por aqui até isso ser resolvido. Quem resolve é quem publicou o projeto, no computador.',
} as const

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
 * armadilha, quem escrevesse o obvio, `config.X ? sim : nao`, imprimiria o
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
    verdadeiro: 'Só Reels',
    falso: 'Qualquer publicação',
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

/** Os dois campos de sim/nao que nao tem par de frases proprio. */
const CANAL_LIGADO = 'Ligada, e quem comenta recebe.'
const CANAL_DESLIGADO = 'Desligada, e nada e enviado por aqui.'

/**
 * O valor de UM campo escrito para a tela de conferencia de §10.10.
 *
 * §10.10 exige o **valor literal** antes da biometria, e §12.1 proibe o
 * vocabulario do banco na tela. Os dois convivem porque os campos sao de duas
 * especies: o link e os dois textos SAO texto do dono, e o literal deles e o
 * proprio texto, ele sai como esta, sem recorte e sem reticencias. Os
 * enumerados e os booleanos guardam `exact`, `contains`, `todas`, `0` e `1`, que
 * §12.1 nao deixa escrever, entao o literal deles e a frase que a tela ja usa em
 * todo lugar.
 *
 * As frases vem das MESMAS tabelas que as telas de leitura usam, nao ha uma
 * segunda traducao de `matchMode` nascendo aqui. Um segundo par de frases seria
 * a chance de a tela de conferencia dizer uma coisa e a tela de Ajustes dizer
 * outra sobre o mesmo valor, no exato momento em que a pessoa decide assinar.
 *
 * O valor chega como `unknown` de proposito: o dicionario nao conhece o tipo do
 * estado do funil, e um `import` de volta fecharia um ciclo.
 */
export function valorNaTela(campo: CampoDaConfig, valor: unknown): string {
  switch (campo) {
    case 'matchMode':
      return MODO_DE_COMPARACAO[valor as MatchMode] ?? String(valor)
    case 'mediaScope':
      return ESCOPO_DE_MIDIAS[valor as EscopoDeMidias] ?? String(valor)
    case 'caseSensitive':
    case 'normalizeAccents':
    case 'ignorePunctuation':
    case 'processOnlyReels':
      return valor === true ? FRASE_DO_AJUSTE[campo].verdadeiro : FRASE_DO_AJUSTE[campo].falso
    case 'triggerKeywords':
      return Array.isArray(valor) && valor.length > 0
        ? valor.join(', ')
        : 'Nenhuma palavra, e por isso a automação nunca responde.'
    case 'userCooldownHours':
      return valor === 1 ? '1 hora de espera' : `${String(valor)} horas de espera`
    case 'enabled':
      return valor === true ? 'Ligada' : 'Desligada'
    case 'publicReplyEnabled':
    case 'privateReplyEnabled':
      return valor === true ? CANAL_LIGADO : CANAL_DESLIGADO
    // O link e os dois textos: o literal deles e o proprio texto do dono, sem
    // recorte e sem reticencias, quem vai assinar precisa ler o que assina.
    default:
      return String(valor)
  }
}

/**
 * Os prefixos de `avisos` que NAO sao campo de configuracao.
 *
 * `carregarConfigEfetiva` devolve avisos no formato `"<prefixo>: <frase
 * tecnica>"`. Quase todo prefixo e um campo, e cai em `NOME_DO_CAMPO`; estes
 * dois sao o resto, e sem eles a tela mostraria o nome de uma tabela do banco.
 */
export const AVISO_SEM_CAMPO: Record<string, string> = {
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
 * palavras que §12.1 proibe. O que a tela precisa e o CAMPO, e §12.6 escreve
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
 * falhar no dia em que uma delas escrever "cooldown", e nenhuma revisao
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
  'sessão',
  'sessões',
  'requisição',
  'chave geral',
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
  // Os nomes antigos das telas, que o glossario do painel aposentou: um nome
  // por coisa, e o mesmo na barra, no titulo e nos links.
  'ajustes finos',
  'ver o link',
  'responde diferente',
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

/**
 * As frases das duas telas de Reels (§3 e §12.5).
 *
 * Elas moram aqui pelo mesmo motivo de todas as outras: nenhuma frase de tela
 * nasce fora do dicionario. E ha uma razao a mais nesta tela, §12.5 escreve
 * cinco estados especiais palavra por palavra, e uma tela que os reescrevesse
 * a mao perderia o pedaco que importa em cada um. O pedaco que importa e
 * sempre o mesmo: **a automacao continua funcionando**. Quem abre a tela de
 * Reels e ve um erro precisa saber, na mesma frase, que nada do que ele salvou
 * parou de valer.
 *
 * A palavra "sobreposicao" nao aparece em lugar nenhum (§3), e nem as tres da
 * lista de proibidas que estariam a um passo daqui.
 */
export const TELA_DOS_REELS = {
  titulo: 'Reels',
  /** §12.5, conta sem Reels. */
  semReels:
    'Não encontramos nenhum Reel nesta conta. A automação só responde em Reels. Se você acabou de publicar, espere alguns minutos e toque em Atualizar lista.',
  /** §12.5, Instagram nao respondeu. A segunda metade e a que acalma. */
  metaMuda:
    'Não conseguimos falar com o Instagram agora. A sua automação continua funcionando normalmente com os Reels que você já tinha escolhido.',
  /** §12.5, a lista salva exibida no lugar da listagem que nao veio. */
  salvoPorVoce: 'salvo por você',
  /** §12.5, linha de midia invalida no banco. O campo entra no fim. */
  reelParado: 'Este Reel está parado por um problema na configuração dele:',
  /** §12.5, linhas orfas. A mesma frase que o aviso do validador ja usa. */
  orfas:
    'Encontramos escolhas de Reels sem uma configuração salva. Elas estão sendo ignoradas até você salvar seus ajustes uma vez.',
  /**
   * §12.5, cursor vencido. **NAO RENDERIZADA HOJE**, zero usos em `src/`.
   *
   * Ela e um dos cinco estados especiais de §12.5, e o estado que a produz, o
   * cursor que venceu enquanto a pagina estava aberta, nao e detectado por
   * nenhum caminho de `reels.ts`. A constante fica, e a ausencia fica ESCRITA:
   * o estado vai para a Task 13b. Ate la, nenhum teste pode dar a entender que
   * esta frase e alcancavel (§13.1).
   */
  cursorVencido:
    'A lista ficou velha enquanto esta página estava aberta. Toque em Atualizar lista. O que você já marcou está guardado nesta tela.',
  /** §3, Reel apagado no Instagram. Ele NAO some da lista. */
  reelApagado: 'Este Reel não existe mais',
  tirarDaLista: 'Tirar da lista',
  /**
   * §3, miniatura vencida. **NAO RENDERIZADA HOJE**, zero usos em `src/`.
   *
   * A tela ja aguenta a miniatura quebrada (o cartao cai num bloco cinza e
   * continua selecionavel), mas a FAIXA que explica "as miniaturas venceram,
   * e normal, elas duram pouco" nao e emitida em lugar nenhum, porque nada
   * detecta o vencimento: um `<img>` que falha falha no navegador, e o servidor
   * nao sabe. Mesma situacao de `cursorVencido`, e o mesmo destino: Task 13b.
   */
  miniaturaVencida:
    'as miniaturas venceram, é normal, elas duram pouco. Nada da sua configuração foi perdido.',
  /** §12.5, as quatro paginas renderam quase nada. */
  poucosReels: 'Estas últimas publicações não são Reels, toque de novo para continuar procurando.',
  /** §12.5, o teto chegando. */
  quaseNoTeto: 'Você está perto do máximo de 200 Reels escolhidos.',
  /** §12.5, o selo de quem tem regras proprias. */
  regrasProprias: 'Regras próprias',
  /** §12.5, abrir “responder diferente” num Reel que nao esta na lista. */
  foraDaLista: 'Este Reel não está marcado.',
  voltarParaReels: 'Voltar para Reels',
  /** O link de cada cartao da lista para a tela daquele Reel. */
  abrirReel: 'Abrir',
  /** A legenda da escolha "todos / so os escolhidos". */
  quaisReels: 'Quais Reels',
  /** Com "Todos" marcado, as caixas de marcar nao valem. */
  marqueParaEscolher: 'Marque “Só os que eu marcar” para escolher.',
  /** O estado de UM Reel, no topo da tela dele. */
  estadoRespondendo: 'Respondendo',
  estadoPausado: 'Pausado neste Reel',
  estadoForaDaLista: 'Não está na sua lista',
  /** O detalhe das regras daquele Reel, recolhido. */
  verAsRegras: 'Ver as regras deste Reel',
  /** §3, o rotulo do que a listagem nao conseguiu confirmar (§15.2, pend. 7). */
  videoOuReel: 'vídeo/Reel',
  /**
   * §3, o botao de marcar em lote. **NAO RENDERIZADO HOJE**, zero usos.
   *
   * O botao existia como `<button type="button" class="marcar-lote">`, a classe
   * era a unica ocorrencia dela no repositorio e `painel.js` nao a conhecia:
   * ele nao fazia nada. Saiu de `reels.ts` nesta rodada, um controle que nao
   * faz o que promete e defeito (R-6, §12.4), e as duas frases ficam aqui
   * porque o botao e §3 e volta na Task 13b, com o desenho escrito no docblock
   * de `listaDeReels`.
   *
   * O numero fica FORA das frases de proposito: ele e o tamanho do que esta
   * carregado na tela, e e o unico numero que a tela pode prometer.
   */
  marcarOsDesta: 'Marcar os',
  marcarOsDestaFim: 'desta lista',
  carregarMais: 'Carregar mais',
  atualizar: 'Atualizar lista',
  /**
   * §12.5: a tela diz DE QUANDO a lista e, e oferece o botao que a renova.
   *
   * **§12.5 escreve o exemplo como "Lista de 14:32", e a hora do relogio nao
   * pode ser escrita aqui.** O docblock de `dataEmPortugues` ja fixou a razao:
   * o Worker roda em UTC, o fuso da instalacao nao esta no contrato de
   * ambiente, e uma hora tres horas errada numa tela que existe para explicar e
   * pior do que nenhuma hora. A IDADE responde a mesma pergunta, "de quando
   * ela e?", e nao depende de fuso nenhum. Quando o fuso virar dado de
   * ambiente, esta frase vira a de §12.5 palavra por palavra.
   */
  listaBuscadaAgora: 'Lista buscada agora.',
  listaBuscadaHa: 'Lista buscada há',
  listaBuscadaHaFim: 'minutos.',
  /** O singular. "há 1 minutos" e o portugues que nenhuma pessoa escreve. */
  listaBuscadaHaFimUm: 'minuto.',
  /** §3, a tela de UM Reel. */
  tituloDoReel: 'Este Reel',
  seguirRegraGeral: 'Voltar à regra geral',
  pausarEsteReel: 'Pausar só este Reel',
  religarEsteReel: 'Voltar a responder neste Reel',
  /** §3, o resumo de uma frase antes de salvar. */
  seguindoOGeral: 'Este Reel segue a regra geral em tudo.',
  /**
   * §10.10: a tela de conferencia NOMEIA o Reel antes de pedir a digital.
   *
   * Sem ela o dono lia "Intervalo por pessoa: 48 para 24" sem saber em qual
   * Reel estava encostando o dedo, e a mudanca assinada era identica para
   * todos eles (Ruling 96).
   */
  soNesteReel: 'Estas mudanças valem só neste Reel:',
  /**
   * §12.3, os tres sinais juntos no botao que PODE cair na cerimonia.
   *
   * "Voltar tudo a seguir a regra geral" alarga quando a sobreposicao daquele
   * Reel estreitava, e §10.10 lista o alargamento entre o que pede a digital.
   * §12.3 e literal: "quem garante o aviso e o cadeado no campo mais a tela de
   * conferencia, nunca uma surpresa biometrica".
   */
  esteBotaoPedeDigital:
    'Neste Reel, este botão aumenta o alcance da automação, então ele vai pedir a sua digital e mostrar antes o que muda.',
  /** O que o botao acrescenta ao proprio rotulo, para dizer o que vai acontecer. */
  vaiPedirADigital: '(vai pedir a sua digital)',
} as const

// ---------------------------------------------------------------------------
// O resultado de cada comentario atendido (§12.6)
// ---------------------------------------------------------------------------

/** O par que a tela mostra por linha: o icone E a palavra, nunca so um deles. */
export interface ResultadoNaTela {
  /** §12.9: icone sozinho nao e estado. Ele vem SEMPRE ao lado da frase. */
  readonly icone: string
  readonly frase: string
}

/**
 * `processed_comments.status` -> a frase de §12.6, uma por valor de `CommentStatus`.
 *
 * **O enum que governa esta tela e `CommentStatus`, e ele NAO e o dos motivos
 * de ignorar.** `SkipReason` e `ProcessOutcome` (`automation.ts`) sao resultados
 * em memoria do processamento e nao chegam a coluna nenhuma, o material de
 * origem misturava os tres numa citacao so. Quem a tela le e `status`, e a
 * unica lista fechada que responde por ele e a de
 * `src/repositories/comments-repository.ts` (§15.3, decisao 7). Um dicionario de
 * `SkipReason` aqui prometeria linhas que o banco nunca teve.
 *
 * **A trava e de TIPO**, como a de `NOME_DO_CAMPO`: `Record<CommentStatus, …>`
 * nao compila com um membro faltando, entao um valor novo no enum quebra o
 * `tsc` antes de qualquer teste, e sem ele a tela imprimiria o nome tecnico
 * cru, que e o defeito que §12.7 proibe em letras.
 *
 * **Hoje so cinco destes oito existem no banco, e a frase honesta e a que a
 * tela escreve.** O unico `INSERT` em `processed_comments` e o `claimComment`,
 * que grava `processing`, e em `processComment` **todo** `skipped` acontece
 * ANTES dele: comentario ignorado nao deixa linha nenhuma. `received` e
 * `ignored` estao declarados no tipo e nao sao escritos em lugar nenhum de
 * `src/`. As oito frases continuam obrigatorias assim mesmo, `processing` E o
 * valor que o claim grava e pode ser lido numa corrida real, e um valor de enum
 * sem frase e o bug que a tela mostraria como texto cru. O que nenhum teste
 * pode afirmar, sob pena de virar promessa falsa, e que todo valor traduzido
 * aparece em producao (§13.1).
 *
 * **A hora nao entra em `retry_pending`, e a ausencia e a mesma decisao de
 * `dataEmPortugues`.** §12.6 escreve "Vamos tentar de novo as 14:35", e o
 * relogio do Worker e UTC: o fuso da instalacao nao esta em lugar nenhum do
 * contrato de ambiente, e uma hora tres horas errada numa tela que existe para
 * explicar e pior que nenhuma hora. Quem quiser a data da proxima tentativa a
 * monta com `dataEmPortugues(next_retry_at)`, que e o que a tela faz.
 */
export const RESULTADO_DO_COMENTARIO: Record<CommentStatus, ResultadoNaTela> = {
  completed: { icone: '✓', frase: 'Direct enviado e comentário respondido' },
  private_sent: {
    icone: '⏳',
    frase: 'Direct enviado. A resposta no comentário ainda não saiu',
  },
  uncertain: {
    icone: '▲',
    frase:
      'Direct enviado, mas não conseguimos confirmar a resposta pública. A pessoa recebeu o link',
  },
  retry_pending: { icone: '⏳', frase: 'Não deu na primeira. Vamos tentar de novo' },
  failed: { icone: '✕', frase: 'Não conseguimos enviar' },
  processing: { icone: '⏳', frase: 'Estamos enviando agora' },
  received: { icone: '⏳', frase: 'Recebemos e vamos processar' },
  ignored: { icone: '–', frase: 'Não era um caso de responder' },
}

/**
 * A frase de um `status` que a tabela acima nao conhece.
 *
 * Ela existe porque a coluna e TEXT e a tela le o que estiver la: uma linha
 * gravada por uma versao futura, ou corrompida, nao pode virar o nome tecnico
 * impresso na tela (§12.7). A direcao e a mesma de `motivoDaRecusa`, frase
 * generica em vez de texto cru, e nao a de `traduzirAviso`, que nomeia o campo.
 */
export const RESULTADO_DESCONHECIDO: ResultadoNaTela = {
  icone: '–',
  frase: 'Não conseguimos dizer o que aconteceu com este comentário',
}

/**
 * A traducao de um `status` vindo do banco, como funcao PURA.
 *
 * Recebe `string` e nao `CommentStatus` de proposito: o argumento vem de uma
 * coluna TEXT, e prometer o tipo estreito aqui seria afirmar sobre o banco uma
 * coisa que so o `INSERT` de hoje garante. A trava de tipo que importa e a do
 * `Record` acima, e ela continua valendo.
 */
export function resultadoNaTela(status: string): ResultadoNaTela {
  const conhecido: ResultadoNaTela | undefined = (
    RESULTADO_DO_COMENTARIO as Record<string, ResultadoNaTela>
  )[status]
  return conhecido ?? RESULTADO_DESCONHECIDO
}
