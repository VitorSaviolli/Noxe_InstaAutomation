/**
 * Aparelhos, codigos de recuperacao e revogacao: `GET+POST /painel/aparelhos`
 * e `POST /setup/painel/zerar` (§3, §10.11, §10.13, §10.14).
 *
 * **Esta e a rede de seguranca do dono, e por isso ela e a tela que mais
 * explica.** Todo o resto do painel muda o que a automacao faz; aqui se muda
 * QUEM entra. Um erro nas outras telas custa um Direct errado; um erro nesta
 * custa o painel inteiro, e o unico caminho de volta e um pedaco de papel.
 *
 * **As tres acoes tem exigencias DIFERENTES, e e por isso que a tabela de rotas
 * declara `stepUp: false`** (§7.1, §10.10, §15.4):
 *
 * | `acao` | step-up | por que |
 * |---|---|---|
 * | `remover_passkey` | **sim** | tira acesso de um aparelho e apaga as sessoes dele |
 * | `gerar_codigos` | **sim** | apaga o conjunto antigo INTEIRO e imprime um novo |
 * | `sair_de_tudo` | **nao** | desligar e barato: e a direcao segura de §10.10 |
 *
 * Cobrar biometria de "sair de todos os aparelhos" seria pedir a digital de
 * quem esta correndo para se proteger, e a versao comprimida do contrato
 * chegou a marcar a tela inteira como step-up "sim", o que §15.4 corrigiu
 * nomeando o caso.
 *
 * **A tela usa `telaDoPainel` com `comScript`**: ela e uma das que leem a
 * digital, e mora dentro de "Mais" na barra de baixo. O link da parada de
 * emergencia vem da barra do topo, como em toda tela.
 *
 * **Nunca o `credential_id` inteiro na tela** (§10.13). Sao tres destinos e uma
 * regra, tela, `console` e `painel_auditoria` veem o mesmo `passkey:<8 hex do
 * sha256>`, nunca o valor cru. O id cru existe nesta pagina em UM lugar so: o
 * `value` do campo escondido da remocao, porque o POST precisa dizer QUAL linha
 * apagar. Ele nao e segredo, quem tem a sessao ja pode le-lo, mas um
 * identificador inteiro escrito para a pessoa ler nao diferencia melhor que
 * oito caracteres e convida a copiar credencial para lugar nenhum.
 *
 * **A MARCACAO da tela mora em `aparelhos-tela.ts`.** O corte e por
 * responsabilidade, aqui, o que cada acao FAZ; la, como a tela se parece, e
 * o teto de 800 linhas foi so o gatilho: o arquivo unico chegou a 867. A
 * dependencia e de mao unica, e o vocabulario do formulario mora do lado de la,
 * com quem desenha os `<input>`.
 */
import {
  type AcaoDeAuditoria,
  PainelAuditoriaRepository,
} from '../../repositories/painel-auditoria-repository'
import { PainelCredenciaisRepository } from '../../repositories/painel-credenciais-repository'
import {
  FALHAS_DE_STEPUP_ATE_APAGAR,
  type LinhaDeSessao,
  PainelSessoesRepository,
} from '../../repositories/painel-sessoes-repository'
import { formatarCodigo } from '../../services/panel-codes'
import { fichaCsrf, rotacionarSessao } from '../../services/panel-session'
import { prefixoDeCredencial } from '../../services/webauthn/verificar'
import type { Env } from '../../types/env'
import { isAdmin } from '../oauth'
import {
  ACAO_GERAR_CODIGOS,
  ACAO_REMOVER,
  ACAO_SAIR_DE_TUDO,
  CAMPO_DO_APARELHO,
  resumoDoAparelho,
  telaDeAparelhos,
  telaDeConferencia,
} from './aparelhos-tela'
import { CAMPO_DA_ACAO, CAMPO_DA_DIGITAL, COOKIE_DA_SESSAO, cookieDoPainel } from './campos'
import { CAMINHO_DE_ENTRAR } from './guardas'
import { type HtmlSeguro, html, pagina } from './html'
import { conjuntoNovoDeCodigos } from './parada'
import { erro, redirecionar } from './resposta'
import { ROTA_APARELHOS } from './rotas'
import type { EntradaDaRota } from './router'
import { cookieDeStepUpExpirado, exigirStepUp, type MudancaCanonica, opHash } from './stepup'

