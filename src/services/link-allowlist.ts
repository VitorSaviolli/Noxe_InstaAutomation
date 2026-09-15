/**
 * A allowlist de dominios: a trava que o painel NAO pode alterar (§9.8).
 *
 * A lista vive no `wrangler.jsonc`, no bloco `vars`, que e SOBRESCRITO a cada
 * publicacao, editar pelo dashboard nao adianta. Isso, que normalmente e uma
 * pegadinha da Cloudflare, e aqui exatamente a propriedade que faz a trava
 * funcionar: mudar a lista exige o repositorio MAIS a credencial de deploy,
 * que sao as duas coisas que um painel invadido nao tem.
 *
 * Duas aplicacoes, uma implementacao so:
 *
 * 1. **Na escrita** (etapa 11): o painel recusa a gravacao com
 *    `dominio_nao_permitido`.
 * 2. **Na leitura** (esta etapa): `config-store.ts` para a automacao. Ela
 *    cobre tres coisas que a escrita nao cobre, uma escrita feita FORA do
 *    painel, um ENCOLHIMENTO posterior da lista, e uma versao futura do
 *    validador com um furo fechado so na escrita.
 *
 * Em link E em texto, porque uma trava que so olhasse `destinationUrl` seria
 * contornada escrevendo o endereco do golpe dentro do texto do Direct.
 *
 * **A regra oposta da escrita, que NAO mora aqui.** Com a allowlist nao
 * configurada, `validarConfigComAllowlist` nao acusa nada, de proposito: a
 * entrega de quem ainda nao preencheu a variavel continua funcionando com o
 * link que ja esta valendo (§9.8). Quem for GRAVAR pergunta antes a
 * `allowlist.configurada`, e nunca deduz permissao do silencio desta funcao:
 * lista nao configurada significa que nenhum link e nenhum texto podem ser
 * alterados pelo painel. `hostPermitido` ja responde `false` para tudo nesse
 * estado, e e por ela que a escrita deve perguntar.
 */
import type { AutomationConfig } from '../config'
import { type Achado, limparTexto, type Validacao, validarConfig } from './config-validation'

/** A lista ja interpretada. Ler a variavel duas vezes daria o mesmo objeto. */
export interface Allowlist {
  /** `false` quando a variavel esta ausente, vazia ou toda invalida (§9.8). */
  readonly configurada: boolean
  /** As entradas validas, em minusculas. Vao para a tela do painel (§11.4). */
  readonly dominios: readonly string[]
}

/**
 * O mesmo objeto para todo chamador que ficar sem lista, e por isso congelado:
 * um `push` em `dominios` daqui envenenaria o isolate inteiro. As listas
 * configuradas nascem uma por chamada e nao tem esse problema.
 */
const NAO_CONFIGURADA: Allowlist = Object.freeze({
  configurada: false,
  dominios: Object.freeze([]) as readonly string[],
})

/** Um rotulo de host: minusculas, digitos e traco, nunca nas pontas. */
const ROTULO = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
/** Um "TLD" so de digitos seria um pedaco de IP, nunca um dominio. */
const SO_DIGITOS = /^[0-9]+$/
const MAX_CARACTERES_DO_HOST = 253
const MAX_CARACTERES_DO_ROTULO = 63

/**
 * Detector conservador DE PROPOSITO (§9.8): qualquer coisa com cara de
 * dominio conta. Falso positivo num texto que a pessoa escreve uma vez e
 * aceitavel; falso negativo e um link de golpe entregue.
 *
 * **Esta expressao e UNICODE, e a de §9.8 e ASCII. E emenda a spec, decidida
 * pelo controlador na rodada 1 de revisao, nao "corrija" de volta lendo a
 * §9.8.** A regra escrita la (`[a-z0-9-]`) contradiz o proposito declarado ao
 * lado dela: `atacantе.com` com um "e" cirilico, a tecnica de homografo que a
 * propria §9.8 nomeia como ameaca, nao casava NENHUM caractere da classe
 * ASCII e passava inteiro pelo caminho do texto. A assimetria decide: falso
 * positivo aqui PARA a automacao, que e falha segura; falso negativo ENTREGA
 * link de golpe.
 *
 * O ultimo rotulo aceita digito e traco depois da primeira letra, para caber
 * TLD em punycode (`xn--p1ai`) inteiro: cortado no `xn`, o aviso nomearia um
 * host que nao existe e uma instalacao com esse TLD nao conseguiria citar o
 * proprio dominio.
 */
