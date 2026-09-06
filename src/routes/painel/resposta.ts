/**
 * As tres respostas do painel — `erro()`, `redirecionar()` e `json()` — e a
 * tabela canonica de codigos de §11.4.
 *
 * **Esta tabela e a UNICA.** As nove grafias divergentes do material de origem
 * estao DELETADAS do projeto e mapeadas assim (§15.3, decisao 2):
 *
 *   stepup_necessario   -> step_up_necessario
 *   stepup_invalido     -> step_up_necessario
 *   link_nao_permitido  -> dominio_nao_permitido
 *   meta_indisponivel   -> falha_meta
 *   d1_indisponivel     -> indisponivel
 *   erro_interno        -> falha_interna
 *   sessao_invalida     -> sessao_ausente
 *   desafio_expirado    -> credencial_invalida
 *   midia_inexistente   -> dados_invalidos
 *   payload_muito_grande-> corpo_grande_demais   (e a palavra e proibida, §7.8)
 *
 * **Nunca** ha campo `detalhe`, `stack`, `cause` ou mensagem de excecao no
 * corpo: a `mensagem` sai da tabela, e nao do erro que aconteceu. O `console`
 * recebe metodo, caminho SEM query string, status e o codigo — nenhum valor,
 * nunca (§11.7), e em argumentos separados, para que nao exista o caminho em
 * que alguem interpola um `destinationUrl` por engano.
 */
import { cabecalhos, type HtmlSeguro, html, pagina } from './html'
import type { FormatoDeRota } from './rotas'

/**
 * A tabela canonica de §11.4, inteira.
 *
 * Ela nasce completa — e nao so com o recorte que as rotas de hoje usam —
 * porque o valor dela e ser a UNICA: um codigo que falta e um literal que
 * alguem escreve na rota, e o literal e que vira a decima grafia divergente.
 */
export const ERROS = {
  corpo_invalido: { status: 400, mensagem: 'Não foi possível ler os dados enviados.' },
  dados_invalidos: { status: 400, mensagem: 'Confira os campos destacados.' },
  sessao_ausente: { status: 401, mensagem: 'Sua sessão expirou. Entre de novo.' },
  credencial_invalida: { status: 401, mensagem: 'Não foi possível confirmar. Tente de novo.' },
  origem_invalida: { status: 403, mensagem: 'Requisição bloqueada por segurança.' },
  csrf_invalido: { status: 403, mensagem: 'Requisição bloqueada por segurança.' },
  step_up_necessario: { status: 403, mensagem: 'Confirme com sua passkey para continuar.' },
  dominio_nao_permitido: {
    status: 403,
    mensagem: 'Este endereço não está na lista liberada no deploy.',
  },
  codigo_incorreto: { status: 403, mensagem: 'Esse código não confere. Confira e digite de novo.' },
  rota_desconhecida: { status: 404, mensagem: 'Página não encontrada.' },
  metodo_nao_permitido: { status: 405, mensagem: 'Método não permitido.' },
  conta_nao_conectada: { status: 409, mensagem: 'Conecte o Instagram pelo assistente antes.' },
  versao_desatualizada: {
    status: 409,
    mensagem: 'A configuração mudou em outro lugar; recarregue a tela.',
  },
  ultima_passkey: { status: 409, mensagem: 'Cadastre outra passkey antes de remover esta.' },
  corpo_grande_demais: { status: 413, mensagem: 'Dados grandes demais.' },
  tipo_nao_suportado: { status: 415, mensagem: 'Formato não suportado.' },
  muitas_tentativas: { status: 429, mensagem: 'Muitas tentativas. Aguarde um minuto.' },
  falha_meta: { status: 502, mensagem: 'O Instagram não respondeu. Tente de novo.' },
  painel_desativado: { status: 503, mensagem: 'O painel ainda não foi ativado neste deploy.' },
  indisponivel: { status: 503, mensagem: 'Serviço temporariamente indisponível.' },
  falha_interna: { status: 500, mensagem: 'Algo deu errado. Tente de novo.' },
} as const

export type CodigoDeErro = keyof typeof ERROS