/**
 * O nome CANONICO da remocao, o que entra no `op_hash` (§10.10, §10.13).
 *
 * Ele fica AQUI, e nao com o vocabulario da tela, porque sao dois espacos de
 * nomes diferentes: `ACAO_REMOVER` (`remover`) e o que o formulario posta e a
 * pessoa poderia ler; este e o que o autenticador assina. Escrito uma vez so:
 * uma segunda grafia produziria um hash que nao fecha com o que o `painel.js`
 * mandou assinar, e a recusa apareceria como "confirme de novo" sem nunca
 * funcionar.
 */
const ACAO_CANONICA_DE_REMOVER = 'remover_passkey'

// ---------------------------------------------------------------------------
// GET /painel/aparelhos, a tela
// ---------------------------------------------------------------------------

/**
 * `GET+POST /painel/aparelhos`.
 *
 * Custo do GET: **2 leituras**, os aparelhos e quantos codigos de recuperacao
 * ainda valem. Elas nao entram num lote so porque as duas respostas alimentam
 * partes diferentes da pagina e o `db.batch()` do painel existe para prender
 * escritas juntas (§8.8), nao para economizar leitura de tela; e esta tela nao
 * esta no orcamento fechado de §12.10, que vale para as telas do dia a dia.
 * Zero escrita no GET, como toda tela de leitura (§6).
 */
export async function handleAparelhos(entrada: EntradaDaRota): Promise<Response> {
  const { request, corpo, contexto, sessao } = entrada

  // Inalcancavel pela tabela (`sessao: true`), e ainda assim respondido com o
  // codigo que §11.4 escreve para ele: a tabela canonica nao admite aproximacao.
  if (sessao === null) return erro('sessao_ausente', contexto)

  // A faixa verde nasce do `?ok=`, e quem a le e a TELA: ela e a dona da lista
  // fechada de codigos, e um segundo lugar consultando `fraseDeConfirmacao`
  // seria a segunda grafia da mesma regra.
  if (request.method !== 'POST') return await telaDeAparelhos(entrada, sessao)

  if (corpo.familia !== 'formulario') return erro('corpo_invalido', contexto)
  const campos = corpo.campos

  switch (campos.get(CAMPO_DA_ACAO)) {
    case ACAO_SAIR_DE_TUDO:
      return await sairDeTudo(entrada, sessao)
    case ACAO_REMOVER:
      return await removerAparelho(entrada, sessao, campos)
    case ACAO_GERAR_CODIGOS:
      return await gerarCodigos(entrada, sessao, campos)
    default:
      // Um `acao` que a rota nao conhece e cliente adulterado ou botao que
      // ninguem desenhou, §9.2 proibe conserto nas duas hipoteses.
      return erro('dados_invalidos', { ...contexto, motivoInterno: 'acao_desconhecida' })
  }
}

// ---------------------------------------------------------------------------
// O step-up desta rota (§10.10, §10.13)
// ---------------------------------------------------------------------------

/** O desfecho do passo 8, do mesmo jeito que o funil de gravacao o tem. */
type Passagem = { readonly resposta: Response } | { readonly credentialId: string }

/**
 * A cerimonia de §10.10 aplicada a uma acao desta tela.
 *
 * E a MESMA `exigirStepUp` do funil de gravacao, com o MESMO `op_hash`
 * recalculado no servidor: nao existe um segundo verificador, e e por isso que
 * uma digital colhida para trocar o link do Direct nao remove aparelho nenhum.
 *
 * **O que muda em relacao a `passarPeloStepUp` e so o que esta rota nao tem**:
 * nao ha campos de configuracao para classificar (as duas acoes protegidas sao
 * protegidas SEMPRE, e nao conforme o conteudo), nao ha trava otimista de
 * versao e nao ha `SnapshotConfig`, a linha de auditoria sai com `versao: 0`,
 * o mesmo carimbo que `codigos_gerados` ja usa, porque perguntar a versao da
 * configuracao custaria uma leitura de `painel_config` que esta rota nao tem no
 * orcamento e que nada aqui altera (§9.9).
 *
 * Os dois desfechos de recusa sao o MESMO `403 step_up_necessario` com a MESMA
 * linha de auditoria; o que os separa nao aparece na resposta: a falha INVALIDA
 * incrementa `falhas_stepup`, a AUSENTE nao. Ausente e o primeiro envio, o
 * caminho normal de quem apertou o botao.
 */
