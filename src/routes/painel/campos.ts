/**
 * O vocabulario que viaja entre o navegador e o painel: os tres cookies de §7.2
 * e os cinco campos escondidos que todo formulario carrega.
 *
 * Ele saiu de `guardas.ts` quando aquele arquivo chegou a 783 das 800 linhas do
 * teto deste repositorio, e a etapa seguinte mexe justamente nas constantes
 * `CAMPO_DA_*` — extrair depois seria extrair no meio de outra mudanca, que e
 * quando um `git diff` deixa de dizer o que aconteceu.
 *
 * **A separacao nao e so de tamanho, e o corte tem uma regra:** `guardas.ts` e
 * onde a escada de §11.3 DECIDE — quem passa pelo limitador, pela origem, pelo
 * portao de sessao e pela ficha —, e este arquivo e so o vocabulario que essas
 * decisoes leem e que as telas escrevem. Nada aqui recusa nada; nada aqui
 * conhece `Env`, `Response` ou a tabela de erros. E por isso que o funil de
 * gravacao, a tela de conferencia e a pagina de recusa podem importar os nomes
 * sem arrastar junto o limitador de taxa.
 *
 * **Os nomes moram num lugar so, e essa e a afirmacao que importa.** A tela que
 * emite um campo escondido, o funil que o le e a pagina de recusa que o reemite
 * sao tres arquivos; uma segunda grafia perderia um deles exatamente uma vez, e
 * essa vez seria a que ninguem viu.
 */

/** O cookie de sessao (§7.2). `Path=/` porque o prefixo `__Host-` exige. */
export const COOKIE_DA_SESSAO = '__Host-painel_sessao'

/** O cookie de desafio das cerimonias (§7.2). Propositos `entrar` e `registrar`. */
export const COOKIE_DO_DESAFIO = '__Host-painel_desafio'

/**
 * O cookie do step-up (§7.2): envelope de proposito `stepup`, 120 s.
 *
 * **O prefixo `__Host-` fica, e nao ha plano B aceitavel** (§15.2, pendencia
 * 11): ele e o que impede outro Worker da mesma conta `workers.dev` de sombrear
 * este cookie com um cookie de dominio pai. Um envelope sombreado seria uma
 * autorizacao escolhida por quem sombreou.
 */
export const COOKIE_DE_STEPUP = '__Host-painel_stepup'

/**
 * O `Set-Cookie` de um dos tres cookies de §7.2.
 *
 * Os quatro atributos nao sao opcionais e nao tem variante: `HttpOnly` (o
 * JavaScript da pagina nunca le), `Secure` e `Path=/` (exigidos pelo prefixo
 * `__Host-`, que e o que impede outro Worker da mesma conta `workers.dev` de
 * sombrear o cookie do painel com um cookie de dominio pai) e `SameSite=Strict`
 * (camada 1 das cinco de §10.9: um POST cross-site nem chega autenticado).
 *
 * `Path=/painel` seria INVALIDO — o prefixo `__Host-` exige `Path=/`.
 *
 * Escrito num lugar so, e nos tres cookies: uma segunda grafia perderia um dos
 * quatro atributos exatamente uma vez, e essa vez seria a que ninguem viu.
 */
export function cookieDoPainel(nome: string, valor: string, segundos: number): string {
  return `${nome}=${valor}; Max-Age=${segundos}; Path=/; Secure; HttpOnly; SameSite=Strict`
}

/** A ficha viaja neste cabecalho nas rotas `/painel/api/*` (§7.2, §10.9). */
export const CABECALHO_DA_FICHA = 'x-painel-csrf'

/** E neste campo escondido nos formularios (§7.2). NUNCA na query string. */
export const CAMPO_DA_FICHA = 'csrf'

/**
 * Os outros tres campos escondidos que um formulario do painel carrega.
 *
 * Eles moram ao lado da ficha porque sao a mesma especie: nomes de campo que
 * NAO sao configuracao, e que quem le o corpo precisa reconhecer para nao os
 * tratar como campo desconhecido. Moram AQUI, e nao no funil de gravacao, porque
 * a tela que os emite, o funil que os le e a pagina de recusa que os reemite sao
 * tres arquivos, e um deles teria de importar do outro so por causa de uma
 * string — que e o ciclo que este projeto nao tem.
 *
 * `versao` e a trava otimista de §8.8. `confirmar` e o gesto explicito que
 * §10.12 exige para religar a automacao. `digital` e onde o passo 3 de §10.10
 * poe a assertion serializada — **no mesmo formulario** da mudanca, para que a
 * autorizacao e o conteudo que ela cobre cheguem na MESMA requisicao e nao
 * exista autorizacao pendurada esperando uma segunda.
 *
 * O nome e `digital` e nao `assertion` porque ele aparece no HTML da tela, e
 * §12.1 fecha o vocabulario do que a tela escreve.
 */
export const CAMPO_DA_VERSAO = 'versao'
export const CAMPO_DA_CONFIRMACAO = 'confirmar'
export const CAMPO_DA_DIGITAL = 'digital'

/**
 * O campo que declara QUAL operacao aquele POST e (§7.1, §11.3 passo 6).
 *
 * §7.1 nao cria rota por operacao: `/painel/chave` recebe `ligar` e `desligar`,
 * e `/painel/ajustes` recebe o `restaurar` do botao "Voltar a esta versao". O
 * identificador da escrita vai no CORPO, e este e o nome dele.
 *
 * Ele mora aqui pela mesma razao que os outros quatro: a tela que o emite, o
 * handler que o le e a lista de estruturais que o deixa passar pelo passo 6 sao
 * tres lugares, e ate esta linha eram SETE grafias soltas da mesma string —
 * duas delas dentro de HTML, onde nenhum compilador olha.
 *
 * **So o NOME sobe; os valores ficam com as rotas donas.** `ligar`, `desligar` e
 * `restaurar` sao vocabulario de UMA tela cada, e junta-los aqui convidaria a
 * proxima rota a aceitar o verbo da outra. E ele NAO alcanca a chave `acao` do
 * JSON canonico de §10.10, em `stepup.ts`: aquilo e outro espaco de nomes com a
 * mesma grafia, e uma constante compartilhada faria renomear um campo de
 * formulario mudar o hash de toda operacao ja assinada.
 */
export const CAMPO_DA_ACAO = 'acao'

/**
 * O valor de um cookie, do cabecalho cru.
 *
 * Nao usa `startsWith` sobre o cabecalho inteiro: `__Host-painel_desafio` e
 * `__Host-painel_desafio_falso` compartilham prefixo, e o navegador manda os
 * dois separados por `; `.
 */
export function lerCookie(request: Request, nome: string): string | null {
  const cabecalho = request.headers.get('cookie')
  if (cabecalho === null) return null

  for (const pedaco of cabecalho.split(';')) {
    const igual = pedaco.indexOf('=')
    if (igual === -1) continue
    if (pedaco.slice(0, igual).trim() !== nome) continue

    const valor = pedaco.slice(igual + 1).trim()
    return valor === '' ? null : valor
  }

  return null
}