const CANDIDATO_HOST = /(?:[\p{L}\p{N}\p{M}-]+\.)+\p{L}[\p{L}\p{N}-]+/gu

/**
 * Voltas de `decodeURIComponent` antes de varrer.
 *
 * `?u=https%3A%2F%2Fatacante%2Ecom` nao tem ponto nenhum para o detector ver,
 * e um redirecionador de verdade decodifica o parametro antes de redirecionar
 * o contorno funciona de ponta a ponta. Tres voltas cobrem o encode simples
 * e o duplo sem virar laco aberto.
 */
const MAX_VOLTAS_DE_DECODE = 3

/** O codigo unico de §11.4. A grafia `link_nao_permitido` esta deletada (§15.3). */
/**
 * O codigo de achado da allowlist.
 *
 * E a MESMA grafia da chave `dominio_nao_permitido` da tabela `ERROS`, e a
 * coincidencia e proposital: a rota de gravacao separa "endereco fora da lista"
 * (403) de "campo invalido" (400) olhando este codigo, e duas grafias fariam a
 * separacao falhar em silencio, devolvendo 400 para um problema de dominio.
 */
export const CODIGO_DA_RECUSA = 'dominio_nao_permitido'

/**
 * Interpreta `ALLOWED_LINK_DOMAINS`.
 *
 * Separada por virgula. Um binding que nao existe chega como `undefined`, e
 * nao como string vazia, por isso o `typeof` vem antes de qualquer coisa.
 *
 * A unica normalizacao aplicada e passar para minusculas, que e o mesmo que
 * `new URL` faz com o host: comparar `Exemplo.com` com `exemplo.com` nao pode
 * depender de o dono ter lembrado da tecla shift. Tudo o mais e recusado sem
 * conserto, uma entrada como `exemplo.com@atacante.com` "consertada" por um
 * `new URL` viraria `atacante.com` e ALARGARIA a lista em silencio, que e o
 * contrario do que este arquivo existe para fazer. Entrada descartada some da
 * lista que o painel mostra na tela, e e assim que o dono percebe o erro.
 */
export function lerAllowlist(bruto: string | undefined): Allowlist {
  if (typeof bruto !== 'string') return NAO_CONFIGURADA

  const dominios = bruto
    .split(',')
    .map((entrada) => entrada.trim().toLowerCase())
    .filter((entrada) => ehEntradaValida(entrada))

  if (dominios.length === 0) return NAO_CONFIGURADA
  return { configurada: true, dominios }
}

function ehEntradaValida(entrada: string): boolean {
  // O ponto inicial e a marca de "e os subdominios tambem"; o resto precisa
  // ser um host, e nada alem de um host: sem esquema, sem barra, sem `@`,
  // sem porta e sem acento, a variavel e escrita em punycode (§9.8).
  const host = entrada[0] === '.' ? entrada.slice(1) : entrada
  if (host.length === 0 || host.length > MAX_CARACTERES_DO_HOST) return false

  const rotulos = host.split('.')
  if (rotulos.length < 2) return false
  if (
    !rotulos.every((rotulo) => rotulo.length <= MAX_CARACTERES_DO_ROTULO && ROTULO.test(rotulo))
  ) {
    return false
  }

  const tld = rotulos.at(-1) ?? ''
  return tld.length >= 2 && !SO_DIGITOS.test(tld)
}

/**
 * O host esta na lista? Trava de LNK-02, LNK-03, LNK-04, LNK-05 e LNK-12.
 *
 * Allowlist nao configurada nao permite NADA, nao "permite tudo". E a
 * pergunta que a gravacao do painel faz antes de aceitar qualquer alteracao
 * de link ou de texto.
 */
export function hostPermitido(host: string, allowlist: Allowlist): boolean {
  if (!allowlist.configurada) return false

  const alvo = host.toLowerCase()
  return allowlist.dominios.some((entrada) => casaComEntrada(alvo, entrada))
}

/**
 * A regra de casamento de §9.8, deliberadamente burra.
 *
 * - Sem ponto inicial: o host INTEIRO e igual a entrada, e nada mais.
 * - Com ponto inicial (`.exemplo.com.br`): o proprio `exemplo.com.br` e
 *   qualquer coisa que termine em `.exemplo.com.br`.
 *
 * Nunca `includes`, nunca `startsWith`. O `endsWith` daqui e ancorado no
 * ponto, e e esse detalhe que separa a regra certa da errada:
 * `evilexemplo.com.br` nao termina em `.exemplo.com.br`, e
 * `exemplo.com.br.atacante.com` tambem nao.
 */
