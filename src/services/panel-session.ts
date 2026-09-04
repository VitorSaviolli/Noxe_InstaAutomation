/**
 * O que o painel deriva do ambiente: subchaves, origem, portao de sanidade e
 * a sessao assinada.
 *
 * Tudo aqui parte de UM segredo, o `PANEL_SESSION_KEY`. Nunca a mesma chave
 * para dois propositos: HMAC-SHA256 e um PRF, entao derivar por rotulo basta e
 * usa so a primitiva que o repositorio ja importa (§10.1).
 */
import { bytesToBase64Url } from '../security/base64url'
import { timingSafeEqual } from '../security/constant-time'
import {
  abrirEnvelope,
  type ClaimsDoEnvelope,
  criarEnvelope,
  hmacSha256,
  type LeituraDeEnvelope,
  type PropositoDeEnvelope,
} from '../security/signed-envelope'
import type { Env } from '../types/env'

const encoder = new TextEncoder()

const PREFIXO_DE_ROTULO = 'noxe-painel/v1/'
const SEPARADOR = '.'

/** Prefixo de versao do cookie de sessao. Entra tambem no texto assinado. */
const VERSAO_DE_SESSAO = 's1'
/** Prefixo, sid, prazo e assinatura. */
const PARTES_DA_SESSAO = 4

/** 32 bytes: o mesmo tamanho da saida do SHA-256 que guardamos no lugar dele. */
const SID_BYTES = 32

/**
 * Prazo absoluto da sessao (§7.6). NUNCA estendido: forca uma biometria por
 * dia de uso. O prazo ocioso e a gravacao de `vista_em` moram na linha do D1 e
 * chegam com a etapa que cria a tabela.
 *
 * Trava de SES-01.
 */
export const PRAZO_ABSOLUTO_DE_SESSAO_MS = 12 * 60 * 60 * 1000

/**
 * As quatro subchaves que saem do `PANEL_SESSION_KEY` (§10.1).
 *
 * `convite` nao esta aqui porque a raiz dele e outra — o `SETUP_ADMIN_TOKEN` —
 * e ele nasce com a etapa do convite.
 */
export type RotuloDeSubchave = 'sessao' | 'desafio' | 'csrf' | 'codigos'

export type LeituraDeSessao =
  | { valida: true; sidHash: string; expiraEm: number }
  | { valida: false; motivo: 'malformado' | 'assinatura_invalida' | 'expirado' }

export interface SessaoEmitida {
  /** O valor do cookie `__Host-painel_sessao`. Contem o `sid` em claro. */
  valor: string
  /** `sha256(sid)`. E ISTO que vai para o banco — nunca o `sid`. */
  sidHash: string
  /** Instante do prazo absoluto, em ms. */
  expiraEm: number
}

/**
 * `k(rotulo) = HMAC-SHA256(chave_raiz, "noxe-painel/v1/" + rotulo)`.
 *
 * A raiz e parametro porque o convite (etapa do registro) deriva do
 * `SETUP_ADMIN_TOKEN`, e nao do `PANEL_SESSION_KEY`. Dentro deste modulo a
 * raiz e sempre `env.PANEL_SESSION_KEY`, para que nenhum chamador precise
 * escolher — escolher e onde o erro acontece.
 *
 * Trava de SES-02: o rotulo entra no texto do HMAC. Tirar o rotulo, ou repetir
 * um, faria duas subchaves coincidirem e derruba o teste da separacao.
 */
export function derivarSubchave(chaveRaiz: string, rotulo: RotuloDeSubchave): Promise<Uint8Array> {
  return hmacSha256(chaveRaiz, PREFIXO_DE_ROTULO + rotulo)
}