async function passarPeloStepUp(
  entrada: EntradaDaRota,
  sessao: LinhaDeSessao,
  campos: URLSearchParams,
  mudanca: MudancaCanonica,
  /**
   * O bloco que explica a recusa, montado SO quando ha recusa.
   *
   * E uma funcao, e nao um `HtmlSeguro` pronto, porque a explicacao da remocao
   * precisa LER a linha do aparelho para mostrar de qual aparelho se trata
   * (§10.10). Pronta no call site, essa leitura seria paga tambem pelo envio que
   * ja traz a digital, o caminho que nao desenha tela nenhuma.
   */
  explicacao: () => HtmlSeguro | Promise<HtmlSeguro>,
  /**
   * O `alvo` da LINHA DE AUDITORIA, ja recortado, nunca `mudanca.alvo`.
   *
   * Os dois sao a mesma entidade em vocabularios diferentes: a mudanca canonica
   * carrega o `credential_id` inteiro, porque e ele que entra no `op_hash` e o
   * hash tem de fechar com o que o cliente assinou; a coluna `alvo` guarda o
   * `passkey:<8 hex>` de §9.9. Passar a mudanca direto para a auditoria escrevia
   * o id cru no banco, o terceiro dos tres destinos que §10.13 proibe, e a
   * coluna, que tem `CHECK (length(alvo) <= 32)`, derrubava a recusa inteira em
   * `500`: a tela de conferencia nunca chegava a aparecer.
   */
  alvoAuditado: string | null,
): Promise<Passagem> {
  const { request, env, now, contexto } = entrada

  const opHashDeAgora = await opHash(mudanca)
  const ficha = await fichaCsrf(env, sessao.sidHash)
  const ator = await atorDaLinha(sessao.credentialId)

  const recusar = async (
    motivoInterno: string,
    extras: readonly D1PreparedStatement[],
  ): Promise<Passagem> => {
    const linha = new PainelAuditoriaRepository(env.DB).statementDeRegistro({
      ocorridoEm: now,
      versao: 0,
      origem: 'painel',
      ator,
      // A recusa NUNCA e uma passagem com step-up: ou ele faltou, ou nao fechou.
      stepUp: false,
      acao: 'stepup_recusado',
      alvo: alvoAuditado,
      campos: JSON.stringify([mudanca.acao]),
      antes: null,
      depois: null,
    })

    if (extras.length === 0) await linha.run()
    else await env.DB.batch([linha, ...extras])

    return {
      resposta: erro('step_up_necessario', {
        ...contexto,
        motivoInterno,
        comScript: true,
        explicacao: html`${await explicacao()}${telaDeConferencia(mudanca, campos, ficha)}`,
      }),
    }
  }

  const digital = campos.get(CAMPO_DA_DIGITAL) ?? ''
  if (digital === '') return await recusar('step_up_ausente', [])

  const veredito = await exigirStepUp({
    request,
    env,
    now,
    sidHash: sessao.sidHash,
    digital,
    opHashDeAgora,
  })
  if (veredito.ok) return { credentialId: veredito.credentialId }

  const sessoes = new PainelSessoesRepository(env.DB)
  const decima = sessao.falhasStepup + 1 >= FALHAS_DE_STEPUP_ATE_APAGAR

  return await recusar(veredito.motivo, [
    decima
      ? sessoes.statementDeApagar(sessao.sidHash)
      : sessoes.statementDeFalhaDeStepup(sessao.sidHash),
  ])
}

// ---------------------------------------------------------------------------
// acao=sair_de_tudo, sessao + ficha, e NENHUM step-up (§10.13, §15.4)
// ---------------------------------------------------------------------------