function casaComEntrada(host: string, entrada: string): boolean {
  if (entrada[0] !== '.') return host === entrada
  return host === entrada.slice(1) || host.endsWith(entrada)
}

/**
 * O validador unico com a allowlist por cima. Trava de LNK-01 a LNK-16.
 *
 * Ponto de entrada UNICO da leitura e da escrita: quem valida configuracao
 * chama esta funcao, nunca `validarConfig` sozinha. E isso que torna
 * estruturalmente impossivel aplicar as regras de campo sem aplicar a
 * allowlist, o furo classico de "a trava existia, mas aquele caminho nao
 * passava por ela".
 *
 * Os dois conjuntos de achados sao devolvidos juntos: quem grava ve de uma
 * vez tudo o que precisa arrumar, em vez de descobrir um problema por
 * tentativa.
 */
export function validarConfigComAllowlist(
  valores: AutomationConfig,
  allowlist: Allowlist,
): Validacao<AutomationConfig> {
  const daConfig = validarConfig(valores)
  const daAllowlist = conferirDominios(valores, allowlist)

  if (daConfig.ok && daAllowlist.length === 0) return daConfig

  return { ok: false, achados: [...(daConfig.ok ? [] : daConfig.achados), ...daAllowlist] }
}

/**
 * Aquele campo carrega endereco, e por isso depende da allowlist? (§9.8)
 *
 * Sao os mesmos tres que `conferirDominios` examina, e eles nao viram uma lista
 * unica porque o exame de cada um e diferente: o link passa por `achadosDoLink`
 * e os dois textos por `achadosDoTexto`. Este predicado existe para a pergunta
 * OPOSTA, que a gravacao faz antes de validar: "este lote mexe em algum campo de
 * endereco?".
 *
 * A pergunta so passou a ter consequencia quando os tres campos viraram
 * gravaveis: ate entao eles paravam no `403 step_up_necessario` antes de
 * qualquer coisa, e a promessa de §9.8, "com a lista nao configurada o painel
 * nao altera o link nem o texto do Direct", era verdadeira por acidente.
 */
export function campoCarregaEndereco(campo: string): boolean {
  return campo === 'destinationUrl' || campo === 'privateReplyText' || campo === 'publicReplyText'
}

/**
 * Os achados da allowlist nos tres campos que carregam endereco.
 *
 * Lista nao configurada devolve vazio, e isso NAO e "permitir": e a decisao de
 * §9.8 de nao punir, na LEITURA, quem tem um `destinationUrl` no arquivo e ainda
 * nao teve chance de preencher a variavel nova. A recusa nesse estado acontece
 * na ESCRITA, perguntando a `allowlist.configurada`, e quem pergunta e
 * `validarOuRecusar`, no funil, com o predicado acima.
 */
function conferirDominios(valores: AutomationConfig, allowlist: Allowlist): readonly Achado[] {
  if (!allowlist.configurada) return []

  return [
    ...achadosDoLink(valores.destinationUrl, allowlist),
    ...achadosDoTexto('privateReplyText', valores.privateReplyText, allowlist),
    ...achadosDoTexto('publicReplyText', valores.publicReplyText, allowlist),
  ]
}

/**
 * O campo do link. Trava de LNK-06 e do redirecionador aberto.
 *
 * O host vem de `new URL`, que ja normaliza para minusculo e punycode: e o
 * host que o navegador visitaria, e nao o que o texto aparenta. Por isso
 * `https://exemplo.com@atacante.com` e reprovado aqui tambem, o host dele e
 * `atacante.com`, por mais que o comeco da string diga outra coisa.
 *
 * Este arquivo NAO repete as regras de `validarConfig` (https obrigatorio,
 * sem credencial, sem porta, tamanho, texto normalizado): as duas rodam
 * sempre juntas em `validarConfigComAllowlist`, e repeti-las aqui criaria o
 * segundo validador que §9.7 existe para impedir. Link que nem parseia ja foi
 * acusado la como `link_invalido`.
 */
