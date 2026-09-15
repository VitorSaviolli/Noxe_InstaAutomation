/**
 * Paginas publicas exigidas pela Meta na configuracao do app:
 * politica de privacidade e instrucoes de exclusao de dados.
 *
 * Sao HTML estatico servido pelo proprio Worker, sem dependencia externa,
 * sem custo e sempre no ar junto com a aplicacao.
 *
 * ================== LEIA ANTES DE PUBLICAR ==================
 * As duas constantes abaixo vem de fabrica com um texto de exemplo entre
 * colchetes. Voce PRECISA preencher as duas antes de submeter o app para
 * revisao da Meta: o revisor abre estas paginas, e pagina legal sem contato
 * costuma ser motivo de reprovacao.
 *
 * Enquanto o contato nao estiver preenchido, as paginas continuam
 * respondendo normalmente (a Meta exige que as URLs fiquem no ar), mas no
 * lugar do contato aparece um aviso honesto dizendo que o responsavel ainda
 * nao informou os dados. O texto entre colchetes nunca chega ao visitante.
 *
 * Pense duas vezes antes de colocar aqui o seu e-mail pessoal: esta pagina e
 * publica e fica exposta a robos de spam. Prefira um endereco criado so para
 * isso (por exemplo, contato@seudominio.com) ou o link de um formulario.
 * ============================================================
 */

/** Preencha antes de submeter o app para revisao da Meta. */
const CONTATO_EMAIL = '[SEU_EMAIL_DE_CONTATO]'
const NOME_RESPONSAVEL = '[NOME_DO_RESPONSAVEL]'

/**
 * Creditos do projeto, exibidos no rodape de toda pagina publica.
 *
 * Diferente das duas constantes acima, estes valores NAO mudam quando alguem
 * clona o projeto: eles dizem quem escreveu o software, nao quem opera esta
 * instalacao. Quem responde pelos dados de quem comenta e o dono da conta do
 * Instagram, e e isso que aparece no corpo da politica de privacidade.
 */
const AUTOR = 'Vitor S. Gonsalez'
const EMPRESA = 'Noxelora'
const REPOSITORIO = 'https://github.com/VitorSaviolli/Noxe_InstaAutomation'
const PIX = 'saviolligonsalez@gmail.com'

/**
 * Escapa o que poderia fechar uma tag ou um atributo no HTML.
 *
 * Hoje os valores vem de constantes deste proprio arquivo, entao nao ha risco.
 * A funcao existe para o dia em que alguem passar a ler esses dados de fora
 * (banco, variavel de ambiente, formulario): a interpolacao ja fica segura e
 * ninguem precisa lembrar de blindar depois.
 */
export function escapeHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * True quando o valor ainda e o texto de fabrica, e nao um dado de verdade.
 *
 * Mesma ideia do `isDestinationUrlConfigured` em src/config.ts: e mais seguro
 * detectar o placeholder do que confiar que a pessoa lembrou de trocar.
 */
export function isPlaceholder(valor: string): boolean {
  const limpo = valor.trim()
  if (limpo.length === 0) return true
  return limpo.startsWith('[') && limpo.endsWith(']')
}

/** So considera o contato pronto quando responsavel E e-mail foram preenchidos. */
function isContatoConfigurado(): boolean {
  return !isPlaceholder(NOME_RESPONSAVEL) && !isPlaceholder(CONTATO_EMAIL)
}

/**
 * Aviso exibido no lugar do contato quando o dono da instalacao nao preencheu.
 *
 * A pagina precisa continuar util para quem chegou nela, entao em vez de um
 * campo vazio o visitante recebe uma orientacao real de com quem falar.
 */
const AVISO_CONTATO_PENDENTE = `<p class="aviso">
<strong>Os dados de contato ainda não foram preenchidos.</strong><br>
Quem instalou esta automação ainda não informou o responsável nem um e-mail
nesta página. Para tratar de qualquer assunto sobre os seus dados, procure
diretamente o dono da conta do Instagram que utiliza esta automação, por
exemplo, por mensagem direta no perfil onde você viu a publicação, e peça o
contato do responsável.</p>`

/** Bloco "Contato", igual nas duas paginas. */
function blocoContato(): string {
  if (!isContatoConfigurado()) return AVISO_CONTATO_PENDENTE

  const responsavel = escapeHtml(NOME_RESPONSAVEL)
  const email = escapeHtml(CONTATO_EMAIL)
  return `<p>Responsável: ${responsavel}<br>E-mail: ${email}</p>`
}

/** Como pedir a remocao dos dados de quem apenas comentou. */
function paragrafoPedidoDeRemocao(): string {
  if (!isContatoConfigurado()) {
    return `<p>Para solicitar a remoção, procure o dono da conta do Instagram que utiliza
esta automação, por mensagem direta no perfil onde você comentou, e informe o link do
comentário. A exclusão é feita em até 30 dias.</p>`
  }

  return `<p>Para solicitar a remoção, envie um e-mail para
<strong>${escapeHtml(CONTATO_EMAIL)}</strong> com o link do comentário.
A exclusão é feita em até 30 dias.</p>`
}

/** Como apagar o token guardado, para o dono da conta conectada. */
function paragrafoRemocaoDoToken(): string {
  if (!isContatoConfigurado()) {
    return `<p>Revogar a autorização invalida o token imediatamente e interrompe a automação.
Para apagar também o token armazenado, fale com quem administra esta instalação.</p>`
  }

  return `<p>Revogar a autorização invalida o token imediatamente e interrompe a automação.
Para apagar também o token armazenado, envie um e-mail para ${escapeHtml(CONTATO_EMAIL)}.</p>`
}

