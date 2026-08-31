# Segurança

Este documento explica **o que** o projeto protege, **como** protege e, principalmente, **por quê** cada decisão foi tomada do jeito que foi. A ideia é que alguém que nunca abriu o painel da Meta consiga ler isto e entender o raciocínio.

Projeto: automação de comentários do Instagram.
Stack: Cloudflare Workers + TypeScript + D1.
Worker: `noxe-insta-automation`
Configuração: `wrangler.jsonc` (este projeto **não** usa `wrangler.toml`).
Versão da Graph API: `v25.0` (variável `META_API_VERSION` no `wrangler.jsonc`).

---

## 1. Modelo de ameaças (resumido)

### O que existe de valioso aqui

| Ativo | Por que importa |
|---|---|
| **Token de acesso do Instagram** | É a chave da conta. Quem tiver ele consegue responder comentários e mandar Direct em nome do perfil. Fica cifrado no D1. |
| **`META_APP_SECRET`** | Assina os webhooks. Quem tiver ele consegue forjar eventos falsos que o Worker aceitaria como verdadeiros. |
| **`SETUP_ADMIN_TOKEN`** | Abre as rotas administrativas (`/setup/authorize`, `/setup/subscribe`). |
| **`TOKEN_ENCRYPTION_KEY`** | Decifra o token guardado no D1. |
| **`META_WEBHOOK_VERIFY_TOKEN`** | Usado só no handshake inicial do webhook, mas se vazar permite que outra pessoa aponte um webhook para cá se souber a URL. |
| **Reputação da conta do Instagram** | O dano mais barato de causar não é técnico: é fazer o perfil mandar spam. |

### Contra o que o sistema se defende

1. **Webhook forjado.** Qualquer pessoa na internet pode fazer `POST` para `https://SEU-WORKER.SEU-SUBDOMINIO.workers.dev/webhooks/instagram`. A URL é pública por definição — a Meta precisa alcançá-la. A defesa não é esconder a URL, é a assinatura HMAC.
2. **Replay / disparo em massa.** Mandar o mesmo evento mil vezes para o perfil responder mil vezes ao mesmo comentário. Defesa: claim atômico no D1.
3. **CSRF no OAuth.** Fazer a vítima concluir um fluxo de autorização que o atacante iniciou, ou entregar um `code` do atacante para o callback. Defesa: `state` assinado com HMAC.
4. **Vazamento de token no banco.** Se alguém obtiver leitura do D1, não deve sair de lá com um token utilizável. Defesa: AES-GCM 256.
5. **Uso indevido das rotas administrativas.** Defesa: `Authorization: Bearer` com comparação em tempo constante.
6. **Exaustão de recursos.** Corpo gigante no webhook para consumir CPU/memória do Worker. Defesa: limite de 512 KB.
7. **Exposição de dados de terceiros.** Quem comenta no post não escolheu ser catalogado por este sistema. Defesa: coleta mínima.

### Contra o que o sistema **não** se defende

Vale ser honesto sobre isso:

- **Comprometimento da conta Cloudflare.** Quem tiver acesso ao dashboard da Cloudflare consegue trocar o código do Worker e ler o que quiser. Proteja essa conta com 2FA.
- **Comprometimento da conta Meta / Business.** Mesma coisa do lado da Meta.
- **Máquina de desenvolvimento comprometida.** Se o notebook onde você roda `wrangler` estiver infectado, os segredos passam por ali no momento em que você os digita.
- **Abuso legítimo dentro do fluxo esperado.** Se cem pessoas comentarem a palavra-chave de verdade, o sistema vai responder a cem pessoas de verdade. Isso é comportamento correto, não ataque.

---

## 2. Mecanismos implementados, e o porquê de cada um

### 2.1 Validação HMAC do webhook (`src/security/webhook-signature.ts`)

**O que é.** Toda requisição `POST /webhooks/instagram` chega com um cabeçalho `X-Hub-Signature-256`. A Meta calcula um HMAC-SHA256 do corpo da requisição usando o `META_APP_SECRET` como chave e coloca o resultado nesse cabeçalho. O Worker recalcula o mesmo HMAC e compara.

**Por que importa.** A URL do webhook é pública. Sem essa checagem, qualquer pessoa que descobrisse o endereço poderia enviar um JSON inventado dizendo "fulano comentou a palavra-chave" e fazer o perfil disparar Directs para quem o atacante quisesse. A assinatura é a única coisa que diferencia "a Meta mandou isto" de "alguém mandou isto".

**Por que o corpo CRU (raw) importa — este é o ponto mais fácil de errar.**

O HMAC é calculado sobre os **bytes exatos** que a Meta enviou. Não sobre o significado do JSON — sobre os bytes.

Se o código fizer `await request.json()` e depois `JSON.stringify(...)` para calcular a assinatura, o resultado quase sempre vai ser diferente, porque:

- espaços, quebras de linha e indentação são preservados nos bytes originais e perdidos no `stringify`;
- a ordem das chaves pode mudar;
- escapes Unicode (`é` vs. `é`) podem ser normalizados de forma diferente;
- números podem ser reformatados (`1.0` virando `1`).

Qualquer uma dessas diferenças muda todos os bits do HMAC. O resultado prático seria: ou a validação falha sempre (e nada funciona), ou — pior — alguém "conserta" desligando a validação.

Por isso o fluxo correto, e o que está implementado, é:

1. ler o corpo **uma vez** como texto/bytes crus (`await request.text()` / `arrayBuffer`);
2. validar o HMAC sobre exatamente esse conteúdo;
3. só **depois** fazer o parse do JSON a partir daquele mesmo texto.

Nunca parsear antes de validar, e nunca reserializar para validar.

**Comparação em tempo constante, de graça.** A verificação usa `crypto.subtle.verify`, que já compara em tempo constante por construção. Não há `===` de strings de assinatura no caminho.

### 2.2 Comparação em tempo constante (`src/security/constant-time.ts`)

**Onde é usada.** No `META_WEBHOOK_VERIFY_TOKEN` (handshake `GET /webhooks/instagram`) e no `SETUP_ADMIN_TOKEN` (`/setup/authorize` e `/setup/subscribe`).

**O problema que resolve.** Comparação normal de string (`a === b`) para assim que encontra o primeiro caractere diferente. Isso significa que comparar `"aXXXXXXX"` com o token real leva um tiquinho mais de tempo do que comparar `"XXXXXXXX"`, se o token começar com `a`.

