/**
 * `GET /painel` — a tela de Inicio.
 *
 * **Nesta etapa ela ainda nao edita nada, e nao le nada.** Ela existe porque o
 * portao precisa ter um lado de dentro: e a rota autenticada que prova que
 * `exigirSessao` recusa quem chega sem cookie (`303` para `/painel/entrar`) e
 * deixa passar quem tem sessao viva, e e para onde o `painel.js` navega depois
 * do login. Os tres estados grandes, o estado da conta e os campos de
 * configuracao chegam com a etapa que sobe as telas em modo leitura, que e a
 * primeira a ler `painel_config`.
 *
 * Ela nao consulta o D1 por conta propria: a UNICA leitura do caminho e a da
 * linha de sessao, que o roteador ja fez no passo 9 da escada e entrega pronta.
 */
import { html, pagina } from './html'
import type { EntradaDaRota } from './router'

/**
 * A tela de Inicio, em modo "voce entrou".
 *
 * Nenhuma interpolacao de valor vindo do banco: o texto e constante. A primeira
 * interpolacao de verdade chega junto com o teste de HDR que afirma que valor
 * vindo do banco passa por `escapeHtml` — e a tag `` html`` `` ja faz isso por
 * padrao desde agora.
 */
export function handleInicio(_entrada: EntradaDaRota): Response {
  return pagina({
    titulo: 'Painel da automação',
    corpo: html`<h1>Voc&ecirc; est&aacute; no painel</h1>
<p>Sua entrada foi confirmada com a digital deste aparelho.</p>
<p>As telas de configura&ccedil;&atilde;o ainda est&atilde;o sendo montadas. Por enquanto, o que
j&aacute; funciona daqui:</p>
<ul>
<li><a href="/painel/parar">Parar a automa&ccedil;&atilde;o</a>, com o c&oacute;digo do papel.</li>
</ul>
<p>A automa&ccedil;&atilde;o continua rodando exatamente como est&aacute; configurada hoje. Nada do
que voc&ecirc; v&ecirc; aqui muda o comportamento dela.</p>`,
  })
}