/**
 * "Sair de todos os aparelhos": `DELETE FROM painel_sessoes`, **1 escrita**,
 * mais a linha de auditoria, no mesmo lote (§8.8).
 *
 * **O `303` aponta para `/painel/entrar`, e nao para esta tela.** E a unica
 * excecao a regra de forma de §7.1 nesta rota, e ela e forcada pelo proprio
 * efeito: a acao apaga a sessao de quem apertou, entao um `303` para
 * `/painel/aparelhos` cairia no `303` do passo 6 da escada e a frase de
 * confirmacao morreria no caminho. Mandar direto para a tela onde a pessoa
 * esta a partir daquele instante e o que faz o gesto nao parecer uma falha.
 *
 * O cookie sai com `Max-Age=0` junto: a linha ja nao existe e o cookie ja nao
 * vale, mas deixar um cookie morto no navegador e pedir para a proxima
 * requisicao gastar um HMAC para descobrir isso.
 */
async function sairDeTudo(entrada: EntradaDaRota, sessao: LinhaDeSessao): Promise<Response> {
  const { env, now } = entrada

  const ator = await atorDaLinha(sessao.credentialId)

  await env.DB.batch([
    new PainelSessoesRepository(env.DB).statementDeApagarTodas(),
    linhaDeAuditoria(env, now, {
      acao: 'sessao_encerrada',
      alvo: null,
      campos: [ACAO_SAIR_DE_TUDO],
      // A coluna responde "esta mudanca passou pela digital?", e aqui a resposta
      // e nao, de proposito (§10.10: desligar e a direcao segura).
      stepUp: false,
      ator,
    }),
  ])

  return redirecionar(`${CAMINHO_DE_ENTRAR}?ok=saiu_de_tudo`, {}, [
    cookieDoPainel(COOKIE_DA_SESSAO, '', 0),
  ])
}

// ---------------------------------------------------------------------------
// acao=remover_passkey, step-up, e a regra da ultima (§10.13)
// ---------------------------------------------------------------------------

/**
 * Remove um aparelho, com a regra da ultima DENTRO da instrucao.
 *
 * O lote e uma CADEIA de `changes()`, e a ordem dele e parte da garantia:
 *
 *   1. `DELETE` da credencial, altera 0 ou 1 linha, e a subconsulta de
 *      `statementDeRemocao` e quem responde "esta e a ultima DESTE endereco?"
 *      de forma atomica;
 *   2. a linha de auditoria, `presoAMudanca`, so entra se (1) apagou;
 *   3. a rotacao do `sid`, `presoAMudanca`, so entra se (2) inseriu;
 *   4. `DELETE` das sessoes daquela credencial, `presoAMudanca`, so entra se
 *      (3) rotacionou, isto e, se (1) apagou.
 *
 * O `changes()` do SQLite vale a contagem do statement IMEDIATAMENTE anterior,
 * entao a auditoria tem de vir logo depois da remocao, se as sessoes viessem
 * no meio, um aparelho sem nenhuma sessao aberta faria `changes()` valer 0 e a
 * linha de auditoria sumiria de uma remocao que aconteceu.
 *
 * Sem o passo 4 a remocao nao seria revogacao: o aparelho removido continuaria
 * dentro do painel ate o prazo ocioso de 2 h vencer.
 *
 * **A rotacao do `sid` entra em TERCEIRO, e a posicao e a mesma garantia.** Ela
 * so pode acontecer se a remocao aconteceu, senao o dono seria deslogado por
 * uma remocao recusada, sem sequer receber o cookie novo, e o `changes()` que
 * ela le tem de ser o da linha de auditoria, que vale 1 exatamente quando o
 * `DELETE` apagou. Posta no FIM, ela leria o `changes()` do `DELETE` das
 * sessoes, que e 0 sempre que o aparelho removido nao tinha sessao aberta: o
 * `sid` no banco ficaria o antigo e a resposta mandaria um cookie novo, o dono
 * deslogado por uma remocao que deu certo. E o `DELETE` das sessoes, agora
 * preso ao `changes()` da rotacao, continua correto: a rotacao altera a linha da
 * sessao de quem esta pedindo, que acabou de passar por `exigirSessaoViva` e
 * esta dentro da mesma transacao, 1 linha, sempre.
 */
