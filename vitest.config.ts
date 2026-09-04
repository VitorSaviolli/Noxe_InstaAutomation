import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { unstable_readConfig } from 'wrangler'

/**
 * Testes rodam no runtime real do Workers (workerd) via Miniflare, com um D1
 * de verdade em memoria. Isso evita mock de banco: as queries testadas sao as
 * mesmas que rodam em producao.
 *
 * Os valores de binding aqui sao FICTICIOS e existem so para o teste — nenhum
 * segredo real entra neste arquivo, que e versionado.
 */
const migrations = await readD1Migrations('./migrations')

/**
 * O `wrangler.jsonc` continua sendo a fonte da verdade, e este arquivo le dele
 * o que o ambiente de teste precisa: entrada, data de compatibilidade, banco e
 * as `vars` publicas.
 *
 * O que ele NAO herda sao os tres bindings `ratelimits` — a excecao declarada
 * de §7.4. Passar `wrangler: { configPath }` faria o pool derivar TODOS os
 * bindings do arquivo, os tres limitadores inclusive, e nao existe forma de
 * remover um binding depois que o pool o leu (a fusao de opcoes do Miniflare
 * so acrescenta). Com os limitadores presentes aqui, o `LimitadorDeBinding`
 * assumiria em todos os testes e a suite deixaria de provar exatamente o que
 * §7.4 manda provar: **ausentes os bindings, o painel funciona sem a camada**.
 * Por isso a leitura e explicita, campo a campo.
 */
const producao = unstable_readConfig({ config: './wrangler.jsonc' })

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: producao.main,
      miniflare: {
        compatibilityDate: producao.compatibility_date,
        compatibilityFlags: producao.compatibility_flags,
        // D1 em memoria, com o mesmo NOME de binding de producao. O id nao
        // importa: o Miniflare nao fala com a Cloudflare nos testes.
        d1Databases: ['DB'],
        bindings: {
          // As `vars` publicas vem do wrangler.jsonc, exatamente como chegam
          // ao Worker publicado. As duas do painel sao sobrescritas abaixo.
          ...producao.vars,
          META_APP_SECRET: 'segredo-de-teste',
          META_WEBHOOK_VERIFY_TOKEN: 'verify-token-de-teste',
          // base64 de exatamente 32 bytes
          TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
          SETUP_ADMIN_TOKEN: 'admin-token-de-teste',
          // Host ficticio do painel. Casa com o RAIZ de tests/fixtures/dubles.ts,
          // para que origemDoPainel(env) seja exatamente a origem das requisicoes
          // de teste. Em wrangler.jsonc este var nasce VAZIO: o endereco e de
          // quem instala, nunca do repositorio.
          PANEL_RP_ID: 'exemplo.workers.dev',
          // Allowlist de dominios VAZIA, igual ao wrangler.jsonc: e o estado
          // em que a entrega continua funcionando e o painel nao altera link
          // nem texto (§9.8). Cada teste que exercita a trava declara a
          // propria lista, do mesmo jeito que `now` e sempre injetado — uma
          // lista fixa aqui esconderia qual regra cada teste esta provando.
          ALLOWED_LINK_DOMAINS: '',
          // Raiz das quatro subchaves do painel. Ficticia, e DIFERENTE do
          // SETUP_ADMIN_TOKEN e do TOKEN_ENCRYPTION_KEY de proposito — o
          // metateste META-05 falha se alguem repetir um valor aqui.
          PANEL_SESSION_KEY: 'chave-de-sessao-do-painel-de-teste',
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