/**
 * `k_env(proposito) = HMAC-SHA256(k_desafio, "noxe-painel/v1/env/" + proposito)`.
 *
 * Um passo a mais a partir de `k_desafio`, sem acrescentar subchave a raiz.
 * E a segunda das tres defesas contra confusao de proposito: cada cerimonia
 * assina com uma chave diferente, entao um envelope de registro nao fecha a
 * assinatura de um step-up nem se o campo do proposito for reescrito.
 *
 * Trava de SES-04: tirar o `proposito` do texto derivado faz as tres chaves
 * virarem uma so, e o envelope disfarcado passa a fechar a assinatura.
 */
export async function chaveDeEnvelope(
  env: Env,
  proposito: PropositoDeEnvelope,
): Promise<Uint8Array> {
  const kDesafio = await derivarSubchave(env.PANEL_SESSION_KEY, 'desafio')
  return hmacSha256(kDesafio, `${PREFIXO_DE_ROTULO}env/${proposito}`)
}

/**
 * Emite um envelope de cerimonia ja com a chave do proposito.
 *
 * Este par — `emitirEnvelope`/`lerEnvelope` — e a unica porta do painel para o
 * envelope. Existe para que nenhum chamador precise escolher a chave: escolher
 * e onde a confusao de proposito nasceria.
 */
export async function emitirEnvelope(
  env: Env,
  proposito: PropositoDeEnvelope,
  claims: ClaimsDoEnvelope,
  now: number,
): Promise<string> {
  return criarEnvelope(proposito, claims, await chaveDeEnvelope(env, proposito), now)
}

/** Le um envelope de cerimonia com a chave do proposito exigido. */
export async function lerEnvelope(
  env: Env,
  proposito: PropositoDeEnvelope,
  envelope: string,
  now: number,
): Promise<LeituraDeEnvelope> {
  return abrirEnvelope(envelope, proposito, await chaveDeEnvelope(env, proposito), now)
}

/**
 * A origem esperada do painel.
 *
 * `PANEL_ORIGIN` NAO existe, e essa ausencia e a defesa: uma variavel a menos
 * para o leigo errar, e torna impossivel a origem e o `rpId` divergirem — a
 * classe de erro que produz credencial irrecuperavel, porque o `rpId` gravado
 * dentro da credencial nao pode ser corrigido depois (§7.4).
 *
 * So faz sentido depois de `painelHabilitado(env)` dizer `ok`.
 */
export function origemDoPainel(env: Env): string {
  return `https://${env.PANEL_RP_ID}`
}

/**
 * Portao de sanidade do painel. Falha fechada: sem segredo forte, o painel nao
 * existe (§10.2).
 *
 * Se o segredo nao foi cadastrado, em Workers ele chega como `undefined` — e
 * NAO como string vazia. Por isso cada linha comeca pelo `typeof`:
 * `env.PANEL_RP_ID.length` sozinho lanca `TypeError`, e um HMAC com chave
 * vazia e perfeitamente computavel por qualquer pessoa que leu este codigo.
 *
 * O piso de 20 caracteres do `SETUP_ADMIN_TOKEN` acompanha o binding ficticio
 * do `vitest.config.ts`; se um dia subir para 32, o arquivo de teste sobe
 * junto ou a suite inteira quebra por 503.
 */
export function painelHabilitado(env: Env): { ok: true } | { ok: false; motivo: string } {
  if (typeof env.PANEL_SESSION_KEY !== 'string' || env.PANEL_SESSION_KEY.length < 32)
    return { ok: false, motivo: 'chave_de_sessao_ausente' }
  if (typeof env.SETUP_ADMIN_TOKEN !== 'string' || env.SETUP_ADMIN_TOKEN.length < 20)
    return { ok: false, motivo: 'admin_token_ausente' }
  if (typeof env.PANEL_RP_ID !== 'string' || env.PANEL_RP_ID.length === 0)
    return { ok: false, motivo: 'endereco_do_painel_nao_configurado' }
  return { ok: true }
}