async function removerAparelho(
  entrada: EntradaDaRota,
  sessao: LinhaDeSessao,
  campos: URLSearchParams,
): Promise<Response> {
  const { env, now, contexto } = entrada

  const alvo = campos.get(CAMPO_DO_APARELHO) ?? ''
  if (alvo === '') {
    return erro('dados_invalidos', { ...contexto, motivoInterno: 'aparelho_ausente' })
  }

  // **O `alvo` da mudanca canonica, e nao um campo** (Ruling 96): o `op_hash`
  // amarra a assinatura AQUELE aparelho, entao um painel invadido nao troca a
  // linha depois que o dono ja encostou o dedo. §10.13 escreve a mudanca como
  // `{acao, credential_id}`; a forma canonica deste projeto ja tem um lugar
  // para "a entidade que a mudanca alcanca", e por um campo de nome livre a
  // mesma informacao teria duas grafias.
  const mudanca: MudancaCanonica = { acao: ACAO_CANONICA_DE_REMOVER, alvo, campos: {} }
  const alvoAuditado = await prefixoDeCredencial(alvo)

  const passagem = await passarPeloStepUp(
    entrada,
    sessao,
    campos,
    mudanca,
    // "Confira o aparelho abaixo" so e verdade porque `resumoDoAparelho` desenha
    // o aparelho abaixo (§10.10): a frase existia antes dele, e apontava para
    // uma tela onde nao havia aparelho nenhum, nem apelido, nem data, nem o
    // prefixo de 8 hex, nem o aviso de §10.13 sobre o aparelho de agora.
    async () => html`<p>Remover um aparelho tira o acesso dele <strong>na hora</strong>: se ele
estiver dentro do painel, sai. Confira o aparelho abaixo antes de confirmar.</p>
${await resumoDoAparelho(env, alvo, sessao)}`,
    alvoAuditado,
  )
  if ('resposta' in passagem) return passagem.resposta

  const credenciais = new PainelCredenciaisRepository(env.DB)
  const sessoes = new PainelSessoesRepository(env.DB)

  // §10.8: o `sid` rotaciona em exatamente dois momentos, e este e o segundo,
  // a sessao muda de "conseguiu ler" para "acabou de autorizar". O prazo
  // absoluto e o que JA estava valendo: SES-01 diz que ele nunca e estendido.
  const sessaoNova = await rotacionarSessao(env, sessao.expiraEm)

  const lote = await env.DB.batch([
    credenciais.statementDeRemocao(alvo, env.PANEL_RP_ID),
    linhaDeAuditoria(
      env,
      now,
      {
        acao: 'passkey_removida',
        alvo: alvoAuditado,
        campos: [ACAO_CANONICA_DE_REMOVER],
        stepUp: true,
        // A credencial que ASSINOU, e nao a que abriu a sessao: num painel com
        // varios aparelhos as duas nem sempre coincidem, e §9.9 quer a primeira.
        ator: await atorDaLinha(passagem.credentialId),
      },
      { presoAMudanca: true },
    ),
    sessoes.statementDeRotacao(sessao.sidHash, sessaoNova.sidHash, { presoAMudanca: true }),
    sessoes.statementDeApagarDaCredencial(alvo, { presoAMudanca: true }),
  ])

  // `changes === 0` e a regra da ultima falando (§10.13), e tambem um `alvo`
  // que nao existe, inclusive o reenvio de uma remocao que outra aba ja fez.
  // As duas respostas sao a mesma frase de propósito: o que a pessoa precisa
  // saber e que ela precisa de outro aparelho antes.
  //
  // Uma credencial de ENDERECO ANTIGO ja nao cai mais aqui: ela sai livre, como
  // §10.14 desenha e como o cartao dela promete. Enquanto caia, esta frase era
  // uma mentira sem saida, "cadastre outra passkey" com duas cadastradas.
  if ((lote[0]?.meta.changes ?? 0) === 0) {
    return erro('ultima_passkey', { ...contexto, motivoInterno: 'remocao_sem_efeito' })
  }

  // §10.10, fim do passo 4: aplica, **expira o cookie**, rotaciona o `sid`,
  // responde `303`. Os dois `Set-Cookie` juntos sao o que garante que o mesmo
  // step-up nao serve para duas operacoes: o envelope morre, e o `sid` que a
  // assinatura dele nomeia deixa de existir. Sem eles, e ate esta linha nao
  // havia nenhum, o par (envelope + assertion) que o dono acabou de produzir
  // continuava fechando pelo resto dos 120 s, e um gesto de biometria
  // autorizava N operacoes: exatamente o "modo privilegiado por 120 s" que o
  // cabecalho de `stepup.ts` diz que o desenho recusou.
  //
  // Quando o aparelho removido E o desta sessao, o cookie novo nomeia uma linha
  // que o passo 4 do lote acabou de apagar. E o desfecho certo e o que a tela
  // avisa antes (§10.13): o dono sai do painel na hora.
  return redirecionar(`${ROTA_APARELHOS.caminho}?ok=aparelho_removido`, {}, [
    cookieDoPainel(
      COOKIE_DA_SESSAO,
      sessaoNova.valor,
      Math.floor((sessaoNova.expiraEm - now) / 1000),
    ),
    cookieDeStepUpExpirado(),
  ])
}

