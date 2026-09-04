/**
 * Os codigos impressos no papel: 6 de recuperacao e 1 de parada (§10.11, §10.12).
 *
 * Tres operacoes e nada mais: **sortear**, **normalizar** e **verificar**. O
 * modulo nao toca no D1, nao toca em `Request` e nao le o relogio — quem faz
 * isso sao `painel-codigos-repository.ts` e as rotas.
 *
 * **Quem sorteia e o Worker, nunca o assistente** (§10.11). Para calcular a
 * pimenta o assistente precisaria da `PANEL_SESSION_KEY` na maquina, que e o
 * oposto exato da separacao de segredos; e sem a pimenta um dump do D1 vira
 * ataque offline. A objecao "o codigo em claro trafega pela rede" nao
 * introduz confianca nova: o assistente ja manda o `SETUP_ADMIN_TOKEN` pelo
 * mesmo canal TLS ao mesmo Worker.
 *
 * **A entropia, e nao o bloqueio, e o que protege estes codigos.** Nao existe
 * tabela de tentativas, e a ausencia dela nao e concessao: com 100 bits, o
 * tempo esperado para adivinhar nao tem significado fisico, e o teto real de
 * 100.000 requisicoes/dia e o mesmo recurso que o atacante estaria tentando
 * derrubar.
 */

import type { TipoDeCodigo } from '../repositories/painel-codigos-repository'
import { timingSafeEqual } from '../security/constant-time'
import { hmacSha256 } from '../security/signed-envelope'

/**
 * Crockford base32: o alfabeto sem `I`, `L`, `O` e `U`.
 *
 * Quem digita no celular, sob estresse, confunde `0`/`O` e `1`/`I`/`l`. Tirar
 * as letras ambiguas do alfabeto e o que torna a normalizacao possivel: `I` e
 * `L` so podem ter sido um `1`, e `O` so pode ter sido um `0`.
 */
export const ALFABETO_DOS_CODIGOS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Tamanho de cada familia, em caracteres. Cada caractere vale 5 bits.
 *
 * `recuperacao`: 20 caracteres = **100 bits**. `parada`: 16 = **80 bits**. O
 * codigo de parada e menor de proposito — ele compra tao pouco (so sabe dizer
 * `enabled = 0`) que 80 bits sobram, e ele e o que a pessoa digita do papel no
 * pior dia do projeto.
 */
export const TAMANHO_DO_CODIGO: Record<TipoDeCodigo, number> = {
  recuperacao: 20,
  parada: 16,
}

/** Quantos codigos de recuperacao um conjunto tem. */
export const CODIGOS_DE_RECUPERACAO = 6

/**
 * Versao do esquema de hash, dentro do texto assinado.
 *
 * Trocar o algoritmo um dia significa subir este numero e gravar `versao_hash`
 * junto — nunca reinterpretar em silencio o que ja esta no banco.
 */
export const VERSAO_DO_HASH = 1

/** Grupos de 5 caracteres na exibicao. Os hifens NAO fazem parte do codigo. */
const TAMANHO_DO_GRUPO = 5

/** So o alfabeto, e exatamente o alfabeto. */
const SO_DO_ALFABETO = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/

/** O que a normalizacao descarta: espaco de qualquer tipo e hifen. */
const SEPARADORES = /[\s-]+/g

/**
 * Sorteia UM codigo do tipo pedido.
 *
 * `256 % 32 === 0`, entao `byte % 32` e uniforme: nao ha vies de modulo a
 * corrigir e nao existe laco de rejeicao para alguem escrever errado.
 */
export function sortearCodigo(tipo: TipoDeCodigo): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TAMANHO_DO_CODIGO[tipo]))

  let codigo = ''
  for (const byte of bytes) {
    codigo += ALFABETO_DOS_CODIGOS[byte % ALFABETO_DOS_CODIGOS.length]
  }

  return codigo
}

/**
 * Sorteia o conjunto inteiro: 6 de recuperacao e 1 de parada.
 *
 * O texto em claro sai daqui e vive UMA UNICA VEZ, no corpo da resposta de
 * `POST /setup/painel/codigos`. Nada neste projeto o grava, o registra em log
 * ou o devolve uma segunda vez.
 */