/**
 * Emite o valor do cookie de sessao (§10.8).
 *
 *   valor = "s1" "." base64url(sid_32B) "." <expira_em> "." base64url(hmac)
 *   hmac  = HMAC-SHA256( k_sessao, "s1|" + sid_b64 + "|" + expira_em )
 *
 * O HMAC e o filtro GRATIS: um bot mandando cookie aleatorio e recusado sem
 * nenhuma consulta ao D1. A linha do banco e a autoridade, e chega com a etapa
 * que cria a tabela — este modulo nunca guarda o `sid`, so devolve o
 * `sha256(sid)` para quem for gravar.
 */
export async function emitirSessao(env: Env, now: number): Promise<SessaoEmitida> {
  // Trava de SES-11: 32 bytes sorteados a CADA emissao. Derivar o `sid` do
  // relogio, do `credential_id` ou de qualquer coisa estavel faria duas
  // sessoes do mesmo milissegundo coincidirem.
  const sid = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SID_BYTES)))
  const expiraEm = now + PRAZO_ABSOLUTO_DE_SESSAO_MS
  const assinatura = await assinarSessao(env, sid, String(expiraEm))

  return {
    valor: [VERSAO_DE_SESSAO, sid, String(expiraEm), assinatura].join(SEPARADOR),
    sidHash: await hashDeSid(sid),
    expiraEm,
  }
}

/**
 * Confere o valor do cookie de sessao.
 *
 * Mesma ordem do envelope e do `state` do OAuth: formato -> assinatura em
 * tempo constante -> prazo. Nunca lanca: a entrada e um cabecalho `Cookie`
 * vindo de qualquer pessoa na internet.
 */
export async function validarSessao(
  env: Env,
  valor: string,
  now: number,
): Promise<LeituraDeSessao> {
  const partes = valor.split(SEPARADOR)
  if (partes.length !== PARTES_DA_SESSAO) return { valida: false, motivo: 'malformado' }

  const [versao, sid, expiraEmCru, assinatura] = partes as [string, string, string, string]
  // Trava de SES-10: `assinarSessao` embute o "s1" como CONSTANTE, entao um
  // cookie "s2" com um MAC calculado sobre o texto "s1" fecharia a assinatura.
  // Esta linha e a unica coisa que o recusa.
  if (versao !== VERSAO_DE_SESSAO) return { valida: false, motivo: 'malformado' }

  // Travas de SES-05 e SES-03: assinatura ANTES do prazo, e sobre o
  // `expira_em` cru. Inverter estas duas linhas derruba os dois testes.
  const esperada = await assinarSessao(env, sid, expiraEmCru)
  if (!timingSafeEqual(esperada, assinatura)) {
    return { valida: false, motivo: 'assinatura_invalida' }
  }

  const expiraEm = Number.parseInt(expiraEmCru, 10)
  if (!Number.isFinite(expiraEm)) return { valida: false, motivo: 'malformado' }
  if (now > expiraEm) return { valida: false, motivo: 'expirado' }

  return { valida: true, sidHash: await hashDeSid(sid), expiraEm }
}

async function assinarSessao(env: Env, sid: string, expiraEm: string): Promise<string> {
  // Trava de SES-02: e `k_sessao`, nunca a raiz e nunca outra subchave.
  const kSessao = await derivarSubchave(env.PANEL_SESSION_KEY, 'sessao')
  const mac = await hmacSha256(kSessao, `${VERSAO_DE_SESSAO}|${sid}|${expiraEm}`)
  return bytesToBase64Url(mac)
}

/**
 * `sha256(sid)`, em base64url.
 *
 * Um dump do D1 nao pode entregar cookie utilizavel — o mesmo raciocinio que
 * ja levou o projeto a guardar `commenter_scoped_id_hash` no lugar do IGSID.
 * O hash e do `sid` COMO ELE VIAJA no cookie, isto e, do texto base64url, para
 * que emissao e validacao cheguem sempre ao mesmo valor.
 */
async function hashDeSid(sid: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(sid))
  return bytesToBase64Url(new Uint8Array(digest))
}