Essa diferença é de nanossegundos. Mas é **mensurável** com repetição suficiente. Um atacante pode descobrir o primeiro caractere testando os 62 possíveis e vendo qual demora mais, depois o segundo, e assim por diante. Um segredo de 32 caracteres deixa de exigir 62³² tentativas e passa a exigir 62 × 32 — de impossível para trivial.

**Como se resolve.** A comparação em tempo constante percorre **todos** os bytes sempre, acumulando as diferenças com XOR, e só no final decide. O tempo de execução não depende de *onde* está a diferença. Comprimentos diferentes também são tratados sem vazar informação.

**Regra prática para quem for mexer no código:** qualquer comparação de segredo passa por `constant-time.ts`. Nunca por `===`.

### 2.3 `state` do OAuth assinado com HMAC (`src/security/oauth-state.ts`)

**O fluxo.** `GET /setup/authorize` (protegida por Bearer) monta a URL de consentimento em `https://www.instagram.com/oauth/authorize`. O usuário autoriza. A Meta redireciona de volta para `GET /oauth/callback` trazendo um `code` e o `state` que foi enviado na ida.

**O ataque sem `state` (CSRF).** O `/oauth/callback` precisa ser publicamente acessível — quem chama nele é o navegador vindo da Meta, e não dá para exigir um cabeçalho `Authorization` nesse redirecionamento. Então, sem proteção, qualquer pessoa poderia chamar `/oauth/callback?code=...` com um `code` obtido de outra conta e fazer o sistema guardar o token de uma conta que não é a sua.

**Como o `state` fecha isso.** O `/setup/authorize` gera um `state` que carrega um carimbo de tempo e vem **assinado com HMAC**. O `/oauth/callback` só aceita um `state` cuja assinatura confere. Como o atacante não tem a chave, ele não consegue fabricar um `state` válido — e, portanto, não consegue completar o callback. Na prática, **o `state` assinado é o que autentica o `/oauth/callback`**.

**Por que expira em 10 minutos.** Três razões:

1. **Janela de replay curta.** Se um `state` válido vazar (histórico do navegador, log de proxy, print de tela, ombro alheio), ele deixa de servir em dez minutos.
2. **É tempo de sobra para o uso real.** Autorizar um app no Instagram leva menos de um minuto. Dez minutos cobrem confortavelmente uma pessoa que precisa fazer login, digitar 2FA, e ainda hesitar um pouco. Não há motivo legítimo para durar mais.
3. **Não precisa de armazenamento.** Como o `state` é autocontido e assinado, o Worker não guarda nada e nem precisa limpar registros vencidos — a expiração é verificada a partir do próprio conteúdo assinado.

**Detalhe do `code` que costuma pegar gente desprevenida.** O `code` do OAuth vale **1 hora**, é de **uso único**, e a Meta **anexa um sufixo `#_`** ao final. Esse sufixo precisa ser removido antes de trocar o `code` pelo token, senão a troca falha.

### 2.4 AES-GCM 256 no token guardado (`src/security/encryption.ts`)

**O que é cifrado.** O token de acesso do Instagram, antes de ir para o D1. A chave é o segredo `TOKEN_ENCRYPTION_KEY`.

**Por que cifrar se o D1 já é privado.** Defesa em profundidade. O banco pode ser exposto por um bug de aplicação, por um dump feito para depuração, por um backup mal guardado, ou por acesso indevido ao painel. Em qualquer um desses cenários, o que vaza é texto cifrado — e a chave não está no banco, está nos secrets do Worker, que é outro lugar. O atacante precisaria comprometer os **dois** lugares.

**Por que AES-GCM e não AES-CBC.** GCM é um modo **autenticado**: além de cifrar, ele produz uma tag de autenticação. Se alguém alterar um único bit do texto cifrado no banco, a decifragem **falha com erro** em vez de devolver lixo silenciosamente. Isso protege contra manipulação do banco, não só contra leitura.

**Por que o IV é aleatório a cada operação — o ponto mais importante desta seção.**

O IV (vetor de inicialização, também chamado de nonce) é um valor que entra na cifragem junto com a chave. No AES-GCM, **reutilizar o mesmo IV com a mesma chave é catastrófico**, e não é exagero de manual:

- O GCM funciona gerando uma sequência pseudoaleatória a partir de (chave, IV) e fazendo XOR com o texto claro. Se dois textos diferentes forem cifrados com a mesma chave e o mesmo IV, o XOR dos dois textos cifrados é igual ao XOR dos dois textos claros. A chave nem precisa ser descoberta — o atacante que conheça (ou adivinhe) um dos textos recupera o outro diretamente.
- Pior: a repetição de nonce no GCM permite recuperar a **chave de autenticação** interna, o que quebra a garantia de integridade e permite forjar textos cifrados válidos.

Por isso o IV **nunca** é fixo, nunca é derivado do conteúdo e nunca é reaproveitado. É gerado com `crypto.getRandomValues` a **cada** operação de cifragem e guardado junto com o texto cifrado. O IV não é secreto — ele pode ficar em claro ao lado do dado. O que ele precisa ser é **único**.

Consequência prática: cifrar o mesmo token duas vezes produz dois resultados completamente diferentes no banco. Isso é o comportamento correto e esperado.

### 2.5 IGSID do autor guardado apenas como SHA-256 (`src/utils/hash.ts`)

**O que é o IGSID.** É o identificador do usuário do Instagram dentro do escopo do app — o "quem" de cada comentário.

**Por que não guardar o valor original.** O sistema precisa responder a uma pergunta simples: *"eu já respondi a esta pessoa neste comentário?"*. Para isso, não é preciso saber **quem** a pessoa é — basta conseguir **reconhecer** se é a mesma. Um hash SHA-256 resolve exatamente isso: entradas iguais produzem hashes iguais, então a comparação continua funcionando, mas o identificador original não fica armazenado.

Isso muda o resultado de um vazamento. Com o IGSID em claro, um dump do banco entrega uma lista de identificadores reais de pessoas que interagiram com o perfil — dado pessoal, reidentificável, ligável a outros conjuntos. Com hash, o que vaza é uma lista de valores opacos, útil apenas para o próprio sistema.

**Sendo honesto sobre a limitação.** SHA-256 puro sobre um espaço de identificadores conhecido não é irreversível na teoria: alguém que já possua uma lista de IGSIDs pode hashear todos e cruzar. O hash **reduz** a exposição, não a elimina. Ele foi escolhido porque o requisito funcional (comparar igualdade sem reter o valor) é atendido e o custo de um vazamento cai bastante. Se for preciso mais garantia no futuro, o caminho seria adicionar um sal secreto — e isso precisa ser avaliado com calma, porque um sal rotacionado invalida todos os registros antigos.