// ---------------------------------------------------------------------------
// acao=gerar_codigos, step-up, e os codigos aparecem UMA vez (§10.11)
// ---------------------------------------------------------------------------

/**
 * O conjunto novo de codigos, gerado pela TELA (§10.11).
 *
 * E a mesma operacao de `POST /setup/painel/codigos`, com a mesma funcao a
 * sortear e a montar os statements, o que muda e quem autoriza: la, o
 * `SETUP_ADMIN_TOKEN` do assistente; aqui, sessao + ficha + step-up.
 *
 * **Esta e a unica escrita do painel que responde `200` e nao `303`**, e a
 * excecao a regra de forma de §7.1 e forcada pelo conteudo: os codigos sao
 * mostrados UMA vez e nunca mais. Um `303` os jogaria fora entre a gravacao e a
 * tela seguinte, e o dono ficaria com um conjunto novo que ninguem anotou,
 * pior do que nao ter gerado, porque o antigo ja foi apagado.
 *
 * **O corpo desta resposta nunca e logado**, em nenhum nivel (§10.11).
 */
async function gerarCodigos(
  entrada: EntradaDaRota,
  sessao: LinhaDeSessao,
  campos: URLSearchParams,
): Promise<Response> {
  const { env, now } = entrada

  const mudanca: MudancaCanonica = { acao: ACAO_GERAR_CODIGOS, campos: {} }
  const passagem = await passarPeloStepUp(
    entrada,
    sessao,
    campos,
    mudanca,
    () => html`<p>Gerar c&oacute;digos novos <strong>apaga os antigos</strong>, inclusive o
c&oacute;digo de emerg&ecirc;ncia. Tenha onde anotar antes de confirmar.</p>`,
    null,
  )
  if ('resposta' in passagem) return passagem.resposta

  const conjunto = await conjuntoNovoDeCodigos(env, now)

  // A segunda metade do passo 4 de §10.10, que faltava aqui: rotacionar o
  // `sid`. Expirar o cookie sozinho protege o navegador do dono e nao protege
  // de quem ja copiou o valor do envelope, e o inimigo nomeado por §10.10 e um
  // painel invadido. Como a assinatura do envelope nomeia o `sid`, e a rotacao
  // que o mata de verdade. Sem `presoAMudanca`: `db.batch` e uma transacao, e
  // ou tudo grava ou nada grava, nao ha aqui trava otimista que altere zero
  // linhas em silencio, como ha no funil de configuracao.
  const sessaoNova = await rotacionarSessao(env, sessao.expiraEm)

  await env.DB.batch([
    ...conjunto.statements,
    linhaDeAuditoria(env, now, {
      acao: 'codigos_gerados',
      alvo: null,
      campos: [ACAO_GERAR_CODIGOS],
      stepUp: true,
      ator: await atorDaLinha(passagem.credentialId),
    }),
    new PainelSessoesRepository(env.DB).statementDeRotacao(sessao.sidHash, sessaoNova.sidHash),
  ])

  const resposta = pagina({
    titulo: 'Anote estes códigos agora',
    // Mesmo motivo do `303` da remocao: o envelope ja foi gasto.
    extras: {
      'set-cookie': cookieDoPainel(
        COOKIE_DA_SESSAO,
        sessaoNova.valor,
        Math.floor((sessaoNova.expiraEm - now) / 1000),
      ),
    },
    corpo: html`<main>
<h1>Anote estes c&oacute;digos agora</h1>
<p><strong>Eles aparecem uma vez s&oacute;.</strong> Escreva no papel, guarde num lugar seguro e
n&atilde;o tire foto: uma foto no celular fica junto do aparelho que os c&oacute;digos existem para
substituir.</p>
<h2>C&oacute;digos de recupera&ccedil;&atilde;o, para cadastrar um aparelho quando voc&ecirc; n&atilde;o tiver nenhum</h2>
<ul class="codigos">${conjunto.recuperacao.map(
      (codigo) => html`<li><code>${formatarCodigo(codigo)}</code></li>`,
    )}</ul>
<h2>C&oacute;digo de emerg&ecirc;ncia, para parar a automa&ccedil;&atilde;o sem entrar no painel</h2>
<p><code>${formatarCodigo(conjunto.parada)}</code></p>
<p>Os c&oacute;digos anteriores <strong>deixaram de valer agora</strong>. Se voc&ecirc; tinha um
papel antigo, rasgue.</p>
<p><a href="${ROTA_APARELHOS.caminho}">J&aacute; anotei, voltar</a></p>
</main>`,
  })

  // O SEGUNDO `Set-Cookie` vai por `append`, e nao por `extras`: aquele campo e
  // um `Record<string, string>` e nao consegue ter a mesma chave duas vezes, o
  // segundo cookie apagaria o primeiro em silencio, e o silencio seria "o dono
  // deslogado" ou "o envelope vivo depois de usado", conforme qual sobrasse.
  resposta.headers.append('set-cookie', cookieDeStepUpExpirado())
  return resposta
}

