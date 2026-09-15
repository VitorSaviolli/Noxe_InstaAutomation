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
 * delas. Producao nao usa isto, o Worker carrega a pagina de uma constante.
 */
declare module '*.html?raw' {
  const conteudo: string
  export default conteudo
}

/**
 * `import.meta.glob` do Vite, na forma EXATA que um teste usa.
 *
 * Declarado a mao, e nao herdado de `vite/client`: aquele pacote de tipos traz
 * junto o `document`, o `window` e o resto do DOM, e o codigo deste projeto
 * roda no workerd, onde nada disso existe. Um tipo largo aqui abriria a porta
 * para um teste, ou pior, para um arquivo de `src/`, referenciar API de
 * navegador e passar no typecheck.
 *
 * Existe para UM teste: o Lema 1 de §10.6, que varre `src/` inteiro e falha se
 * `INSERT INTO painel_credenciais` aparecer em mais de um arquivo. Sem ler as
 * fontes como TEXTO nao ha como afirmar isso de dentro do workerd, onde nao ha
 * sistema de arquivos.
 */
interface ImportMeta {
  glob(
    padrao: string,
    opcoes: { query: '?raw'; eager: true; import: 'default' },
  ): Record<string, string>
}

/**
 * Uma SUITE lida como texto, e nao como modulo.
 *
 * Existe para UM teste: META-13 varre `tests/` inteiro pelo `import.meta.glob`
 * acima e afirma que nenhum teste oferece a cerimonia de step-up para uma
 * gravacao que a allowlist daquele ambiente jamais aceitaria. O `glob` do Vite
 * OMITE o modulo que o chama, entao o unico arquivo fora da guarda seria
 * justamente aquele onde ela mora, e uma guarda cega para si mesma e o buraco
 * mais facil de nao notar. Esta declaracao e o que deixa aquele arquivo se
 * importar como texto e entrar na propria varredura.
 */
declare module '*.test.ts?raw' {
  const conteudo: string
  export default conteudo
}
