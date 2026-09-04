/**
 * Arquivo lido como TEXTO pelo Vite (`import ... from '...?raw'`).
 *
 * Mora num arquivo proprio, e nao em `tests/env.d.ts`, porque aquele arquivo
 * tem `import` no topo e portanto e um MODULO: dentro de um modulo,
 * `declare module` vira aumento de modulo existente e o curinga nao vale.
 *
 * Existe para UM teste: o asset `public/painel/parar/index.html` e a copia que
 * o Worker serve em `GET /painel/parar` precisam ser o MESMO byte a byte, e
 * duas copias sem prova de igualdade divergem na primeira etapa que mexer numa
 * delas. Producao nao usa isto — o Worker carrega a pagina de uma constante.
 */
declare module '*.html?raw' {
  const conteudo: string
  export default conteudo
}
