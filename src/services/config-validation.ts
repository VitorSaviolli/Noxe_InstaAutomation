/**
 * O validador UNICO da configuracao — um so codigo, dois chamadores (§9.7).
 *
 * Ele roda na ESCRITA (a rota do painel rejeita com mensagem especifica) e na
 * LEITURA (o `config-store.ts` nao pode rejeitar: degrada para falha segura).
 * Duas copias divergiriam, e a divergencia apareceria do pior jeito possivel:
 * a tela mostrando um valor e o webhook entregando outro.
 *
 * Duas regras que este arquivo NAO pode quebrar:
 *
 * 1. **Nunca conserta.** Nenhuma funcao daqui devolve "o valor corrigido".
 *    Ela devolve `ok: true` com o valor que chegou, ou `ok: false` com os
 *    achados. Um validador que conserta entrega comportamento que ninguem
 *    pediu, e e pior que a ausencia de validador (§9.2).
 * 2. **E puro.** Sem `Env`, sem D1, sem rede, sem relogio. Por isso recusar
 *    uma config invalida na escrita nao custa consulta nenhuma (CFG-13).
 *
 * A allowlist de dominios NAO mora aqui: ela depende de `ALLOWED_LINK_DOMAINS`
 * e vive em `src/services/link-allowlist.ts` (§15.3, decisao 6), aplicada por
 * cima deste validador.
 */
import type { AutomationConfig, MatchMode } from '../config'
import { normalizeText } from '../utils/normalize'
import { renderTemplate } from '../utils/templates'

/** Um problema encontrado, sempre nomeando o campo (§9.7). */
export interface Achado {
  /** Nome do campo em `AutomationConfig`, como aparece na tela. */
  campo: string
  /** Codigo em snake_case. Vai para o `console.warn`, nunca o valor. */
  codigo: string
  /** Frase em portugues. Vai para a tela. */
  mensagem: string
}

export type Validacao<T> = { ok: true; valor: T } | { ok: false; achados: readonly Achado[] }

/** Teto de palavras-gatilho. O mesmo numero do `CHECK` da migration 0002. */
export const MAX_GATILHOS = 20
/** Teto de caracteres de UMA palavra-gatilho, medido no texto normalizado. */
export const MAX_CARACTERES_DO_GATILHO = 40
/** Piso de um gatilho em `exact`. Abaixo disso o acionamento vira acidente. */
export const MIN_GATILHO_EXACT = 2
/**
 * Piso de um gatilho em `contains`. Maior que o de `exact` porque `contains`
 * com duas letras casa quase todo comentario.
 */
export const MIN_GATILHO_CONTAINS = 4
/** Teto de caracteres dos dois textos de resposta, depois da limpeza. */
export const MAX_CARACTERES_DO_TEXTO = 500
/** Teto do link. Acompanha o `MAX_LINK_LENGTH` de `src/utils/templates.ts`. */
export const MAX_CARACTERES_DO_LINK = 2048
/** Teto de horas do cooldown. Um ano. O mesmo numero do `CHECK` da 0002. */
export const MAX_HORAS_DE_COOLDOWN = 8760
/**
 * Teto do Direct DEPOIS de renderizado, com o link real no lugar de `{link}`
 * e o pior username no lugar de `{username}`. Teto defensivo: a API da Meta
 * nao documenta o numero exato, e um texto de 500 com um link de 2048 dentro
 * viraria uma mensagem de 2500 que ninguem revisou.
 */
export const MAX_DIRECT_RENDERIZADO = 1000

/** Os unicos placeholders que `renderTemplate` conhece. */
const PLACEHOLDERS_CONHECIDOS = new Set(['{username}', '{link}'])
/** Qualquer `{...}` no texto, conhecido ou nao. */
const QUALQUER_PLACEHOLDER = /\{[^{}]*\}/g
/** Caracteres de controle (Cc) e de formatacao invisivel (Cf). */
const CARACTERES_INVISIVEIS = /[\p{Cc}\p{Cf}]/gu

/**
 * O pior username possivel, para medir o Direct renderizado.
 *
 * 64 e o mesmo teto defensivo que `renderTemplate` aplica ao username.
 */
const PIOR_USERNAME = 'w'.repeat(64)