**O que também não é guardado:** o **texto do comentário** e o **username** de quem comentou. O texto é avaliado em memória para decidir se aciona a automação e depois é descartado. Nada disso é necessário depois da decisão, então nada disso é persistido.

### 2.6 Limite de 512 KB no corpo do webhook

**Por quê.** Um Worker tem limites de CPU e memória por requisição. Se alguém enviar um corpo de dezenas de megabytes, o Worker gasta tempo e memória lendo e calculando HMAC sobre lixo — mesmo que no fim rejeite. Repetir isso é um jeito barato de degradar o serviço.

O corte de 512 KB é feito **antes** do processamento pesado. Notificações reais de comentário são objetos JSON pequenos, na casa de poucos kilobytes, então o limite tem margem enorme sobre o uso legítimo e ainda assim descarta cedo o que é claramente abusivo.

### 2.7 Ordem do fluxo: claim atômico → Direct → resposta pública

Esta ordem é **crítica** e não pode ser trocada por conveniência.

```
1. claim atômico no D1      (reserva exclusiva do comentário)
2. Direct                    (POST /{ig-user-id}/messages)
3. resposta pública          (POST /{comment-id}/replies)
```

**Por que o claim atômico vem primeiro e é obrigatório.**

A Meta permite **apenas UMA** private reply por comentário. Não é uma recomendação — é um limite da plataforma. A segunda tentativa falha.

Ao mesmo tempo, webhooks podem chegar **duplicados**. Isso é normal em sistemas de entrega de eventos: se a Meta não recebeu confirmação a tempo, ela reenvia. E o Worker é serverless — duas execuções podem estar processando o mesmo comentário **ao mesmo tempo**, em isolados diferentes, sem memória compartilhada.

Sem claim atômico, o cenário é este: duas execuções leem "ainda não respondi", as duas concluem que devem responder, e as duas chamam a API. Uma consome a única private reply disponível e a outra recebe erro. Pior: dependendo de onde cada uma parar, o perfil pode acabar publicando **duas respostas públicas** no mesmo comentário — o que é visível para todo mundo e parece bot quebrado.

O claim atômico resolve porque a decisão de "quem processa este comentário" acontece em **uma única operação de escrita no banco**, que só pode ter um vencedor. Quem vence, segue. Quem perde, para ali e não faz nenhuma chamada à API. Um `SELECT` seguido de um `INSERT` **não** serve: entre as duas operações cabe outra execução inteira.

**Por que o Direct vem ANTES da resposta pública.**

Porque o Direct é o passo que pode falhar de forma irreversível, e a resposta pública é o passo que fica visível para todo mundo.

A resposta pública é, na prática, uma **promessa**: "olha na sua caixa de mensagens". Se ela for publicada primeiro e o Direct falhar depois, o resultado é uma promessa quebrada em público — a pessoa vai procurar uma mensagem que nunca chegou, no comentário, à vista de todos os seguidores. Não há como desfazer isso de forma limpa, e não dá para tentar o Direct de novo mais tarde sem esbarrar no limite de uma private reply por comentário.

Invertendo a ordem, o pior caso fica muito melhor: o Direct falha, a resposta pública **não** é publicada, e ninguém vê nada. O evento é registrado para diagnóstico e o comentário simplesmente não recebe resposta. Falhar em silêncio é preferível a falhar em público.

**Regra:** se o Direct falhar, a resposta pública **não** é publicada. Nunca inverta esses dois passos.

**Limites da plataforma que moldam esse fluxo:**

| Limite | Valor |
|---|---|
| Private replies por comentário | 1 (uma) |
| Janela para responder | 7 dias a partir da criação do comentário |
| Rate limit de private replies | 750 chamadas/hora por conta profissional |

### 2.8 Resposta rápida no webhook + processamento em `waitUntil`

O `POST /webhooks/instagram` valida a assinatura, responde `200` imediatamente e faz o trabalho pesado em `waitUntil`.

**Por que.** Provedores de webhook interpretam demora como falha e **reenviam** o evento. Se o Worker segurasse a resposta até terminar de chamar a Graph API duas vezes, uma lentidão pontual da Meta viraria timeout, que viraria reenvio, que viraria mais carga — exatamente quando o sistema já está lento. Responder rápido corta esse laço. A proteção contra os reenvios que ainda acontecerem é o claim atômico da seção anterior.

### 2.9 Nenhum segredo em log

Nada de token, `code`, `state`, assinatura ou valor de segredo é escrito em log. Logs de Worker são visíveis para qualquer pessoa com acesso ao painel da Cloudflare e ficam retidos; um token em log é um token vazado, mesmo que o painel seja privado.

Ao depurar com `npm run tail`, resista à tentação de adicionar um `console.log(token)` "só para ver". Se precisar confirmar que um valor chegou, logue o **comprimento** ou os últimos quatro caracteres — nunca o valor.

---

## 3. Gestão de segredos

São **4** segredos. Todos vivem nos secrets do Worker na Cloudflare, definidos por `wrangler secret put`. Nenhum deles fica no `wrangler.jsonc`, nenhum vai para o repositório.

| Segredo | Para que serve | Onde nasce |
|---|---|---|
| `META_APP_SECRET` | Chave do HMAC que valida a assinatura do webhook | Painel da Meta, no app do Instagram |
| `META_WEBHOOK_VERIFY_TOKEN` | Handshake do webhook (`GET /webhooks/instagram`) | Você inventa; precisa ser idêntico dos dois lados |
| `TOKEN_ENCRYPTION_KEY` | Chave AES-GCM 256 que cifra o token no D1 | Você gera aleatoriamente |
| `SETUP_ADMIN_TOKEN` | Bearer das rotas `/setup/authorize` e `/setup/subscribe` | Você gera aleatoriamente |

### Onde cada coisa vive

- **Configuração não secreta** (`META_API_VERSION`, binding do D1, etc.): `wrangler.jsonc`, versionado normalmente.
- **Configuração de comportamento** (`automationConfig`, `mediaAutomations`): `src/config.ts`. Não é secreto — é regra de negócio.
- **Segredos**: apenas nos secrets do Worker. Se algum dia você vir um deles em um arquivo do repositório, trate como vazamento e siga a seção 5.

### Como rotacionar cada um

**Regra geral:** `wrangler secret put NOME` pede o valor de forma interativa e não deixa rastro no histórico do shell. **Nunca** passe o valor como argumento na linha de comando.

#### `META_APP_SECRET`

Este é o único que **não é você quem escolhe** — quem gera é a Meta.

