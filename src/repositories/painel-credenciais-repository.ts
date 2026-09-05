/**
 * `painel_credenciais`: as passkeys do dono, no D1 dele.
 *
 * Como nos outros repositorios do painel, aqui nao existe regra de produto:
 * este arquivo devolve LINHAS e devolve STATEMENTS. Quem verifica attestation
 * e assertion e `src/services/webauthn/`; quem decide o que fazer com o
 * resultado sao as rotas.
 *
 * **Lema 1 de §10.6 mora neste arquivo.** `INSERT INTO painel_credenciais`
 * aparece em EXATAMENTE um lugar de `src/`, e e o `statementDeInsercao` daqui.
 * Um teste de `tests/painel-convite.test.ts` varre `src/` e fica vermelho se a
 * string aparecer num segundo arquivo — sem ele, o lema envelheceria mal: o
 * teorema de §10.6 vale porque so existe UM caminho de insercao, e um segundo
 * caminho escrito de boa fe amanha nao acionaria nenhum alarme.
 *
 * A chave publica e guardada em JWK, em texto: ela e PUBLICA, e cifra-la seria
 * teatro. O que nunca entra aqui e o `credential_id` em log ou em tela — para
 * esses dois destinos existe `prefixoDeCredencial()` (§10.13).
 */

/**
 * Tamanho do `usuario_handle`: 32 bytes sorteados, em base64url (§10.4).
 *
 * E o `user.id` do WebAuthn, e ele precisa ser ESTAVEL para sempre: se mudasse,
 * cada registro criaria uma conta separada no gerenciador de senhas do celular
 * em vez de agrupar as passkeys do dono.
 */
const HANDLE_BYTES = 32

import { bytesToBase64Url } from '../security/base64url'
import type { CredencialGuardada } from '../services/webauthn/verificar'

/** Como a credencial entrou no banco (§8.6). Nao existe uma quarta origem. */
export type OrigemDeRegistro = 'convite' | 'sessao' | 'recuperacao'

/**
 * O par `{credential_id, rp_id}` de todas as linhas.
 *
 * As duas colunas vem juntas porque as tres perguntas do registro se respondem
 * com UMA leitura: quais credenciais excluir no `excludeCredentials` deste
 * `rp_id`, se ja existe alguma credencial (a regra do `pre=0`) e quantas ha
 * neste `rp_id` (o teto de 10). Tres consultas separadas dariam a mesma
 * resposta por tres vezes o preco, num teto de no maximo dez linhas.
 */
export interface CredencialConhecida {
  credentialId: string
  rpId: string
}

/**
 * O que o login carrega numa consulta so: o dono da instalacao e a credencial.
 *
 * `credencial: null` significa "este `credential_id` nao existe" — e nao um
 * erro. Quem responde igual para credencial desconhecida e para assinatura
 * invalida e a rota, e e o que fecha o oraculo de enumeracao de §11.4.
 */
export interface LeituraDeLogin {
  /** `painel_estado.usuario_handle`, o `user.id` estavel da instalacao. */
  handleDoDono: string
  credencial: CredencialGuardada | null
}

/** Uma linha pronta para gravar. Sai da verificacao da attestation (§10.5). */
export interface CredencialParaGravar {
  credentialId: string
  rpId: string
  usuarioHandle: string
  /** JWK em JSON. Ja passou por `importKey` antes de chegar aqui (§10.5). */
  chavePublicaJwk: string
  algoritmo: number
  /** JSON array; so dica de interface, nunca decisao (§8.6). */
  transportes: string | null
  signCount: number
  backupElegivel: boolean
  backupAtivo: boolean
  apelido: string
  origemRegistro: OrigemDeRegistro
  criadoEm: number
}