/**
 * Limpeza aplicada aos dois textos antes de medir (§9.7).
 *
 * NFKC junta as formas compatíveis e `\p{Cc}\p{Cf}` tira o que e invisivel:
 * sem isso, 500 caracteres de zero-width passariam como texto valido.
 */
export function limparTexto(texto: string): string {
  return texto.normalize('NFKC').replace(CARACTERES_INVISIVEIS, '').trim()
}

/**
 * Formato de um `media_id` do Instagram.
 *
 * String opaca de digitos, NUNCA convertida para `Number`: acima de 2^53 a
 * conversao perde precisao e casa o Reel errado, sem erro nenhum.
 */
const FORMATO_DE_MEDIA_ID = /^[0-9]{5,25}$/

export function ehMediaIdValido(mediaId: string): boolean {
  return FORMATO_DE_MEDIA_ID.test(mediaId)
}

/**
 * Valida uma configuracao EFETIVA completa. Trava de CFG-02, CFG-08 e CFG-13.
 *
 * "Efetiva" e a palavra importante: na leitura, cada sobreposicao de midia e
 * validada ja mesclada sobre a global, porque e a config mesclada que decide
 * o comportamento. Um `matchMode: 'contains'` numa midia com gatilho de duas
 * letras so e visivel depois da mesclagem.
 *
 * `allowedMediaIds` fica de fora de proposito: ele nao e campo gravavel
 * (§9.4), e derivado de `mediaScope` e das linhas ativas de `painel_midias`.
 * O formato de cada id e conferido por `ehMediaIdValido`, na linha dele.
 */
export function validarConfig(valores: AutomationConfig): Validacao<AutomationConfig> {
  const achados: Achado[] = []

  validarBooleanos(valores, achados)
  validarMatchMode(valores, achados)
  validarGatilhos(valores, achados)
  validarTextoPublico(valores, achados)
  validarTextoPrivado(valores, achados)
  validarLink(valores, achados)
  validarCooldown(valores, achados)

  if (achados.length > 0) return { ok: false, achados }
  return { ok: true, valor: valores }
}

const CAMPOS_BOOLEANOS = [
  'enabled',
  'caseSensitive',
  'normalizeAccents',
  'ignorePunctuation',
  'processOnlyReels',
  'publicReplyEnabled',
  'privateReplyEnabled',
] as const

function validarBooleanos(valores: AutomationConfig, achados: Achado[]): void {
  for (const campo of CAMPOS_BOOLEANOS) {
    if (typeof valores[campo] !== 'boolean') {
      achados.push({
        campo,
        codigo: 'nao_e_booleano',
        mensagem: `O campo ${campo} precisa ser sim ou nao.`,
      })
    }
  }
}

const MODOS: readonly MatchMode[] = ['exact', 'contains']

function validarMatchMode(valores: AutomationConfig, achados: Achado[]): void {
  if (!MODOS.includes(valores.matchMode)) {
    achados.push({
      campo: 'matchMode',
      codigo: 'modo_desconhecido',
      mensagem: 'O modo de comparacao precisa ser "exact" ou "contains".',
    })
  }
}

/**
 * Gatilhos, medidos SEMPRE no texto normalizado com as opcoes vigentes.
 *
 * Medir no cru deixaria passar `"eu!"`, que normaliza para `"eu"` — dois
 * caracteres em modo `contains`, que casaria quase todo comentario. E um item
 * que normaliza para vazio hoje e PULADO EM SILENCIO por `matchKeyword`: a
 * pessoa acha que configurou e nada acontece.
 */