1. No painel da Meta, no app do Instagram, gere/redefina a chave secreta.
2. `wrangler secret put META_APP_SECRET` e cole o novo valor.
3. `npm run deploy`.
4. Confirme que webhooks continuam sendo aceitos (`npm run tail` e provoque um comentário de teste).

**Cuidado com a janela.** Entre trocar na Meta e fazer o deploy, os webhooks que chegarem virão assinados com a chave nova e serão rejeitados pela chave antiga ainda em produção. Faça os dois passos em sequência, sem pausa.

**Atenção — pendência a confirmar:** no fluxo **Instagram Login**, os valores que valem são o *ID do app do Instagram* e a *Chave secreta do app do Instagram*, encontrados em **Casos de uso > Personalizar** — e **não** os de *Configurações > Básico*. Antes de rotacionar, confirme que os valores em `META_APP_ID` e `META_APP_SECRET` são os dessa tela. Isso ainda está pendente de verificação neste projeto (ver "Pendências abertas neste projeto", no fim deste documento).

#### `META_WEBHOOK_VERIFY_TOKEN`

Este segredo precisa ser **idêntico** em dois lugares: no Worker e no painel da Meta.

1. Gere um valor novo (ver "como gerar" abaixo).
2. `wrangler secret put META_WEBHOOK_VERIFY_TOKEN`.
3. `npm run deploy`.
4. No painel da Meta: **Casos de uso > Personalizar > Webhooks**. Atualize o Verify Token e refaça a verificação da Callback URL.

Ordem importa: se você trocar na Meta antes de fazer o deploy, o handshake falha. Worker primeiro, Meta depois.

Esse token só é usado no handshake, então uma incompatibilidade não derruba o processamento de eventos já inscritos — ela impede reconfigurar o webhook. Ainda assim, mantenha os dois em sincronia.

#### `TOKEN_ENCRYPTION_KEY`

Este é o mais delicado, porque **o dado cifrado no D1 depende dele**.

Trocar essa chave torna o token que está no banco **impossível de decifrar**. Não existe migração automática. O procedimento é:

1. Gere a chave nova.
2. `wrangler secret put TOKEN_ENCRYPTION_KEY`.
3. `npm run deploy`.
4. **Refaça o fluxo de OAuth** por `GET /setup/authorize` para obter e cifrar um token novo com a chave nova.

Não rotacione essa chave "por higiene" sem estar pronto para refazer o OAuth logo em seguida. Entre o passo 3 e o passo 4, a automação não consegue usar o token e fica fora do ar.

#### `SETUP_ADMIN_TOKEN`

O mais simples dos quatro, porque nada além dele depende dele.

1. Gere um valor novo.
2. `wrangler secret put SETUP_ADMIN_TOKEN`.
3. `npm run deploy`.
4. Atualize o valor onde quer que você guarde (gerenciador de senhas). Não deixe em arquivo de texto solto nem no histórico do terminal.

### Como gerar um valor aleatório forte

Para `TOKEN_ENCRYPTION_KEY` e `SETUP_ADMIN_TOKEN`, use um gerador criptográfico — não invente à mão, não use nome de cachorro com número no fim.

No PowerShell:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Se tiver Node à mão (é o caso deste projeto):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

O formato exato exigido pelo `TOKEN_ENCRYPTION_KEY` (base64, hex, comprimento) está definido em `src/security/encryption.ts` — confirme lá antes de gerar, para não descobrir o formato errado só na hora do deploy.

---

## 4. Coleta mínima de dados

O princípio é direto: **o dado que não é guardado não pode vazar.** Quem comenta em um post não pediu para entrar em banco de dados nenhum.

### O que É guardado

| Dado | Forma | Por que é necessário |
|---|---|---|
| ID do comentário | Em claro | É a chave do claim atômico — sem ele não dá para garantir uma resposta só |
| IGSID do autor | **Apenas SHA-256** | Permite reconhecer "é a mesma pessoa" sem reter o identificador |
| Estado do processamento | Em claro | Saber se o comentário foi reivindicado, respondido, ou falhou |
| Carimbos de tempo | Em claro | Diagnóstico e controle da janela de 7 dias |
| Token de acesso | **Cifrado com AES-GCM 256** | É preciso para chamar a Graph API entre execuções |

### O que NÃO é guardado

- **Texto do comentário.** É lido em memória para decidir se a automação dispara e descartado em seguida. Guardar isso significaria manter conteúdo escrito por terceiros — o dado de maior sensibilidade e menor utilidade do conjunto.
- **Username de quem comentou.** Não é necessário para nada no fluxo. Um username é diretamente identificável e ligável ao perfil público da pessoa; um hash não é.
- **IGSID em claro.** Só a forma hasheada (seção 2.5).
- **Foto, bio, contagem de seguidores ou qualquer outro dado de perfil.** Não são solicitados nem armazenados.

### Por que isso também é bom para você

Além de ser a coisa certa a fazer com dado de terceiro, guardar menos:

- reduz o estrago de um vazamento a quase nada de valor pessoal;
- diminui a superfície de responsabilidade sobre dados pessoais;
- simplifica atender pedidos de exclusão — há muito pouco a excluir;
- deixa o banco menor e mais barato.

### Permissões solicitadas

O app pede apenas os escopos necessários:

```
instagram_business_basic
instagram_business_manage_comments
instagram_business_manage_messages
```

`instagram_business_content_publish` **não** é solicitado, porque o projeto não publica mídia. Pedir permissões que não são usadas aumenta o dano de um token vazado sem trazer benefício algum.

> Nota: os nomes de escopo sem o prefixo `instagram_` foram descontinuados em 27/01/2025. Use apenas os nomes acima.

### Nível de acesso

**Standard Access basta** para operar a própria conta — não exige App Review. **Advanced Access** (com App Review e Verificação de Negócio) só é necessário para atender contas de **terceiros/clientes**. Enquanto o projeto for só para a sua conta, não solicite Advanced Access: mais acesso é mais risco sem contrapartida.

---

## 5. O que fazer se um segredo vazar

Vazamento é quando um segredo foi visto por quem não devia: commitado por engano, colado num chat, exposto em print, ou você simplesmente não tem certeza. **Na dúvida, trate como vazado.** Rotacionar custa minutos; não rotacionar pode custar a conta.

### Ordem geral (siga de cima para baixo)