export class PainelCredenciaisRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Todas as credenciais, com o `rp_id` de cada uma. UMA leitura.
   *
   * Traz TODAS, e nao so as do `rp_id` de hoje, porque a regra do `pre=0` de
   * §10.4 pergunta se existe *alguma* credencial: uma passkey criada no
   * endereco antigo prova que a instalacao ja teve um dono, mesmo que ela nao
   * sirva mais para entrar (§10.14). Filtrar pelo `rp_id` aqui faria um
   * convite de primeira instalacao voltar a funcionar so porque o endereco do
   * painel mudou — exatamente o instante em que ele nao pode funcionar.
   *
   * O teto de 10 por `rp_id` mantem esta lista pequena por construcao.
   */
  async listarTodas(): Promise<CredencialConhecida[]> {
    const resultado = await this.db
      .prepare('SELECT credential_id, rp_id FROM painel_credenciais')
      .all<{ credential_id: string; rp_id: string }>()

    if (resultado.success !== true) {
      throw new Error('D1_ERROR: a leitura das credenciais do painel nao reportou sucesso')
    }

    return (resultado.results ?? []).map((linha) => ({
      credentialId: linha.credential_id,
      rpId: linha.rp_id,
    }))
  }

  /**
   * Quantas credenciais existem neste `rp_id`. UMA leitura barata.
   *
   * Existe para o passo 9 de §10.5 — o teto de 10 conferido na hora de gravar,
   * e nao so na hora de gerar as options. A conferencia dupla nao e desperdicio:
   * entre uma requisicao e outra o dono pode ter cadastrado por outro caminho,
   * e o teto que so vale na primeira metade da cerimonia nao e teto.
   */
  async contarPorRpId(rpId: string): Promise<number> {
    const linha = await this.db
      .prepare('SELECT COUNT(*) AS total FROM painel_credenciais WHERE rp_id = ?')
      .bind(rpId)
      .first<{ total: number }>()

    return linha?.total ?? 0
  }

  /**
   * Le — ou cria, uma unica vez na vida da instalacao — o `usuario_handle`.
   *
   * **Por que `painel_estado` mora neste arquivo e nao num repositorio proprio.**
   * §7.7 lista SEIS `painel-*-repository.ts`, e `estado.ts` esta entre os nomes
   * deletados: a tabela existe so para guardar o `user.id` que agrupa as
   * passkeys, entao ela e parte do subsistema de credenciais e nao um assunto
   * separado. Um setimo repositorio para uma coluna seria contrato novo por
   * nada.
   *
   * O caminho comum — toda instalacao que ja registrou alguma vez — custa UMA
   * leitura e ZERO escrita. So a primeirissima chamada da vida grava, e o
   * `ON CONFLICT DO NOTHING` e o que faz duas chamadas simultaneas chegarem ao
   * MESMO handle em vez de criarem dois: o D1 e SQLite com escritor unico, a
   * segunda perde o conflito e vai reler a linha da primeira.
   */
  async lerOuCriarHandle(now: number): Promise<string> {
    const existente = await this.db
      .prepare('SELECT usuario_handle FROM painel_estado WHERE id = 1')
      .first<{ usuario_handle: string }>()

    if (existente !== null) return existente.usuario_handle

    const sorteado = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(HANDLE_BYTES)))
    await this.db
      .prepare(
        `INSERT INTO painel_estado (id, usuario_handle, criado_em, atualizado_em)
         VALUES (1, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .bind(sorteado, now, now)
      .run()

    const gravado = await this.db
      .prepare('SELECT usuario_handle FROM painel_estado WHERE id = 1')
      .first<{ usuario_handle: string }>()

    // A releitura nao e paranoia: no empate, quem perdeu o `ON CONFLICT` tem de
    // devolver o handle do VENCEDOR, nunca o proprio sorteio descartado.
    if (gravado === null) throw new Error('D1_ERROR: painel_estado nao materializou o handle')
    return gravado.usuario_handle
  }

  /**
   * A credencial daquele `credential_id` E o dono da instalacao, em **UMA**
   * leitura (§10.7, passos 4 e 5).
   *
   * As duas coisas vem juntas porque §9.10 fixa o custo do login — bem-sucedido
   * ou fracassado — em **1 leitura**. Duas consultas dariam a mesma resposta
   * pelo dobro do preco numa rota nao autenticada, que e exatamente onde o
   * preco vira alavanca de quem esta martelando.
   *
   * `painel_estado` do lado esquerdo do `LEFT JOIN` de proposito: a linha
   * VOLTA mesmo quando o `credential_id` nao existe, e e isso que permite
   * comparar o `userHandle` que o autenticador mandou sem uma segunda ida ao
   * banco. Credencial desconhecida chega aqui como `credencial: null`, e quem
   * decide o que fazer com isso e `verificarAssertion` — que percorre um
   * `verify` inteiro com uma chave descartavel para nao se denunciar pelo
   * relogio (§11.4).
   *
   * `chave_publica_jwk` e JSON gravado por nos, mas e lido de volta dentro de
   * um `try`: uma linha corrompida no D1 nao pode virar excecao no login, ela
   * vira credencial desconhecida — falha fechada.
   */
  async buscarParaLogin(credentialId: string): Promise<LeituraDeLogin | null> {
    const linha = await this.db
      .prepare(
        `SELECT e.usuario_handle AS handle_do_dono,
                c.credential_id, c.rp_id, c.usuario_handle,
                c.chave_publica_jwk, c.algoritmo, c.sign_count
           FROM painel_estado e
           LEFT JOIN painel_credenciais c ON c.credential_id = ?
          WHERE e.id = 1`,
      )
      .bind(credentialId)
      .first<{
        handle_do_dono: string
        credential_id: string | null
        rp_id: string | null
        usuario_handle: string | null
        chave_publica_jwk: string | null
        algoritmo: number | null
        sign_count: number | null
      }>()

    if (linha === null) return null

    return {
      handleDoDono: linha.handle_do_dono,
      credencial: montarCredencial(linha),
    }
  }

  /**
   * O `UPDATE` do login: `sign_count`, `backup_state` e `usado_em` (§10.7,
   * passo 12).
   *
   * Statement, e nao gravacao: ele viaja no MESMO lote da sessao e da
   * auditoria. `backup_eligible` NAO entra — a elegibilidade e definida no
   * registro e nao muda durante a vida da credencial; o que muda e o estado.
   */
  statementDeUsoNoLogin(uso: {
    credentialId: string
    signCount: number
    backupAtivo: boolean
    usadoEm: number
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE painel_credenciais
            SET sign_count = ?, backup_state = ?, usado_em = ?
          WHERE credential_id = ?`,
      )
      .bind(uso.signCount, uso.backupAtivo ? 1 : 0, uso.usadoEm, uso.credentialId)
  }

  /**
   * O UNICO `INSERT INTO painel_credenciais` do projeto (Lema 1 de §10.6).
   *
   * Devolve um statement em vez de gravar, pela mesma razao dos outros
   * repositorios do painel: a linha de auditoria vai no MESMO `db.batch()`, e
   * "grava e depois tenta logar" nao pode ser escrito por engano se a API nao
   * oferecer (§8.8).
   *
   * Sem `ON CONFLICT`: um `credential_id` repetido e conflito de chave
   * primaria, o lote inteiro falha e nada e gravado — que e precisamente o que
   * o passo 8 de §10.5 manda fazer. `ON CONFLICT DO NOTHING` aqui deixaria a
   * linha de auditoria sobreviver a uma insercao que nao aconteceu, e o
   * historico passaria a mentir.
   */
  statementDeInsercao(credencial: CredencialParaGravar): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO painel_credenciais
           (credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo, transportes,
            sign_count, backup_eligible, backup_state, apelido, origem_registro, criado_em, usado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        credencial.credentialId,
        credencial.rpId,
        credencial.usuarioHandle,
        credencial.chavePublicaJwk,
        credencial.algoritmo,
        credencial.transportes,
        credencial.signCount,
        credencial.backupElegivel ? 1 : 0,
        credencial.backupAtivo ? 1 : 0,
        credencial.apelido,
        credencial.origemRegistro,
        credencial.criadoEm,
      )
  }
}