function validarGatilhos(valores: AutomationConfig, achados: Achado[]): void {
  const lista = valores.triggerKeywords

  if (!Array.isArray(lista) || lista.some((item) => typeof item !== 'string')) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'nao_e_lista_de_texto',
      mensagem: 'As palavras-gatilho precisam ser uma lista de textos.',
    })
    return
  }

  if (lista.length === 0) {
    // Lista vazia so e aceitavel com a automacao desligada: ligada, ela
    // nunca dispararia e a tela mostraria algo que parece vivo e nao esta.
    if (valores.enabled === true) {
      achados.push({
        campo: 'triggerKeywords',
        codigo: 'lista_vazia_com_automacao_ligada',
        mensagem: 'Com a automacao ligada e preciso pelo menos uma palavra-gatilho.',
      })
    }
    return
  }

  if (lista.length > MAX_GATILHOS) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'gatilhos_demais',
      mensagem: `No maximo ${MAX_GATILHOS} palavras-gatilho.`,
    })
  }

  const opcoes = {
    caseSensitive: valores.caseSensitive === true,
    normalizeAccents: valores.normalizeAccents === true,
    ignorePunctuation: valores.ignorePunctuation === true,
  }
  const minimo = valores.matchMode === 'contains' ? MIN_GATILHO_CONTAINS : MIN_GATILHO_EXACT
  const jaVistos = new Set<string>()

  for (const item of lista) {
    const normalizado = normalizeText(item, opcoes)
    validarUmGatilho(normalizado, { minimo, modo: valores.matchMode, jaVistos }, achados)
    jaVistos.add(normalizado)
  }
}

function validarUmGatilho(
  normalizado: string,
  regras: { minimo: number; modo: string; jaVistos: Set<string> },
  achados: Achado[],
): void {
  if (normalizado.length === 0) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'gatilho_vazio',
      mensagem: 'Uma das palavras-gatilho fica vazia depois da normalizacao.',
    })
    return
  }

  if (normalizado.length < regras.minimo) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'gatilho_curto',
      mensagem: `No modo ${regras.modo} cada palavra-gatilho precisa de pelo menos ${regras.minimo} caracteres.`,
    })
  }

  if (normalizado.length > MAX_CARACTERES_DO_GATILHO) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'gatilho_longo',
      mensagem: `Cada palavra-gatilho tem no maximo ${MAX_CARACTERES_DO_GATILHO} caracteres.`,
    })
  }

  if (regras.jaVistos.has(normalizado)) {
    achados.push({
      campo: 'triggerKeywords',
      codigo: 'gatilho_duplicado',
      mensagem: 'Duas palavras-gatilho ficam iguais depois da normalizacao.',
    })
  }
}

/**
 * O texto publico NAO passa por `renderTemplate`.
 *
 * Um `{link}` ali sairia escrito assim mesmo, publicamente, embaixo do Reel.
 * Por isso nenhum placeholder e aceito — nem os conhecidos.
 */
function validarTextoPublico(valores: AutomationConfig, achados: Achado[]): void {
  const limpo = medirTexto('publicReplyText', valores.publicReplyText, achados)
  if (limpo === null) return

  if (limpo.match(QUALQUER_PLACEHOLDER) !== null) {
    achados.push({
      campo: 'publicReplyText',
      codigo: 'placeholder_no_texto_publico',
      mensagem: 'A resposta publica nao aceita {placeholders}: ela sai escrita como esta.',
    })
  }
}

function validarTextoPrivado(valores: AutomationConfig, achados: Achado[]): void {
  const limpo = medirTexto('privateReplyText', valores.privateReplyText, achados)
  if (limpo === null) return

  const encontrados = limpo.match(QUALQUER_PLACEHOLDER) ?? []

  for (const placeholder of encontrados) {
    if (!PLACEHOLDERS_CONHECIDOS.has(placeholder)) {
      achados.push({
        campo: 'privateReplyText',
        codigo: 'placeholder_desconhecido',
        mensagem: 'O Direct so conhece {username} e {link}.',
      })
      break
    }
  }

  // `renderTemplate` deixa um placeholder desconhecido INTACTO de proposito —
  // bom em tempo de execucao, pessimo como estado salvo. Um Direct sem link e
  // um Direct quebrado, enviado a cada acionamento.
  if (valores.privateReplyEnabled === true && !limpo.includes('{link}')) {
    achados.push({
      campo: 'privateReplyText',
      codigo: 'direct_sem_link',
      mensagem: 'O texto do Direct precisa conter {link}.',
    })
  }

  // Medido com o MESMO `renderTemplate` que monta o Direct de verdade: um
  // segundo calculo aqui divergiria do texto que a pessoa recebe.
  const piorCaso = renderTemplate(limpo, {
    username: PIOR_USERNAME,
    link: typeof valores.destinationUrl === 'string' ? valores.destinationUrl : '',
  })

  if (piorCaso.length > MAX_DIRECT_RENDERIZADO) {
    achados.push({
      campo: 'privateReplyText',
      codigo: 'direct_longo_demais',
      mensagem: `Com o link substituido o Direct passaria de ${MAX_DIRECT_RENDERIZADO} caracteres.`,
    })
  }
}