1. **Pare e avalie o alcance.** Qual segredo? Onde apareceu? Por quanto tempo? Quem pôde ver? Se foi para o Git, ele está no histórico mesmo depois de você apagar o arquivo — o histórico também precisa ser tratado.
2. **Rotacione primeiro o que dá mais poder ao atacante.** A ordem de prioridade é:
   1. `TOKEN_ENCRYPTION_KEY` — porque leva ao token, que é o acesso à conta;
   2. `META_APP_SECRET` — porque permite forjar webhooks e disparar a automação à vontade;
   3. `SETUP_ADMIN_TOKEN` — porque abre as rotas administrativas;
   4. `META_WEBHOOK_VERIFY_TOKEN` — o de menor impacto isolado, mas rotacione mesmo assim.
3. **Faça o deploy imediatamente após cada `wrangler secret put`.** Um segredo trocado que não foi deployado não protege nada.
4. **Invalide o token do Instagram.** Se houver qualquer suspeita de que o token em si vazou (ou de que a `TOKEN_ENCRYPTION_KEY` vazou junto com um dump do D1), o token precisa deixar de valer. Refaça o OAuth por `GET /setup/authorize` para obter um novo. Se for necessário revogar explicitamente o token antigo pelo lado da Meta, **o procedimento de revogação precisa ser confirmado na documentação oficial da Meta** — não está definido neste projeto e não vou chutar o passo a passo.
5. **Verifique o que foi feito com o acesso.** Olhe o perfil no Instagram: houve resposta pública ou Direct que você não reconhece? Rode `npm run tail` e olhe os logs recentes do Worker. Verifique se as inscrições de webhook continuam as que você configurou.
6. **Limpe o rastro.** Se o segredo foi para um repositório Git, remover o arquivo **não** basta — o valor continua no histórico e em qualquer clone/fork existente. Rotacionar continua sendo obrigatório mesmo depois de limpar o histórico; a limpeza é complementar, nunca substituta.
7. **Registre o que aconteceu.** Data, qual segredo, como vazou, o que foi rotacionado, o que foi verificado. Serve para não repetir o erro.

### Procedimentos específicos

**Se vazou `TOKEN_ENCRYPTION_KEY`:**
Chave nova → `wrangler secret put` → `npm run deploy` → refazer OAuth por `/setup/authorize`. O token antigo no D1 fica indecifrável, o que é o comportamento desejado. Presuma que o token antigo está comprometido e substitua-o.

**Se vazou `META_APP_SECRET`:**
Redefina no painel da Meta → `wrangler secret put` → `npm run deploy` → provoque um comentário de teste e confirme pelo `npm run tail` que a assinatura está sendo aceita. Enquanto o segredo antigo era válido, qualquer pessoa podia forjar webhooks — revise as respostas publicadas no período.

**Se vazou `SETUP_ADMIN_TOKEN`:**
Valor novo → `wrangler secret put` → `npm run deploy`. Depois verifique se alguém usou as rotas administrativas: `/setup/authorize` inicia um fluxo de OAuth e `/setup/subscribe` mexe nas inscrições de webhook. Confirme que a inscrição no campo `comments` continua correta.

**Se vazou `META_WEBHOOK_VERIFY_TOKEN`:**
Valor novo → `wrangler secret put` → `npm run deploy` → atualizar no painel da Meta em **Casos de uso > Personalizar > Webhooks** e refazer a verificação da Callback URL.

**Se o token do Instagram ficou mais de 60 dias sem renovação:**
Isto não é vazamento, mas o remédio é parecido e vale registrar aqui. Não existe refresh depois de expirado — o único caminho é **refazer o OAuth** por `/setup/authorize`.

---

## 6. Antes de tornar o seu repositório público

Se você forkou este projeto e vai publicar o seu próprio repositório, pare cinco minutos e passe por esta lista. Ela é curta de propósito: são os erros que realmente acontecem, não hipóteses.

### 6.1 Os arquivos de segredo não podem ir para o GitHub

Os segredos ficam em dois arquivos locais: `.env` (usado pelos scripts em Node) e `.dev.vars` (usado pelo `wrangler dev`). Nenhum dos dois pode ser versionado.

O `.gitignore` deste projeto já bloqueia os dois, e também as variações mais comuns (`.env.backup-...`, `.env copy`, `secrets.txt`, `*.bak`). Só os arquivos de exemplo — `.env.example` e `.dev.vars.example`, que contêm apenas nomes de variáveis e nenhum valor — é que passam.

Mesmo assim, **confira antes do primeiro commit**:

```
git status
```

Se `.env` ou `.dev.vars` aparecerem nessa listagem, alguma coisa está errada — pare e corrija o `.gitignore` antes de commitar. Se eles **não** aparecerem, está tudo certo: o Git não está enxergando esses arquivos.

O script de verificação do projeto também faz essa checagem para você:

```
npm run verificar
```

### 6.2 Publique sempre por `git` — nunca por upload de ZIP

Este é o furo mais silencioso de todos, e vale um parágrafo próprio.

O `.gitignore` é um arquivo que **o Git** lê. Ele não é uma propriedade da pasta. Se você compactar o projeto em um `.zip` e subir pelo site do GitHub, ou arrastar a pasta inteira para a interface web, **quem está copiando os arquivos não é o Git** — e o `.gitignore` é simplesmente ignorado. Resultado: `.env` e `.dev.vars` sobem junto, com os segredos dentro, para um repositório público.

A mesma armadilha vale para copiar a pasta para o Google Drive, mandar por WhatsApp ou anexar em e-mail: são caminhos que não passam pelo Git e não respeitam o `.gitignore`.

**Regra:** a única forma aceitável de publicar este projeto é `git add` / `git commit` / `git push`. Sem exceção.

### 6.3 Se um segredo já foi publicado, apagar não resolve

Suponha que você commitou o `.env` sem perceber e só notou depois. A reação natural é apagar o arquivo e fazer um commit novo. **Isso não resolve nada.**

O Git guarda o histórico. O commit antigo continua lá, com o conteúdo do arquivo intacto, acessível para qualquer pessoa que clone o repositório — e já replicado em todo fork, clone ou cache que existir. Ferramentas automatizadas varrem o GitHub continuamente procurando exatamente isso; o tempo entre publicar um segredo e ele ser encontrado costuma ser de minutos.

**O que fazer, nesta ordem:**

1. **Rotacione os segredos imediatamente.** Este é o passo que de fato protege — os outros são limpeza. Siga a seção 5.
2. Só depois pense em limpar o histórico. É complementar, nunca substituto.

Um segredo que foi publicado é um segredo queimado. Trate-o como tal, mesmo que o repositório tenha ficado público por dez segundos.

### 6.4 Placeholders que precisam ser trocados antes de publicar

Alguns arquivos vêm com valores de fábrica que você precisa substituir pelos seus:

