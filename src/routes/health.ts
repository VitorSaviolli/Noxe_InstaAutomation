import { carregarConfigEfetiva } from '../services/config-store'
import { painelHabilitado } from '../services/panel-session'
import type { Env } from '../types/env'
import { isAdmin } from './oauth'

/**
 * Health check publico.
 *
 * Nao expoe segredo nem estado sensivel: apenas se as pecas obrigatorias
 * estao presentes. Serve para monitoramento externo e para conferir um
 * deploy sem abrir o dashboard.
 */

/**
 * Os SEIS estados do painel, na ordem de precedencia em que sao resolvidos.
 *
 * A ordem e o contrato: `desativado` vence tudo (sem chave nao ha painel),
 * depois vem os dois graus de desamparo, e so no fim os tres `pronto_*`.
 */
export type EstadoDoPainel =
  | 'desativado'
  | 'sem_passkey'
  | 'sem_codigo_parada'
  | 'pronto_arquivo'
  | 'pronto_banco'
  | 'pronto_parado'

/** Os TRES valores que qualquer anonimo pode ver. */
export type EstadoPublicoDoPainel = 'desativado' | 'sem_acesso' | 'pronto'

/**
 * De seis para tres.
 *
 * POR QUE `sem_passkey` NAO PODE SER PUBLICO: o convite comum funciona
 * exatamente enquanto nao existe nenhuma credencial, e some no instante em que
 * a primeira passkey nasce. Publicar `sem_passkey` numa rota anonima entrega,
 * por polling de graca, o instante preciso em que um convite interceptado — ou
 * fotografado num tutorial — ainda vale. O valor mesclado `sem_acesso` nao
 * separa os dois estados, e essa fusao E a protecao.
 *
 * `sem_codigo_parada` acompanha pelo mesmo motivo: junto com `sem_passkey` ele
 * descreve o grau de desamparo do painel para quem ainda nao tem nada.
 *
 * Os tres `pronto_*` tambem so saem sob Bearer, e esses nao por ameaca: um enum
 * que muda de TAMANHO conforme quem pergunta e mais facil de testar do que um
 * que muda de CONTEUDO.
 */
export function comoPublico(estado: EstadoDoPainel): EstadoPublicoDoPainel {
  if (estado === 'desativado') return 'desativado'
  if (estado === 'sem_passkey' || estado === 'sem_codigo_parada') return 'sem_acesso'
  return 'pronto'
}

/**
 * O pedido traz o `SETUP_ADMIN_TOKEN` correto?
 *
 * Delega ao `isAdmin` de `oauth.ts`, que e o comparador UNICO das rotas
 * administrativas — o mesmo que `/setup/authorize`, `/setup/subscribe`,
 * `/setup/painel/codigos` e `/setup/painel/zerar` usam. A primeira versao desta
 * funcao repetia a comparacao aqui, e uma segunda copia de verificacao de
 * credencial e exatamente o lugar onde uma correcao de seguranca chega em um
 * arquivo e nao no outro.
 *
 * Sem `request` a resposta e nao, que e o lado seguro.
 */
function pediuComoDono(request: Request | undefined, env: Env): boolean {
  return request !== undefined && isAdmin(request, env)
}

export async function handleHealth(env: Env, now: number, request?: Request): Promise<Response> {
  const temToken = await hasStoredToken(env, now)

  // O detalhado so e calculado quando alguem tem direito de ve-lo. Para o
  // anonimo os tres `pronto_*` colapsam em `pronto`, entao a leitura da
  // configuracao — a unica consulta a mais dos tres — nao precisa acontecer.
  const comoDono = pediuComoDono(request, env)
  const estado = await estadoDoPainel(env, now, comoDono)

  return Response.json({
    status: 'ok',
    webhook: '/webhooks/instagram',
    configurado: {
      appId: env.META_APP_ID.length > 0,
      apiVersion: env.META_API_VERSION,
      contaAutorizada: temToken,
    },
    // EXATAMENTE um campo novo, e ele mora na RAIZ, irmao de `status` e
    // `webhook` — nunca dentro de `configurado`. E este caminho, `corpo.painel`,
    // que o teste "nenhum outro campo apareceu" percorre.
    painel: comoDono ? estado : comoPublico(estado),
  })
}

/**
 * Resolve o estado do painel, na ordem de precedencia de 11.9.
 *
 * `detalhado = false` para no primeiro degrau que ja decide a resposta publica:
 * distinguir `pronto_arquivo` de `pronto_banco` custaria uma leitura de
 * configuracao para entregar a mesma palavra `pronto`. Numa rota PUBLICA, que
 * um monitor externo consulta em laco, uma consulta que nao muda a resposta e
 * cota gasta a troco de nada.
 */
