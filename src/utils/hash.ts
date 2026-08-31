const encoder = new TextEncoder()

/**
 * SHA-256 em hex.
 *
 * Usado para guardar o IGSID do autor do comentario sem guardar o ID em si:
 * permite comparar "e a mesma pessoa?" para o cooldown, sem reter o
 * identificador original.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
