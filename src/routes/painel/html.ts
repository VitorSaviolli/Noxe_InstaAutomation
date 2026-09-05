/**
 * O HTML do painel: a tag `` html`` `` que escapa por padrao, o `cru()` que e a
 * unica saida dela, a `pagina()` que monta o documento e o `cabecalhos(perfil)`
 * de §11.5.
 *
 * **Escapar e o padrao, e nao a lembranca.** Toda interpolacao passa por
 * `escapeHtml` a menos que alguem escreva `cru(...)` — uma palavra curta, facil
 * de procurar e cuja unica ocorrencia legitima e um trecho que ja nasceu desta
 * mesma tag. A checagem 19 de §13.5 varre o repositorio por `cru(` e falha
 * quando ele aparece fora da lista autorizada: a garantia mora la porque ela e
 * sobre ARQUIVOS, e teste nenhum enxerga isso de dentro do bundle.
 *
 * `escapeHtml` e IMPORTADO de `src/routes/legal.ts` (§7.7). Nao existe segunda
 * copia: duas implementacoes de escape divergem na primeira vez que uma delas
 * ganhar um caractere, e a que ficar para tras vira o buraco.
 */
import { escapeHtml } from '../legal'

// ---------------------------------------------------------------------------
// A tag
// ---------------------------------------------------------------------------

/**
 * A marca que separa "texto ja seguro" de "texto que veio de fora".
 *
 * `Symbol` e nao uma propriedade booleana comum de proposito: um objeto vindo
 * de `JSON.parse` — isto e, do corpo de uma requisicao — nunca carrega um
 * simbolo, entao nao existe corpo capaz de se declarar seguro sozinho.
 */
const MARCA_DE_SEGURO = Symbol('painel/html-seguro')

/** Um trecho de HTML que ja passou pelo escape, ou que nasceu constante. */
export interface HtmlSeguro {
  readonly [MARCA_DE_SEGURO]: true
  readonly texto: string
}

function marcar(texto: string): HtmlSeguro {
  return { [MARCA_DE_SEGURO]: true, texto }
}

function ehSeguro(valor: unknown): valor is HtmlSeguro {
  return typeof valor === 'object' && valor !== null && MARCA_DE_SEGURO in valor
}

/**
 * A porta de fuga, e a UNICA.
 *
 * Marca um texto como ja seguro. Existe para o caso em que o HTML e montado
 * fora da tag — hoje nada precisa disso na producao — e para que a garantia de
 * §13.5 tenha uma palavra unica a procurar. Chamar `cru()` com valor que veio
 * de fora e o unico jeito de furar o escape do painel inteiro.
 */
export function cru(texto: string): HtmlSeguro {
  return marcar(texto)
}

/**
 * Um valor interpolado vira texto seguro.
 *
 * `null` e `undefined` somem (e o que faz `${talvez}` nao imprimir a palavra
 * "undefined" na tela do dono); lista vira a concatenacao dos itens, cada um
 * pela mesma regra; `HtmlSeguro` entra como esta; qualquer outra coisa e
 * convertida para texto e ESCAPADA.
 */
function interpolar(valor: unknown): string {
  if (valor === null || valor === undefined) return ''
  if (ehSeguro(valor)) return valor.texto
  if (Array.isArray(valor)) return valor.map(interpolar).join('')
  return escapeHtml(String(valor))
}

/**
 * A tag de template do painel. Escapa por padrao.
 *
 * ```ts
 * html`<p>${apelidoDoBanco}</p>`          // escapado
 * html`<ul>${linhas.map(linhaDeAparelho)}</ul>`  // lista de HtmlSeguro
 * ```
 *
 * Devolve `HtmlSeguro` — e nao `string` — para que `html` dentro de `html`
 * funcione sem escapar duas vezes. Uma tag que devolvesse `string` obrigaria
 * `cru()` em toda composicao, e `cru()` espalhado e exatamente o que a
 * checagem 19 existe para impedir.
 */
export function html(partes: TemplateStringsArray, ...valores: readonly unknown[]): HtmlSeguro {
  let texto = partes[0] ?? ''
  for (let i = 0; i < valores.length; i++) {
    texto += interpolar(valores[i]) + (partes[i + 1] ?? '')
  }
  return marcar(texto)
}

// ---------------------------------------------------------------------------
// Cabecalhos (§11.5)
// ---------------------------------------------------------------------------

/**
 * Os dois perfis em codigo. O terceiro — o dos tres assets — vai em
 * `public/_headers`, fora do Worker (§11.5).
 */
export type PerfilDeCabecalho = 'pagina' | 'api'

/**
 * A CSP unica das paginas, sem nonce porque o CSS e arquivo externo.
 *
 * `require-trusted-types-for 'script'` transforma `innerHTML` em erro de
 * RUNTIME, e nao de revisao: e a linha que faz "o painel.js nao usa innerHTML"
 * parar de depender de alguem lembrar. `form-action 'self'` e a que impede um
 * `action` reescrito de postar para fora. Nada de `unsafe-inline`, nada de
 * `unsafe-eval`.
 */