/**
 * Monta a resposta HTML.
 *
 * `titulo` e texto puro e por isso passa pelo escape. `corpo` ja e HTML
 * montado aqui dentro, com os textos variaveis escapados na origem.
 */
function pagina(titulo: string, corpo: string): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titulo)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.6; max-width: 42rem; margin: 0 auto; padding: 2rem 1.25rem;
  }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  code { background: rgba(128,128,128,0.15); padding: 0.1em 0.35em; border-radius: 3px; }
  ul { padding-left: 1.25rem; }
  .aviso {
    border-left: 4px solid #b45309; background: rgba(180,83,9,0.12);
    padding: 0.75rem 1rem; border-radius: 4px;
  }
  .creditos {
    margin-top: 3rem; padding-top: 1.25rem; font-size: 0.85rem; opacity: 0.85;
    border-top: 1px solid rgba(128,128,128,0.35);
  }
  .creditos p { margin: 0.4rem 0; }
</style>
</head>
<body>
${corpo}
<footer class="creditos">
<p><strong>Software sem fins lucrativos.</strong> Este projeto não rouba e não coleta
informações de ninguém. Tudo o que ele guarda fica no banco de dados da própria pessoa
que o instalou, e nada é enviado ao autor do código nem a terceiros.</p>
<p>Desenvolvido por <strong>${escapeHtml(AUTOR)}</strong>, ${escapeHtml(EMPRESA)}.</p>
<p>Se o projeto deu certo para você, não esqueça de dar uma força com a sua
<strong>estrela no GitHub</strong>. É totalmente de graça e ajuda outras pessoas a
encontrarem o projeto: <a href="${escapeHtml(REPOSITORIO)}">${escapeHtml(REPOSITORIO)}</a></p>
<p>Quer fazer uma doação? PIX: <strong>${escapeHtml(PIX)}</strong>, isso ajuda a
manter projetos como este 100% gratuitos.</p>
</footer>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}

export function handlePrivacyPolicy(): Response {
  return pagina(
    'Política de Privacidade',
    `<h1>Política de Privacidade</h1>
<p>Esta aplicação automatiza respostas a comentários feitos em publicações de
uma conta profissional do Instagram, usando exclusivamente a API oficial da Meta.</p>

<h2>Quais dados são tratados</h2>
<ul>
  <li><strong>Identificador do comentário</strong>, para não responder duas vezes ao mesmo comentário.</li>
  <li><strong>Identificador da publicação</strong>, para saber qual automação aplicar.</li>
  <li><strong>Identificador do autor do comentário, em forma de hash irreversível</strong>,
      usado apenas para limitar quantas vezes a mesma pessoa aciona a automação
      num intervalo. O identificador original não é armazenado.</li>
  <li><strong>Token de acesso da conta</strong>, armazenado de forma criptografada.</li>
</ul>

<h2>O que NÃO é armazenado</h2>
<ul>
  <li>O texto do comentário.</li>
  <li>O nome de usuário de quem comentou.</li>
  <li>Qualquer conteúdo de mensagem privada.</li>
  <li>Senhas, a aplicação nunca solicita senha do Instagram.</li>
</ul>

<h2>O painel administrativo</h2>
<ul>
  <li><strong>O histórico das suas próprias mudanças</strong>, quando você altera a
      configuração pelo painel, o registro dessa alteração fica guardado no
      <em>seu</em> banco de dados, na sua conta da Cloudflare. Ele existe para
      você poder ver o que mudou e voltar atrás.</li>
  <li><strong>O nome de usuário na tela "O que aconteceu"</strong>, essa tela abre
      <em>sem</em> consultar o Instagram. Somente <strong>quando você pede</strong>, tocando no
      botão que busca os nomes, o painel pergunta ao Instagram, naquele momento, o
      @ de quem comentou nos comentários listados. Esse nome é usado apenas para
      desenhar a página e <strong>não é guardado</strong>: ele não vai para o banco
      de dados, não vai para os registros, e desaparece quando a página termina de
      carregar.</li>
  <li><strong>Metadados de requisição registrados pela Cloudflare</strong>, a Cloudflare,
      que hospeda esta aplicação, registra dados técnicos de cada acesso (como
      endereço IP e identificador da requisição). Isso acontece na infraestrutura
      dela, fora do controle deste código, e a retenção é definida pela
      Cloudflare.</li>
</ul>

<h2>Compartilhamento</h2>
<p>Nenhum dado é vendido, cedido ou compartilhado com terceiros. A comunicação
ocorre apenas entre esta aplicação e a API oficial da Meta.</p>

<h2>Retenção</h2>
<p>Os registros de comentários processados são mantidos apenas enquanto forem
necessários para impedir respostas duplicadas.</p>

<h2>Seus direitos</h2>
<p>Para solicitar a exclusão dos seus dados, veja
<a href="/data-deletion">as instruções de exclusão</a>.</p>

<h2>Contato</h2>
${blocoContato()}`,
  )
}

export function handleDataDeletion(): Response {
  return pagina(
    'Exclusão de Dados',
    `<h1>Instruções para Exclusão de Dados</h1>

<h2>Se você comentou em uma publicação</h2>
<p>O único dado guardado sobre você é um <strong>hash irreversível</strong> do seu
identificador, junto com o identificador do comentário. Não guardamos seu nome de
usuário nem o texto do comentário.</p>
${paragrafoPedidoDeRemocao()}

<h2>Se você é o dono da conta conectada</h2>
<p>Você pode revogar o acesso a qualquer momento, sem depender de nós:</p>
<ul>
  <li>No aplicativo do Instagram, vá em <code>Configurações e privacidade</code> →
      <code>Apps e sites</code> e remova a autorização desta aplicação.</li>
</ul>
${paragrafoRemocaoDoToken()}

<h2>Contato</h2>
${blocoContato()}`,
  )
}
