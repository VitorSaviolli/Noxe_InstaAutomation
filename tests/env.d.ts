import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env as WorkerEnv } from '../src/types/env'

/**
 * Tipagem do `env` que o modulo "cloudflare:test" entrega aos testes.
 *
 * O pacote declara `export const env: Cloudflare.Env`, entao quem precisa
 * ensinar o TypeScript sobre os bindings do projeto e o namespace global
 * `Cloudflare`, e nao um `ProvidedEnv`, que versoes antigas expunham e esta
 * nao expoe mais.
 *
 * `TEST_MIGRATIONS` nao existe em producao: e injetado pelo vitest.config.ts
 * e consumido por tests/setup.ts para montar o schema do D1 de teste.
 *
 * `TEST_BINDINGS_DO_WRANGLER` tambem nao existe em producao: e a lista de
 * nomes de binding lida do wrangler.jsonc pelo vitest.config.ts, consumida
 * pelo metateste META-04. Ela chega por binding porque o teste roda dentro do
 * workerd, onde nao ha sistema de arquivos para ler o arquivo de novo.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
      TEST_BINDINGS_DO_WRANGLER: string[]
    }
  }
}