/** Limpa e mede um dos textos. Devolve `null` quando ja acusou o problema. */
function medirTexto(campo: string, texto: unknown, achados: Achado[]): string | null {
  if (typeof texto !== 'string') {
    achados.push({
      campo,
      codigo: 'nao_e_texto',
      mensagem: `O campo ${campo} precisa ser um texto.`,
    })
    return null
  }

  const limpo = limparTexto(texto)

  if (limpo.length === 0) {
    achados.push({ campo, codigo: 'texto_vazio', mensagem: 'O texto nao pode ficar vazio.' })
    return null
  }

  if (limpo.length > MAX_CARACTERES_DO_TEXTO) {
    achados.push({
      campo,
      codigo: 'texto_longo',
      mensagem: `O texto tem no maximo ${MAX_CARACTERES_DO_TEXTO} caracteres.`,
    })
    return null
  }

  return limpo
}

/**
 * A regra de escrita do link e MAIS estrita que `isDestinationUrlConfigured`.
 *
 * Aquela funcao ainda aceita `http://` e fica como esta, por compatibilidade
 * com quem ja usa o projeto; e a gravacao — e a leitura de uma linha do banco,
 * que e a mesma coisa vinda de fora — que aperta.
 */
function validarLink(valores: AutomationConfig, achados: Achado[]): void {
  const bruto = valores.destinationUrl

  if (typeof bruto !== 'string') {
    achados.push({
      campo: 'destinationUrl',
      codigo: 'nao_e_texto',
      mensagem: 'O link precisa ser um texto.',
    })
    return
  }

  if (bruto.length > MAX_CARACTERES_DO_LINK) {
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_longo',
      mensagem: `O link tem no maximo ${MAX_CARACTERES_DO_LINK} caracteres.`,
    })
    return
  }

  let url: URL
  try {
    url = new URL(bruto)
  } catch {
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_invalido',
      mensagem: 'O link precisa ser um endereco completo, comecando com https://.',
    })
    return
  }

  if (url.protocol !== 'https:') {
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_sem_https',
      mensagem: 'O link precisa comecar com https://.',
    })
  }

  if (url.username.length > 0 || url.password.length > 0) {
    // `https://exemplo.com@evil.com` engana o olho de quem le a tela.
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_com_credencial',
      mensagem: 'O link nao pode conter usuario e senha.',
    })
  }

  if (url.port.length > 0) {
    // `new URL` ja apaga a porta 443 quando o esquema e https, entao chegar
    // aqui com porta significa uma porta DIFERENTE da padrao.
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_com_porta',
      mensagem: 'O link nao pode indicar uma porta diferente da padrao.',
    })
  }

  // `new URL` ja normaliza o host para minusculo e punycode. Se o que veio
  // nao bate com o normalizado, o texto guardado nao e o endereco que o
  // navegador visitaria — e essa diferenca e a base do ataque de homografo.
  if (!bruto.includes(url.host)) {
    achados.push({
      campo: 'destinationUrl',
      codigo: 'link_nao_normalizado',
      mensagem: 'O endereco do site precisa estar em minusculas e sem acentos.',
    })
  }
}

/**
 * Cooldown: o campo mais traicoeiro do conjunto. Trava de CFG-09.
 *
 * `now - horas * 3600000` com horas negativa joga a janela para o FUTURO: a
 * comparacao passa a ser sempre falsa e o freio desaparece sem erro nenhum.
 * `NaN` e `Infinity` viram `.bind(NaN)` e derrubam a consulta dentro de
 * `processComment`, documentada como funcao que nunca lanca.
 */
function validarCooldown(valores: AutomationConfig, achados: Achado[]): void {
  const horas = valores.userCooldownHours

  if (!Number.isInteger(horas) || horas < 0 || horas > MAX_HORAS_DE_COOLDOWN) {
    achados.push({
      campo: 'userCooldownHours',
      codigo: 'cooldown_fora_da_faixa',
      mensagem: `A janela precisa ser um numero inteiro de horas entre 0 e ${MAX_HORAS_DE_COOLDOWN}.`,
    })
  }
}