/** O que muda de um erro para outro. Tudo o mais vem da tabela. */
export interface ContextoDoErro {
  readonly request: Request
  /** O caminho da rota, SEM query string — §11.7 nao admite query no log. */
  readonly caminho: string
  /** `json` responde `{erro, mensagem}`; `pagina` mostra a mesma frase na tela. */
  readonly formato: FormatoDeRota
  /** `allow` no `405`, `retry-after` no `429`. Nunca CSP nem `set-cookie`. */
  readonly extras?: Record<string, string>
  /**
   * O motivo INTERNO, quando o codigo ao cliente e mais generico que ele.
   *
   * Existe para a fronteira do login, onde §10.3 manda colapsar todo motivo em
   * `credencial_invalida` e o dono ainda precisa saber qual foi. Ele entra na
   * MESMA linha de `console.warn` — nunca numa segunda: duas linhas por
   * tentativa recusada sao amplificacao de log na rota nao autenticada mais
   * exposta do painel, e quem paga os Workers Logs e o dono (mesma classe do
   * Ruling 27).
   *
   * E um codigo de vocabulario fechado, em snake_case, como todo o resto que
   * §11.7 permite. Nunca um valor, nunca um pedaco do corpo.
   *
   * **A forma e conferida em tempo de execucao** (`FORMA_DO_MOTIVO`), e a
   * conferencia nao e paranoia: `motivoInterno` e o unico campo desta interface
   * que vai para o `console`, e um `motivoInterno: corpo.campos.toString()`
   * escrito por engano publicaria o formulario inteiro — palavras, link e texto
   * do Direct — nos Workers Logs, que §9.9 proibe em letras. O que nao casa a
   * forma e DESCARTADO: o codigo e o status continuam no log, e a direcao do
   * erro e a segura.
   */
  readonly motivoInterno?: string
  /**
   * Os campos que a recusa acusa, pelo nome tecnico (§11.4, `dados_invalidos`).
   *
   * **Nomes, nunca valores.** Vao para o corpo JSON como `campos: string[]` — a
   * unica chave que §11.4 acrescenta a `{erro, mensagem}` — e NAO vao para o
   * `console`: o log tem o codigo, e o codigo basta para saber o que aconteceu.
   */
  readonly campos?: readonly string[]
  /**
   * O bloco que explica a recusa na TELA, e so na tela.
   *
   * §11.4 fixa a `mensagem` — uma frase por codigo, igual nos dois formatos — e
   * §12.4 exige que a pessoa saiba QUAL campo e POR QUE. As duas coisas convivem
   * porque sao camadas diferentes: a frase e o cabecalho da pagina, e isto e o
   * corpo dela. Nunca entra no JSON, e nunca carrega rastro de excecao — quem o
   * monta e a rota, com frases do dicionario.
   */
  readonly explicacao?: HtmlSeguro
}

/** Um codigo de motivo interno bem formado: snake_case curto, e nada mais. */
const FORMA_DO_MOTIVO = /^[a-z][a-z0-9_]{0,39}$/

/**
 * Um erro de §11.4, com o codigo no log e a frase no corpo.
 *
 * A MESMA `mensagem` nos dois formatos, e o MESMO `erro` no `console.warn`:
 * quem depura pelo log ve a palavra que o corpo JSON traria, e quem le a tela
 * ve a frase que o JSON traria. Duas tabelas seriam duas verdades.
 */
export function erro(codigo: CodigoDeErro, contexto: ContextoDoErro): Response {
  const { status, mensagem } = ERROS[codigo]
  const motivo =
    contexto.motivoInterno !== undefined && FORMA_DO_MOTIVO.test(contexto.motivoInterno)
      ? contexto.motivoInterno
      : undefined

  if (motivo === undefined) {
    console.warn('painel:', contexto.request.method, contexto.caminho, status, codigo)
  } else {
    console.warn('painel:', contexto.request.method, contexto.caminho, status, codigo, motivo)
  }

  if (contexto.formato === 'json') {
    return Response.json(
      // `campos` e a UNICA chave que §11.4 acrescenta a `{erro, mensagem}`, e ela
      // carrega nomes — nunca valores. Ausente quando a recusa nao acusa campo.
      contexto.campos === undefined
        ? { erro: codigo, mensagem }
        : { erro: codigo, mensagem, campos: [...contexto.campos] },
      { status, headers: { ...contexto.extras, ...cabecalhos('api') } },
    )
  }

  return pagina({
    titulo: mensagem,
    // A frase, e o que a rota souber explicar sobre ELA. Sem o codigo na tela:
    // `csrf_invalido` nao diz nada a quem instala o projeto, e dizer mais do que
    // isto e o que vira vazamento.
    corpo: html`<h1>${mensagem}</h1>
${contexto.explicacao ?? null}
<p><a href="/painel">Voltar ao início</a></p>`,
    status,
    extras: contexto.extras,
  })
}

/**
 * O `303` de §7.1 e o do passo 6 da escada.
 *
 * `303 See Other` e nao `302`: e o unico status que obriga o navegador a trocar
 * o metodo para `GET`, e e por isso que "gravar e redirecionar" nao reenvia o
 * POST quando a pessoa aperta atualizar.
 *
 * Sai com os cabecalhos de pagina inteiros, `Vary: Cookie` inclusive: a regra
 * de §11.5 e "toda resposta do Worker, sem excecao por rota", e um redirect e
 * uma resposta.
 */
export function redirecionar(para: string, extras: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { ...extras, ...cabecalhos('pagina'), location: para },
  })
}

/**
 * Uma resposta JSON de sucesso das rotas `/painel/api/*`.
 *
 * `extras` existe para o `set-cookie` — o cookie de desafio das opcoes e o de
 * sessao do login. Ele vem ANTES dos cabecalhos de §11.5 pela mesma razao de
 * sempre: os de seguranca ganham de quem tentar sobrescreve-los.
 */
export function json(
  corpo: unknown,
  opcoes: { status?: number; extras?: Record<string, string> } = {},
): Response {
  return Response.json(corpo, {
    status: opcoes.status ?? 200,
    headers: { ...opcoes.extras, ...cabecalhos('api') },
  })
}