const CSP_DE_PAGINA =
  "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
  "script-src 'self'; style-src 'self'; " +
  "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'none'; " +
  "require-trusted-types-for 'script'; upgrade-insecure-requests"

/** A CSP das respostas JSON (§11.5). `sandbox` porque JSON nao renderiza nada. */
const CSP_DE_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox"

/**
 * `Permissions-Policy` de §11.5.
 *
 * As duas ultimas diretivas sao as que importam: sem
 * `publickey-credentials-get=(self)` e `publickey-credentials-create=(self)` o
 * navegador recusaria a propria cerimonia de passkey do painel.
 */
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), ' +
  'payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)'

/**
 * **Sem `preload`**, e a ausencia e decisao: `workers.dev` nao e nosso, e pedir
 * preload de um host dentro de um sufixo publico de terceiro nao e decisao que
 * este projeto possa tomar.
 */
const HSTS = 'max-age=31536000; includeSubDomains'

/**
 * Os cabecalhos comuns aos dois perfis.
 *
 * `Vary: Cookie` vai em TODA resposta do Worker, sem excecao por rota — mesmo
 * numa rota que nao le cookie. Uma regra sem excecao vale mais que a economia
 * de um cabecalho, porque e a excecao que alguem copia para a rota errada.
 *
 * **`Cross-Origin-Embedder-Policy: require-corp` nunca entra**: ele quebraria
 * as miniaturas do `fbcdn.net` na tela de Reels. A ausencia esta escrita aqui
 * porque um contribuidor futuro a acrescentaria de boa fe.
 */
function comuns(): Record<string, string> {
  return {
    'strict-transport-security': HSTS,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, no-store',
    vary: 'Cookie',
  }
}

/**
 * Os cabecalhos daquele perfil (§11.5).
 *
 * Este e o dono UNICO do conjunto. `cabecalhosDePagina()` — que morava em
 * `parada.ts` enquanto este arquivo nao existia — foi apagada: duas grafias do
 * mesmo conjunto divergem na primeira vez que uma delas ganha uma diretiva, e
 * a que ficar para tras e a que serve a pagina de emergencia.
 *
 * Nao ha `content-type` no perfil `api`: quem monta a resposta e
 * `Response.json`, que carimba `application/json` sozinho — e um `content-type`
 * escrito aqui apagaria o dele.
 */
export function cabecalhos(perfil: PerfilDeCabecalho): Record<string, string> {
  if (perfil === 'api') {
    return { ...comuns(), 'content-security-policy': CSP_DE_API }
  }

  return {
    ...comuns(),
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP_DE_PAGINA,
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
  }
}

// ---------------------------------------------------------------------------
// A pagina
// ---------------------------------------------------------------------------

/** O que muda de uma pagina para outra. Tudo o mais e igual, e de proposito. */
export interface PaginaDoPainel {
  /** Vai para `<title>`, escapado como qualquer outro valor. */
  readonly titulo: string
  /** O conteudo de `<body>`, ja montado pela tag `` html`` ``. */
  readonly corpo: HtmlSeguro
  /** `200` salvo quando a tela E o erro. */
  readonly status?: number
  /** Cabecalhos da rota, como `set-cookie` ou `location`. Nunca CSP. */
  readonly extras?: Record<string, string>
  /** `true` quando a tela precisa do `painel.js` (so as que leem a digital). */
  readonly comScript?: boolean
}

/**
 * O documento inteiro, montado num lugar so.
 *
 * `lang="pt-BR"`, `viewport` com `initial-scale=1` e a folha de estilo externa
 * sao os tres que nao podem faltar em nenhuma tela: sem o primeiro o leitor de
 * tela le em ingles, sem o segundo o iOS da zoom sozinho, e o terceiro e o que
 * permite a CSP nao ter `unsafe-inline`.
 *
 * Os cabecalhos de §11.5 vem DEPOIS dos extras, e a ordem e a trava: fosse o
 * contrario, uma rota poderia sobrescrever a CSP passando uma chave de mesmo
 * nome. E o mesmo cuidado que `parada.ts` ja tinha.
 */
export function pagina(entrada: PaginaDoPainel): Response {
  const script =
    entrada.comScript === true ? html`<script src="/painel/painel.js" defer></script>` : null

  const documento = html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${entrada.titulo}</title>
<link rel="stylesheet" href="/painel/painel.css">
</head>
<body>
${entrada.corpo}
${script}
</body>
</html>
`

  return new Response(documento.texto, {
    status: entrada.status ?? 200,
    headers: { ...entrada.extras, ...cabecalhos('pagina') },
  })
}