export function sortearConjunto(): { recuperacao: string[]; parada: string } {
  return {
    recuperacao: Array.from({ length: CODIGOS_DE_RECUPERACAO }, () => sortearCodigo('recuperacao')),
    parada: sortearCodigo('parada'),
  }
}

/**
 * `XXXXX-XXXXX-XXXXX-XXXXX` — hifens SO na exibicao (§10.11).
 *
 * O ultimo grupo absorve o resto, para que o codigo de parada saia
 * `XXXXX-XXXXX-XXXXXX` em vez de terminar num grupo de um caractere so, que a
 * pessoa leria como sujeira.
 */
export function formatarCodigo(codigo: string): string {
  const grupos: string[] = []
  const cheios = Math.floor(codigo.length / TAMANHO_DO_GRUPO) - 1

  for (let i = 0; i < cheios; i++) {
    grupos.push(codigo.slice(i * TAMANHO_DO_GRUPO, (i + 1) * TAMANHO_DO_GRUPO))
  }
  grupos.push(codigo.slice(cheios * TAMANHO_DO_GRUPO))

  return grupos.join('-')
}

/**
 * Normaliza o que a pessoa digitou. Devolve `null` para qualquer outra coisa.
 *
 * Maiusculas, fora espacos e hifens, `I`/`L` viram `1` e `O` vira `0`; depois
 * exige EXATAMENTE o tamanho do tipo, so com caracteres do alfabeto. A recusa
 * acontece **antes** de qualquer consulta ao D1 — e o que faz um bot mandando
 * lixo custar zero leitura (§10.12).
 *
 * O `U` nao e mapeado de proposito: Crockford o exclui para nao formar
 * palavras ofensivas por acidente, e nao por ambiguidade visual. Mapea-lo para
 * `V` transformaria um erro de digitacao real em um codigo diferente e valido.
 */
export function normalizarCodigo(bruto: string, tipo: TipoDeCodigo): string | null {
  const limpo = bruto
    .toUpperCase()
    .replace(SEPARADORES, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')

  if (limpo.length !== TAMANHO_DO_CODIGO[tipo]) return null
  if (!SO_DO_ALFABETO.test(limpo)) return null

  return limpo
}

/**
 * `HMAC-SHA256(k_codigos, "<tipo>|<versao_hash>|<codigo_normalizado>")`, em hex.
 *
 * A pimenta e o que impede ataque OFFLINE contra um dump do D1: sem a
 * `PANEL_SESSION_KEY` nao da nem para testar candidatos. Por isso e HMAC e nao
 * SHA-256 puro (§8.5).
 *
 * O `tipo` entra no texto assinado: sem ele, um codigo de recuperacao gravado
 * teria o mesmo hash de um codigo de parada com o mesmo texto, e a linha de um
 * tipo valeria para o outro.
 */
export async function hashDoCodigo(
  chaveDosCodigos: Uint8Array,
  tipo: TipoDeCodigo,
  normalizado: string,
): Promise<string> {
  const mac = await hmacSha256(chaveDosCodigos, `${tipo}|${VERSAO_DO_HASH}|${normalizado}`)

  return Array.from(mac)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * O codigo normalizado casa com algum dos hashes vivos?
 *
 * Trava de STOP-10: a comparacao passa SEMPRE por `timingSafeEqual`, nunca por
 * `===`. `comparar` e parametro com o padrao de producao exatamente para que o
 * teste consiga injetar um duble e provar que nao existe um segundo caminho de
 * comparacao escondido — e nao para que alguem troque a funcao em producao.
 *
 * O laco NAO sai no primeiro acerto: sair cedo faria o tempo de resposta
 * contar a posicao da linha na tabela. Sao no maximo sete hashes.
 */
export async function conferirCodigo(
  normalizado: string,
  tipo: TipoDeCodigo,
  chaveDosCodigos: Uint8Array,
  hashesVivos: readonly string[],
  comparar: (a: string, b: string) => boolean = timingSafeEqual,
): Promise<boolean> {
  const esperado = await hashDoCodigo(chaveDosCodigos, tipo, normalizado)

  let encontrado = false
  for (const hash of hashesVivos) {
    if (comparar(esperado, hash)) encontrado = true
  }

  return encontrado
}