// ---------------------------------------------------------------------------
// A linha de auditoria desta rota
// ---------------------------------------------------------------------------

/**
 * A linha de `painel_auditoria` de uma acao desta tela.
 *
 * `versao: 0` porque nada aqui muda a configuracao, e perguntar a versao atual
 * custaria uma leitura de `painel_config` que esta rota nao tem no orcamento,
 * o mesmo `0` que `codigos_gerados` e `login` ja usam (§9.9).
 *
 * O `ator` e a credencial que AUTORIZOU quando houve step-up, e a que abriu a
 * sessao quando nao houve: §9.9 quer saber quem assinou, e num painel com
 * varios aparelhos as duas nem sempre coincidem.
 */
function linhaDeAuditoria(
  env: Env,
  now: number,
  evento: {
    acao: AcaoDeAuditoria
    alvo: string | null
    campos: readonly string[]
    stepUp: boolean
    /** Ja no formato `passkey:<8 hex>`. Nunca o `credential_id` cru (§9.9). */
    ator: string
  },
  opcoes: { presoAMudanca?: boolean } = {},
): D1PreparedStatement {
  return new PainelAuditoriaRepository(env.DB).statementDeRegistro(
    {
      ocorridoEm: now,
      versao: 0,
      origem: 'painel',
      ator: evento.ator,
      stepUp: evento.stepUp,
      acao: evento.acao,
      alvo: evento.alvo,
      campos: JSON.stringify([...evento.campos]),
      antes: null,
      depois: null,
    },
    opcoes,
  )
}

/**
 * O `ator` de §9.9: `passkey:<8 hex do sha256 do credential_id>`.
 *
 * Ele e `async` e por isso e resolvido ANTES da montagem do array do lote,
 * um `await` dentro do array espalharia a mesma conversao por cinco lugares, e
 * o primeiro que a esquecesse gravaria o `credential_id` cru, que e o terceiro
 * destino que §10.13 proibe.
 */
async function atorDaLinha(credentialId: string): Promise<string> {
  return `passkey:${await prefixoDeCredencial(credentialId)}`
}