function achadosDoLink(bruto: unknown, allowlist: Allowlist): readonly Achado[] {
  if (typeof bruto !== 'string') return []

  let url: URL
  try {
    url = new URL(bruto)
  } catch {
    return []
  }

  // Esquema sem host, `javascript:`, `data:`, `mailto:`, nao tem endereco
  // para conferir contra a lista, e `validarConfig` ja o recusou por nao ser
  // `https`. Inventar aqui um achado com host vazio so encheria a tela do
  // dono com uma frase que nao explica nada.
  if (url.host.length === 0) return []

  // `url.host` carrega a porta quando ela existe, e isso e proposital: uma
  // porta diferente da padrao nao casa a entrada da lista, que e o lado
  // seguro do erro.
  const suspeitos = [url.host]

  // A query e o fragmento passam pelo detector de texto porque e ali que mora
  // o redirecionador aberto: `https://permitido.com/?r=atacante.com` tem host
  // permitido e leva para fora. O CAMINHO fica de fora de proposito, em
  // `https://permitido.com/guia.pdf` o detector veria "guia.pdf" e recusaria
  // um link legitimo.
  suspeitos.push(...hostsNoTexto(`${url.search}${url.hash}`))

  return achadosDosHosts('destinationUrl', suspeitos, allowlist)
}

/**
 * Um dos dois textos. Trava de LNK-10 e LNK-11.
 *
 * Sem isto, a allowlist seria contornada em dez segundos: bastaria deixar o
 * campo do link em paz e escrever o endereco do golpe no meio da mensagem.
 */
function achadosDoTexto(
  campo: 'privateReplyText' | 'publicReplyText',
  bruto: unknown,
  allowlist: Allowlist,
): readonly Achado[] {
  if (typeof bruto !== 'string') return []
  return achadosDosHosts(campo, hostsNoTexto(bruto), allowlist)
}

/**
 * Os candidatos a host dentro de um texto qualquer, ja canonizados.
 *
 * Duas limpezas antes de procurar, porque as duas escondem dominio:
 *
 * 1. `limparTexto`, NFKC mata a largura total e a remocao de `\p{Cc}\p{Cf}`
 *    mata o zero-width usado para partir um dominio no meio.
 * 2. As voltas de percent-decode, varridas ALEM do texto cru: o cru continua
 *    valendo porque decodificar pode juntar o que estava separado, e nunca
 *    pode fazer sumir o que ja estava visivel.
 */
function hostsNoTexto(bruto: string): string[] {
  const candidatos = variantesDecodificadas(bruto).flatMap(procurarCandidatos)
  return [...new Set(candidatos)]
}

function procurarCandidatos(texto: string): string[] {
  return [...limparTexto(texto).matchAll(CANDIDATO_HOST)]
    .map((achado) => canonizarHost(achado[0]))
    .filter((host) => host.length > 0)
}

/**
 * O texto cru e o que ele vira depois de ate tres percent-decodes.
 *
 * Para quando a volta nao muda nada e quando `decodeURIComponent` estoura,
 * um `%` solto numa frase ("50% de desconto") e texto legitimo, nao motivo
 * para recusar a configuracao inteira.
 */
function variantesDecodificadas(bruto: string): string[] {
  const variantes = [bruto]
  let atual = bruto

  for (let volta = 0; volta < MAX_VOLTAS_DE_DECODE; volta++) {
    let proxima: string
    try {
      proxima = decodeURIComponent(atual)
    } catch {
      break
    }
    if (proxima === atual) break

    variantes.push(proxima)
    atual = proxima
  }

  return variantes
}

/**
 * O candidato do texto vira o host que o navegador visitaria.
 *
 * E a MESMA canonizacao que o campo do link ganha de graca do `new URL`:
 * minusculas e punycode. Sem ela, `atacantе.com` com "e" cirilico seria
 * comparado letra a letra com a lista e nunca casaria nada, mas tambem nunca
 * seria reconhecido como o endereco que ele e.
 *
 * Candidato que nem como host parseia fica como esta, em minusculas: ele nao
 * vai estar em lista nenhuma, que e o lado seguro do erro.
 */
function canonizarHost(candidato: string): string {
  try {
    const host = new URL(`https://${candidato}`).host
    if (host.length > 0) return host
  } catch {
    // Cai no retorno de baixo.
  }
  return candidato.toLowerCase()
}

/** Um achado por host reprovado, sem repetir o mesmo host duas vezes. */
function achadosDosHosts(
  campo: string,
  hosts: readonly string[],
  allowlist: Allowlist,
): readonly Achado[] {
  const reprovados = new Set(hosts.filter((host) => !hostPermitido(host, allowlist)))

  return [...reprovados].map((host) => ({
    campo,
    codigo: CODIGO_DA_RECUSA,
    mensagem: `O endereco ${host} nao esta na lista liberada no deploy.`,
  }))
}