| Arquivo | O que trocar |
|---|---|
| `wrangler.jsonc` | `database_id` — o ID do **seu** banco D1 |
| `wrangler.jsonc` | `META_APP_ID` — o ID do **seu** app da Meta |
| `src/config.ts` | `destinationUrl` — o link que a automação envia |
| `src/routes/legal.ts` | `CONTATO_EMAIL` e `NOME_RESPONSAVEL` das páginas legais |

Sobre os dois últimos, uma ponderação honesta: `CONTATO_EMAIL` e `NOME_RESPONSAVEL` aparecem nas páginas públicas `/privacy-policy` e `/data-deletion`, e a Meta exige essas páginas para aprovar o app. Mas o que você colocar ali fica visível para a internet inteira e vai ser coletado por robôs de spam.

**Pense duas vezes antes de expor um e-mail pessoal.** Alternativas melhores: um e-mail criado só para isso, um alias/encaminhador, ou um endereço do domínio que você já usa profissionalmente. E lembre que o `database_id` e o `META_APP_ID` não são segredos — mas também não há motivo para publicar os seus quando um placeholder resolve.

---

## 7. Limitações conhecidas e aceitas

Esta seção existe para ser honesta. São pontos que uma auditoria do código encontrou, que **não** foram corrigidos, e que você deve conhecer antes de rodar isto em produção. Nenhum deles é grave o bastante para travar o uso do projeto, mas você merece saber onde estão as arestas.

Para cada item: qual é o risco real, e por que hoje ele é aceitável.

### 7.1 Não existe rate limiting em nenhum endpoint

**O risco.** Nenhuma rota tem limite de requisições por origem — nem mesmo as que comparam segredo (`/setup/authorize`, `/setup/subscribe`, o handshake do webhook). Qualquer pessoa pode disparar milhares de requisições contra elas.

**Por que é aceitável hoje.** Adivinhar o segredo por força bruta é inviável: `SETUP_ADMIN_TOKEN` e `META_WEBHOOK_VERIFY_TOKEN` são gerados com 32 bytes aleatórios de fonte criptográfica, ou seja, **256 bits de entropia** (veja `scripts/gerar-segredos.mjs`). Não existe volume de tentativas que chegue perto disso. O dano possível é outro, e é de custo, não de invasão: um atacante consegue **queimar a sua cota** do plano gratuito da Cloudflare com requisições inúteis. Se isso incomodar, a defesa não está no código — está no painel da Cloudflare, com uma regra de WAF ou Rate Limiting na frente do Worker.

### 7.2 O limite de 512 KB só vale depois que o corpo já está na memória

**O risco.** O `readWebhookRequest` (em `src/routes/webhook.ts`) primeiro olha o cabeçalho `content-length` e corta cedo se ele for grande demais. Mas esse cabeçalho é informado por quem faz a requisição — pode estar ausente ou mentir. Quando isso acontece, a checagem que vale é a seguinte, `rawBody.length > MAX_BODY_BYTES`, e ela só roda **depois** do `await request.text()`, ou seja, com o corpo inteiro já carregado na memória do Worker.

**Por que é aceitável hoje.** A Cloudflare já impõe os próprios limites de tamanho de requisição e de memória por invocação antes do seu código ser alcançado, então o teto real não é o do projeto. O efeito prático de um corpo gigante é uma invocação desperdiçada, não uma quebra: o pedido é rejeitado com `413` e nunca chega ao processamento. É o mesmo tipo de custo descrito no item 7.1.

### 7.3 Promises em `ctx.waitUntil` podem rejeitar em silêncio

**O risco.** O webhook responde `200` na hora e joga o trabalho pesado para `ctx.waitUntil(processEvents(...))` (em `src/index.ts`). Dentro do laço, cada comentário tem seu próprio `try`/`catch` — um evento com problema não derruba os outros. Mas o que roda **antes** do laço não tem essa proteção: carregar a conta e decifrar o token. Se uma dessas etapas lançar erro (D1 indisponível, chave de cifra trocada), a promise rejeita sem tratamento e o **lote inteiro** se perde sem deixar registro claro. Vale o mesmo para o cron, em `runScheduledTasks` → `retryPending`.

**Por que é aceitável hoje.** É perda de disponibilidade, não de segurança: nada vaza, nada é executado indevidamente, nenhuma resposta duplicada é publicada. E os comentários perdidos não somem de vez — a Meta reenvia webhooks não confirmados, e a tabela de pendentes é varrida pelo cron. Na prática o pior caso é um atraso, não um dado perdido. Ainda assim: se você adicionar código ao `waitUntil`, envolva tudo em `try`/`catch` com log.

### 7.4 IDs vindos do payload entram nas URLs da Graph API sem `encode`

**O risco.** Em `src/services/meta-api.ts`, valores como `commentId`, `mediaId` e `igUserId` são interpolados direto no caminho da URL (`` `${HOST_GRAPH}/${this.apiVersion}/${commentId}/replies` ``), sem `encodeURIComponent`. Um ID que contivesse `?`, `#` ou `..` poderia, em teoria, alterar o significado da URL montada.

**Por que é aceitável hoje.** Duas travas em série. Primeiro, esses IDs só chegam ali depois de um webhook cuja **assinatura HMAC foi validada** — para injetar um ID malicioso seria preciso já ter o `META_APP_SECRET`, e quem tem esse segredo tem problemas maiores para causar. Segundo, o `assertGraphHost` lança erro se a URL final não começar exatamente com `https://graph.instagram.com/`, o que impede o desvio mais perigoso, que seria mandar o token de acesso para outro servidor. O risco residual fica em manipular parâmetros de consulta de uma chamada que já é sua.

### 7.5 O `error_reason` do callback volta na resposta e no log sem tratamento

**O risco.** Em `src/routes/oauth.ts`, quando o usuário nega a autorização, o `/oauth/callback` lê `error_reason` da query string e devolve esse texto na resposta (`Autorizacao negada: ${motivo}`), além de gravá-lo no log. É conteúdo controlado por quem monta o link.

**Por que é aceitável hoje.** A resposta sai com `content-type: text/plain; charset=utf-8`, então o navegador exibe o texto como texto — não interpreta HTML nem executa script. O que sobra é a possibilidade de alguém montar um link que mostra uma mensagem enganosa a quem clicar, e de sujar o log com texto inventado. Nenhum dos dois toca segredo, token ou banco. Se for mexer nesse trecho, a correção certa é validar `error_reason` contra a lista de valores que a Meta documenta, em vez de ecoar o que veio.

### 7.6 O que já estava documentado e continua valendo

