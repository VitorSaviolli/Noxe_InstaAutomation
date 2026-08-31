import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

/**
 * Cria o schema no D1 de teste antes de qualquer suite rodar.
 * As migrations sao as MESMAS de producao, lidas de ./migrations.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
