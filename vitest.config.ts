import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * Testes rodam no runtime real do Workers (workerd) via Miniflare, com um D1
 * de verdade em memoria. Isso evita mock de banco: as queries testadas sao as
 * mesmas que rodam em producao.
 *
 * Os valores de binding aqui sao FICTICIOS e existem so para o teste — nenhum
 * segredo real entra neste arquivo, que e versionado.
 */
const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          META_APP_SECRET: 'segredo-de-teste',
          META_WEBHOOK_VERIFY_TOKEN: 'verify-token-de-teste',
          // base64 de exatamente 32 bytes
          TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
          SETUP_ADMIN_TOKEN: 'admin-token-de-teste',
          // Consumido por tests/setup.ts para criar o schema antes dos testes.
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
})