/**
 * A metade direita do `LEFT JOIN` vira `CredencialGuardada`, ou `null`.
 *
 * Uma coluna `NULL` em qualquer campo obrigatorio significa que o `ON` nao
 * casou — nao existe linha de credencial com campo obrigatorio nulo, porque o
 * schema nao permite. O `JSON.parse` num `try` e a segunda metade: uma linha
 * corrompida vira credencial desconhecida, e nunca uma excecao no login.
 */
function montarCredencial(linha: {
  credential_id: string | null
  rp_id: string | null
  usuario_handle: string | null
  chave_publica_jwk: string | null
  algoritmo: number | null
  sign_count: number | null
}): CredencialGuardada | null {
  const { credential_id, rp_id, usuario_handle, chave_publica_jwk, algoritmo } = linha
  if (credential_id === null || rp_id === null || usuario_handle === null) return null
  if (chave_publica_jwk === null || algoritmo === null) return null

  let jwk: JsonWebKey
  try {
    jwk = JSON.parse(chave_publica_jwk) as JsonWebKey
  } catch {
    return null
  }
  if (typeof jwk !== 'object' || jwk === null) return null

  return {
    credentialId: credential_id,
    rpId: rp_id,
    usuarioHandle: usuario_handle,
    jwk,
    algoritmo,
    signCount: linha.sign_count ?? 0,
  }
}
