## O que muda e por quê

<!--
Descreva em poucas linhas o que este PR faz e, principalmente, o motivo.
O diff mostra o "o quê"; o que ninguém consegue deduzir depois é o "por quê".
Se resolve uma issue, escreva "Resolve #123".
-->

## Checklist

- [ ] `npm run check` passou na minha máquina (lint + typecheck + testes)
- [ ] Escrevi testes cobrindo o novo comportamento — inclusive o caso em que ele **não** deve disparar
- [ ] Nenhum segredo entrou no diff (token, `META_APP_SECRET`, `SETUP_ADMIN_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, conteúdo de `.dev.vars` ou `.env`)
- [ ] Atualizei a documentação, se o comportamento visível para quem usa mudou
- [ ] Segui o padrão de commit do projeto (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`)

<!--
Se este PR mexe no texto enviado por Direct (src/utils/templates.ts) ou na
lógica de gatilho (src/utils/normalize.ts, src/services/automation.ts), o teste
não é opcional: cada pessoa roda a própria instância, e um erro nessas duas
áreas chega direto no Direct de gente real. Veja o CONTRIBUTING.md, seção 5.
-->