Não é novidade desta seção, mas cabe repetir junto: o sistema **não** se defende de conta Cloudflare comprometida, conta Meta comprometida, nem máquina de desenvolvimento infectada (seção 1). E o hash do IGSID reduz, mas não elimina, a reidentificação (seção 2.5).

---

## 8. Como reportar uma vulnerabilidade

### Onde reportar

Use o **GitHub Security Advisories**: na página do repositório, abra a aba **Security** e clique em **Report a vulnerability**.

Esse botão abre um canal **privado** entre você e quem mantém o projeto. Ninguém mais vê o relato enquanto ele não for publicado — nem os outros usuários, nem os robôs que varrem repositórios públicos.

**Por que não abrir uma issue pública.** Uma issue é indexada por buscadores em minutos e fica visível para todo mundo, inclusive para quem quer explorar a falha. Como este projeto é auto-hospedado (veja abaixo), cada instância rodando por aí passaria a ser um alvo conhecido antes de existir correção. Uma issue pública transforma um problema em uma receita de ataque distribuída de graça.

Pelo mesmo motivo: não descreva o problema em post, thread, comentário de vídeo, grupo ou qualquer canal aberto antes de a correção existir.

**Não existe e-mail de contato para segurança neste projeto.** O canal é o do GitHub, e é de propósito: ele fica registrado, é privado e não depende de uma caixa de entrada pessoal.

### Não existe servidor central — cada pessoa roda a própria instância

Isto muda como uma falha aqui se propaga, e vale entender.

Não há um serviço rodando em algum lugar que atenda todo mundo. Cada pessoa que usa este projeto faz o deploy do **seu próprio** Worker, na **sua própria** conta Cloudflare, com o **seu próprio** banco D1 e os **seus próprios** segredos. Quem mantém o repositório não tem acesso nenhum à instância de ninguém.

As consequências práticas:

- Uma falha no código afeta **cada operador na infraestrutura dele**, separadamente. Não dá para "corrigir no servidor" e resolver para todos de uma vez.
- Uma correção só chega até alguém quando essa pessoa atualiza o próprio código e faz um novo `npm run deploy`.
- Se você encontrou algo, não há um botão para desligar as instâncias afetadas. O relato privado é justamente o que dá tempo de publicar a correção antes que a falha vire conhecimento público.

### O que interessa (escopo)

Estes são os problemas que valem um relato:

- **Bypass da validação HMAC do webhook** — qualquer caminho que faça o Worker aceitar um `POST /webhooks/instagram` sem assinatura válida da Meta.
- **Bypass do `SETUP_ADMIN_TOKEN`** — alcançar `/setup/authorize` ou `/setup/subscribe` sem o Bearer correto, incluindo vazamento de informação pela diferença de tempo ou de resposta.
- **Exposição do token de acesso ou da chave de cifra** — qualquer caminho que faça o token do Instagram, o `TOKEN_ENCRYPTION_KEY` ou o texto decifrado aparecerem em resposta HTTP, log, mensagem de erro ou banco em claro.
- **Falhas no fluxo OAuth** — forjar um `state` válido, reaproveitar um `state` já usado ou expirado, completar o `/oauth/callback` com `code` de outra conta, ou fixar a sessão de alguém.
- **Injeção no D1** — qualquer forma de escapar dos parâmetros vinculados (`bind`) e influenciar o SQL executado.

Se estiver em dúvida se algo se encaixa, relate assim mesmo. É melhor receber um relato a mais do que perder um relato de verdade.

### O que está fora de escopo

Estes casos já são conhecidos e não precisam de relato:

- **Ausência de rate limiting.** Já documentado na seção 7.1, com a razão de ser aceitável e o caminho de mitigação (regra na Cloudflare, não no código).
- **Falta de cabeçalhos de segurança nas páginas estáticas.** `/health`, `/privacy-policy` e `/data-deletion` são páginas sem qualquer campo de entrada e sem dado sensível. Ausência de CSP, HSTS ou `X-Frame-Options` ali não leva a nada explorável.
- **Qualquer coisa que exija acesso prévio à conta Cloudflare do operador.** Quem já entrou no painel pode trocar o código do Worker e ler os secrets — não há defesa possível no código contra isso, e a seção 1 já assume esse limite. O mesmo vale para acesso prévio ao painel da Meta ou à máquina de quem faz o deploy.
- **Relatos gerados por scanner automático sem demonstração de impacto.** Uma saída de ferramenta colada sem análise não é um relato.

### O que incluir no relato

- O que você encontrou, em uma frase.
- Como reproduzir, passo a passo.
- Qual o impacto na sua avaliação — o que um atacante consegue de fato fazer.
- Se tiver, uma sugestão de correção.

### Limites do teste

- **Não explore além do necessário** para demonstrar o problema.
- **Nunca teste contra a instância de outra pessoa.** Faça o deploy da sua própria e teste nela — é para isso que o projeto é auto-hospedado.
- Especificamente: não publique respostas nem Directs em nome de nenhum perfil, não extraia dados de terceiros, não degrade o serviço de ninguém.

### Prazo de resposta

Sejamos realistas sobre o tamanho da operação: este projeto é mantido por **uma pessoa só**, no tempo livre. O compromisso é o seguinte, e só ele:

- **Confirmação de recebimento em até 7 dias.**
- **Não há SLA de correção.** Não existe prazo garantido para o conserto sair. Um problema sério vai ser priorizado, mas não é possível prometer data.
- Você recebe crédito no aviso publicado, se quiser.

**Dê tempo para a correção antes de qualquer divulgação pública.** Se depois de um prazo razoável nada tiver acontecido, converse sobre isso no próprio advisory antes de publicar por conta própria.

---

## 9. Checklist de segurança antes de cada deploy

Rode isto **toda vez**, mesmo em mudança pequena. Mudança pequena é exatamente onde se erra.

### Verificação automática

```
npm run check       # roda lint + typecheck + test, em sequencia
npm run typecheck   # tipos
npm run lint        # lint
npm run test        # 125 testes devem passar
```

- [ ] `npm run check` passa
- [ ] `npm run typecheck` sem erros
- [ ] `npm run lint` limpo
- [ ] `npm run test` — os 125 testes passando

### Placeholders trocados pelos seus valores

Os valores de fábrica precisam sair antes de o projeto ir para o ar. Um placeholder esquecido não quebra o deploy — ele quebra o comportamento em produção, que é pior porque passa despercebido.