// ---------------------------------------------------------------------------
// POST /setup/painel/zerar, a porta do assistente (§7.1, §10.8)
// ---------------------------------------------------------------------------

/**
 * `POST /setup/painel/zerar`: apaga sessoes e, se pedido, credenciais.
 *
 * **Nao e caminho de painel.** Ela e do assistente local, autenticada por
 * Bearer, e mora ao lado de `/setup/painel/codigos` pelo mesmo motivo: quem
 * chega aqui nao tem sessao, na maioria das vezes porque nao consegue mais ter
 * uma. Ela e o ultimo recurso quando o dono perdeu todos os aparelhos E o papel
 * dos codigos, e o preco de usa-la e cadastrar tudo de novo por um convite.
 *
 * **`?tudo=1` e o que apaga as credenciais**, e o padrao apaga so as sessoes. A assimetria e deliberada:
 * derrubar sessoes e reversivel (basta entrar de novo) e apagar credenciais nao
 * e. Uma rota administrativa cujo comportamento padrao e o irreversivel seria a
 * pior forma de um comando digitado errado.
 *
 * **Ela NAO toca `account_tokens`**, e a regressao escrita em §13.2. A conexao
 * com o Instagram nao e acesso ao painel, e derruba-la junto faria uma rota de
 * recuperacao de acesso desligar a automacao de quem so queria voltar a entrar.
 */
export async function handleZerarAcesso(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  if (request.method !== 'POST') {
    return respostaDeTexto('Metodo nao permitido', 405, { allow: 'POST' })
  }

  // Bearer, nunca cookie e nunca query string, a mesma porta das irmas de
  // `/setup/*`, com o mesmo comparador em tempo constante. Como elas, ela NAO
  // registra nada em log: §11.4 e a tabela do painel, e quem nao e painel nao
  // se anuncia como `painel:`.
  if (!isAdmin(request, env)) return respostaDeTexto('Nao autorizado', 401)

  const url = new URL(request.url)
  const apagarCredenciais = url.searchParams.get('tudo') === '1'

  const sessoes = new PainelSessoesRepository(env.DB)
  const credenciais = new PainelCredenciaisRepository(env.DB)

  // Sem log, sem mudanca (§8.8): a linha de auditoria vai no MESMO lote. O
  // `ator` e `'assistente'`, constante, como em `codigos_gerados`, quem chamou
  // provou o `SETUP_ADMIN_TOKEN` e nao ha credencial nenhuma a nomear.
  await env.DB.batch([
    sessoes.statementDeApagarTodas(),
    ...(apagarCredenciais ? [credenciais.statementDeApagarTodas()] : []),
    new PainelAuditoriaRepository(env.DB).statementDeRegistro({
      ocorridoEm: now,
      versao: 0,
      origem: 'assistente',
      ator: 'assistente',
      stepUp: false,
      acao: 'acesso_zerado',
      alvo: null,
      campos: JSON.stringify(apagarCredenciais ? ['sessoes', 'aparelhos'] : ['sessoes']),
      antes: null,
      depois: null,
    }),
  ])

  // A forma da resposta e a das IRMAS de `/setup/*`, e nao a do painel
  // (Ruling 19): `Response.json` com os dois cabecalhos que `/setup/painel/
  // codigos` ja usa. O `json()` de `resposta.ts` carimba a CSP e o `sandbox` da
  // familia `/painel/api/*`, e esta rota nao e dessa familia, quem nao e
  // painel nao se veste de painel.
  return Response.json(
    {
      ok: true,
      sessoes: 'apagadas',
      aparelhos: apagarCredenciais ? 'apagados' : 'mantidos',
      instrucoes: apagarCredenciais
        ? 'Nenhum aparelho entra mais. Gere um convite novo para cadastrar o primeiro.'
        : 'As sessoes abertas foram encerradas. Os aparelhos cadastrados continuam entrando.',
    },
    { headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } },
  )
}

/** A resposta de texto das rotas `/setup/*`, igual a das irmas de `oauth.ts`. */
function respostaDeTexto(
  corpo: string,
  status: number,
  extras: Record<string, string> = {},
): Response {
  return new Response(corpo, {
    status,
    headers: {
      ...extras,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}
