import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { invalidarBaldesDeReserva } from '../src/routes/painel/guardas'

/**
 * Cria o schema no D1 de teste antes de qualquer suite rodar.
 * As migrations sao as MESMAS de producao, lidas de ./migrations.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

/**
 * Isolamento entre testes, pelo mesmo motivo de `invalidarCacheDeConfig()`
 * (§8.10): os baldes do limitador de reserva sao estado de MODULO, vivo
 * enquanto o isolate viver. Sem esta linha, um teste que gasta tentativas com
 * `AGORA` deixaria o balde cheio para o teste seguinte, e como `AGORA` e
 * sempre o mesmo instante, a janela nunca viraria sozinha.
 *
 * Mora aqui, e nao no `beforeEach` de cada suite, porque a partir do roteador
 * TODA rota do painel passa pelo limitador: uma copia por suite envelheceria
 * na primeira que alguem esquecesse.
 */
beforeEach(() => {
  invalidarBaldesDeReserva()
})
