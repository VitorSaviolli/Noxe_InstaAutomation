/**
 * Configuracao NAO SECRETA da automacao.
 *
 * Segredos nunca entram aqui — eles vivem no Cloudflare Secrets (producao)
 * ou no .dev.vars (local) e chegam pelo objeto `Env`.
 *
 * Para trocar o gatilho, altere apenas `triggerKeywords`.
 */

/** Como o texto do comentario e comparado com as palavras-gatilho. */
export type MatchMode = 'exact' | 'contains'

export interface AutomationConfig {
  /** Desliga a automacao inteira sem precisar remover o webhook. */
  enabled: boolean
  /** Palavras ou expressoes que disparam a automacao. */
  triggerKeywords: string[]
  /** `exact` e o padrao: evita acionamento acidental. */
  matchMode: MatchMode
  caseSensitive: boolean
  /** Trata "eu quero" e "eu querô" como equivalentes. */
  normalizeAccents: boolean
  /** Ignora pontuacao final: "eu quero!" casa com "eu quero". */
  ignorePunctuation: boolean
  /** Quando true, so processa comentarios em Reels. */
  processOnlyReels: boolean
  /** `["*"]` = todas as midias. Ou uma lista de media IDs. */
  allowedMediaIds: string[]
  publicReplyEnabled: boolean
  publicReplyText: string
  privateReplyEnabled: boolean
  /** Placeholders suportados: {username} e {link}. */
  privateReplyText: string
  /**
   * Link entregue no Direct. Vem com um placeholder DE PROPOSITO.
   *
   * Enquanto o valor comecar com `[`, a automacao recusa o acionamento com o
   * motivo `link_nao_configurado` e ninguem recebe um Direct quebrado.
   * Troque pelo SEU link (comecando com https://) ANTES de ligar a automacao
   * de verdade — nao adianta configurar o resto e deixar isto para depois.
   */
  destinationUrl: string
  /** Janela em horas antes do mesmo usuario poder acionar de novo. */
  userCooldownHours: number
}

/** Automacao especifica para um ou mais Reels. Sobrepoe a config global. */
export interface MediaAutomation extends Partial<Omit<AutomationConfig, 'allowedMediaIds'>> {
  mediaIds: string[]
}

export const automationConfig: AutomationConfig = {
  enabled: true,
  triggerKeywords: ['eu quero', 'quero o link'],
  matchMode: 'exact',
  caseSensitive: false,
  normalizeAccents: true,
  ignorePunctuation: true,
  processOnlyReels: true,
  allowedMediaIds: ['*'],
  publicReplyEnabled: true,
  publicReplyText: 'Enviei as informações no seu Direct.',
  privateReplyEnabled: true,
  privateReplyText: 'Segue o link como prometido😊 {link}',
  // Link real da Noxelora. Se algum dia voltar a ser um placeholder entre
  // colchetes, a automacao para de disparar por seguranca.
  destinationUrl: 'https://noxelora.com.br',
  userCooldownHours: 24,
}

/**
 * Automacoes por Reel. Deixe o array vazio para usar so a config global.
 *
 * Exemplo:
 *   {
 *     mediaIds: ['17912345678901234'],
 *     triggerKeywords: ['cardápio'],
 *     publicReplyText: 'Enviei o cardápio no seu Direct.',
 *     privateReplyText: 'Olá, {username}! Aqui está o cardápio: {link}',
 *     destinationUrl: 'https://exemplo.com/cardapio',
 *   }
 */
export const mediaAutomations: MediaAutomation[] = []

/** Marca usada em `allowedMediaIds` para liberar qualquer midia. */
const WILDCARD = '*'

/**
 * Resolve a configuracao efetiva de uma midia.
 *
 * Procura uma entrada em `mediaAutomations` que cite o mediaId; se achar,
 * mescla sobre a config global. Caso contrario devolve a global.
 * Retorna sempre um objeto novo — a config global nunca e mutada.
 */
export function resolveConfigForMedia(
  mediaId: string,
  global: AutomationConfig = automationConfig,
  overrides: readonly MediaAutomation[] = mediaAutomations,
): AutomationConfig {
  const match = overrides.find((entry) => entry.mediaIds.includes(mediaId))
  if (!match) return { ...global }

  const { mediaIds: _ignored, ...patch } = match
  return { ...global, ...patch }
}

/** Verifica se a midia esta na lista permitida da config global. */
export function isMediaAllowed(
  mediaId: string,
  config: AutomationConfig = automationConfig,
): boolean {
  return config.allowedMediaIds.includes(WILDCARD) || config.allowedMediaIds.includes(mediaId)
}

/** True quando `destinationUrl` ja foi trocado por um link real (http/https). */
export function isDestinationUrlConfigured(config: AutomationConfig): boolean {
  const url = config.destinationUrl.trim()
  if (url.length === 0 || url.startsWith('[')) return false
  return url.startsWith('https://') || url.startsWith('http://')
}