async function estadoDoPainel(env: Env, now: number, detalhado: boolean): Promise<EstadoDoPainel> {
  // Degrau 1, e ele nao custa consulta nenhuma: DELEGA ao mesmo predicado que
  // decide o 503 de toda rota do painel (§10.2), em vez de reescreve-lo aqui.
  //
  // **A primeira versao reescreveu, e mentia.** Ela conferia comprimento ZERO de
  // dois bindings; `painelHabilitado` exige TRES pisos — chave de sessao >= 32,
  // admin token >= 20, `rp_id` nao vazio. Entre os dois havia uma faixa inteira
  // de configuracao (uma chave de 31 caracteres, um caractere perdido no
  // copiar-e-colar) em que TODA tela respondia `503 painel_desativado` e esta
  // rota respondia `pronto` — e o assistente, lendo daqui, mandava o dono ficar
  // tranquilo. §11.9 abre dizendo que NAO existe `/painel/diagnostico`: este
  // campo e o unico diagnostico do subsistema, e ele mentia exatamente no caso
  // de ma configuracao que existe para nomear.
  //
  // Delegar tambem apagou os dois `?? ''` que estavam aqui: `painelHabilitado`
  // ja confere `typeof`, entao o TypeError que motivou aqueles operadores era
  // sintoma da copia, e nao um problema de verdade.
  if (!painelHabilitado(env).ok) return 'desativado'

  const acesso = await lerAcessoDoPainel(env)

  // Uma consulta que falhou nao pode virar `pronto`. O caso real e a migration
  // ainda nao aplicada: as tabelas do painel nao existem, ninguem consegue
  // entrar, e `sem_passkey` e exatamente a frase verdadeira — "ligado, mas
  // nenhuma credencial utilizavel".
  if (acesso === null) return 'sem_passkey'

  // A credencial conta so para o `rp_id` ATUAL. Credencial de endereco antigo e
  // inutil para entrar: trocar de endereco e re-registro, nao migracao.
  if (acesso.credenciais === 0) return 'sem_passkey'
  if (acesso.codigosDeParada === 0) return 'sem_codigo_parada'

  if (!detalhado) return 'pronto_arquivo'

  const snapshot = await carregarConfigEfetiva(env, now)
  if (snapshot.origem === 'banco') return 'pronto_banco'
  if (snapshot.origem === 'parado_por_erro') return 'pronto_parado'
  return 'pronto_arquivo'
}

/**
 * Quantas credenciais utilizaveis e quantos codigos de parada existem.
 *
 * UMA consulta, com as duas contagens como subconsultas escalares, e a escolha
 * e da rota e nao do gosto: `/health` e publica e um monitor a consulta em laco.
 * Duas consultas aqui dobrariam o custo de cada batida.
 *
 * Separada da leitura do token de proposito: se as tabelas do painel nao
 * existirem — migration nao aplicada —, o erro fica contido nesta funcao e
 * `contaAutorizada` continua respondendo a verdade sobre a conta.
 */
async function lerAcessoDoPainel(
  env: Env,
): Promise<{ credenciais: number; codigosDeParada: number } | null> {
  try {
    const linha = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM painel_credenciais WHERE rp_id = ?1) AS credenciais,
         (SELECT COUNT(*) FROM painel_codigos
           WHERE tipo = 'parada' AND usado_em IS NULL AND invalidado_em IS NULL) AS parada`,
    )
      .bind(env.PANEL_RP_ID)
      .first<{ credenciais: number; parada: number }>()

    if (linha === null) return null
    return { credenciais: linha.credenciais, codigosDeParada: linha.parada }
  } catch {
    return null
  }
}

/**
 * True se ja existe um token de conta gravado E ele ainda vale.
 *
 * `expires_at > ?` pelo mesmo motivo de `contaConectada` no painel: a linha
 * sobrevive ao token. Sem essa metade, `contaAutorizada: true` respondia
 * "autorizada" a um monitor externo dois meses depois de a conta ter morrido —
 * e o campo existe justamente para que alguem de fora perceba antes do dono.
 *
 * O `now` vem por parametro: o `fetch` do Worker ja tem o instante da
 * requisicao, e uma rota que chamasse `Date.now()` sozinha seria a primeira.
 */
async function hasStoredToken(env: Env, now: number): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      'SELECT 1 AS hit FROM account_tokens WHERE id = 1 AND expires_at > ?',
    )
      .bind(now)
      .first<{ hit: number }>()
    return row !== null
  } catch {
    return false
  }
}
