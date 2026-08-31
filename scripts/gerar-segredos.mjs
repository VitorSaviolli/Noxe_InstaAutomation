#!/usr/bin/env node
/**
 * Gera os valores aleatorios dos 4 segredos do projeto.
 *
 * Uso:  node scripts/gerar-segredos.mjs
 *
 * NAO grava em arquivo nenhum de proposito: copie a saida para o seu
 * gerenciador de senhas e cadastre com `npx wrangler secret put <NOME>`.
 */
import { randomBytes } from 'node:crypto'

/** base64 puro: exigido pela TOKEN_ENCRYPTION_KEY (32 bytes). */
const base64 = (bytes) => randomBytes(bytes).toString('base64')

/** base64url: seguro para header e query, sem caractere de escape. */
const base64url = (bytes) => randomBytes(bytes).toString('base64url')

const segredos = {
  META_WEBHOOK_VERIFY_TOKEN: base64url(32),
  TOKEN_ENCRYPTION_KEY: base64(32),
  SETUP_ADMIN_TOKEN: base64url(32),
}

console.log('Segredos gerados. Guarde no gerenciador de senhas ANTES de cadastrar.\n')
for (const [nome, valor] of Object.entries(segredos)) {
  console.log(`${nome}=${valor}`)
}

console.log('\nPara cadastrar em producao:')
for (const nome of Object.keys(segredos)) {
  console.log(`  npx wrangler secret put ${nome}`)
}
console.log('\nO META_APP_SECRET nao e gerado aqui: copie do painel da Meta.')