- [ ] `database_id` no `wrangler.jsonc` é o ID do **seu** banco D1
- [ ] `META_APP_ID` no `wrangler.jsonc` é o ID do **seu** app da Meta
- [ ] `destinationUrl` em `src/config.ts` é o link real, não `[COLOQUE_O_SEU_LINK_AQUI]`
- [ ] `CONTATO_EMAIL` e `NOME_RESPONSAVEL` em `src/routes/legal.ts` estão preenchidos (e você conferiu que não é um e-mail que prefere manter privado — ver seção 6.4)

### Segredos

- [ ] Nenhum segredo hardcoded no código, nos testes ou no `wrangler.jsonc`
- [ ] Nenhum `console.log` que imprima token, `code`, `state` ou assinatura
- [ ] Os 4 segredos estão definidos no Worker: `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `TOKEN_ENCRYPTION_KEY`, `SETUP_ADMIN_TOKEN`
- [ ] `.env` e `.dev.vars` locais, se existirem, **não** aparecem no `git status` (ver seção 6.1)

### Mecanismos de segurança intactos

- [ ] A validação HMAC do webhook está ativa e usa o **corpo cru** (nada de parsear antes de validar, nada de reserializar)
- [ ] Comparações de segredo passam por `src/security/constant-time.ts` — nenhum `===` novo comparando token
- [ ] O `state` do OAuth continua sendo assinado e com expiração de 10 minutos
- [ ] O IV do AES-GCM continua sendo aleatório por operação (nada de IV fixo, derivado ou reutilizado)
- [ ] O limite de 512 KB no corpo do webhook continua aplicado antes do processamento
- [ ] O IGSID continua sendo guardado apenas como SHA-256
- [ ] Texto do comentário e username continuam **não** sendo persistidos

### Ordem do fluxo

- [ ] A sequência continua **claim atômico → Direct → resposta pública**
- [ ] O claim é uma operação **atômica** no D1 (não um `SELECT` seguido de `INSERT`)
- [ ] Se o Direct falhar, a resposta pública **não** é publicada

### Rotas

- [ ] `/setup/authorize` e `/setup/subscribe` continuam exigindo `Authorization: Bearer`
- [ ] `/oauth/callback` continua validando o `state` assinado
- [ ] `/health`, `/privacy-policy` e `/data-deletion` não expõem nada sensível

### Banco

- [ ] Migrações aplicadas: `npm run db:migrate:local` para testar, `npm run db:migrate:remote` para produção
- [ ] A migração não introduz nenhuma coluna que guarde texto de comentário, username ou IGSID em claro

### Configuração da Meta

- [ ] `META_API_VERSION` no `wrangler.jsonc` está em `v25.0`
- [ ] Escopos limitados a `instagram_business_basic`, `instagram_business_manage_comments`, `instagram_business_manage_messages` — sem `instagram_business_content_publish`
- [ ] Hosts corretos por etapa: consentimento em `www.instagram.com`, troca do `code` em `api.instagram.com`, todo o resto em `graph.instagram.com`. **`graph.facebook.com` não é usado neste projeto** (pertence ao fluxo com Facebook Login)

### Depois do deploy

- [ ] `npm run tail` acompanhando
- [ ] Um comentário de teste dispara a automação de ponta a ponta
- [ ] Nenhum segredo apareceu nos logs
- [ ] Um segundo evento do mesmo comentário **não** gera segunda resposta (claim atômico funcionando)

---

## Pendências abertas neste projeto

Estes itens ainda estão sem resolução e afetam segurança ou conformidade. Registrados aqui para não serem esquecidos:

1. **`destinationUrl` em `src/config.ts`** vem de fábrica como `[COLOQUE_O_SEU_LINK_AQUI]`. Enquanto estiver assim, a automação enviaria o placeholder no lugar do link real.
2. **`CONTATO_EMAIL` e `NOME_RESPONSAVEL` em `src/routes/legal.ts`** são placeholders. As páginas públicas `/privacy-policy` e `/data-deletion` dependem deles. Leia a seção 6.4 antes de decidir qual e-mail colocar ali.
3. **Confirmar a origem do `META_APP_ID` / `META_APP_SECRET`.** No fluxo **Instagram Login**, os valores válidos são o *ID do app do Instagram* e a *Chave secreta do app do Instagram* da tela **Casos de uso > Personalizar** — **não** os de *Configurações > Básico*. É preciso confirmar que os valores configurados hoje vieram da tela certa.

---

## Referência rápida: endpoints e limites

Mantido aqui porque erro de host ou de campo em endpoint de autenticação vira problema de segurança rápido.

**Hosts — cada etapa usa um host diferente:**

| Etapa | Host |
|---|---|
| Consentimento | `https://www.instagram.com/oauth/authorize` |
| Troca do `code` | `POST https://api.instagram.com/oauth/access_token` (único uso deste host) |
| Todo o resto | `https://graph.instagram.com` |

**Endpoints:**

| Ação | Chamada |
|---|---|
| Resposta pública | `POST https://graph.instagram.com/v25.0/{comment-id}/replies` — body `{"message":"..."}` |
| Direct | `POST https://graph.instagram.com/v25.0/{ig-user-id}/messages` — body `{"recipient":{"comment_id":"..."},"message":{"text":"..."}}` |
| Dados da conta | `GET https://graph.instagram.com/v25.0/me?fields=user_id,username` — o campo é `user_id`, **não** `id` |
| Token longo | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token` — **sem** versão no path |
| Refresh | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` — **sem** versão no path |
| Inscrição | `POST https://graph.instagram.com/v25.0/me/subscribed_apps?subscribed_fields=comments` |

**Ciclo de vida dos tokens:**

| Item | Regra |
|---|---|
| Token curto | 1 hora |
| Token longo | 60 dias (5.184.000 s) |
| Refresh | Exige token com no mínimo **24h** de idade e ainda **não expirado** |
| Passou de 60 dias | Não há refresh — só refazendo o OAuth |
| `code` do OAuth | Vale 1 hora, uso único, e a Meta anexa `#_` que precisa ser removido |

**Webhook — os dois níveis são necessários:**

- **Nível APP (manual, sem API):** painel da Meta, **Casos de uso > Personalizar > Webhooks**. Cadastrar Callback URL e Verify Token, assinar o campo `comments`.
- **Nível CONTA:** `POST /me/subscribed_apps` — feito automaticamente pelo `/oauth/callback`, ou manualmente por `POST /setup/subscribe`.

Configurar só um dos dois não funciona. Se o webhook não chega, verifique os dois antes de suspeitar do código.

**Qualquer coisa que não esteja documentada acima precisa ser confirmada na documentação oficial da Meta antes de ser implementada.** Não presuma comportamento de endpoint, nome de permissão ou limite de taxa.
