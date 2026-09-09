# Painel administrativo do noxe-insta-automation — projeto completo

Documento único de projeto. Ele consolida treze documentos de pesquisa e arbitragem e substitui
todos eles: **nada além deste arquivo precisa ser consultado para implementar**.

Marcações de origem, obrigatórias em toda afirmação sobre limite de plano ou comportamento de API
externa: `[C]` = confirmado lendo o código deste repositório ou a documentação oficial citada;
`[I]` = inferência de projeto, ainda não verificada; `[V]` = pendência empírica que precisa de um
teste em ambiente real antes de virar promessa escrita na documentação do usuário.

Onde o material de origem se contradizia, este documento **decide** e diz que decidiu. A lista das
divergências resolvidas está em §15.3.

---

# PARTE 1 — PARA O DONO

## 1. O problema, e o que muda na prática

Hoje, para mudar qualquer coisa no comportamento da automação — a palavra que aciona, o texto do
Direct, o link entregue, em quais Reels ela vale — é preciso abrir um arquivo de código
(`src/config.ts`), editar TypeScript à mão e publicar o projeto de novo a partir do computador.
Duas dessas coisas nem o assistente local (`node scripts/configurar.mjs`) sabe fazer: escolher os
Reels e criar regras diferentes por Reel só existem editando código na mão.

Depois deste projeto, existe um endereço na internet — servido pelo próprio Worker, no mesmo
domínio da automação — onde a pessoa entra pelo celular, com a digital ou o Face ID, e muda tudo
isso clicando. Sem senha, sem e-mail, sem redeploy, sem computador.

O que muda, em uma frase por item:

- **Escolher Reels clicando.** Uma tela lista os Reels da conta com miniatura e legenda; a pessoa
  marca em quais a automação responde. Isso é a prioridade número um do dono e hoje não existe de
  forma nenhuma sem editar código.
- **Regras diferentes por Reel.** "Neste Reel aqui o link é outro" vira uma tela, não um bloco de
  TypeScript.
- **Palavras-gatilho com teste.** A pessoa escreve um comentário de mentirinha e vê, na hora, se
  aquilo acionaria — usando exatamente a mesma função que o Worker usa de verdade.
- **Prévia da mensagem.** Vê o Direct como a pessoa vai receber, antes de salvar.
- **Um botão de desligar em toda tela.** E uma página separada, sem login, que só sabe desligar,
  para o dia em que nada mais funcionar.
- **Ver o que aconteceu.** Uma tela mostra se está tudo em pé, o que está travando, e a lista dos
  últimos comentários atendidos, com o @ de quem acionou.

O que **não** muda: a automação em si. Quem já usa o projeto e só atualizar o código continua com
exatamente o mesmo comportamento de hoje, até o dia em que salvar alguma coisa pelo painel de
propósito. Enquanto ninguém salvar nada, o `src/config.ts` continua mandando.

---

## 2. As decisões tomadas, e o porquê de cada uma

### 2.1 A resposta honesta ao argumento contra painel na internet

O arquivo `scripts/configurar.mjs`, nas linhas 12 a 19, traz hoje um manifesto contra exatamente o
que este projeto vai construir. Ele diz três coisas. Vale responder uma a uma, sem maquiagem.

**(i) "Os segredos já vivem nesta máquina, então um painel não acrescenta valor."** Isso **já é
falso hoje** `[C]`. O `SETUP_ADMIN_TOKEN` de produção sai da máquina toda vez que o assistente
conecta o Instagram: ele viaja num cabeçalho `Authorization: Bearer` para `GET /setup/authorize`,
uma rota pública, cujo caminho e cuja verificação estão no GitHub. A superfície administrativa
remota já existe. O que o painel faz é **trocar** um segredo estático, reutilizável e copiável por
uma credencial de hardware (passkey) que não sai do aparelho, não pode ser reenviada e pode ser
revogada aparelho por aparelho.

**(ii) "Um painel capaz de editar o texto do Direct, se invadido, vira uma máquina de golpe
operando em nome da conta legítima."** Isto **continua verdadeiro e é o núcleo do projeto**. É o
pior cenário, e o desenho inteiro gira em torno dele. Três travas respondem:

1. **Trava de conteúdo (allowlist de domínios).** Existe uma lista de domínios permitidos, definida
   no momento de publicar o projeto, dentro do repositório. O painel **não pode** apontar o link
   para fora dessa lista, e a mesma trava vale para endereços escritos dentro do texto do Direct —
   senão bastaria escrever a URL do golpe na mensagem. Mudar essa lista exige o repositório e a
   credencial de deploy da Cloudflare, que é justamente o que um painel invadido não tem.
2. **Trava de gesto (re-autenticação por operação).** Trocar o link, o texto do Direct ou a resposta
   pública exige a digital **na hora**, e a autorização vale para **aquela mudança específica**, não
   por um tempo. Um invasor que roubasse o momento da confirmação conseguiria, no máximo, reenviar
   exatamente a mudança que o dono leu na tela e aprovou.
3. **Trava de leitura.** A allowlist é reaplicada também quando o Worker **lê** a configuração. Se
   alguém gravar um link proibido por fora do painel, ou se a lista encolher depois, a automação
   **para** em vez de entregar o link errado.

A honestidade que precisa estar escrita: hoje, editar o texto do Direct exige repositório **mais**
credencial de deploy. O painel encurta esse caminho — passa a exigir a passkey do dono. A allowlist
é a compensação, não um extra opcional. Sem allowlist configurada, o painel **recusa** qualquer
alteração de link e de texto, e diz isso na tela.

**(iii) "Nada é exposto: o script só fala com o SEU Worker."** Continua verdadeiro. O painel é
servido pelo próprio Worker, na mesma origem — o que, aliás, é requisito técnico do login por
passkey. Não existe servidor de terceiro no meio, nem antes nem depois.

O manifesto de `configurar.mjs:12-19` precisa ser reescrito para "por que o painel é seguro", e
essa reescrita é item de entrega (§14, etapa 15).

### 2.2 As oito decisões estruturais

| # | Decisão | Por quê, em uma frase |
|---|---|---|
| 1 | **A tela é HTML montado pelo Worker**, não uma "casca" estática com JavaScript buscando dados | é o único desenho em que o teste automático consegue provar que nenhum valor do banco chega à tela sem ser neutralizado; e os cabeçalhos de segurança viram código, não configuração |
| 2 | **O painel entra por último no roteamento** | assim é estruturalmente impossível uma rota nova do painel passar na frente do webhook do Instagram e quebrá-lo em silêncio |
| 3 | **Três arquivos de migração de banco**, cada um numa etapa de entrega | um arquivo só obrigaria a editar um arquivo já aplicado, que é a operação que o banco não percebe e que quebra só em produção |
| 4 | **A re-autenticação vale para uma operação, presa ao conteúdo** — não para uma janela de 5 minutos | com janela, um painel invadido faz N mudanças dentro dela; preso ao conteúdo, faz zero |
| 5 | **O Worker gera os códigos de recuperação e de parada**, e os mostra uma única vez | é o que permite guardar os códigos com uma "pimenta" secreta, tornando um vazamento do banco inútil para quem quiser testar códigos |
| 6 | **O histórico guarda o valor antigo e o novo, no seu próprio banco; o log da Cloudflare nunca guarda valor nenhum** | o histórico de links e textos é a única prova documental de um sequestro de painel; o log sai do controle do dono e por isso não recebe valor algum |
| 7 | **A parada de emergência responde de forma clara** (três frases possíveis), em vez de responder sempre igual | esconder o resultado não esconderia nada do atacante (a automação para de responder, e isso se vê de fora) e esconderia tudo da pessoa leiga digitando um código de um papel sob estresse |
| 8 | **Campo inválido para a automação; não existe conserto automático** | consertar é seguro numa direção e perigoso na outra, e não dá para saber qual é qual na hora da leitura — parar é sempre menos permissivo, e nunca entrega um link diferente do que a tela mostra |

### 2.3 A decisão do dono sobre a tela "O que aconteceu"

**Decidido: a tela mostra o @ de quem acionou, buscando ao vivo no Instagram, sem armazenar nada de
novo.** Ao abrir a tela, para cada linha exibida, o painel pergunta ao Instagram quem escreveu
aquele comentário e mostra o @. Nada disso é gravado — nem no banco, nem em cache, nem em log.
Fechou a tela, acabou.

Consequências que o dono precisa saber, e que estão detalhadas em §12.6:

- **A lista envelhece para "sem nome" sozinha.** Se o comentário foi apagado, ou o perfil sumiu, ou
  a pessoa bloqueou a conta, a linha continua aparecendo com "@ indisponível — o comentário foi
  apagado" e o resultado intacto. Nunca some.
- **Custa cota do Instagram**, a mesma cota que a automação usa para responder. Por isso: 20 linhas
  por página, botão "Atualizar" explícito, e **nenhuma** atualização automática.
- **A política de privacidade ganha uma frase**, e só. O cabeçalho do código-fonte, que promete que
  o username **não é armazenado**, continua verdadeiro sem ressalva — porque continua não sendo.

Alternativas descartadas, registradas como decisão tomada:

- **Só números agregados** (quantos responderam, quantos foram ignorados, por motivo): descartada
  porque o dono não conseguiria conferir uma reclamação de "não recebi" caso a caso.
- **Armazenar o username no banco**: descartada porque quebraria uma promessa feita por escrito e em
  público no cabeçalho de `src/index.ts`, na política de privacidade servida em `/privacy-policy` e
  no `SECURITY.md`, e obrigaria a anunciar a forks que atualizar passa a guardar uma classe nova de
  dado pessoal de terceiro.

---

## 3. O que o painel deixa a pessoa fazer, tela por tela

São oito telas com login, três sem login, e uma página de emergência. Cada tela cabe numa frase; se
precisar de duas, ela está fazendo coisa demais.

### Início — "está funcionando?"

Um estado grande, em cor, ícone e palavra (nunca só cor): **Ligada e respondendo** (verde),
**Ligada, mas nada vai ser enviado** (âmbar), **Desligada** (cinza). Abaixo, a lista de pendências,
cada uma com um botão que resolve: "O link ainda não foi configurado. [Configurar o link]", "Você
não tem nenhuma palavra que aciona. [Escolher as palavras]", "Você escolheu 'só nos Reels que eu
escolher', mas não marcou nenhum. [Escolher Reels]", "A conta do Instagram não está conectada.
[Ver como conectar]".

O estado âmbar é o que hoje acontece **sem contar a ninguém**: a automação recusa disparar por
segurança e ninguém fica sabendo. A tela é o que torna isso visível.

E um botão vermelho, grande, na primeira dobra: **DESLIGAR TUDO**.

### Meus Reels — a prioridade número um

Duas opções: **"Em todos os meus Reels"** (inclusive nos que você publicar depois) ou **"Só nos que
eu escolher"** (Reels novos ficam de fora até você marcar). Abaixo, a lista com miniatura, legenda
cortada, data, número de comentários e uma caixa de marcar — e a área de toque é o cartão inteiro,
não a caixinha.

Detalhes que importam para não mentir para a pessoa:

- O botão de marcar em lote **não** se chama "Selecionar todos". Chama-se **"Marcar os 12 desta
  lista"**, com o número do que já está carregado na tela — porque é o único número que a tela pode
  prometer. Quem quer literalmente todos usa a opção de cima, que é uma regra permanente.
- "Carregar mais" não promete quantidade, porque quantos Reels saem de uma página do Instagram só se
  sabe depois de filtrar. Quem posta muita foto pode ter três Reels em vinte e cinco publicações.
- Reel apagado no Instagram **não some da lista**: fica cinza, com "Este Reel não existe mais" e um
  botão "Tirar da lista". Sumir em silêncio faria a pessoa achar que continua ativo.
- Miniatura quebrada não impede nada: o Instagram assina os endereços de imagem e eles vencem em
  pouco tempo `[C]`. Quando isso acontece, aparece um bloco cinza com as primeiras palavras da
  legenda, o cartão continua selecionável, e uma faixa explica: *"as miniaturas venceram — é normal,
  elas duram pouco. Nada da sua configuração foi perdido."*

### Este Reel responde diferente

A palavra "sobreposição" nunca aparece. Cada linha mostra o que vale hoje e oferece trocar só aquela
linha: *"● Usar as mesmas de sempre (eu quero, quero o link)"* ou *"○ Usar outras só neste Reel"*.
O valor herdado fica escrito entre parênteses e muda sozinho se a regra geral mudar — e a tela avisa
que é assim. Antes de salvar, um resumo de uma frase: *"Neste Reel muda só o link. Todo o resto
segue a regra geral."* E um botão **"Voltar tudo a seguir a regra geral"**, que não pede digital,
porque desfazer é sempre a direção segura.

### Palavras que ligam a automação

Lista de palavras em fichas, campo para adicionar, e a escolha do modo de comparação escrita sem
jargão:

- **"O comentário tem que ser só isso"** (recomendado) — responde a "eu quero", "Eu Quero!",
  "eu querô"; não responde a "eu quero muito isso".
- **"Basta aparecer no meio do comentário"** — responde a tudo acima **e também**, com o rótulo
  honesto *"responde também, e talvez você não queira"*: "não é isso que eu quero", "eu quero saber
  o preço".

Os exemplos são gerados com a palavra que a pessoa escolheu, não com exemplos genéricos, e a frase
sobre acentos e maiúsculas é gerada a partir dos ajustes reais dela — uma explicação que mente é
pior do que nenhuma.

E uma caixa de teste: escreva um comentário de mentirinha, toque em Testar, e a tela diz
**"✓ Este comentário aciona (casou com 'eu quero')"** ou **"✕ Este comentário não aciona"** — usando
a função de produção, não uma cópia.

### A mensagem e o link — a tela protegida

Texto do Direct, link de destino e resposta pública no comentário. Os três campos levam cadeado e a
palavra "protegido", e o botão diz o que vai acontecer: **"Salvar (vai pedir a sua digital)"**.
Nunca "Salvar" seguido de uma surpresa biométrica.

Abaixo do link, sempre visível: *"Só dá para usar links destes endereços: noxelora.com.br. Isso é
uma trava do próprio programa, e é proposital: se um dia alguém invadir o seu painel, essa pessoa
não consegue apontar o seu link para um site de golpe."*

E a prévia, em formato de balão de conversa, mostrando o Direct como a pessoa vai receber e a
resposta pública como vai aparecer no comentário — renderizada pelo servidor, com a mesma função que
envia de verdade. A prévia mostra os efeitos reais da limpeza de texto: se a pessoa colar algo de um
editor com caracteres invisíveis, ela vê o resultado limpo antes de salvar, não depois de um cliente
reclamar.

### O que aconteceu

Os três estados grandes, as pendências, e a lista dos últimos comentários **atendidos**: o @ de quem
comentou, o horário e o resultado traduzido para português — "✓ Direct enviado e comentário
respondido", "⏳ Direct enviado. A resposta no comentário ainda não saiu", "⏳ Não deu na primeira.
Vamos tentar de novo às 14:35". Vinte linhas por página, botão "Ver mais", botão "Atualizar". Nunca
sozinho, nunca automático.

E uma frase honesta, impressa na própria tela, porque o contrário seria prometer o que o programa não
guarda: *"Aqui aparecem os comentários que a automação atendeu. Comentários que ela ignorou — por não
serem de um Reel da sua lista, por não terem nenhuma das suas palavras, ou porque a pessoa já tinha
recebido — não deixam registro, e por isso não aparecem aqui."* A explicação técnica dessa escolha,
com a conta que a sustenta, está em §12.6.

### Aparelhos e códigos de recuperação

Lista dos aparelhos que conseguem entrar, com apelido, data de cadastro, último uso e o aviso que
mais importa: **"✓ Está salvo na conta do celular — se você trocar de aparelho, continua entrando"**
ou **"▲ Existe só neste aparelho. Se ele quebrar ou for formatado, este acesso se perde"**. Botão
para cadastrar outro aparelho, e a área dos seis códigos de recuperação. Nunca dá para remover o
último aparelho.

E um aviso obrigatório: *"Estes aparelhos estão presos ao endereço minha-conta.workers.dev. Se um
dia o painel mudar de endereço, todos vão precisar ser cadastrados de novo, usando um código de
recuperação. Não é possível transferir."* Isso é uma propriedade da tecnologia de passkey, não uma
escolha do projeto `[C]`.

### Ajustes finos

Só em Reels ou em qualquer publicação; intervalo por pessoa; acentos, maiúsculas e pontuação; ligar
ou desligar a resposta pública e o Direct. No rodapé, a regra escrita: *"Diminuir o alcance da
automação nunca pede a sua digital. Aumentar, sim."* No fim da tela, em modo somente leitura, o
histórico das últimas mudanças com um botão "Voltar a esta versão".

### As três telas sem login, e a página de emergência

**Entrar** (a digital), **Entrar com código de recuperação** (para quando não há aparelho à mão) e
**Primeiro cadastro** (o link que sai do computador, na primeira instalação). E `/painel/parar`, a
parada de emergência: um campo, um botão, nenhuma informação. Ela responde uma de três frases:
*"Pronto. A automação está desligada."*, *"Esse código não confere. Confira e digite de novo."* ou
*"Não foi possível confirmar agora. Em caso de erro a automação para sozinha."*

---

## 4. Modelo de ameaças, em linguagem direta

Premissa que vale para tudo: **o atacante leu todo o código**. O projeto é público, MIT, no GitHub.
Ele conhece cada rota, cada nome de cookie, cada passo da verificação. A única coisa que ele não tem
é um segredo. Toda vez que este documento diz "seguro", a frase completa é: *seguro porque exige um
segredo que ele não tem, e esse segredo é grande demais para ser adivinhado dentro dos limites de
requisição que o plano gratuito impõe*.

| Ataque | Defesa | Risco residual aceito |
|---|---|---|
| **Um bot se cadastra como dono antes da pessoa**, aproveitando que a URL é previsível e o código é público | Não existe, em lugar nenhum, um caminho "primeira passkey é livre". Cadastrar exige uma de três provas: o token de administração (que nasce no deploy), uma passkey já cadastrada, ou um código de recuperação | **Nenhum por essa via.** Se o dono nunca rodar o assistente, ninguém nunca se cadastra: o painel fica inerte, não aberto |
| **Roubo do token de administração** (print de tela, histórico de terminal, vazamento no repositório) | Rotacionável em um comando; o convite morre com ele; a varredura de segredos antes de publicar já procura por isso | **Fica.** Quem tem esse token cadastra uma passkey. O painel torna esse token **mais** importante do que ele é hoje, e isso precisa estar escrito na documentação |
| **Convite interceptado antes do primeiro uso** | Vale 20 minutos, serve uma vez só, viaja depois do `#` na URL (a parte que nunca chega ao servidor nem ao log), e o convite comum deixa de funcionar no instante em que a primeira passkey existe | Janela de 20 minutos entre gerar e usar |
| **Painel invadido por falha na própria tela (XSS)** | Todo valor que entra no HTML é neutralizado por construção, não por disciplina; a política de conteúdo do navegador transforma a forma perigosa de escrever HTML em erro de execução; e a re-autenticação está presa ao conteúdo da mudança | **Fica um resto:** o invasor consegue reenviar exatamente a mudança que o dono leu e aprovou. Não consegue trocar o link para outro destino |
| **Falsificação de requisição** (um site enganando o navegador do dono para salvar algo) | Quatro trancas somadas: o cookie não acompanha requisição vinda de outro site; a origem é conferida por igualdade exata; todo formulário leva uma ficha derivada da sessão; e o painel não emite nenhum cabeçalho que permita outro site ler suas respostas | **Nenhum conhecido** |
| **Roubo do cookie de sessão** | O cookie não é legível por JavaScript, exige HTTPS, tem prefixo que impede outro Worker da mesma conta plantar um cookie irmão, e o banco é a autoridade: apagar a linha mata a sessão na hora | Sessão vale 12 h no máximo, e 2 h de inatividade |
| **Força bruta do código de recuperação** | 100 bits de entropia. O tempo esperado para adivinhar não tem significado físico | **Nenhum praticável** |
| **Força bruta do código de parada** | 80 bits. E acertar só **desliga** a automação | Desligar a automação de alguém. Aborrecimento, não comprometimento |
| **Queimar a cota de escrita do banco** e derrubar a automação junto | Nenhuma requisição não autenticada grava no banco. O desafio de login é assinado, não guardado | **Nenhum por essa via** |
| **Queimar as leituras do banco** varrendo o painel | Nenhuma rota sem login consulta o banco antes de uma assinatura fechar. As três rotas que recebem código digitado fazem 1 leitura e 0 escrita, e só depois de conferir o formato | Leitura marginal, muito longe do teto diário |
| **Queimar as 100.000 requisições por dia do Worker** | Superfície mínima; três arquivos estáticos fora da cota; limitadores de tentativa opcionais | **FICA, e é o maior risco residual do projeto.** Ver §5.3 |
| **Enumerar quais credenciais existem** | O login não devolve lista de credenciais; a lista de exclusão só sai depois de uma autorização válida | **Nenhum** |
| **Descobrir, de fora, o instante em que o painel ainda não tem dono** — que é a janela em que um convite `pre=0` interceptado funciona | `GET /health` é uma rota **pública** `[C]`, e por isso o campo `painel` só distingue `sem_passkey` de `sem_codigo_parada` sob `Authorization: Bearer`. Sem Bearer, os dois somem no valor mesclado `sem_acesso`, que também cobre o painel já cadastrado (§11.9) | **Fica um resto pequeno:** `sem_acesso` ainda diz "ninguém entrou ainda **ou** falta o código de parada". Não separa os dois, que é o que o atacante precisaria |
| **Vazamento do banco** (backup, engano) | A sessão é guardada como digest, não como cookie; os códigos são guardados com uma pimenta secreta; a chave pública da passkey não é segredo | **Nada utilizável** sem a chave de sessão, que é secret da Cloudflare |
| **Análise de tempo de resposta** | Toda comparação de segredo passa por comparação de tempo constante | O comprimento ainda vaza, e todos os códigos têm tamanho fixo — irrelevante aqui |
| **Máquina do dono comprometida** | — | **Fora do escopo de qualquer desenho.** Quem tem a máquina tem os segredos e o deploy |
| **Reapresentar o mesmo desafio de login dentro de 2 minutos** | Desafio de uso efêmero, cookie preso ao navegador, HTTPS, origem conferida | **Fica**, e é assumido: sem gravar nada não existe uso único de verdade. A janela é de 120 segundos |
| **Aparelho desbloqueado na mão de outra pessoa** | O painel exige verificação do usuário (digital, rosto ou PIN) tanto no login quanto na confirmação de mudanças | **Fica** se a pessoa emprestar o dedo. Nenhuma tecnologia resolve isso |

O que **não está coberto**, dito sem rodeio:

1. **A cota gratuita do Worker.** Cem mil requisições por dia custam centavos para um atacante e são
   pouco mais de uma requisição por segundo sustentada `[C]`. Ao estourar, o erro derruba painel e
   automação **juntos**, porque no plano gratuito não existe cota separada por rota `[C]`. Nenhuma
   defesa deste desenho muda esse número: o limitador de tentativas da Cloudflare conta por data
   center e um atacante distribuído multiplica o limite por trezentos `[C]`.
2. **O navegador.** Os testes provam que o servidor recusa origem errada e identificador de site
   errado. Quem impõe isso do outro lado é o navegador, e isso não cabe em teste automático.
3. **A biometria.** O servidor prova que leu o bit que diz "o usuário foi verificado". Ele não pode
   provar que um dedo foi lido.
4. **Se a pessoa leiga entende a tela.** Isso se descobre observando alguém usar.

---

## 5. Custo e limites do plano gratuito, com a conta feita

### 5.1 Os tetos que existem `[C — documentação oficial da Cloudflare]`

| Recurso | Plano gratuito |
|---|---|
| Requisições ao Worker | **100.000 por dia** (zera à meia-noite UTC) |
| Tempo de processamento por requisição | 10 ms (espera de rede **não** conta) |
| Sub-chamadas por requisição (inclui **cada consulta ao banco**) | **50** |
| Banco: linhas lidas | 5.000.000 por dia |
| Banco: linhas escritas | **100.000 por dia** |
| Requisições a arquivos estáticos | gratuitas e ilimitadas, **fora** da cota |

Não existe cobrança automática nem upgrade automático no plano gratuito `[C]`. Isso é bom (ninguém
recebe fatura) e ruim (ao estourar, é queda, não custo).

### 5.2 A conta do painel

Uma sessão realista do dono — entrar, ver o início, revisar as palavras, listar duas páginas de
Reels, abrir a tela da mensagem, trocar o link com a digital, conferir a atividade e sair — custa
**cerca de 12 requisições ao Worker**. Vinte sessões num dia movimentado: **240 requisições**, ou
**0,24%** do teto diário.

```
100.000 requisições/dia
  -    288  cron a cada 5 minutos    [V] assumindo que invocação agendada conta como requisição
  -    240  painel em uso pesado
  = 99.472  sobram para o webhook do Instagram
```

Em escrita no banco: salvar uma tela custa 2 escritas; a parada de emergência custa 2; um login
custa 3. O dia a dia do dono são dezenas de escritas, contra 100.000. **O painel não é o problema.**

> **Correção de 2026-09-08 — o cron passou de 15 para 5 minutos.** O bloco acima dizia 96
> invocações. O intervalo de 15 minutos engolia inteiros os dois primeiros degraus da espera de
> `computeNextRetry` (1 min, 4 min, 16 min): quem pedia 1 minuto esperava até 15. A conta foi de
> 96 para 288 invocações por dia — 0,29% do teto, contra 0,10% —, e a conclusão do parágrafo não
> muda. Um tique com a fila vazia sai antes de qualquer escrita.

Do lado da automação, por comentário atendido: 5 consultas ao banco e cerca de 7 linhas escritas
`[C]`. Isso dá teto de aproximadamente **14.000 comentários atendidos por dia**, folgado.

### 5.3 O problema real, e ele não é o painel

O gargalo é o teto de **100.000 requisições por dia**, e ele é atingível por tráfego não solicitado.
O que este desenho faz a respeito, em ordem de eficácia:

1. **Nenhuma rota sem login consulta o banco antes de uma assinatura fechar.** Uma varredura custa
   invocação, mas não custa banco e não custa escrita — então ela não derruba a automação por
   consumo de cota de escrita.
2. Superfície sem login pequena e **escrita dentro de um teste**: três páginas, cinco rotas de
   cerimônia e a parada.
3. Limitadores de tentativa opcionais. O painel funciona sem eles, e nada do desenho pode depender
   deles para estar correto.
4. Três arquivos estáticos fora da cota, inclusive o formulário da parada de emergência — que é a
   última coisa que precisa responder quando tudo o mais está errado.

E o que este desenho **não** faz: não promete imunidade. Isso precisa estar escrito no README, na
mesma página em que o painel for anunciado. Um software gratuito pode ter esse limite; o que ele não
pode é escondê-lo.

**Correção honesta a um texto antigo:** o README **não** deve dizer que "as telas do painel ficam
fora da cota". Isso era verdade num desenho anterior, em que as páginas eram arquivos estáticos.
Como as páginas passaram a ser montadas pelo Worker, cada tela aberta custa uma invocação. A troca
foi aceita conscientemente: o ganho é que o teste automático passa a provar que nenhum valor do
banco chega à tela sem ser neutralizado, o que no desenho antigo era impossível de verificar.

### 5.4 A cota do Instagram

O painel disputa **a mesma** cota de 24 horas que a automação usa para responder — a fórmula
oficial é `4800 × impressões` `[C]`. Por isso: listagem de Reels com cache curto e botão "Atualizar"
explícito, nunca busca automática; e a tela "O que aconteceu" tem teto de 20 consultas por abertura.
Vinte aberturas num dia são 400 chamadas subtraídas do orçamento de envio. O caminho do webhook
**nunca** depende de nenhuma dessas chamadas.

---

## 6. O que continua exigindo o computador, e por quê

O painel não substitui o assistente local. Cinco coisas continuam sendo feitas no computador, e
todas por um motivo estrutural, não por preguiça de portar:

1. **Gerar e cadastrar os segredos** (`wrangler secret put`). Nenhuma rota HTTP pode gravar um
   segredo da Cloudflare — não existe essa API para o próprio Worker. E se existisse, seria a porta
   que o painel inteiro existe para não abrir.
2. **A chave que cifra o token do Instagram.** Rotacioná-la inutiliza o token guardado no banco. É
   uma operação que precisa de um humano ciente na frente do terminal.
3. **Publicar o projeto, aplicar as migrações e definir a allowlist de domínios.** A allowlist é,
   por definição, a trava que o painel não pode alterar. Ela vive no repositório e é sobrescrita a
   cada publicação — o que normalmente é uma pegadinha e aqui é exatamente **a propriedade que faz a
   trava funcionar**.
4. **A primeira conexão com o Instagram (OAuth).** Ela acontece antes de existir qualquer passkey;
   não há sessão para autorizar. E o painel **nunca** inicia esse fluxo, nem depois: se ele pudesse,
   um painel comprometido conectaria a conta do **atacante**. O painel lê o estado da conexão e
   manda usar o assistente. Ele lê, não age.
5. **Emitir o convite do primeiro cadastro e gerar os códigos.** O convite é assinado offline, na
   máquina, com o token de administração. Os códigos são gerados pelo Worker sob esse mesmo token e
   mostrados uma única vez, no terminal, para a pessoa anotar no papel.

O assistente ganha um item de menu novo, **"6. Conferir o painel"**, que pergunta ao Worker em que
estado o painel está e diz em português o que fazer.

---

# PARTE 2 — REFERÊNCIA DE IMPLEMENTAÇÃO

Regra que atravessa toda a Parte 2: **um nome por conceito**. Sinônimo é erro, não estilo.

## 7. Contrato de nomes

### 7.1 Rotas

| Caminho | Método | Sessão | CSRF | Step-up | Onde vive |
|---|---|---|---|---|---|
| `/painel` | GET | sim | — | — | Worker (Início) |
| `/painel/chave` | POST | sim | sim | **não** | Worker (`acao=ligar\|desligar`) |
| `/painel/entrar` | GET | não | — | — | Worker (**0 consulta ao D1**) |
| `/painel/entrar/codigo` | GET, POST | não | — | — | Worker (entrada por código de recuperação) |
| `/painel/convite` | GET | não | — | — | Worker (lê o token do fragmento; 0 consulta) |
| `/painel/reels` | GET, POST | sim | sim | ao alargar | Worker |
| `/painel/reel` | GET (`?midia=`), POST | sim | sim | se tocar mensagem/link | Worker |
| `/painel/palavras` | GET, POST | sim | sim | ao alargar | Worker |
| `/painel/palavras/testar` | POST | sim | sim | não | Worker (função pura, 0 escrita) |
| `/painel/mensagem` | GET, POST | sim | sim | **sempre** no POST | Worker |
| `/painel/mensagem/previa` | POST | sim | sim | não | Worker (`renderTemplate`, 0 escrita) |
| `/painel/atividade` | GET | sim | — | — | Worker |
| `/painel/aparelhos` | GET, POST | sim | sim | sim em `remover_passkey` e `gerar_codigos`; **não** em `sair_de_tudo` | Worker |
| `/painel/ajustes` | GET, POST | sim | sim | ao alargar | Worker |
| `/painel/sair` | POST | sim | sim | não | Worker |
| `/painel/api/entrar/opcoes` | POST | não | — | — | Worker, JSON, **0 consulta ao D1** |
| `/painel/api/entrar/verificar` | POST | não | — | — | Worker, JSON |
| `/painel/api/registrar/opcoes` | POST | convite \| recuperação \| sessão+step-up | **sim no modo sessão** | — | Worker, JSON |
| `/painel/api/registrar/verificar` | POST | bilhete de registro | — | — | Worker, JSON |
| `/painel/api/stepup/opcoes` | POST | sim | sim | — | Worker, JSON |
| `/painel/parar` | GET | não | — | — | **asset** `public/painel/parar/index.html` |
| `/painel/parada` | POST | não | não | não | Worker (ação da parada de emergência) |
| `/painel/painel.css`, `/painel/painel.js` | GET | não | — | — | **assets** |
| `/setup/painel/codigos` | POST | Bearer admin | — | — | Worker (gera e devolve os códigos uma vez) |
| `/setup/painel/zerar` | POST | Bearer admin | — | — | Worker (apaga credenciais e sessões) |

Inalteradas e intocáveis: `/health`, `/privacy-policy`, `/data-deletion`, `/webhooks/instagram`,
`/setup/authorize`, `/setup/subscribe`, `/oauth/callback` `[C]`.

**Regra de forma.** `GET /painel/<tela>` renderiza; `POST /painel/<tela>` grava e responde `303`
para `GET /painel/<tela>?ok=<codigo>`. Um caminho por tela.

**A exceção, escrita porque o metateste a lê:** existe uma segunda forma de POST, o **POST que só
renderiza** — zero escrita, zero `303`, devolve `200` com a página inteira remontada no servidor. São
exatamente três: a paginação dos Reels em `POST /painel/reels` (§12.5), `POST /painel/palavras/testar`
e `POST /painel/mensagem/previa`. Elas existem porque o desenho tem de funcionar sem JavaScript, e
`303` perderia o estado já digitado no formulário. A tabela de rotas de §11.1 carrega o campo
`escreve: true | false`, e o metateste afirma as duas metades: **toda rota com `escreve: true`
responde `303`**, e **toda rota com `escreve: false` executa zero escritas no D1** (contador de
§13.4). Sem esse campo, o metateste da regra de forma nasceria contra o próprio desenho.

**Regra de identificador.** Nenhum segmento variável de caminho, em nenhuma rota, para sempre.
Identificador que precisa de URL própria vai na **query string**, com nome em português (`?midia=`);
identificador de uma **escrita** vai no corpo do POST. `media_id` **não é segredo** — ele aparece no
`permalink` público do Reel —, então a regra "segredo nunca na query string" (`oauth.ts:26-30`
`[C]`) **não é violada**. Continua proibido na URL, sem exceção: código de parada, código de
recuperação, token de convite, desafio, assertion, qualquer material de sessão.

**As duas exceções de caminho.** `/painel/parar` (asset, só o formulário) e `/painel/parada`
(Worker, a ação) são deliberadamente diferentes, para que um POST nunca seja endereçado a um caminho
de asset. `GET /painel/parada` responde **`303` para `/painel/parar`** — decisão deste documento,
explicada em §11.6.

**Nomes deletados, que não existem em lugar nenhum:** `/painel/api/estado`, `/painel/api/config*`,
`/painel/api/midias*`, `/painel/api/passkeys*`, `/painel/api/sessao`, `/painel/api/sair`,
`/painel/api/sessoes/revogar`, `/painel/api/stepup/verificar`, `/painel/api/stepup/desafio`,
`/painel/api/codigos/gerar`, `/painel/api/entrar` (sem `/verificar`), `/painel/api/registrar` (sem
`/verificar`), `/painel/reels/{id}`, `/painel/login`, `/painel/erro`, `/painel/diagnostico`,
`/setup/codigos`, `/setup/painel/revogar`, `/setup/painel/limpar-credenciais`.

### 7.2 Cookies

Três, todos com prefixo `__Host-`, `HttpOnly; Secure; SameSite=Strict; Path=/`.

| Nome | Conteúdo | Max-Age |
|---|---|---|
| `__Host-painel_sessao` | `"s1" "." base64url(sid_32B) "." <expira_em> "." base64url(hmac)` | restante do prazo absoluto |
| `__Host-painel_desafio` | envelope de propósito `entrar` (120 s) ou `registrar` (300 s) | 120 ou 300 |
| `__Host-painel_stepup` | envelope de propósito `stepup`, com `oh` (op_hash) e `sid` | 120 |

`Path=/painel` é **inválido**: o prefixo `__Host-` exige `Path=/`. Grafias deletadas:
`__Host-pnl_sessao`, `__Host-pnl_reg`, `__Host-pnl_desafio`, `__Host-pnl_step`.

Ficha anti-CSRF: valor `base64url(HMAC-SHA256(k_csrf, "csrf|v1|" + sid_hash))`, **derivada e não
sorteada**. Viaja em campo escondido de nome `csrf` nos formulários e no cabeçalho `X-Painel-CSRF`
em **toda** rota `/painel/api/*` que corra com sessão (hoje `stepup/opcoes` sempre, e
`registrar/opcoes` no modo `sessao`).

### 7.3 Tabelas e colunas

| Tabela | Migration | Colunas canônicas |
|---|---|---|
| `painel_config` | 0002 | `id` (=1), `enabled`, `trigger_keywords`, `match_mode`, `case_sensitive`, `normalize_accents`, `ignore_punctuation`, `process_only_reels`, `media_scope`, `public_reply_enabled`, `public_reply_text`, `private_reply_enabled`, `private_reply_text`, `destination_url`, `user_cooldown_hours`, `versao`, `parado_por_codigo_em`, `criado_em`, `atualizado_em` |
| `painel_midias` | 0002 | `media_id` (PK, TEXT), `ativo`, `legenda_curta`, `permalink`, `media_product_type`, `postado_em`, `visto_em`, `indisponivel_desde`, colunas de sobreposição NULL-áveis, `criado_em`, `atualizado_em` |
| `painel_auditoria` | 0002 | `id` (INTEGER PK, **sem AUTOINCREMENT**), `ocorrido_em`, `versao`, `origem`, `ator`, `step_up`, `acao`, `alvo`, `campos`, `antes`, `depois` |
| `painel_codigos` | 0003 | `hash` (PK), `tipo`, `versao_hash`, `criado_em`, `usado_em`, `invalidado_em` |
| `painel_estado` | 0004 | `id` (=1), `usuario_handle`, `criado_em`, `atualizado_em` |
| `painel_credenciais` | 0004 | `credential_id` (PK), `rp_id`, `usuario_handle`, `chave_publica_jwk`, `algoritmo`, `transportes`, `sign_count`, `backup_eligible`, `backup_state`, `apelido`, `origem_registro`, `criado_em`, `usado_em` |
| `painel_sessoes` | 0004 | `sid_hash` (PK), `credential_id`, `rp_id`, `criada_em`, `expira_em`, `ociosa_ate`, `vista_em`, `falhas_stepup` |
| `painel_convites_usados` | 0004 | `nonce` (PK), `consumido_em`, `expira_em` |

Índices, e só estes: `idx_painel_credenciais_rp (rp_id)`, `idx_painel_sessoes_cred (credential_id)`,
`idx_painel_codigos_tipo (tipo, usado_em)`. Nenhum índice em `painel_config`, `painel_midias` nem
`painel_auditoria` — justificado em §8.4. **Nenhum índice novo em `processed_comments`**, nunca:
índice encarece **cada** escrita do caminho quente `[C]`.

Prefixo `painel_` obrigatório em toda tabela nova. Nome deletado: `midias_selecionadas`.

### 7.4 Bindings e variáveis de ambiente

| Nome | Tipo | Onde | Para que |
|---|---|---|---|
| `PANEL_RP_ID` | var pública | `wrangler.jsonc` `vars` | Host exato do painel. É o `rpId` do WebAuthn **e** a base da origem esperada. Vazio = painel em `503` |
| `ALLOWED_LINK_DOMAINS` | var pública | `wrangler.jsonc` `vars` | Allowlist de domínios, separada por vírgula, minúscula, punycode |
| `PANEL_SESSION_KEY` | secret | `secrets.required` | Raiz de `k_sessao`, `k_desafio`, `k_csrf`, `k_codigos`. **Nunca** reusar `SETUP_ADMIN_TOKEN` nem `TOKEN_ENCRYPTION_KEY` |
| `PANEL_LIMITER_LOGIN` | ratelimit **opcional** | `ratelimits` | `{ limit: 10, period: 60 }`. Rotas de entrar e de registrar por convite |
| `PANEL_LIMITER_CODIGO` | ratelimit **opcional** | `ratelimits` | `{ limit: 30, period: 60 }`. `POST /painel/entrar/codigo` e `registrar/opcoes` no modo recuperação |
| `PANEL_LIMITER_STOP` | ratelimit **opcional** | `ratelimits` | `{ limit: 30, period: 60 }`. Só `POST /painel/parada` |

**`PANEL_ORIGIN` não existe.** A origem esperada é sempre `'https://' + env.PANEL_RP_ID`, calculada
num único helper `origemDoPainel(env)`. Motivo: uma variável a menos para o leigo errar, e torna
**impossível** origem e `rpId` divergirem — a classe de erro que produz credencial irrecuperável,
porque o `rpId` gravado dentro da credencial não pode ser corrigido depois `[C]`.

**Chave de cada balde**, especificada porque há teste que a afirma: `PANEL_LIMITER_LOGIN` usa
`"painel:" + cf-connecting-ip`; `PANEL_LIMITER_CODIGO` usa `"codigo:" + cf-connecting-ip`;
`PANEL_LIMITER_STOP` usa `"parada:" + cf-connecting-ip`. O **prefixo distinto** é o que impede que o
balde do login e o da parada se misturem mesmo quando dois deles caem no mesmo binding de reserva.
Requisição **sem** `CF-Connecting-IP` cai num balde global daquele prefixo (`"painel:global"`,
`"codigo:global"`, `"parada:global"`) e continua limitada — nunca passa livre.

**A troca embutida em `PANEL_LIMITER_CODIGO`, dita como troca:** ela **triplica** a taxa de tentativa
permitida contra o código de recuperação, de 10/60 s para 30/60 s, e o código de recuperação é o
caminho para **cadastrar uma passkey nova**. Aceitamos porque o limitador nunca foi a defesa desse
segredo — a defesa são os 100 bits de §10.11, e o contador da Cloudflare é por data center e
eventualmente consistente `[C]`, então um atacante distribuído já multiplicava os 10 por trezentos. O
que o binding próprio compra é real e é outra coisa: um bot martelando o login não consome mais a
cota de que o dono precisa para digitar o código numa emergência.

São **três** limitadores e não um porque `limit` é fixo por binding e `period` só aceita 10 ou 60
`[C]` — a chave não consegue expressar limites diferentes. **Ausentes os bindings, o painel funciona
sem a camada**; nada do desenho pode depender deles para estar correto. Nomes deletados:
`PANEL_LIMITER`, `LOGIN_LIMITER`, `LIMITE_LOGIN`, `LIMITE_PAINEL`.

Checklist de propagação obrigatório para cada um `[C]`: `src/types/env.ts` → `wrangler.jsonc` →
`.dev.vars.example` → bindings do `vitest.config.ts` → documentação. Os três limitadores são a
exceção declarada: **não** entram nos bindings de teste, de propósito.

### 7.5 Migrations

`0002_painel_config.sql` · `0003_painel_codigos.sql` · `0004_painel_acesso.sql` ·
`migrations/CHECKSUMS.txt`. Deletado: `0002_painel.sql` e qualquer segundo `0002`.

### 7.6 Tetos numéricos

| Grandeza | Valor canônico |
|---|---|
| Corpo de `/painel/api/*` (JSON) | **8 KB** |
| Corpo de formulário `/painel/*` | **32 KB** |
| Corpo de `POST /painel/parada` | **1 KB** |
| Corpo do webhook | **512 KB**, intocado `[C]` |
| Mídias selecionadas, total | **200 linhas** |
| Ids novos revalidados por gravação | **20** |
| Itens por página da Meta (`limit`) | **25** |
| Páginas da Meta por toque em "Carregar mais" | **4**, parando antes com 10 Reels ou sem `paging.next` |
| Sessão — prazo absoluto | **12 h**, nunca estendido |
| Sessão — prazo ocioso | **2 h** deslizante |
| Sessão — gravação de `vista_em` | no máximo 1 a cada **15 min** |
| Desafio WebAuthn — `entrar` e `stepup` | **120 s** |
| Desafio WebAuthn — `registrar` | **300 s** (ver §15.3, objeção acolhida) |
| Step-up | **120 s e uma operação** |
| Convite | **20 min**, uso único |
| Códigos de recuperação | **6**, 20 caracteres Crockford base32 (**100 bits**) |
| Código de parada | **1**, 16 caracteres Crockford base32 (**80 bits**) |
| Credenciais por `rp_id` | **10** |
| Apelido de aparelho | **1..40** caracteres |
| `triggerKeywords` | **1..20** itens, cada um ≤ 40 caracteres; mínimo **2** normalizados em `exact`, **4** em `contains` |
| `publicReplyText` / `privateReplyText` | **1..500** caracteres após NFKC + remoção de `\p{Cc}\p{Cf}` (`CHECK` de schema em 2000) |
| `destinationUrl` | ≤ **2048** (acompanha `MAX_LINK_LENGTH` `[C]`) |
| `userCooldownHours` | inteiro **0..8760** |
| Auditoria | **500 linhas**, podadas no cron |
| Cache de config por isolate | **10 s** ligado, **60 s** desligado |
| Linhas por página em "O que aconteceu" | **20** |
| Chamadas simultâneas à Graph API na tela de atividade | blocos de **6** |
| Falhas de step-up até apagar a sessão | **10** |

### 7.7 Arquivos de código novo

```
src/routes/painel/
  router.ts              despacho (switch de string exata) + método          ~120 linhas
  rotas.ts               tabela declarativa {caminho, metodos, sessao, csrf, stepUp}
  html.ts                html`` com escape por padrão, cru(), pagina(), cabecalhos(perfil)
  resposta.ts            erro(), redirecionar(), json(); tabela de códigos de erro
  guardas.ts             exigirSessao(), exigirCsrf(), exigirStepUp(), limitar(), exigirOrigem()
  entrar.ts              GET /painel/entrar, GET+POST /painel/entrar/codigo, api/entrar/*
  registrar.ts           GET /painel/convite, api/registrar/*
  stepup.ts              api/stepup/opcoes
  inicio.ts              GET /painel, POST /painel/chave, POST /painel/sair
  reels.ts               GET+POST /painel/reels, GET+POST /painel/reel
  palavras.ts            GET+POST /painel/palavras, POST /painel/palavras/testar
  mensagem.ts            GET+POST /painel/mensagem, POST /painel/mensagem/previa
  atividade.ts           GET /painel/atividade
  aparelhos.ts           GET+POST /painel/aparelhos
  ajustes.ts             GET+POST /painel/ajustes
  parada.ts              POST /painel/parada

src/security/
  signed-envelope.ts     envelope assinado com propósito, claims e prazo (generaliza oauth-state.ts)
  base64url.ts           encode + decode (hoje só existe o encode, e privado)

src/services/
  config-store.ts        snapshot + cache por isolate + invalidarCacheDeConfig()
  config-validation.ts   validador puro, um só, usado na escrita E na leitura
  link-allowlist.ts      allowlist aplicada em link E em texto
  panel-session.ts       emitir/validar sessão, derivação de subchaves
  panel-codes.ts         geração, normalização e verificação dos códigos
  webauthn/opcoes.ts · webauthn/verificar.ts · webauthn/cbor.ts · webauthn/cose.ts · webauthn/der.ts

src/repositories/
  painel-config-repository.ts · painel-midias-repository.ts · painel-credenciais-repository.ts
  painel-sessoes-repository.ts · painel-codigos-repository.ts · painel-auditoria-repository.ts

public/painel/
  painel.css · painel.js · parar/index.html          [V] confirmar servido em GET /painel/parar

migrations/
  0002_painel_config.sql · 0003_painel_codigos.sql · 0004_painel_acesso.sql · CHECKSUMS.txt
```

`link-allowlist.ts` fica em **`src/services/`**, não em `src/security/` — decisão registrada em
§15.3. `escapeHtml` continua exportado de `src/routes/legal.ts:50` `[C]` e é **importado** por
`html.ts`; não existe segunda cópia, e `legal.ts` não é movido nem editado nesta fase.

Nomes deletados: `signed-token.ts`, `panel-config-store.ts`, `panel-challenge.ts`,
`credentials-repository.ts`, `panel-config-repository.ts` (grafia sem `painel_`),
`media-selection-repository.ts`, `panel-secrets-repository.ts`, `audit-repository.ts`,
`config-rotas.ts`, `midias-rotas.ts`, `sessao-rotas.ts`, `estado.ts`, `passkeys.ts`, `http.ts`,
`public/painel/app.js`, `public/painel/estilo.css`.

### 7.8 Vocabulário transversal

- **Erro ao cliente:** `{ "erro": "<snake_case>", "mensagem": "<frase em português>" }` em JSON;
  em HTML, a mesma `mensagem` na tela e o mesmo `erro` no `console.warn`. A tabela canônica de
  códigos está em §11.4 e é a **única**; a palavra "payload" é proibida até em código interno.
- **UV = 1 obrigatório sempre**, no login e no step-up: `userVerification: "required"` nas options e
  a flag UV conferida no `authData` nos dois fluxos. Consequência a escrever na tela de cadastro:
  **chave de segurança sem PIN não entra**.
- **`allowedMediaIds` não é campo gravável.** O conceito gravável é `mediaScope: 'todas' |
  'selecionadas'`; `allowedMediaIds` é **derivado** das linhas ativas de `painel_midias`.
- **Origem:** exigir `Origin === origemDoPainel(env)` quando presente; se ausente, exigir
  `Sec-Fetch-Site: same-origin`; se os dois ausentes, `403 origem_invalida`. Comparação de **string
  inteira**, nunca `includes`/`startsWith`.
- **Nunca** nenhum cabeçalho `Access-Control-*`, em nenhuma hipótese; `OPTIONS` devolve `405`.

---

## 8. Esquema do banco e as migrations

### 8.1 Três arquivos, cada um na etapa que precisa dele

| Arquivo | Tabelas | Entra na etapa (§14) |
|---|---|---|
| `migrations/0002_painel_config.sql` | `painel_config`, `painel_midias`, `painel_auditoria` | 2 |
| `migrations/0003_painel_codigos.sql` | `painel_codigos` | 4 |
| `migrations/0004_painel_acesso.sql` | `painel_estado`, `painel_credenciais`, `painel_sessoes`, `painel_convites_usados` | 7 |

`painel_auditoria` nasce no `0002` mesmo só começando a receber escrita na **etapa 4** (ver §14):
ela é a única tabela de auditoria do painel e criar tabela vazia não custa nada.

### 8.2 As quatro regras contra o `CREATE TABLE IF NOT EXISTS` silencioso

`CREATE TABLE IF NOT EXISTS` continua sendo usado — é a convenção do projeto (`0001_initial.sql`
`[C]`) e é o que torna a reaplicação segura. O que muda é que ele deixa de ser a única linha de
defesa, porque sozinho ele transforma "a tabela já existe com outra forma" num no-op silencioso que
só quebra em produção, com `no such column`.

1. **Um nome de tabela aparece em exatamente um arquivo de migration, para sempre.** Verificado pela
   checagem 18 do `scripts/verificar-antes-de-publicar.mjs`: extrair todo
   `CREATE TABLE IF NOT EXISTS (\w+)` de `migrations/**` e falhar com qualquer nome repetido.
2. **Migration aplicada nunca é editada.** `migrations/CHECKSUMS.txt` guarda o SHA-256 de cada
   arquivo já publicado; a checagem 15 recalcula e falha na divergência.
3. **Mudança de schema em tabela existente é sempre `ALTER TABLE` numa migration nova.**
4. **META-08:** depois de `applyD1Migrations`, o teste lê `PRAGMA table_info(<tabela>)` de cada
   tabela do painel e compara com o conjunto **exato** de colunas escrito no teste. Sem este teste, a
   falha continua silenciosa.

`0001_initial.sql` nunca é editado, porque os testes aplicam as mesmas migrations de produção `[C]`.

### 8.3 Princípio das restrições: `CHECK` = teto absurdo, validador = regra de produto

A rota de parada de emergência precisa gravar `enabled = 0` **mesmo quando a linha de configuração
ainda não existe** — ela faz um `INSERT ... ON CONFLICT DO UPDATE` que, no ramo `INSERT`,
materializa a linha a partir do padrão de fábrica. Se um `CHECK` de produto
(`destination_url LIKE 'https://%'`) estivesse no schema, um fork cujo `src/config.ts` ainda tem
`'[COLE_SEU_LINK]'` veria a **parada de emergência falhar com erro de constraint**. A última rota
que precisa funcionar não pode depender de o link estar bonito.

Portanto, no SQL ficam só: enums, booleanos `0/1`, tetos de tamanho grosseiros e o invariante
estrutural do override. Política de produto (https obrigatório, allowlist, tamanho de gatilho,
placeholders) fica no validador em TypeScript, que roda **na escrita e na leitura**.

### 8.4 `migrations/0002_painel_config.sql`

```sql
-- Configuracao global da automacao, agora editavel pelo painel.
--
-- Linha unica (id = 1), mesmo padrao de account_tokens: o projeto atende UMA
-- conta profissional. Colunas tipadas em vez de um JSON unico porque o banco e
-- fronteira: o CHECK e a segunda barreira depois do validador em TypeScript.
--
-- Os CHECK aqui sao tetos grosseiros de proposito: a rota de parada de
-- emergencia materializa esta linha a partir do padrao de fabrica, e nenhuma
-- restricao de schema pode ser o motivo de a parada falhar.
CREATE TABLE IF NOT EXISTS painel_config (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  enabled                INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  trigger_keywords       TEXT    NOT NULL CHECK (
                           json_valid(trigger_keywords)
                           AND json_type(trigger_keywords) = 'array'
                           AND json_array_length(trigger_keywords) <= 20
                           AND length(trigger_keywords) <= 2000
                         ),
  match_mode             TEXT    NOT NULL CHECK (match_mode IN ('exact', 'contains')),
  case_sensitive         INTEGER NOT NULL CHECK (case_sensitive IN (0, 1)),
  normalize_accents      INTEGER NOT NULL CHECK (normalize_accents IN (0, 1)),
  ignore_punctuation     INTEGER NOT NULL CHECK (ignore_punctuation IN (0, 1)),
  process_only_reels     INTEGER NOT NULL CHECK (process_only_reels IN (0, 1)),

  -- Substitui allowedMediaIds. 'todas' vira ['*'] em memoria; 'selecionadas'
  -- vira a uniao dos media_id ativos de painel_midias. NAO guardamos a lista
  -- aqui de proposito: e o que impede uma automacao por Reel que nunca dispara
  -- porque o Reel ficou de fora da lista global.
  media_scope            TEXT    NOT NULL CHECK (media_scope IN ('todas', 'selecionadas')),

  public_reply_enabled   INTEGER NOT NULL CHECK (public_reply_enabled IN (0, 1)),
  public_reply_text      TEXT    NOT NULL CHECK (length(public_reply_text) <= 2000),
  private_reply_enabled  INTEGER NOT NULL CHECK (private_reply_enabled IN (0, 1)),
  private_reply_text     TEXT    NOT NULL CHECK (length(private_reply_text) <= 2000),

  -- O teto de 2048 acompanha MAX_LINK_LENGTH de src/utils/templates.ts.
  destination_url        TEXT    NOT NULL CHECK (length(destination_url) <= 2048),

  -- Horas inteiras. O piso 0 existe porque um valor negativo joga o cooldown
  -- para o futuro e desliga o freio EM SILENCIO, sem erro nenhum.
  user_cooldown_hours    INTEGER NOT NULL CHECK (user_cooldown_hours BETWEEN 0 AND 8760),

  -- Contador monotonico de TODA a configuracao (global + midias). Serve de
  -- carimbo do cache, de trava otimista na gravacao e de chave do log.
  versao                 INTEGER NOT NULL CHECK (versao >= 1),

  -- Epoch ms do ultimo acionamento bem-sucedido da parada de emergencia, ou
  -- NULL. Existe para o painel poder dizer "a automacao foi parada pelo codigo
  -- em <data>". NAO participa de nenhuma decisao do caminho quente.
  parado_por_codigo_em   INTEGER,

  criado_em              INTEGER NOT NULL,
  atualizado_em          INTEGER NOT NULL
);
-- Sem indice: uma linha so, busca sempre por id = 1, que ja e a chave primaria.


-- Midias escolhidas na tela, com sobreposicao opcional por midia.
--
-- media_id como PRIMARY KEY resolve no schema a ambiguidade do .find() de
-- resolveConfigForMedia: nao existe "duas entradas citando o mesmo Reel, a
-- primeira vence em silencio".
--
-- Toda coluna de sobreposicao e NULL-avel, e NULL significa CHAVE AUSENTE no
-- patch, nunca `undefined`: {...global, ...patch} com undefined explicito ZERA
-- o campo global e faz isDestinationUrlConfigured lancar TypeError dentro de
-- processComment, documentada como funcao que nunca lanca.
CREATE TABLE IF NOT EXISTS painel_midias (
  -- String opaca de 17-18 digitos. TEXT SEMPRE: converter para numero perde
  -- precisao acima de 2^53 e casa o Reel errado, sem erro nenhum.
  media_id               TEXT PRIMARY KEY,
  ativo                  INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),

  -- Metadados so para a tela. thumbnail_url e media_url NUNCA entram aqui:
  -- sao URLs assinadas que expiram.
  legenda_curta          TEXT    CHECK (legenda_curta IS NULL OR length(legenda_curta) <= 200),
  permalink              TEXT    CHECK (permalink IS NULL OR length(permalink) <= 512),
  media_product_type     TEXT    CHECK (media_product_type IS NULL OR length(media_product_type) <= 16),
  postado_em             INTEGER,
  visto_em               INTEGER,
  indisponivel_desde     INTEGER,

  -- --- Sobreposicoes. NULL = nao sobrepoe. ---
  -- enabled so aceita 0: uma midia pode PAUSAR, nunca ligar contra a chave
  -- geral. Um enabled = 1 aqui derrotaria a parada de emergencia, porque o
  -- patch e aplicado POR CIMA da global.
  enabled                INTEGER CHECK (enabled IS NULL OR enabled = 0),
  trigger_keywords       TEXT    CHECK (
                           trigger_keywords IS NULL OR (
                             json_valid(trigger_keywords)
                             AND json_type(trigger_keywords) = 'array'
                             AND json_array_length(trigger_keywords) <= 20
                             AND length(trigger_keywords) <= 2000
                           )
                         ),
  match_mode             TEXT    CHECK (match_mode IS NULL OR match_mode IN ('exact', 'contains')),
  case_sensitive         INTEGER CHECK (case_sensitive IS NULL OR case_sensitive IN (0, 1)),
  normalize_accents      INTEGER CHECK (normalize_accents IS NULL OR normalize_accents IN (0, 1)),
  ignore_punctuation     INTEGER CHECK (ignore_punctuation IS NULL OR ignore_punctuation IN (0, 1)),
  process_only_reels     INTEGER CHECK (process_only_reels IS NULL OR process_only_reels IN (0, 1)),
  public_reply_enabled   INTEGER CHECK (public_reply_enabled IS NULL OR public_reply_enabled IN (0, 1)),
  public_reply_text      TEXT    CHECK (public_reply_text IS NULL OR length(public_reply_text) <= 2000),
  private_reply_enabled  INTEGER CHECK (private_reply_enabled IS NULL OR private_reply_enabled IN (0, 1)),
  private_reply_text     TEXT    CHECK (private_reply_text IS NULL OR length(private_reply_text) <= 2000),
  destination_url        TEXT    CHECK (destination_url IS NULL OR length(destination_url) <= 2048),
  user_cooldown_hours    INTEGER CHECK (user_cooldown_hours IS NULL OR user_cooldown_hours BETWEEN 0 AND 8760),

  criado_em              INTEGER NOT NULL,
  atualizado_em          INTEGER NOT NULL
);
-- Sem indice secundario DE PROPOSITO. A unica consulta do caminho quente e
-- "todas as linhas ativas", que varre a tabela inteira — e a tabela tem teto de
-- 200 linhas. Um indice em `ativo` teria cardinalidade 2 (inutil) e faria cada
-- gravacao custar o dobro: um write na tabela e um no indice.


-- Log de auditoria das mudancas de configuracao. E a UNICA tabela de auditoria
-- do painel: nenhuma outra migration declara painel_auditoria.
--
-- id INTEGER PRIMARY KEY e o proprio rowid: ele JA e o indice cronologico. Sem
-- AUTOINCREMENT de proposito: AUTOINCREMENT obriga uma escrita extra em
-- sqlite_sequence a cada insert. A poda so apaga do lado ANTIGO (id <= X),
-- entao o maior id nunca e removido e a sequencia continua monotonica.
CREATE TABLE IF NOT EXISTS painel_auditoria (
  id            INTEGER PRIMARY KEY,
  ocorrido_em   INTEGER NOT NULL,
  versao        INTEGER NOT NULL,
  origem        TEXT    NOT NULL CHECK (origem IN ('painel', 'parada', 'assistente', 'migracao')),
  -- Passkey vira 'passkey:<8 hex do sha256 do credential_id>'; nunca o
  -- credential_id cru, para o log nao virar uma segunda copia do identificador.
  ator          TEXT    NOT NULL CHECK (length(ator) <= 64),
  step_up       INTEGER NOT NULL CHECK (step_up IN (0, 1)),
  acao          TEXT    NOT NULL CHECK (length(acao) <= 40),
  alvo          TEXT    CHECK (alvo IS NULL OR length(alvo) <= 32),
  campos        TEXT    NOT NULL CHECK (length(campos) <= 500),
  -- Estado COMPLETO da entidade afetada antes e depois, restrito aos campos de
  -- comportamento. NULL nos dois quando a mudanca foi RECUSADA ou quando o
  -- evento nao muda configuracao (login, parada, passkey).
  antes         TEXT    CHECK (antes IS NULL OR length(antes) <= 4000),
  depois        TEXT    CHECK (depois IS NULL OR length(depois) <= 4000)
);
```

`[V]` Confirmar que as funções JSON1 (`json_valid`, `json_type`, `json_array_length`) estão
disponíveis no D1. Se não estiverem, remover **só** esses três predicados: o `length(...) <= 2000`
continua sendo o teto e o validador em TypeScript continua sendo a barreira de verdade.

`WITHOUT ROWID` **não é usado** em nenhuma tabela — fica decidido, e não é pendência.

### 8.5 `migrations/0003_painel_codigos.sql`

```sql
-- Painel administrativo: codigos de recuperacao e o codigo unico de parada.
--
-- Regra de ouro: NENHUMA tabela do painel recebe escrita provocada por uma
-- requisicao NAO autenticada. A cota gratuita do D1 e 100.000 escritas/dia e e
-- COMPARTILHADA com a automacao: um bot que consegue gravar aqui derruba o
-- webhook junto.
--
-- Guardamos HMAC-SHA256(k_codigos, tipo|versao|codigo), nunca o codigo. E HMAC
-- e nao SHA-256 puro porque a "pimenta" impede ataque OFFLINE contra um dump:
-- sem o PANEL_SESSION_KEY nao da nem para testar candidatos.
CREATE TABLE IF NOT EXISTS painel_codigos (
  hash          TEXT PRIMARY KEY,
  tipo          TEXT    NOT NULL,             -- 'recuperacao' | 'parada'
  versao_hash   INTEGER NOT NULL DEFAULT 1,
  criado_em     INTEGER NOT NULL,
  usado_em      INTEGER,
  invalidado_em INTEGER
);

CREATE INDEX IF NOT EXISTS idx_painel_codigos_tipo
  ON painel_codigos (tipo, usado_em);
```

### 8.6 `migrations/0004_painel_acesso.sql`

```sql
-- Painel administrativo: credenciais WebAuthn, sessoes e convites consumidos.
-- Mesma regra de ouro do 0003.

-- Estado singleton do painel. Existe para guardar o user.id do WebAuthn: ele
-- precisa ser ESTAVEL, senao cada registro cria uma entrada separada no
-- gerenciador de senhas do celular em vez de agrupar as passkeys do dono.
-- NAO guarda estado de configuracao: parado_por_codigo_em mora em painel_config.
CREATE TABLE IF NOT EXISTS painel_estado (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  usuario_handle    TEXT    NOT NULL,
  criado_em         INTEGER NOT NULL,
  atualizado_em     INTEGER NOT NULL
);

-- Passkeys registradas. O rp_id fica gravado em CADA linha porque ele e
-- imutavel dentro da credencial: se o endereco do painel mudar, estas linhas
-- nao "migram", elas viram inuteis. Guardando o rp_id conseguimos IGNORAR as
-- antigas e explicar na tela, em vez de devolver um erro incompreensivel.
CREATE TABLE IF NOT EXISTS painel_credenciais (
  credential_id     TEXT PRIMARY KEY,          -- base64url, como o navegador mandou
  rp_id             TEXT    NOT NULL,
  usuario_handle    TEXT    NOT NULL,
  chave_publica_jwk TEXT    NOT NULL,          -- JWK em JSON. Chave PUBLICA: sem cifra
  algoritmo         INTEGER NOT NULL,          -- COSE alg: -7 (ES256) ou -257 (RS256)
  transportes       TEXT,                      -- JSON array; so dica de UI, nunca decisao
  sign_count        INTEGER NOT NULL DEFAULT 0,
  backup_eligible   INTEGER NOT NULL DEFAULT 0,
  backup_state      INTEGER NOT NULL DEFAULT 0,
  apelido           TEXT    NOT NULL,
  origem_registro   TEXT    NOT NULL,          -- 'convite' | 'sessao' | 'recuperacao'
  criado_em         INTEGER NOT NULL,
  usado_em          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_painel_credenciais_rp
  ON painel_credenciais (rp_id);

-- Sessoes ativas. O cookie carrega um identificador aleatorio; aqui fica so o
-- SHA-256 dele. Um dump do D1 nao entrega cookie utilizavel, do mesmo jeito que
-- a tabela de comentarios guarda hash do IGSID e nao o IGSID.
CREATE TABLE IF NOT EXISTS painel_sessoes (
  sid_hash        TEXT PRIMARY KEY,
  credential_id   TEXT    NOT NULL,
  rp_id           TEXT    NOT NULL,           -- copiado da credencial: evita JOIN
  criada_em       INTEGER NOT NULL,
  expira_em       INTEGER NOT NULL,           -- teto absoluto, nunca estendido
  ociosa_ate      INTEGER NOT NULL,           -- janela deslizante
  vista_em        INTEGER NOT NULL,
  falhas_stepup   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_painel_sessoes_cred
  ON painel_sessoes (credential_id);

-- Nonces de convite JA CONSUMIDOS. So entra linha aqui DEPOIS que a assinatura
-- HMAC do convite foi conferida: quem nao tem o SETUP_ADMIN_TOKEN nao consegue
-- provocar nem uma escrita nesta tabela.
CREATE TABLE IF NOT EXISTS painel_convites_usados (
  nonce         TEXT PRIMARY KEY,
  consumido_em  INTEGER NOT NULL,
  expira_em     INTEGER NOT NULL              -- so para a faxina do cron
);
```

**Não existe tabela `painel_tentativas`**, e isso é a decisão, não um esquecimento. Dois motivos,
cada um suficiente sozinho: (1) uma linha por tentativa de login daria ao atacante um botão para
esgotar a cota de escrita e desligar o webhook `[C]`; (2) bloqueio por tentativa em rota não
autenticada é uma arma apontada para o dono, e não há espaço de senha a exaurir — o segredo do login
é uma chave privada dentro de um autenticador. O único contador persistido do painel é
`painel_sessoes.falhas_stepup`, alcançável só por quem já tem sessão válida.

### 8.7 Escolhas de schema, e o porquê

| Escolha | Motivo |
|---|---|
| Linha única `id = 1` com `CHECK (id = 1)` | Mesmo padrão de `account_tokens` `[C]`. Multi-conta seria outra migration |
| Colunas tipadas, não um blob JSON | O banco é fronteira; um JSON único não aceita restrição por campo |
| `media_scope` em vez de `allowed_media_ids` | Mata por construção a armadilha do override que nunca dispara (§9.6) |
| `media_id TEXT PRIMARY KEY` | Unicidade obrigatória e `TEXT` obrigatório (nunca `Number`: perda de precisão silenciosa) |
| Colunas de override `NULL`-áveis | `NULL` → chave ausente no patch |
| `CHECK (enabled IS NULL OR enabled = 0)` | Preserva a parada de emergência como chave-mestra real |
| `parado_por_codigo_em` em `painel_config`, e só ali | É estado de **configuração**: mora na mesma linha que a própria rota de parada já grava, no mesmo lote |
| Zero índice secundário nas três tabelas do 0002 | Índice encarece escrita `[C]`; as consultas do caminho quente já são cobertas pela PK/rowid |
| `versao` único para global + mídias | Um só carimbo de cache, uma só trava otimista. Para dono único, conflito é caso de recarregar a tela |
| Epoch ms em `INTEGER`, vindo de `now` | Convenção do projeto `[C]`: tempo sempre injetado, nunca `CURRENT_TIMESTAMP` |
| Sem `FOREIGN KEY` de `painel_midias` para `painel_config` | O invariante real é mais forte e não é expressável numa FK: linhas de mídia só são honradas quando a linha de config existe **e é válida**. Fica no loader, com aviso na tela |

### 8.8 Atomicidade e versionamento

Mudança de configuração = um `db.batch([...])` com, nesta ordem: linhas de mídia → linha global com
o incremento de versão → insert de auditoria.

`painel_config.versao` é monotônico e tem três funções:

1. **Trava otimista.** A tela envia a versão que carregou; o `UPDATE` traz
   `WHERE id = ? AND versao = ?`. `result.meta.changes === 0` `[C]` → **409**, página com a mensagem
   "a configuração mudou em outro lugar; recarregue a tela" e o formulário preenchido com o que a
   pessoa digitou. Efeito colateral que é recurso: a **parada de emergência também incrementa a
   versão**, então quem estava com o formulário aberto é obrigado a recarregar e ver, em letras
   grandes, que a automação foi parada e desde quando.
2. **Carimbo do cache**, para correlacionar log de isolate com log de auditoria.
3. **Chave do log**: cada linha de auditoria guarda a versão resultante.

`[V]` Confirmar que `db.batch()` roda em transação implícita e conta como um único subrequest. Se a
garantia não existir, a ordem acima é a defesa: a linha global com a nova versão é a **última**, e
qualquer divergência em `changes` vira erro duro na tela, nunca sucesso silencioso.

**Regra de ouro da auditoria: sem log, sem mudança.** O insert de auditoria vai no mesmo lote da
alteração. Se ele falhar, a alteração falha junto. Nada de "grava e depois tenta logar".

### 8.9 Poda da auditoria, sem `COUNT(*)`

Retenção de **500 linhas**. `COUNT(*)` varreria a tabela inteira e conta como linhas lidas na cota:

```sql
-- Existe alguma linha alem das 500 mais recentes? O rowid ja da a ordem.
SELECT id FROM painel_auditoria ORDER BY id DESC LIMIT 1 OFFSET 500;
-- So se vier linha:
DELETE FROM painel_auditoria WHERE id <= ?;
```

Lê no máximo 501 linhas pelo rowid e só escreve quando há o que apagar. Entra em
`runScheduledTasks`, que já roda a cada 5 minutos `[C]` — assim a poda **nunca** entra no caminho de
gravação do painel. É a única poda de `painel_auditoria` no projeto.

No mesmo cron, guardada por uma leitura de `painel_estado.atualizado_em` para rodar no máximo a cada
6 h, a faxina de acesso:

```sql
DELETE FROM painel_convites_usados WHERE expira_em < ?;
DELETE FROM painel_sessoes         WHERE expira_em < ? OR ociosa_ate < ?;
```

Sessões expiradas já são rejeitadas na leitura; o delete é higiene de armazenamento, não segurança.

### 8.10 Isolamento nos testes

`limparBanco()` sai de `tests/repositories.test.ts:9` `[C]` e passa a viver em
`tests/fixtures/banco.ts` — é a **única** edição mecânica autorizada nos seis arquivos de teste
atuais. As **oito** tabelas novas entram nessa função, junto com `processed_comments` e
`account_tokens`. E `invalidarCacheDeConfig()` é chamada no `beforeEach`: sem isso, um teste que usa
`AGORA = 1_700_000_000_000` deixa um cache "válido até o futuro" que contamina o teste seguinte.

---

## 9. Configuração: resolução, cache, validação, allowlist e migração

### 9.1 `src/config.ts` continua sendo a fábrica, e não muda nada

O arquivo permanece um literal exportado, síncrono, sem `import` de `Env` nem de D1, com os mesmos
nomes de campo e a mesma formatação. Três razões confirmadas no repositório:

1. `src/utils/normalize.ts:1` importa tipos dele `[C]`.
2. `tests/automation.test.ts:3,15` importa `automationConfig` e faz spread por cima `[C]`; a origem
   D1 não toca esses testes, porque a config já é injetada por `deps.config` `[C]`.
3. `scripts/configurar.mjs:526,754-793` faz **parsing por regex linha a linha** do bloco
   `export const automationConfig: AutomationConfig = {` `[C]`. Mudar formatação, ordem de campos ou
   nomes quebra o assistente local **em silêncio**.

`resolveConfigForMedia` e `isMediaAllowed` continuam **puras, síncronas e com os parâmetros default
intactos** `[C]`. Os novos chamadores passam o snapshot explicitamente.

### 9.2 Os estados da resolução

```ts
type OrigemConfig = 'arquivo' | 'banco' | 'parado_por_erro'

interface SnapshotConfig {
  readonly global: AutomationConfig
  readonly overrides: readonly MediaAutomation[]
  readonly origem: OrigemConfig
  readonly versao: number
  /** Achados do validador na leitura. Vao para a tela, nao para o webhook. */
  readonly avisos: readonly string[]
}
```

| Estado do banco | Resultado | Por quê |
|---|---|---|
| **Linha ausente** | `{...automationConfig}` do arquivo, `overrides: []`, `origem: 'arquivo'` | Não é conserto de inválido: é o estado bem definido "o painel ainda não existe". É o que torna a atualização de quem já usa o projeto **byte-idêntica** ao comportamento de hoje |
| **Tabela inexistente** | idem, mais `console.error` e sinal em `/health` | idem. `[I]` reconhecer isso pela mensagem `no such table` é frágil; o remédio primário é a ordem documentada do deploy: migration antes do código |
| **Linha presente e válida** | config do banco, `origem: 'banco'` | caminho normal |
| **Linha global com QUALQUER campo inválido** | `{...automationConfig, enabled: false}`, `origem: 'parado_por_erro'`, aviso na tela **nomeando o campo** | um único campo inválido significa que a tela e o webhook podem discordar; entregar um link diferente do que a tela mostra é pior que não entregar nada |
| **Erro de D1 na leitura** | idem, e o snapshot de falha **é cacheado** com o TTL longo | seguro, e não martela um banco que já está caindo |
| **Linha de override inválida** | aquela mídia recebe patch `{ enabled: false }`; as outras seguem | descartar a linha **alargaria** — ela podia ser justamente o que estreitava |
| **Linhas de mídia órfãs** (sem linha de config) | ignoradas, com aviso na tela | misturar global-do-arquivo com override-do-banco alarga |

A propriedade que fica escrita e verificável: **erro nunca alarga, e erro nunca inventa um valor que
o dono não viu na tela.**

### 9.3 O parser: `NULL` vira chave ausente

```ts
// ERRADO — produz { destinationUrl: undefined } e zera o campo global no spread,
// levando isDestinationUrlConfigured a lancar TypeError dentro de processComment.
const patch = { destinationUrl: row.destination_url ?? undefined }

// CERTO — insercao condicional de chave. A chave so existe se a coluna nao e NULL.
function patchDaLinha(row: PainelMidiaRecord): Partial<AutomationConfig> {
  const patch: Partial<AutomationConfig> = {}
  if (row.enabled !== null) patch.enabled = row.enabled === 1
  if (row.match_mode !== null) patch.matchMode = row.match_mode as MatchMode
  if (row.destination_url !== null) patch.destinationUrl = row.destination_url
  if (row.user_cooldown_hours !== null) patch.userCooldownHours = row.user_cooldown_hours
  // ... um `if` por coluna, sem excecao
  return patch
}
```

Três reforços: ligar `"exactOptionalPropertyTypes": true` no `tsconfig.json` `[V]` (transforma
`patch.x = undefined` em erro de compilação); teste explícito
`expect('destinationUrl' in patch).toBe(false)` — não basta `toBeUndefined()`, que passa nos dois
casos e é exatamente o teste que deixaria o bug passar; e guarda em desenvolvimento
`Object.values(patch).every((v) => v !== undefined)`.

### 9.4 Derivação de `allowedMediaIds`

```ts
// media_scope 'todas' -> ['*']. 'selecionadas' -> a uniao das linhas ativas.
const allowedMediaIds =
  row.media_scope === 'todas' ? [WILDCARD] : midiasAtivas.map((m) => m.media_id)

// Cada linha vira UMA entrada com UM mediaId. resolveConfigForMedia nao muda de
// assinatura e o .find() passa a ser deterministico por construcao.
const overrides: MediaAutomation[] = midiasAtivas.map((m) => ({
  mediaIds: [m.media_id],
  ...patchDaLinha(m),
}))
```

Consequência: o invariante `existe override(X) ⟹ isMediaAllowed(X)` passa a valer **sempre**, sem
nenhuma checagem. Na tela, na documentação, no validador e no log, o alargamento se chama
`mediaScope: 'todas'` — nunca "`allowedMediaIds` para `*`".

### 9.5 Uma carga por lote, não por comentário

`src/index.ts:149` hoje chama `resolveConfigForMedia(event.mediaId)` **dentro do `for` de eventos**
`[C]`. Com D1 isso viraria N leituras e um snapshot inconsistente no meio do lote.

```ts
export async function processEvents(events, env, now) {
  const conta = await new TokensRepository(env.DB).get()
  if (!conta) return
  const credencial = await loadAccessToken(env)
  if (!credencial) return

  // UMA carga por lote, antes do laco. Do cache na maioria das invocacoes.
  const cfg = await carregarConfigEfetiva(env, now)

  for (const event of events) {
    const config = resolveConfigForMedia(event.mediaId, cfg.global, cfg.overrides)
    // ... resto identico
  }
}
```

O mesmo vale para `retryPending` (`src/index.ts:210`) `[C]`.

### 9.6 Cache por isolate, com TTL assimétrico

```ts
/** Cache do isolate. Vive enquanto o isolate viver; some no proximo deploy. */
let cache: { snapshot: SnapshotConfig; expiraEm: number } | null = null

/** Ligado: janela curta, porque servir "ligado" desatualizado e a direcao perigosa. */
const TTL_LIGADO_MS = 10_000
/** Desligado: janela longa, porque servir "parado" desatualizado e a direcao segura. */
const TTL_DESLIGADO_MS = 60_000

export async function carregarConfigEfetiva(
  env: Env, now: number, opcoes: { ignorarCache?: boolean } = {},
): Promise<SnapshotConfig> {
  if (!opcoes.ignorarCache && cache !== null && now < cache.expiraEm) return cache.snapshot
  const snapshot = await lerEValidar(env, now)      // 2 consultas, ou 0 no fallback
  const ttl = snapshot.global.enabled ? TTL_LIGADO_MS : TTL_DESLIGADO_MS
  cache = { snapshot: congelarFundo(snapshot), expiraEm: now + ttl }
  return cache.snapshot
}

/** Chamado pela rota que grava e pelos testes. Vale so para ESTE isolate. */
export function invalidarCacheDeConfig(): void { cache = null }
```

- **Ligado, 10 s.** É a janela em que uma parada de emergência ainda pode não ter alcançado um
  isolate quente. Em texto para o dono: *"pode levar até 10 segundos para todos os servidores
  pararem."* Dez segundos a 5 comentários/s são ~50 Directs no pior caso, contra o dano indefinido
  de não conseguir parar.
- **Desligado, 60 s.** Servir "parado" desatualizado nunca causa dano, e economiza exatamente quando
  o sistema mais precisa. O preço é que religar demora até 1 minuto para valer em todos os isolates
  — e a tela diz isso.
- **Congelamento em profundidade obrigatório.** `{...global}` de `resolveConfigForMedia` é cópia
  rasa: os arrays continuam sendo a mesma referência do cache. Sem `Object.freeze` nos arrays, um
  consumidor que fizesse `config.triggerKeywords.push(...)` envenenaria o isolate inteiro. Hoje
  ninguém muta `[C]`; o congelamento é o que garante que continue assim.
- **O cache nunca concede nada.** Tudo que entra nele já passou pelo validador; um cache velho pode,
  no máximo, repetir uma permissão que **realmente existiu** por até 10 segundos.
- **A allowlist nunca fica velha no cache**, porque mudá-la exige deploy e deploy descarta os
  isolates `[I, mas sólido]`.
- **O painel não usa o cache.** Toda leitura do painel chama com `ignorarCache: true`. Salvar e a
  tela mostrar o valor antigo destrói a confiança de um leigo mais rápido que qualquer bug. Como
  toda gravação é POST → `303` → GET, o caminho é: gravou no lote → `invalidarCacheDeConfig()` →
  redireciona → o GET relê do banco. A pessoa vê o que ficou gravado, não o que ela digitou.

Alternativas recusadas: Cache API (é por colo e não tem invalidação — criaria uma segunda fonte de
verdade); Workers KV (1.000 escritas/dia no free `[C]` e consistência eventual); Durable Object
(cota própria e binding a mais, atrito para leigo); ler a `versao` a cada invocação (continua sendo
uma consulta e um subrequest — não economiza nada).

### 9.7 Validação: um só validador, dois chamadores

O mesmo módulo puro `src/services/config-validation.ts` roda na **escrita** (rejeita com mensagem
específica) e na **leitura** (não pode rejeitar — degrada para falha segura). É o que garante que
uma linha que entrou por fora do painel (`wrangler d1 execute`, bug de migration futura) seja
julgada pela mesma régua.

```ts
type Achado = { campo: string; codigo: string; mensagem: string }
type Validacao<T> = { ok: true; valor: T } | { ok: false; achados: readonly Achado[] }
```

**Nuance importante:** a convenção de mensagem genérica ao cliente `[C]` vale para erro de
**autenticação**, onde distinguir "passkey desconhecida" de "assinatura inválida" ajuda o atacante.
Erro de **validação** numa rota já autenticada é o oposto: o leigo precisa saber exatamente qual
campo está errado e por quê. A `mensagem` e os nomes dos campos vão para a tela; o código em
snake_case vai para o `console.warn`; **nenhum valor vai para o `console`, nunca**.

#### Ordem obrigatória na rota de escrita

Toda gravação de configuração é formulário `application/x-www-form-urlencoded`; não existe API JSON
de dados. A ordem espelha a já usada no webhook (tamanho → assinatura → parse, sobre o corpo cru,
`webhook.ts:49-69` `[C]`):

0. `painelHabilitado(env)` — sem `PANEL_RP_ID` o painel inteiro responde `503`, antes de tudo.
1. Teto do corpo — **32 KB** em formulário.
2. `Origin` / `Sec-Fetch-Site` (§7.8).
3. Sessão válida.
4. Ficha anti-CSRF do campo escondido `csrf`, comparada em tempo constante.
5. Leitura do corpo com `URLSearchParams`, dentro do teto já aplicado.
6. **Campos desconhecidos: rejeitar.** Na entrada vinda de humano, estranheza é sinal de erro de
   digitação ou de cliente adulterado. (Na leitura do banco é o contrário: colunas desconhecidas são
   descartadas em silêncio, para compatibilidade com versões futuras.)
7. Validação campo a campo.
8. **Step-up**, quando o diff toca campo que exige. O servidor **recalcula** o `op_hash` a partir do
   corpo recebido e compara com `timingSafeEqual`. Vem depois da validação porque o hash é sobre a
   mudança canônica, que só existe depois do parse — e isso não é concessão: até aqui nada foi
   gravado.
9. Trava otimista por `versao` e gravação em lote com o registro de auditoria.
10. `303` para `GET /painel/<tela>?ok=<codigo>`.

**Invariante: nenhuma escrita acontece antes do passo 9.**

#### Regra por campo

| Campo | Regra na escrita | O que quebra sem ela |
|---|---|---|
| `enabled` | booleano estrito | — |
| `triggerKeywords` | array de string, 1..20 itens, cada um ≤ 40 caracteres. **Comprimento medido no texto NORMALIZADO** com as opções vigentes, não no cru | `"eu!"` normaliza para `"eu"`: medir no cru deixa passar gatilho de 2 letras |
| — gatilho curto | mínimo **2** normalizados em `exact`; **4** em `contains` | `contains` com gatilho de 2 letras casa quase todo comentário |
| — gatilho vazio | rejeitar item que normalize para vazio | Hoje ele é **pulado em silêncio** (`normalize.ts:77` `[C]`): a pessoa acha que configurou e nada acontece |
| — duplicata | rejeitar dois itens que normalizem para o mesmo texto | confusão pura na tela |
| — lista vazia | permitida só com `enabled = 0` | automação ligada que nunca dispara parece viva |
| `matchMode` | `'exact' \| 'contains'`; ir para `contains` é **alargar → step-up** | campo que compõe o pior combo |
| `caseSensitive`, `normalizeAccents`, `ignorePunctuation` | booleano estrito | — |
| `processOnlyReels` | booleano; `false` é **alargar → step-up** | amplia o raio para qualquer publicação |
| `mediaScope` | `'todas' \| 'selecionadas'`; ir para `'todas'` é **alargar → step-up** | idem |
| `publicReplyEnabled` / `privateReplyEnabled` | booleano; **desligar nunca exige step-up** | a direção segura não pode ter atrito |
| `publicReplyText` | 1..500 caracteres após NFKC + remoção de `\p{Cc}\p{Cf}`; **nenhum placeholder**; **step-up sempre** | o texto público não passa por `renderTemplate`: um `{link}` ali sairia escrito assim mesmo, publicamente |
| `privateReplyText` | 1..500, mesma limpeza; **só** `{username}` e `{link}`; se `privateReplyEnabled`, exigir `{link}`; pior caso renderizado (link 2048 + username 64) ≤ 1000 `[I, teto defensivo]`; **step-up sempre** | Direct sem link é um Direct quebrado enviado a cada acionamento |
| — placeholder inválido | rejeitar qualquer `{...}` fora do par conhecido | `renderTemplate` deixa desconhecido intacto de propósito `[C]` — bom em runtime, péssimo como estado salvo |
| — URL no texto | **toda** sequência com cara de domínio passa pela allowlist (§9.8) | allowlist só no campo do link é contornada escrevendo a URL no texto |
| `destinationUrl` | `new URL()` obrigatório; **só `https:`**; sem `user:senha@`; sem porta diferente de 443; host minúsculo e em punycode; ≤ 2048; host na allowlist; **step-up sempre** | a regra de escrita é mais estrita que `isDestinationUrlConfigured`, que ainda aceita `http://` `[C]` — a função de leitura fica como está, por compatibilidade, e a escrita é que aperta |
| `userCooldownHours` | `Number.isInteger`, 0..8760. Baixar abaixo do valor atual é **alargar → step-up** e confirmação escrita | **cooldown negativo é o caso mais traiçoeiro:** `now - horas*3600000` `[C]` vai para o futuro, a comparação é sempre falsa e o freio **desaparece sem erro nenhum**. `NaN`/`Infinity` viram `.bind(NaN)` e derrubam a consulta dentro de `processComment`, documentada como função que nunca lança |
| `mediaIds` | `^[0-9]{5,25}$`, nunca `Number()`; **máximo 200 no total**; no máximo **20 ids novos por requisição**; ids novos revalidados contra a conta com `getMediaInfo` | 200 é o bound de carga fria, memória e CPU; 20 é o bound de subrequests |

Os três campos com step-up **sempre** — `destinationUrl`, `privateReplyText` e `publicReplyText` —
vivem na mesma tela, `/painel/mensagem`. Não há caminho de gravação desses três fora dela.

Duas recusas que não são sobre campo isolado: não deixar salvar `mediaScope: 'selecionadas'` com
lista vazia e `enabled = 1`; e, se a listagem da Meta falhar na montagem da tela, o painel mostra o
erro e **não deixa salvar a seleção** — salvar a partir de uma lista que não carregou apagaria a
seleção existente.

### 9.8 A allowlist de domínios

Módulo `src/services/link-allowlist.ts`, uma implementação só, usada na escrita **e** na leitura.

Variável **pública** `ALLOWED_LINK_DOMAINS` no bloco `vars` do `wrangler.jsonc`. Não é segredo: não
tem confidencialidade nenhuma e precisa ser revisável num diff. O bloco `vars` é sobrescrito a cada
deploy e editá-lo pelo dashboard não adianta `[C]` — o que aqui é **a propriedade que faz a trava
funcionar**: o teto do painel está ancorado no repositório mais a credencial de deploy, exatamente
as duas coisas que um painel invadido não tem.

```jsonc
// Dominios para os quais o painel pode apontar o link do Direct. Um item que
// comeca com ponto tambem libera os subdominios. Vazio = o painel NAO pode
// alterar link nenhum.
"ALLOWED_LINK_DOMAINS": "noxelora.com.br,www.noxelora.com.br"
```

Regra de casamento, deliberadamente burra:

- Entrada sem ponto inicial: `host === entrada` (host exato, nada mais).
- Entrada com ponto inicial (`.exemplo.com.br`): `host === 'exemplo.com.br' || host.endsWith('.exemplo.com.br')`.
- Nunca `includes`, nunca `startsWith`. `evilnoxelora.com.br` não termina em `.noxelora.com.br`, e é
  esse detalhe que separa a regra certa da errada.

**Ausente, vazia ou toda inválida** → allowlist não configurada. Nesse caso o painel **recusa
qualquer alteração de link e de texto** e mostra a tarja *"a lista de domínios permitidos não foi
configurada no deploy; nenhum link pode ser alterado por aqui"*, e a **entrega continua funcionando**
com o link que já está valendo. Bloquear a entrega quebraria, na atualização, todo mundo que hoje
tem um `destinationUrl` no arquivo e nenhuma variável nova — punir o usuário legítimo por uma
configuração que ele ainda não teve chance de fazer não é falha segura, é falha barulhenta.

Aplicação na escrita, sobre `destinationUrl` **e** `publicReplyText` **e** `privateReplyText`:

```ts
// Normalizacao ANTES de procurar: NFKC mata caracteres de largura total e
// confundiveis; a limpeza de controle mata zero-width usado para disfarcar.
const texto = sanitizeValue(bruto.normalize('NFKC'), MAX_TEXTO)

// Detector conservador de proposito: qualquer coisa com cara de dominio conta.
// Falso positivo num texto que a pessoa escreve uma vez e aceitavel;
// falso negativo e um link de golpe entregue.
const CANDIDATO_HOST = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi
```

**Aplicação na leitura, e por que ela é obrigatória.** Ela cobre três coisas que a escrita não
cobre: uma escrita feita **fora** do painel; um **encolhimento posterior** da allowlist; e uma versão
futura do validador com um furo fechado só na escrita. Violação na global → `enabled: false`,
`origem: 'parado_por_erro'`, aviso nomeando campo e host. Violação numa linha de mídia → patch
`{ enabled: false }` para aquela mídia. Nunca substituir pelo link de fábrica. O escaneamento roda
uma vez por preenchimento de cache, não por comentário — irrelevante nos 10 ms de CPU.

### 9.9 Auditoria: dois destinos, duas regras opostas

| Destino | O que pode | Por quê |
|---|---|---|
| **`painel_auditoria` (D1 do dono)** | `antes` e `depois` com o estado **completo** da entidade afetada, em JSON | é o **histórico** de um dado que já está na mesma base, em texto claro, e que é conteúdo do próprio dono |
| **`console` / Workers Logs** | método, caminho **sem query string**, status, código de erro em snake_case. **Nenhum valor, nunca** | sai da base do dono, retenção definida pela Cloudflare, fora do controle deste código |

A promessa escrita em `src/index.ts:8-16` `[C]` é sobre **dado de terceiro**: o IGSID só como
SHA-256, e o texto do comentário e o username não armazenados. A configuração do painel — link,
texto do Direct, palavras-gatilho — **não é dado de terceiro**: é conteúdo do próprio dono, e já
está armazenado em `painel_config`, na mesma base, em texto claro. Guardar o valor anterior numa
linha de auditoria **não acrescenta nenhuma classe nova de dado**; acrescenta histórico. A promessa
pública fica intacta, sem ressalva.

**O que entra em `antes`/`depois`:** o estado completo da entidade, restrito aos **campos de
comportamento**. Para a global, de `enabled` a `user_cooldown_hours`, sem `versao`,
`parado_por_codigo_em`, `criado_em` e `atualizado_em`. Para uma linha de mídia, `media_id`, `ativo` e
as colunas de sobreposição — **fica de fora todo o metadado de exibição** (`legenda_curta`,
`permalink`, `media_product_type`, `postado_em`, `visto_em`, `indisponivel_desde`). Motivo decisivo:
`legenda_curta` é um recorte da `caption` do Reel, e `caption` de Reel está na lista de proibidos
abaixo — **a proibição vence a regra do "estado completo"**. (Isto era uma contradição aparente no
material de origem e fica resolvida aqui.)

**Proibido nos dois destinos, sem exceção:** segredo de qualquer espécie (cookie, HMAC, desafio,
`op_hash`, código de recuperação, código de parada, token de convite, access token da Meta,
`TOKEN_ENCRYPTION_KEY`, `SETUP_ADMIN_TOKEN`), `credential_id` inteiro, endereço IP, `User-Agent`,
`thumbnail_url`/`media_url` (URL-capacidade `[C]`), `caption` de Reel, username de quem comentou,
texto de comentário.

Demais regras:

- `ator` = `passkey:<8 hex do sha256 do credential_id>` | `parada` | `assistente` | `migracao`.
  Nunca o `credential_id` cru.
- `step_up` registra se houve reautenticação na hora. É o campo que responde "essa troca de link foi
  autorizada com a passkey presente?" numa investigação.
- **Tentativa recusada também gera linha**, com `antes = depois = NULL` e `acao` própria. É o que
  impede que uma sequência de tentativas de sequestro passe sem deixar rastro.
- Valores de `acao`: `config_alterada`, `midia_alterada`, `mudanca_recusada`, `login`,
  `sessao_encerrada`, `passkey_registrada`, `passkey_removida`, `stepup_recusado`, `codigos_gerados`,
  `recuperacao_usada`, `parada_acionada`, `acesso_zerado`.
- Fracasso de requisição **não autenticada** não gera linha nenhuma no D1 — vai só para
  `console.warn`. Gravar tentativa de estranho seria escrita provocada por estranho.
- **Restaurar passa pelo mesmo funil**: reenviar o `antes` pela rota normal de gravação, com o mesmo
  validador, o mesmo step-up e a **allowlist de hoje**. Se a allowlist encolheu, a restauração é
  recusada — e isso está certo.

### 9.10 Contabilidade de escrita

| Operação | Consultas D1 | Escritas |
|---|---|---|
| Webhook, cache quente | **0** de config | 0 |
| Webhook, cache frio | 2 | 0 |
| Cron (`runScheduledTasks`) | 2 no pior caso + 1 leitura barata da poda | 0, ou 1 `DELETE` quando há poda |
| Painel: ler a configuração | 2 (sempre ignora o cache) | 0 |
| Painel: salvar uma tela global | 1 lote | 2 (config + auditoria) |
| Painel: salvar uma mídia | 1 lote | 3 (mídia + config + auditoria) |
| Painel: importar/salvar tudo com 200 mídias | 1 lote | ~400 |
| Parada de emergência, código correto, primeira vez | 2 leituras | **2** (config + auditoria) |
| Parada de emergência, código correto, repetida | 2 leituras | **0** |
| Parada de emergência, código errado | 1 leitura | **0** |
| Login bem-sucedido | 1 leitura | 3 (sessão + credencial + auditoria) |
| Login fracassado | 1 leitura | **0** |
| Registro por convite | 2 leituras | 3 (consumo do nonce + credencial + auditoria) |
| Registro por sessão + step-up | 2 leituras | 2 (credencial + auditoria) |
| Registro por código de recuperação | 2 leituras | 5 (consumo + invalidação dos demais + `DELETE` de sessões + credencial + auditoria) |
| `POST /setup/painel/codigos` | 0 | 1 lote (DELETE do conjunto antigo + 7 INSERT + auditoria) |

### 9.11 Quem já usa o projeto hoje

> Atualizar o código e fazer deploy **não pode mudar comportamento nenhum**. A configuração só passa
> a vir do banco quando a pessoa salva pela primeira vez no painel, deliberadamente.

É por isso que "linha ausente" resolve para o padrão de fábrica, e não para "parado": o padrão de
fábrica de quem já usa o projeto **é o `src/config.ts` que ela mesma editou**.

1. A migration cria as três tabelas **vazias**. Nada de `INSERT` de seed: o SQL não sabe ler
   `src/config.ts`, e um seed com valores fixos seria pior que nenhum seed.
2. Deploy. Automação segue idêntica, `origem: 'arquivo'`.
3. Primeiro acesso ao painel: a tela carrega **preenchida com a config efetiva atual**, com a tarja
   *"estes valores vieram do arquivo do projeto. Ao salvar, o painel passa a mandar."*
4. Primeiro salvamento: materializa `painel_config` com `versao = 1` e grava auditoria com
   `origem: 'migracao'`, `ator: 'migracao'`.

**Importar `mediaAutomations` do arquivo** conserta dois problemas de graça, e a tela precisa dizer
que consertou:

- Um cartão com vários `mediaIds` vira **N linhas idênticas**: *"o cartão de 3 Reels virou 3
  cartões; editar um não muda os outros"*. É perda real de expressividade em troca da unicidade.
  `[I]` Se um dia doer, a saída aditiva é uma coluna `grupo_id` que agrupa na tela e continua sem
  participar da resolução.
- Reel citado em dois cartões: importa o primeiro (mesma semântica do `.find()` de hoje) e **avisa**
  qual foi descartado. Hoje esse conflito é silencioso.
- `allowedMediaIds` como lista específica vira `mediaScope: 'selecionadas'`, e as linhas são a
  **união** de `allowedMediaIds` com todos os `mediaIds` dos cartões. Essa união conserta, na
  importação, quem hoje tem uma automação por Reel que **nunca dispara**.

**Não deixar o arquivo virar armadilha.** Depois que a linha existe, editar `src/config.ts` e fazer
deploy não muda nada. Três defesas: a **origem aparece em toda tela de configuração** (`arquivo`,
`banco` ou `parado_por_erro`), com a tarja correspondente; quando a origem é `banco`, o painel mostra
quais campos divergem do arquivo; e o `scripts/configurar.mjs`, na opção 4, consulta `GET /health`
antes de editar e olha o único campo novo dessa rota (§11.9). Se o valor indicar que a configuração
já vive no banco, ele **bloqueia** a edição direta, mostrando *"a configuração vive no painel; abra
{base}/painel para mudar. Editar o arquivo aqui não vai mudar nada"*.

**Caminho de volta**, documentado e disponível como opção do assistente:

```sql
DELETE FROM painel_midias;
DELETE FROM painel_config;
```

As duas, sempre nesta ordem e juntas. O log de auditoria **não** é apagado: ele é o histórico e
sobrevive ao rollback.

### 9.12 Como cada armadilha de `resolveConfigForMedia` morre

| Armadilha | Tratamento | Onde |
|---|---|---|
| `MediaAutomation` omite `allowedMediaIds`; override para Reel fora da lista global nunca dispara | `allowedMediaIds` deixa de ser gravável; a lista é **derivada** das mesmas linhas que geram override | schema + loader |
| `.find()` — dois cartões citando o mesmo Reel, o primeiro vence em silêncio | `media_id` é PRIMARY KEY; duas entradas para o mesmo Reel deixam de ser representáveis | schema |
| `{...global, ...patch}` com `undefined` explícito zera o campo global | `NULL` → **chave ausente**, via `if (row.x !== null)`; reforçado por `exactOptionalPropertyTypes` e por teste com `'campo' in patch` | parser + tsconfig + teste |
| **Nova:** `enabled: true` num override **derrota a parada de emergência** | `CHECK (enabled IS NULL OR enabled = 0)` | schema |
| Assinatura síncrona vs D1 assíncrono, com chamada dentro do `for` | funções continuam puras e síncronas; snapshot carregado uma vez por lote | `config-store.ts` + `index.ts` |
| O banco como entrada não confiável | mesmo validador na escrita e na leitura; **nunca conserto** | `config-validation.ts` |
| Migration reaplicada sobre forma antiga | nome em um arquivo só, `CHECKSUMS.txt`, `ALTER TABLE` em migration nova, META-08 | §8.2 |

---

## 10. Autenticação: registro, login, sessão, step-up, recuperação e parada

Premissa desta seção inteira: **o atacante leu todo o código**. Ele conhece rotas, nomes de cookie,
formato dos envelopes, ordem das verificações e cada comparação. A única coisa que ele não tem é um
segredo.

### 10.1 Segredos e derivação de subchaves

Nunca usar a mesma chave para dois propósitos. HMAC-SHA256 é um PRF; derivar por rótulo basta e usa
**só a primitiva que o repositório já importa** (`crypto.subtle.sign` com HMAC), sem HKDF nem
dependência nova.

```
k(rotulo) = HMAC-SHA256(chave_raiz, "noxe-painel/v1/" + rotulo)
```

| Subchave | Raiz | Rótulo | Uso |
|---|---|---|---|
| `k_sessao` | `PANEL_SESSION_KEY` | `sessao` | assina o cookie `__Host-painel_sessao` |
| `k_desafio` | `PANEL_SESSION_KEY` | `desafio` | raiz das chaves de envelope de cerimônia |
| `k_csrf` | `PANEL_SESSION_KEY` | `csrf` | deriva a ficha anti-CSRF a partir da sessão |
| `k_codigos` | `PANEL_SESSION_KEY` | `codigos` | pimenta do hash dos códigos de recuperação e de parada |
| `k_convite` | `SETUP_ADMIN_TOKEN` | `convite` | assina o convite de uso único |

São exatamente estas cinco. Cada propósito de cerimônia deriva mais um passo, a partir de
`k_desafio`, sem acrescentar subchave à raiz:

```
k_env(proposito) = HMAC-SHA256( k_desafio, "noxe-painel/v1/env/" + proposito )
proposito ∈ { "entrar", "registrar", "stepup" }
```

O convite deriva do `SETUP_ADMIN_TOKEN` porque ele é emitido **offline**, na máquina do dono, pelo
assistente, que já lê esse token do `.dev.vars` `[C]`. A separação por rótulo garante que um convite
vazado **não** vira cookie de sessão nem desafio válido, e que rotacionar o `SETUP_ADMIN_TOKEN`
invalida convites **sem** derrubar as sessões — que era o problema de hoje, em que o
`SETUP_ADMIN_TOKEN` é simultaneamente token de acesso e chave HMAC do `state` do OAuth `[C]`.

**Consequência a documentar em letra grande:** rotacionar `PANEL_SESSION_KEY` derruba todas as
sessões **e invalida os códigos de recuperação e de parada** (a pimenta muda). Por isso existe a
coluna `versao_hash`, e por isso o assistente, ao rotacionar essa chave, tem de oferecer a
regeneração dos códigos no mesmo passo, em letras grandes. As passkeys **não** são afetadas.

### 10.2 Portão de sanidade — o furo mais fácil de deixar aberto

Se o segredo **não foi cadastrado**, em Workers ele chega como `undefined`, e um HMAC com chave
vazia é perfeitamente computável **por qualquer pessoa que leu o código**.

```ts
/** Portao de sanidade do painel. Falha fechada: sem segredo forte, o painel nao existe. */
export function painelHabilitado(env: Env): { ok: true } | { ok: false; motivo: string } {
  if (typeof env.PANEL_SESSION_KEY !== 'string' || env.PANEL_SESSION_KEY.length < 32)
    return { ok: false, motivo: 'chave_de_sessao_ausente' }
  if (typeof env.SETUP_ADMIN_TOKEN !== 'string' || env.SETUP_ADMIN_TOKEN.length < 20)
    return { ok: false, motivo: 'admin_token_ausente' }
  if (typeof env.PANEL_RP_ID !== 'string' || env.PANEL_RP_ID.length === 0)
    return { ok: false, motivo: 'endereco_do_painel_nao_configurado' }
  return { ok: true }
}
```

Toda rota `/painel/**` chama isso na **primeira linha** e devolve `503 painel_desativado`. A única
exceção é `POST /painel/parada`, que não depende de `rpId` nem de sessão, só de `k_codigos`.

O piso de 20 caracteres do `SETUP_ADMIN_TOKEN` foi escolhido para não quebrar o binding fictício de
teste atual, de 20 caracteres `[C]`. Se um dia o piso subir para 32, `vitest.config.ts` precisa ser
atualizado junto ou a suíte inteira quebra por 503.

### 10.3 O envelope assinado

`src/security/oauth-state.ts` já é um JWT mínimo `[C]`, mas o payload só carrega nonce + prazo e
`sign()` é privado. Generalizar para `src/security/signed-envelope.ts`, mantendo `oauth-state.ts`
funcionando por cima dele (para não mexer no OAuth):

```
formato: "v1" "." <proposito> "." base64url(json_do_payload) "." <expira_em> "." base64url(hmac)
hmac  = HMAC-SHA256( k_env(proposito), "v1|" + proposito + "|" + payload_b64 + "|" + expira_em )
```

Três defesas embutidas contra confusão de propósito: o propósito entra no **texto assinado**, na
**derivação da chave** (mesmo que um bug de parser ignore o campo, a assinatura não fecha) e no
**nome do cookie**. Ordem de validação idêntica à do `validateState` atual `[C]`: formato →
assinatura em tempo constante → prazo. Nunca o contrário. A mensagem ao cliente é sempre a mesma
(`credencial_invalida`).

`src/security/base64url.ts` passa a exportar encode **e** decode; `decodeBase64Url` devolve
`Uint8Array | null` e **nunca lança**.

### 10.4 Registro de passkey: as três — e apenas três — autorizações

```ts
type AutorizacaoRegistro =
  | { tipo: 'convite';     nonce: string }        // HMAC do assistente local
  | { tipo: 'recuperacao'; hashCodigo: string }   // codigo de recuperacao valido
  | { tipo: 'sessao';      credencialId: string } // sessao viva + step-up recem feito
```

Não existe uma quarta. Em particular, **não existe** o ramo `if (credenciais.length === 0) permitir`
— o "trust on first use" que é exatamente o takeover de primeiro acesso.

**O convite**, emitido pelo assistente sem rede e sem rota:

```
convite = "cv1" "." base64url(nonce_16B) "." <pre> "." <expira_em> "." base64url(hmac)
hmac    = HMAC-SHA256( k_convite, "cv1|" + nonce + "|" + pre + "|" + expira_em )
pre     = "0"  -> so vale enquanto NAO existir nenhuma credencial (primeira instalacao)
        | "q"  -> vale em qualquer estado (recuperacao; o assistente avisa que e mais perigoso)
```

O assistente imprime `https://<host>/painel/convite#c=<convite>`. **Fragmento**, não query string: o
fragmento não é enviado ao servidor, não entra em log de proxy nem em `Referer` — a mesma regra que
`oauth.ts:26-30` já aplica `[C]`. TTL de 20 minutos: tempo de sair do terminal e pegar o celular,
curto o bastante para que um convite esquecido num print esteja morto. `pre=0` é defesa em
profundidade barata: o convite comum, que pode acabar num print de tutorial, deixa de funcionar no
instante em que a primeira passkey existe.

Uso único: o `nonce` vai para `painel_convites_usados` com `ON CONFLICT DO NOTHING` — o mesmo padrão
de claim atômico do `claimComment` `[C]` — e o resultado é lido por `meta.changes` `[C]`. Duas
requisições concorrentes com o mesmo convite não podem ambas ver `changes === 1`, porque o D1 é
SQLite com escritor único `[I, forte — vale um teste de concorrência]`.

**`POST /painel/api/registrar/opcoes`** — corpo `{ tipo, ... }`:

1. Escada de verificação (§11.3). No modo `sessao`, exige sessão + **ficha CSRF** + assertion de
   step-up cuja mudança canônica é `{ acao: "adicionar_passkey" }`.
2. Limitador: `PANEL_LIMITER_LOGIN` no modo convite, `PANEL_LIMITER_CODIGO` no modo recuperação.
3. **Valida a autorização antes de gerar qualquer coisa.** As options revelam o `usuario_handle` e a
   lista de `excludeCredentials`, isto é, os `credential_id` já registrados: devolver isso a um
   estranho é enumeração gratuita `[C]`.
4. Nesse ponto **nada foi consumido**: o convite não foi marcado, o código não foi queimado. Se a
   pessoa cancelar a biometria — o fracasso mais comum — ela tenta de novo com o mesmo convite.
5. Lê ou cria `painel_estado.usuario_handle` (32 bytes aleatórios, base64url). Estável para sempre:
   se mudasse, cada registro criaria uma conta separada no gerenciador de senhas do celular.
6. Sorteia `desafio = base64url(random(32))` e monta o **bilhete de registro**, no mesmo cookie
   `__Host-painel_desafio`, distinguido pelo propósito `registrar`, com `Max-Age=300`:
   `payload { c: desafio, a: tipo, k: nonce|hashCodigo|credencialId, h: usuario_handle }`.
7. Devolve as options:

```json
{
  "rp": { "id": "<PANEL_RP_ID>", "name": "Painel da automacao" },
  "user": { "id": "<usuario_handle>", "name": "@<username ou 'painel'>", "displayName": "Dono da conta" },
  "challenge": "<desafio>",
  "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }],
  "authenticatorSelection": { "residentKey": "required", "userVerification": "required" },
  "attestation": "none",
  "excludeCredentials": [ "... credenciais com o rp_id atual ..." ],
  "timeout": 300000
}
```

`[-7, -257]` e nada mais: ES256 cobre Apple/iCloud/Google/Android, RS256 cobre Windows Hello, e a
documentação do SimpleWebAuthn recomenda restringir a esses dois `[C]`. `attestation: "none"`
elimina ~90% do trabalho de verificação e a cadeia X.509 que ameaçaria os 10 ms de CPU `[C]`.
`residentKey: "required"` porque, com dono único, não há campo de usuário para enumerar `[C]`.
Ed25519 (-8) fica de fora por decisão: cobertura mínima e incompatibilidades conhecidas `[C]`.

### 10.5 `POST /painel/api/registrar/verificar` — verificação da attestation

Verificações obrigatórias, em ordem, cada uma com falha genérica ao cliente (`credencial_invalida`)
e detalhe só em `console.warn` — o padrão de `oauth.ts` `[C]`:

1. Escada de §11.3 (corpo ≤ 8 KB, `content-type: application/json`, origem).
2. Cookie `__Host-painel_desafio` presente, envelope válido, propósito **`registrar`**, no prazo.
3. `type === "public-key"`.
4. `clientDataJSON`: `type === "webauthn.create"` **literal** (confundir com `"webauthn.get"`
   permitiria usar uma resposta de login para registrar `[C]`); `challenge` igual ao do bilhete,
   comparado com `timingSafeEqual`, **nunca** aceito do corpo `[C]`; `origin === origemDoPainel(env)`
   por **string exata** (nunca `includes`/`startsWith`: `https://host.evil.com` passaria `[C]`);
   `crossOrigin !== true`.
5. `attestationObject` em CBOR: `fmt === "none"` e `attStmt` mapa vazio. Qualquer outra coisa é
   anomalia e é **recusada**, não "aceita e ignorada".
6. `authData` (binário cru): bytes 0–31 `rpIdHash === SHA-256(PANEL_RP_ID)`, comparado byte a byte —
   é o passo mais pulado de todos `[C]`; byte 32 flags, com `UP` (bit 0), `UV` (bit 2) e `AT` (bit 6)
   **obrigatórios**, e `BE` (bit 3) e `BS` (bit 4) lidos para a tela; bytes 33–36 `signCount`
   big-endian; depois `aaguid` (16 B), `credentialIdLength` (2 B, teto de 1023), `credentialId` e a
   chave COSE.
7. COSE → JWK: ES256 (`kty=2, alg=-7, crv=1`, `x` e `y` de exatamente 32 bytes) →
   `{kty:'EC', crv:'P-256', x, y}`; RS256 (`kty=3, alg=-257`, `n` ≥ 256 bytes, `e`) →
   `{kty:'RSA', n, e}`; qualquer outro `alg` recusa. `crypto.subtle.importKey('jwk', ...)` **agora**,
   no registro: se a chave não importa, a credencial nunca entra no banco.
8. `credential_id` ainda não existe na tabela (conflito de PK → recusa genérica).
9. Teto de **10** credenciais por `rp_id`.
10. `apelido` saneado, 1–40 caracteres, sem caracteres de controle. Ele **não** é escapado na
    gravação; é escapado na renderização, automaticamente.

**Parser CBOR — requisitos de segurança** (`src/services/webauthn/cbor.ts`): subconjunto mínimo
(inteiros, byte strings, text strings, arrays, mapas); **recusar** comprimento indefinido;
profundidade máxima 4; byte string máxima 2 KB; e exigir que o parser **consuma exatamente** os
bytes esperados, sem sobra. Nunca lança: devolve união discriminada, no formato que `webhook.ts` já
usa `[C]`. **O parser CBOR só roda no registro**, nunca no login — o que mantém o caminho quente
longe dos 10 ms de CPU.

**Ordem de gravação, e o preço dela.** Consumir a autorização **antes** de inserir a credencial. Se
a inserção falhar, o convite ou o código foi queimado por nada, e a pessoa precisa de outro —
aceito de propósito. A ordem inversa abre uma corrida em que duas requisições com o mesmo convite
inserem duas credenciais, e uma delas pode ser do atacante. Perder um convite é aborrecimento;
ganhar uma credencial indevida é o fim do jogo.

```sql
-- convite
INSERT INTO painel_convites_usados (nonce, consumido_em, expira_em)
VALUES (?, ?, ?) ON CONFLICT DO NOTHING;        -- changes = 0 -> ja usado -> recusa

-- codigo de recuperacao
UPDATE painel_codigos SET usado_em = ?
 WHERE hash = ? AND tipo = 'recuperacao'
   AND usado_em IS NULL AND invalidado_em IS NULL;  -- changes = 1 obrigatorio

-- sessao: nada a consumir; a autorizacao ja foi o step-up
```

**Esta rota NÃO emite sessão.** É decisão deste documento (§15.3, divergência 5). Depois de
registrar, a resposta é `{ ok: true, para: "/painel/entrar" }` e a tela diz *"Aparelho cadastrado.
Agora entre com ele."* Três razões: (a) a sessão nasce **sempre** de uma assertion de login
(`webauthn.get`) com UV conferido, num ponto único do código, o que torna a garantia testável;
(b) a rotação obrigatória de identificador no login fecha fixação de sessão; (c) é o que faz o
código de recuperação nunca virar sessão, nem direta nem indiretamente (§15.3, divergência 1). O
custo é um gesto de biometria a mais, logo depois de outro — aceito, e a tela explica.

### 10.6 Prova de que não existe janela em que um estranho se registre

**Invariante R.** Para todo instante `t ≥ t0` (deploy), uma linha só entra em `painel_credenciais`
se o requisitante possuir: (S1) o `SETUP_ADMIN_TOKEN`; ou (S2) a chave privada de uma passkey já
registrada; ou (S3) um código de recuperação não usado.

- *Lema 1 — caminho único.* `INSERT INTO painel_credenciais` aparece em exatamente um lugar do
  código, chamado de exatamente um lugar. **Verificado por teste** que faz grep em `src/` e falha se
  a string aparecer em mais de um arquivo. Sem esse teste, o lema envelhece mal.
- *Lema 2 — nenhum registro sem bilhete.* `401` antes de qualquer parse se o cookie faltar, tiver
  MAC inválido, propósito diferente de `registrar` ou prazo vencido.
- *Lema 3 — o bilhete não é forjável.* MAC sob `k_env("registrar")`, derivada de
  `PANEL_SESSION_KEY`, que é secret da Cloudflare e cuja ausência desliga o painel inteiro (§10.2).
- *Lema 4 — o bilhete só é emitido com uma das três autorizações*, e a função tem exatamente três
  ramos.
- *Lema 5 — cada ramo exige um segredo:* convite (MAC de 256 bits sob chave derivada do admin
  token), recuperação (100 bits), sessão (chave privada em hardware **mais** biometria).
- *Lema 6 — não existe ramo TOFU.*

**Teorema.** Um requisitante sem S1, S2 e S3 não consegue inserir credencial em nenhum instante. Em
particular, no intervalo entre o deploy e a primeira passkey, as três autorizações já dependem de
segredos que **existem antes do deploy**. O conjunto de instantes em que o registro está aberto é
**vazio**, não apenas curto. **Corolário:** se o dono nunca rodar o assistente, o painel fica
inerte, não aberto — a direção certa.

O teorema **não** cobre: vazamento do `SETUP_ADMIN_TOKEN` (rotacionável; a varredura de segredos já
procura por isso `[C]`); interceptação do convite antes do primeiro uso (TTL de 20 min, uso único,
fragmento, `pre=0`); máquina do dono comprometida (fora do escopo de qualquer desenho); e XSS com
sessão viva (limitado pelo escape automático e pelo step-up preso ao conteúdo).

### 10.7 Login

**`POST /painel/api/entrar/opcoes`** é a rota não autenticada mais exposta do painel, e custa **zero
consulta ao D1**: sorteia 32 bytes e assina um envelope de propósito `entrar`, `Max-Age=120`.
Resposta: `{ challenge, rpId, allowCredentials: [], userVerification: "required", timeout: 120000 }`.
`allowCredentials` vazio porque as credenciais são descobríveis — e porque devolver a lista de
`credential_id` a quem ainda não provou nada é enumeração `[C]`.

**`POST /painel/api/entrar/verificar`**, na ordem:

1. Escada de §11.3 (≤ 8 KB, JSON, origem, `PANEL_LIMITER_LOGIN`).
2. Cookie de desafio: MAC válido em tempo constante, propósito `entrar`, dentro dos 120 s.
   **Só depois disto o D1 é tocado.**
3. `type === "public-key"`; `id` é base64url plausível.
4. `SELECT` da credencial por `credential_id` — 1 leitura. Não encontrada **ou**
   `rp_id !== PANEL_RP_ID`: falha genérica. Credencial de endereço antigo é **ignorada**, não é erro
   especial — é o que faz a troca de domínio não virar mensagem incompreensível `[C]`.
5. `userHandle` presente e igual a `painel_estado.usuario_handle`.
6. `clientDataJSON`: `type === "webauthn.get"` literal; `challenge` igual ao do cookie com
   `timingSafeEqual`; `origin === origemDoPainel(env)` exato; `crossOrigin !== true`.
7. `authenticatorData`: `rpIdHash` confere; `UP = 1` e **`UV = 1` obrigatório**; lê `signCount`,
   `BE`, `BS`.
8. **O que é assinado**: `authenticatorData || SHA-256(clientDataJSON)` — os bytes crus
   concatenados, **não** o JSON `[C]`. Errar isso é o bug que faz tudo retornar `false`.
9. **ES256: converter a assinatura de DER para bruto.** É a armadilha número um do projeto `[C]`: o
   autenticador devolve `SEQUENCE { INTEGER r, INTEGER s }` e o WebCrypto exige `r||s` em 64 bytes.
   Sem converter, `verify` devolve `false` **em silêncio** e o dono nunca entra.

```
derParaBruto(der: Uint8Array): Uint8Array | null
  1. der[0] === 0x30, senao null
  2. comprimento: forma curta (< 0x80) ou 0x81 xx. Total <= 72 bytes, senao null
  3. der[i] === 0x02 (INTEGER); le tamanho; le r
  4. remove zeros a esquerda de r; se sobrar > 32 bytes -> null
  5. alinha r a esquerda com zeros ate 32 bytes
  6. repete 3-5 para s
  7. exige que os bytes tenham sido consumidos EXATAMENTE, sem sobra
  8. devolve concat(r32, s32)
```

   Maleabilidade (`s` e `n-s` ambas válidas) é irrelevante aqui: replay já está bloqueado pelo
   desafio efêmero e nenhum identificador deriva da assinatura. RS256 já vem bruta.
10. `importKey('jwk', ...)` + `verify` (`ECDSA/SHA-256` ou `RSASSA-PKCS1-v1_5`). Ambos suportados no
    runtime da Cloudflare `[C]`.
11. `signCount`: se `novo > 0 && antigo > 0 && novo <= antigo`, apenas `console.warn` **sem o
    `credential_id` inteiro**. **Nunca recusar** — passkeys sincronizadas por iCloud Keychain e
    Google Password Manager devolvem 0 sempre `[C]`, e recusar trancaria o dono legítimo para fora,
    invertendo a falha segura.
12. Cria a sessão e atualiza a credencial (`sign_count`, `backup_state`, `usado_em`) — 2 escritas,
    ambas depois de uma assinatura válida. Auditoria `acao = 'login'` — 1 escrita.
13. Resposta `{ ok: true, para: "/painel" }`; o `painel.js` navega. É a única navegação que o
    JavaScript faz — não há roteador.

**Custo do fracasso: 1 verificação de MAC, 1 leitura e ZERO escritas.** É o número que sustenta a
regra de não gravar por tentativa: o teto passa a ser a cota de requisições do Worker, e a automação
não cai junto por consumo de escrita.

Detalhe de front que quebra em iOS se esquecido: `navigator.credentials.get()`/`create()` precisam
ser chamados dentro de um gesto do usuário (clique), nunca no `onload` `[C]`.

### 10.8 Sessão

```
Set-Cookie: __Host-painel_sessao=<valor>; HttpOnly; Secure; SameSite=Strict; Path=/;
            Max-Age=<restante do prazo absoluto>
valor = "s1" "." base64url(sid_32B) "." <expira_em> "." base64url(hmac)
hmac  = HMAC-SHA256( k_sessao, "s1|" + sid_b64 + "|" + expira_em )
```

**Por que HMAC e linha no banco.** O HMAC sozinho daria sessão sem estado, mas sem revogação; a
linha sozinha faria cada cookie de lixo custar uma consulta. Juntos: o **HMAC é o filtro grátis**
(bot mandando cookies aleatórios é rejeitado com zero consultas) e a **linha é a autoridade**
(logout de verdade, "desconectar este aparelho", morte em cascata quando a passkey é removida).
Guardamos `sha256(sid)`, não o `sid`: um dump do D1 não entrega cookie utilizável — o mesmo
raciocínio que já levou o projeto a guardar `commenter_scoped_id_hash` em vez do IGSID `[C]`.

O prefixo `__Host-` importa de verdade aqui: `workers.dev` está na lista de sufixos públicos `[C]`,
então `<conta>.workers.dev` é domínio registrável e **qualquer outro Worker seu na mesma conta**
poderia, sem o prefixo, gravar um cookie de domínio pai e sombrear a sessão do painel. O preço é
`Path=/`, que faz o cookie acompanhar também `/webhooks/instagram` — inofensivo e verificável: o
handler do webhook não lê cookie e não pode passar a ler, e a assinatura do webhook é calculada
sobre o corpo cru, jamais sobre o cabeçalho `Cookie` `[C]`.

| Prazo | Valor | Por quê |
|---|---|---|
| absoluto (`expira_em`) | **12 h** | nunca estendido; força uma biometria por dia de uso |
| ocioso (`ociosa_ate`) | **2 h** deslizante | celular esquecido na mesa expira sozinho |
| gravação de `vista_em` | no máximo 1 a cada **15 min** | uso intenso não vira uma escrita por requisição |

**Rotação** em exatamente dois momentos: login bem-sucedido (sempre linha nova — fecha fixação de
sessão) e step-up bem-sucedido (a sessão muda de "conseguiu ler" para "acabou de autorizar"). **Não**
rotaciona a cada requisição: custaria uma escrita por requisição e criaria a corrida clássica de
rede móvel (resposta perdida, cookie novo nunca chega, dono deslogado). Como a rotação do step-up
acontece na mesma requisição que grava e devolve `303`, o cookie novo chega junto com o redirect.

**Consequência honesta do `SameSite=Strict`:** ao abrir o painel por um link vindo de fora
(WhatsApp, um atalho de outro app), a **primeira** navegação é cross-site e o navegador **não** manda
o cookie — o dono cai em `GET /painel/entrar` mesmo tendo sessão viva. Por isso essa página traz,
além do botão de passkey, um link **"Continuar"** apontando para `/painel`: clicá-lo é navegação
same-site, o cookie vai junto e a sessão aparece. Custa **0 consulta**. Navegação por favorito ou
atalho na tela inicial não tem origem iniciadora e **carrega o cookie normalmente** `[I]`, então o
caso ruim é só o link colado em outro app. `SameSite=Lax` resolveria isso e continuaria bloqueando
POST cross-site; **fica `Strict`**, porque com ele nem a página autenticada chega a renderizar numa
navegação hostil, e o custo tem mitigação de uma linha.

Revogação: `POST /painel/sair` apaga a linha, manda `Set-Cookie` com `Max-Age=0` e
`Clear-Site-Data` `[I: suporte irregular no Safari; é reforço, não a defesa]`. "Sair de todos os
aparelhos" (`POST /painel/aparelhos`, `acao=sair_de_tudo`, §10.13) apaga a tabela. Remover uma
passkey apaga as sessões dela, e a tela avisa antes quando a passkey é a da sessão atual (§10.13). Trocar o endereço invalida
tudo por `rp_id`. `POST /setup/painel/zerar` apaga sessões e, se pedido, credenciais.

### 10.9 CSRF: cinco camadas

1. **`SameSite=Strict`** no cookie de sessão. Um POST cross-site nem chega autenticado.
2. **Origem obrigatória e exata**, com fallback para `Sec-Fetch-Site: same-origin` (§7.8). O
   fallback é o que elimina o risco de trancar o dono para fora caso algum navegador não mande
   `Origin`: deixou de ser pendência de projeto e virou teste da suíte.
3. **Ficha derivada da sessão**, obrigatória em **todo POST autenticado**:
   `csrf = base64url(HMAC-SHA256(k_csrf, "csrf|v1|" + sid_hash))`. Em campo escondido nos
   formulários; no cabeçalho `X-Painel-CSRF` nas rotas `/painel/api/*` que correm com sessão.
   Comparada com `timingSafeEqual`. **Derivada, não sorteada**: não precisa de coluna, não precisa de
   segundo cookie, e é impossível de dessincronizar.
4. **`content-type` exato por família:** `application/json` em `/painel/api/*` (o que sozinho já
   elimina CSRF por formulário HTML), `application/x-www-form-urlencoded` nos formulários. Qualquer
   outro é `415`.
5. **Zero CORS, sempre.** Nenhuma rota emite `Access-Control-Allow-Origin`; não há configuração, não
   há allowlist, não há exceção "só para desenvolvimento". `OPTIONS` devolve `405`.

Exceção deliberada e única: `POST /painel/parada` não exige origem nem ficha (§10.12).

### 10.10 Step-up: uma operação, presa ao conteúdo

```
1. a tela monta a mudanca e MOSTRA o valor literal que sera gravado
2. POST /painel/api/stepup/opcoes { operacao, mudanca }        (sessao + CSRF, JSON)
   servidor: op_hash = SHA-256(json_canonico(mudanca))
             sorteia desafio; Set-Cookie __Host-painel_stepup =
               envelope{ p:"stepup", c: desafio, oh: op_hash, sid: sid_hash }  Max-Age=120
3. painel.js chama navigator.credentials.get() (userVerification: "required")
   e coloca a assertion serializada num campo escondido do MESMO formulario
4. o formulario e submetido para a rota de escrita normal
   servidor: valida a assertion (mesma lista de §10.7, proposito "stepup");
             RECALCULA op_hash a partir do corpo recebido e compara com timingSafeEqual;
             confere que o sid do envelope == sessao atual;
             aplica; expira o cookie; rotaciona o sid; responde 303
```

Não existe `/painel/api/stepup/verificar`: a verificação acontece **dentro** da rota de escrita, o
que torna impossível haver uma autorização pendurada esperando uma segunda requisição. Não existe
"modo privilegiado", não existe `elevadoAte`, não existe janela.

Por que não uma janela de 5 minutos, que seria mais confortável: o inimigo é um painel invadido. Com
janela, um XSS que rouba o instante do step-up faz **N** mudanças dentro dela, inclusive trocar o
link **depois** que o dono aprovou outra coisa. Preso ao `op_hash`, o autenticador assina *aquela*
mudança. O ganho é categórico; o custo é um toque a mais numa operação rara. E custa **zero estado e
zero escrita**: a autorização é consumida na mesma requisição que aplica a mudança.

Regras que acompanham:

- **`json_canonico` é especificado e testado com vetores congelados.** A entrada **nunca** é o corpo
  cru: é o mapa de campos **já validado e normalizado** pelo mesmo `config-validation.ts` nos dois
  caminhos. Chaves ordenadas lexicograficamente por code point, sem espaço entre tokens, números como
  inteiros, strings já em NFKC e sem `\p{Cc}\p{Cf}`. O objeto `mudanca` sempre carrega
  `{ acao: "<operacao>", ... }`, com `acao` ∈ `config` | `adicionar_passkey` | `remover_passkey` |
  `gerar_codigos` — assim duas operações diferentes com payload idêntico não compartilham
  assinatura, e o campo `operacao` do corpo da cerimônia é só roteamento e **precisa ser igual** a
  `mudanca.acao`. Sem essa especificação, o hash recalculado diverge e a trava vira bug
  intermitente.
- A tela **tem que** mostrar o valor literal antes da biometria. Se o humano não leu o que assinou,
  a amarração ao conteúdo não vale nada.
- Se **qualquer** campo do lote exige step-up, o lote inteiro exige, e gravação parcial é
  impossível.
- O `sid_hash` no envelope amarra o step-up àquela sessão; um envelope roubado não serve em outra.
- Falha de step-up incrementa `painel_sessoes.falhas_stepup`; em **10**, a sessão é apagada.
- Uma tentativa de gravação **recusada** por step-up ausente ou inválido também gera linha de
  auditoria. Isso não contradiz a regra de não gravar fracasso: a requisição é autenticada, portanto
  a escrita já está limitada por uma credencial.

**O que exige step-up:** `destinationUrl`, `privateReplyText` e `publicReplyText` (sempre);
alargamento do envelope de alcance (`matchMode` → `contains`, cooldown abaixo do atual,
`mediaScope` → `'todas'`, `processOnlyReels` → `false`); adicionar ou remover passkey; gerar códigos
novos. **O que não exige:** desligar qualquer coisa, estreitar alcance, remover um Reel da lista,
apagar palavra, **"sair de todos os aparelhos"**, e **ligar a automação de novo** — é a direção
segura, e a parada de emergência depende de desligar ser barato.

**Por que ligar de novo não exige step-up**, apesar de parecer alargamento: religar não muda nenhum
valor, apenas devolve a chave ao estado anterior, que já era do dono e que ele já autorizou quando
gravou aqueles campos. Exigir biometria aqui puniria justamente quem acabou de usar o freio de
emergência. Religar exige **sessão + ficha CSRF + confirmação explícita na tela**, com a data vinda
de `parado_por_codigo_em` (§10.12) — e nada além disso.

### 10.11 Códigos de recuperação

| Item | Escolha | Justificativa |
|---|---|---|
| Quantidade | **6** | suficiente para várias trocas de aparelho sem virar uma lista que ninguém guarda |
| Alfabeto | Crockford base32 (sem `I`, `L`, `O`, `U`) | quem digita no celular sob estresse confunde `0`/`O` e `1`/`I`/`l` |
| Tamanho | 20 caracteres = **100 bits** | ver abaixo |
| Formato exibido | `XXXXX-XXXXX-XXXXX-XXXXX` | hífens só na exibição |
| Geração | `crypto.getRandomValues` **no Worker** | ver abaixo |
| Armazenamento | `HMAC-SHA256(k_codigos, "recuperacao\|1\|" + normalizado)` em hex | a pimenta impede ataque offline sobre um dump |
| Uso | **único**, atômico | `UPDATE ... WHERE hash=? AND usado_em IS NULL`, exige `changes === 1` |
| Poder | **só registra uma passkey nova**; nunca cria sessão sozinho | um código não pode virar senha |

Normalização da entrada: maiúsculas, remover espaços e hífens, mapear `I`/`L` → `1` e `O` → `0`;
depois exigir exatamente 20 caracteres do alfabeto — qualquer outra coisa é recusa **antes** de
qualquer consulta.

**A conta de entropia.** O pior caso agregado do limitador, por ele ser por data center, é da ordem
de 1.500 requisições/minuto distribuídas `[C/I]`. Com 100 bits, o tempo esperado para adivinhar é
`2^99 / 1500` minutos — número sem significado físico. E o teto real é mais duro: o atacante não
consegue emitir 100.000 requisições/dia sem estourar a cota do Worker, que é o mesmo recurso que ele
estaria tentando derrubar. **A entropia, não o bloqueio, é o que protege esses códigos** — e é por
isso que a ausência de tabela de tentativas não é uma concessão.

**Por que o Worker gera, e não o assistente.** Para calcular a pimenta, o assistente precisaria da
`PANEL_SESSION_KEY` na máquina — um segundo lugar onde a chave de sessão existe, o oposto exato da
separação de segredos. Sem a pimenta, um dump do D1 vira ataque offline. E há um modo de falha
silencioso a evitar: o dono rodar o assistente numa máquina que nunca teve a chave e gravar um hash
que o Worker não consegue verificar. A objeção "o código em claro trafega pela rede" não introduz
confiança nova: o assistente **já** envia o `SETUP_ADMIN_TOKEN` pelo mesmo canal TLS ao mesmo
Worker `[C]`.

```
POST /setup/painel/codigos     Authorization: Bearer <SETUP_ADMIN_TOKEN>
  -> Worker sorteia 6 codigos de recuperacao (20 chars) + 1 codigo de parada (16 chars)
  -> grava SO os HMAC-SHA256(k_codigos, "<tipo>|<versao_hash>|<codigo_normalizado>")  (1 lote)
  -> devolve os codigos em texto no corpo da resposta, UMA UNICA VEZ
  -> o assistente imprime na tela e manda anotar; nunca grava em arquivo
```

**O corpo dessa resposta nunca é logado**, em nenhum nível: `console.log`/`warn`/`error` do corpo
desta rota é proibido, e a varredura de segredos do `verificar-antes-de-publicar` cobre o arquivo do
handler. Gerar um conjunto novo **apaga o antigo inteiro** (`DELETE` + `INSERT` em lote). A mesma
operação existe pela tela, com sessão + step-up, em `POST /painel/aparelhos` com `acao=gerar_codigos`.

**Invalidação em bloco.** Usar um código de recuperação consome aquele **e**, no mesmo lote: marca
`invalidado_em` em todos os demais; apaga **todas** as sessões; grava `acao = 'recuperacao_usada'`;
e o painel abre com aviso bloqueante *"gere um novo conjunto de códigos agora"*. Justificativa: se
um código foi usado por quem não devia, os outros estão na mesma lista vazada.

### 10.12 Código de parada de emergência

**Por que é seguro expô-lo sem login** — argumento de assimetria de consequência, não de
obscuridade:

1. Ele só sabe uma coisa: `enabled = 0`. Não lê configuração, não lista Reels, não mostra o link,
   não diz se a conta está conectada.
2. O efeito é a direção segura. O pior abuso possível é **parar** uma automação.
3. A alternativa é pior: sem esta rota, o dono trancado para fora não tem freio nenhum enquanto o
   Worker continua mandando Direct em nome dele.
4. Ela não é fraca por estar exposta: são 80 bits, e o que a torna aceitável não é o segredo ser
   grande — é o segredo comprar tão pouco.

**Forma e execução:**

```
POST /painel/parada
content-type: application/x-www-form-urlencoded
codigo=XXXXX-XXXXX-XXXXXX

1. rate limit PANEL_LIMITER_STOP por IP, se o binding existir                       (0 D1)
2. normaliza; formato exato (16 chars do alfabeto Crockford); senao recusa           (0 D1)
3. SELECT hash FROM painel_codigos WHERE tipo='parada' AND invalidado_em IS NULL     (1 leitura)
4. HMAC-SHA256(k_codigos, "parada|1|" + normalizado); compara com timingSafeEqual
5. nao bate (ou nao ha linha nenhuma): recusa. ZERO escritas.
6. bate: le enabled (1 leitura). Ja desligada? responde "Pronto" e NAO grava.        (0 escritas)
7. senao: UPDATE painel_config SET enabled=0, parado_por_codigo_em=?, versao=versao+1
          + 1 linha de auditoria (origem='parada', ator='parada')                    (1 lote)
```

O formulário vive no **asset** `public/painel/parar/index.html`, sem script e sem interpolação. A
ação é um caminho **diferente**, para que um POST nunca seja endereçado a um caminho de asset.
**POST com o código no corpo, nunca GET com o código na URL** `[C]`: query string vaza em log de
proxy, histórico e `Referer`. Corpo capado em **1 KB**. Sem exigência de `Origin`/`Sec-Fetch-Site` e
sem ficha CSRF — "CSRF" aqui significaria enganar o dono para que ele desligue a própria automação,
e mesmo isso exige o código; exigir origem quebraria a chamada por `curl` do assistente, que é um
caminho legítimo de emergência. É a **única** exceção de origem em todo o painel.

**As três respostas, e nada além disso:**

| Caso | Texto integral da página |
|---|---|
| código correto (gravou, ou já estava desligada) | **Pronto. A automação está desligada.** |
| código incorreto ou malformado | **Esse código não confere. Confira e digite de novo.** |
| falha ao ler ou gravar no D1 | **Não foi possível confirmar agora. Em caso de erro a automação para sozinha.** |

Por que distinguir, contrariando a convenção de erro genérico do projeto: (a) o que a distinção
compra o atacante é um oráculo sobre um espaço de 80 bits que ele não consegue varrer, porque o teto
de 100.000 requisições/dia `[C]` é o mesmo recurso que ele estaria tentando derrubar; (b) a
indistinção não esconde o resultado — a automação para de responder, e isso se vê de fora —, esconde
só do dono; (c) uma pessoa que acredita ter parado a automação e não parou é exatamente a falha que
a regra de falha segura existe para impedir; (d) a convenção genérica é sobre **autenticação**, onde
há credencial a enumerar, e aqui não há nada a enumerar. Por isso `credencial_invalida` **não** se
aplica a esta rota: o código dela é `codigo_incorreto`, exclusivo.

Regras obrigatórias: a página de resultado **não contém** nenhum campo de configuração, nenhum link,
nenhuma contagem, nenhum estado da conta, e **não informa se existe código de parada cadastrado**.
Código errado custa **1 leitura e 0 escrita**. Acionar duas vezes é idempotente. Comparação sempre
por `timingSafeEqual` `[C]`, nunca `===`. **Não é de uso único**, de propósito: é um freio, e freio
precisa funcionar todas as vezes. Religar exige sessão e confirmação explícita, com a data vinda de
`parado_por_codigo_em`. A rota não depende de `painel_credenciais`, `painel_sessoes` nem do `rpId`:
se o subsistema WebAuthn estiver quebrado, o freio continua funcionando.

### 10.13 Várias passkeys, e a regra da última

Adicionar: sessão + ficha + step-up com `{ acao: "adicionar_passkey" }`, depois o fluxo de §10.4 com
`tipo: 'sessao'`. São **dois** gestos de biometria (um para autorizar, um para criar), e a tela
explica: "confirme que é você" e depois "crie a nova chave".

Remover: `POST /painel/aparelhos` com `acao=remover_passkey`, step-up cuja mudança canônica é
`{ acao: "remover_passkey", credential_id: "<id>" }` — o `op_hash` amarra a assinatura **àquela**
credencial, então um XSS não troca o alvo depois da aprovação. A regra "não pode remover a última"
tem de ser **atômica**:

```sql
DELETE FROM painel_credenciais
 WHERE credential_id = ?
   AND rp_id = ?
   AND (SELECT COUNT(*) FROM painel_credenciais WHERE rp_id = ?) > 1;
```

A subconsulta é avaliada dentro da mesma instrução e o D1 é SQLite com escritor único
`[I, forte — vale um teste de concorrência]`. `meta.changes === 0` `[C]` vira "não é possível remover
a última passkey; cadastre outra antes". A contagem considera **só** credenciais com o `rp_id`
atual: credenciais de endereço antigo são inúteis e podem ser removidas livremente, inclusive todas.

**Aviso obrigatório antes do gesto:** remover uma passkey **apaga as sessões dela**. Se for a
credencial da sessão atual, o dono é deslogado na hora — comportamento correto, e **a tela avisa
antes**: *"Este é o aparelho que você está usando agora. Ao removê-lo você vai sair do painel e vai
precisar entrar de novo com outro aparelho ou com um código de recuperação."*

**Nunca exibir o `credential_id` inteiro.** Na tela de Aparelhos, cada linha é identificada por
apelido, data de cadastro e último uso; quando um desempate visual é necessário, aparece **só o
prefixo de 8 caracteres do `sha256(credential_id)`** — o mesmo recorte que §9.9 usa no campo `ator`
(`passkey:<8 hex>`) e §11.7 no `console`. Um identificador inteiro na tela não diferencia melhor e
convida a copiar credencial para lugar nenhum. São **três** destinos e **uma** regra: tela, `console`
e `painel_auditoria` veem o mesmo prefixo, nunca o valor cru.

**"Sair de todos os aparelhos"** é `POST /painel/aparelhos` com `acao=sair_de_tudo`: sessão + ficha
CSRF, **sem step-up** (é a direção segura de §10.10), `DELETE FROM painel_sessoes` — 1 escrita —, e o
próprio dono sai junto, com a tela dizendo isso antes. A mesma página traz "sair deste aparelho"
(`POST /painel/sair`), "gerar novos códigos" e "cadastrar outro aparelho", cada um como formulário
POST com o campo `csrf` escondido.

### 10.14 A consequência do `rpId` preso ao `workers.dev`

`workers.dev` está na seção de domínios privados da Public Suffix List `[C]`. Consequências:

1. `rpId = "workers.dev"` é **rejeitado pelo navegador** — é um eTLD.
2. `rpId` = **host completo**, nunca `<conta>.workers.dev`: usar a conta faria qualquer outro Worker
   seu compartilhar as passkeys do painel `[C]`.
3. `PANEL_RP_ID` é var explícita, **sem fallback para `url.hostname`**: o `Host` é controlado pelo
   cliente, uma URL de preview geraria credencial que não funciona em produção, e credencial criada
   com `rpId` errado é **irrecuperável**. Vazia → `503`, nunca adivinha.
4. **Trocar de endereço é re-registro, não migração.** Related Origin Requests não resolve: estende
   as origens aceitas, mas o `rpId` continua fixo e o arquivo `/.well-known/webauthn` teria de ser
   servido no domínio do `rpId` `[C]`.
5. O desenho absorve isso porque `rp_id` está gravado em cada linha: credenciais de outro `rp_id` são
   ignoradas no login, listadas como "endereço antigo", não contam para a regra da última, e as
   sessões morrem sozinhas. O caminho de volta é o convite `pre=q` ou um código de recuperação.
6. A tela de registro **precisa** dizer isso em português claro, antes do primeiro cadastro, junto
   com "chave de segurança sem PIN não entra".

---

## 11. Camada HTTP

### 11.1 Onde o painel entra no roteamento

O painel entra pelo **`default:` do switch** de `src/index.ts:61` `[C]` — nunca por um `startsWith`
avaliado antes dele:

```ts
      default: {
        const doPainel = await routePainel(request, env, url, now)
        return doPainel ?? new Response('Not Found', { status: 404 })
      }
```

```ts
// src/routes/painel/router.ts
export async function routePainel(request, env, url, now): Promise<Response | null> {
  if (url.pathname !== '/painel' && !url.pathname.startsWith('/painel/')) return null
  // A parada de emergencia e a ultima rota que precisa funcionar: ela NAO passa
  // pelo portao de sanidade, porque nao depende de rpId, de sessao nem de WebAuthn.
  if (url.pathname === '/painel/parada' || url.pathname === '/painel/parar')
    return despachar(request, env, now, ROTA_PARADA, handleParada)
  const sanidade = painelHabilitado(env)                        // §10.2, typeof-safe
  if (!sanidade.ok) return painelDesativado()                   // 503, falha segura
  switch (url.pathname) {
    case '/painel':        return despachar(request, env, now, ROTA_INICIO, handleInicio)
    // ... uma linha por rota, ~21 no total
    default:               return erro(404, 'rota_desconhecida')
  }
}
```

**Por quê:** com o painel no `default:`, **nenhum caminho do painel pode ser avaliado antes de
`case WEBHOOK_PATH`**. Um erro de digitação futuro numa rota do painel deixa de ser uma falha de
segurança capaz de engolir o webhook — cuja assinatura é calculada sobre o corpo cru e não sobrevive
a qualquer código que leia o corpo antes `[C]`. Ordem léxica vira garantia estrutural. O 404 atual
`[C]` é preservado por construção. `/painelzinho` não casa; `/painel` sem barra casa. `src/index.ts`
cresce seis linhas e não ganha nenhum import do painel além do roteador.

`routePainel` lê uma **tabela declarativa** `src/routes/painel/rotas.ts` com
`{caminho, metodos, sessao, csrf, stepUp}`, para que os metatestes leiam o conjunto de rotas de um
lugar só e "exige sessão / exige CSRF / exige step-up" seja **dado**, não `if` espalhado.
`despachar` centraliza, nesta ordem: método (`405` com `Allow`), origem, corpo, limitador, sessão,
CSRF, step-up. `HEAD` é tratado como `GET`; `OPTIONS` cai em `405` de propósito.

**Por que a parada é desviada antes do portão, e não depois.** O portão de §10.2 exige `PANEL_RP_ID`,
que é um dado do **subsistema WebAuthn**. Se ele estiver faltando ou quebrado, um roteador que
aplicasse o portão a tudo derrubaria com `503` justamente o freio que §10.12 chama de "a última que
precisa funcionar" — e a linha `env.PANEL_RP_ID.length`, escrita sem `typeof`, ainda lançaria
`TypeError` dentro do `default:` do switch de `src/index.ts`, porque um binding não cadastrado chega
como `undefined` em Workers. As duas coisas se resolvem com o mesmo desvio: `/painel/parada` e
`/painel/parar` saem antes, e todo o resto passa por `painelHabilitado(env)`, que já é `typeof`-safe.
`POST /painel/parada` continua exigindo apenas `PANEL_SESSION_KEY` (raiz de `k_codigos`); sem ela não
há como comparar código nenhum, e aí sim ela devolve o `503`. **Teste obrigatório (STOP):** com
`PANEL_RP_ID` ausente, `GET /painel` responde `503` e `POST /painel/parada` com código correto
**continua desligando a automação**.

### 11.2 Assets: três arquivos, e nada mais

`"assets": { "directory": "./public", "not_found_handling": "none" }` — **sem `binding`** e **sem
`run_worker_first`**: com `run_worker_first` as rotas casadas sempre invocam o Worker e passam a
devolver 429 quando a cota estoura `[C]`, que é exatamente o que não queremos para o arquivo da
parada de emergência.

| Caminho servido | Arquivo | Cache-Control |
|---|---|---|
| `/painel/painel.css` | `public/painel/painel.css` | `no-cache` |
| `/painel/painel.js` | `public/painel/painel.js` | `no-cache` |
| `/painel/parar` | `public/painel/parar/index.html` | `no-cache` |

`no-cache` (revalidar sempre) em vez de `max-age` longo: revalidação de asset também é gratuita, e
elimina a classe de bug "JS velho no cache depois do deploy".

Duas armadilhas que viram regra de projeto: **`not_found_handling` NUNCA pode ser
`single-page-application`** (nesse modo qualquer caminho não encontrado devolve `index.html` —
inclusive `/webhooks/instagram`); e **nenhum arquivo de `public/` pode ter o caminho de uma rota do
Worker** (o sequestro seria silencioso). O `verificar-antes-de-publicar` lista `public/` e falha se
aparecer um quarto arquivo ou se algum caminho colidir com `rotas.ts`.

### 11.3 Escada de verificação, do mais barato ao mais caro

| # | Verificação | Custo | Falha |
|---|---|---|---|
| 0 | `painelHabilitado(env)` — **exceto** `/painel/parada` e `/painel/parar`, desviadas antes (§11.1) | 0 | `503 painel_desativado` |
| 1 | método exato; `OPTIONS` → `405` com `Allow` | 0 | `405 metodo_nao_permitido` |
| 2 | `Origin` / `Sec-Fetch-Site` | 0 | `403 origem_invalida` |
| 3 | `content-type` por família | 0 | `415 tipo_nao_suportado` |
| 4 | teto do corpo: **8 KB** em `/painel/api/*`, **32 KB** em formulário, **1 KB** em `/painel/parada`; `content-length` conferido **e** relido na leitura | 0 | `413 corpo_grande_demais` |
| 5 | limitador de taxa (se o binding existir) | 0 D1 | `429 muitas_tentativas` + `Retry-After` |
| 6 | cookie presente **e** HMAC do envelope válido | 1 HMAC | `401` em JSON, `303` para `/painel/entrar` em página |
| 7 | ficha CSRF (todo POST autenticado) | 1 HMAC | `403 csrf_invalido` |
| 8 | step-up, quando a rota ou o conteúdo exige | 0 | `403 step_up_necessario` |
| 9 | **só agora: D1** | — | — |

**Até o passo 8, inclusive, nenhuma consulta ao D1 acontece.** Lixo em cookie, cookie forjado, corpo
enorme, origem errada — tudo recusado sem tocar no banco.

**A regra escrita pelo seu conteúdo real** (correção de uma frase errada no material de origem, que
dizia haver uma única exceção): *nenhuma rota não autenticada consulta o D1 antes de um HMAC
fechar.* **Três** rotas recebem código digitado e têm a mesma forma — `POST /painel/parada`,
`POST /painel/entrar/codigo` e `POST /painel/api/registrar/opcoes` no modo `recuperacao`. Nelas o
HMAC que fecha é o **do próprio código**, calculado com a pimenta `k_codigos` que o atacante não
tem; o formato exato é validado **antes** (0 consulta), e só então vem **1 leitura e 0 escrita**. Não
são exceções à regra: são a regra aplicada a um segredo que não é cookie.

Corpo capado em 8 KB nas cerimônias, não em 512 KB como o webhook: uma resposta WebAuthn com
attestation `none` tem ~1–2 KB `[I]`, e o teto pequeno é o que protege os 10 ms de CPU do parser
CBOR. O teto do webhook continua **intocado** `[C]`.

**O que a escada deliberadamente NÃO faz**, escrito aqui porque é exatamente o tipo de regra que um
contribuidor futuro reintroduz de boa fé:

- **Não atrasamos a resposta artificialmente.** Nada de `sleep`, `setTimeout` ou backoff no servidor
  para "punir" tentativa errada. Um atraso no Worker consome tempo de execução e prende uma das **6**
  conexões simultâneas `[C]`; ele não desacelera um atacante distribuído e **vira ferramenta de DoS a
  favor dele**, contra as 100.000 requisições/dia que §5.3 já aponta como o maior risco residual do
  projeto. O que fazemos contra timing é outra coisa, e está em §11.4: verificar a assinatura mesmo
  quando a credencial não existe, para não criar diferença **grosseira** de tempo. Uma coisa é
  igualar o custo; a outra é comprá-lo de propósito.
- **Não bloqueamos conta após N falhas.** Numa rota não autenticada, isso é um botão de DoS contra o
  dono, e não há espaço de senha a exaurir: o segredo do login é uma chave privada em hardware.
- **Não gravamos tentativas.** O único contador persistido em todo o desenho é
  `painel_sessoes.falhas_stepup`, alcançável só por quem já tem sessão válida (§10.10).

### 11.4 Tabela canônica de códigos de erro

Esta tabela é a **única**. As grafias `stepup_necessario`, `stepup_invalido`, `link_nao_permitido`,
`meta_indisponivel`, `d1_indisponivel`, `erro_interno`, `sessao_invalida`, `desafio_expirado`,
`midia_inexistente` e `payload_muito_grande` estão **deletadas do projeto**.

| Status | `erro` | Quando | Mensagem ao usuário |
|---|---|---|---|
| 400 | `corpo_invalido` | JSON ou formulário malformado, `content-length` mentiroso | "Não foi possível ler os dados enviados." |
| 400 | `dados_invalidos` | Validação de campo falhou. Acompanha `campos: string[]` com **nomes**, nunca valores. **Nada é gravado, nem parcialmente** | "Confira os campos destacados." |
| 401 | `sessao_ausente` | Cookie ausente, expirado, ocioso demais ou de sessão apagada | "Sua sessão expirou. Entre de novo." |
| 401 | `credencial_invalida` | **Código único** para: credencial desconhecida, assinatura inválida, **desafio expirado**, origem errada, `rpIdHash` errado, `type` errado, flag UP ou UV ausente, convite inválido, convite já usado, código de recuperação errado | "Não foi possível confirmar. Tente de novo." |
| 403 | `origem_invalida` | `Origin`/`Sec-Fetch-Site` fora do esperado, ou os dois ausentes | "Requisição bloqueada por segurança." |
| 403 | `csrf_invalido` | Ficha de formulário ausente ou divergente | "Requisição bloqueada por segurança." |
| 403 | `step_up_necessario` | A operação exige step-up e a assertion não veio, expirou **ou o `op_hash` não bate** | "Confirme com sua passkey para continuar." |
| 403 | `dominio_nao_permitido` | Link ou texto aponta para fora da allowlist. Acompanha os domínios permitidos, que são var pública de deploy | "Este endereço não está na lista liberada no deploy." |
| 403 | `codigo_incorreto` | **Só** `POST /painel/parada` | "Esse código não confere. Confira e digite de novo." |
| 404 | `rota_desconhecida` | Caminho `/painel/**` inexistente | "Página não encontrada." |
| 405 | `metodo_nao_permitido` | Método errado. Cabeçalho `Allow` presente | "Método não permitido." |
| 409 | `conta_nao_conectada` | Nenhum token no D1 `[C]` | "Conecte o Instagram pelo assistente antes." |
| 409 | `versao_desatualizada` | Trava otimista: a configuração mudou em outro lugar | "A configuração mudou em outro lugar; recarregue a tela." |
| 409 | `ultima_passkey` | Tentou remover a única credencial | "Cadastre outra passkey antes de remover esta." |
| 413 | `corpo_grande_demais` | Corpo acima do teto de §7.6 | "Dados grandes demais." |
| 415 | `tipo_nao_suportado` | `content-type` diferente do esperado | "Formato não suportado." |
| 429 | `muitas_tentativas` | Limitador disparou. Cabeçalho `Retry-After` | "Muitas tentativas. Aguarde um minuto." |
| 502 | `falha_meta` | Erro na Graph API (listagem de Reels, revalidação de id, busca do @) | "O Instagram não respondeu. Tente de novo." |
| 503 | `painel_desativado` | `PANEL_RP_ID` ou `PANEL_SESSION_KEY` ausentes | "O painel ainda não foi ativado neste deploy." |
| 503 | `indisponivel` | D1 indisponível ou cota estourada | "Serviço temporariamente indisponível." |
| 500 | `falha_interna` | Qualquer exceção não prevista | "Algo deu errado. Tente de novo." |

Formato: `{ "erro": "<snake_case>", "mensagem": "<frase>" }` em JSON; em HTML, a mesma `mensagem` na
tela e o mesmo `erro` no `console.warn`. **Nunca** há campo `detalhe`, `stack`, `cause` ou mensagem
de exceção. Todo `try/catch` segue o padrão de `oauth.ts:136-140` `[C]`:
`console.error('painel:', codigo, cause instanceof Error ? cause.message : cause)` e devolve
`500 falha_interna` com frase fixa.

**A linha que mais importa é a do `credencial_invalida`.** O painel não pode distinguir "passkey
desconhecida" de "assinatura inválida" `[C]`: com o código público, separar os dois casos daria um
oráculo de enumeração. Um código só, uma frase só, e — na medida do possível — o **mesmo caminho de
trabalho**: verificar a assinatura mesmo quando a credencial não existe, usando uma chave
descartável, para não criar diferença grosseira de tempo `[I: mitigação parcial]`.

### 11.5 Cabeçalhos e CSP

Dois perfis em código (`html.ts` expõe `cabecalhos(perfil)`): `'pagina'` para HTML do Worker e
`'api'` para as cinco respostas JSON. O terceiro perfil, dos três assets, vai em `public/_headers`
`[V]` — e se `_headers` não funcionar, **nada quebra**: ele cobre um CSS, um JS e uma página sem
script e sem interpolação. O plano B com `run_worker_first` está deletado do projeto.

CSP única das páginas, sem nonce, porque o CSS é arquivo externo:

```
default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';
script-src 'self'; style-src 'self';
img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net;
connect-src 'self'; font-src 'self'; object-src 'none'; media-src 'none';
require-trusted-types-for 'script'; upgrade-insecure-requests
```

CSP das respostas JSON: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox`.

| Cabeçalho | Três assets | Página do Worker | API JSON |
|---|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (**sem `preload`**) | idem | idem |
| `X-Content-Type-Options` | `nosniff` | `nosniff` | `nosniff` |
| `X-Frame-Options` | `DENY` | `DENY` | `DENY` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` | `same-origin` | — |
| `Cross-Origin-Resource-Policy` | `same-origin` | `same-origin` | `same-origin` |
| `Permissions-Policy` | ver abaixo | ver abaixo | — |
| `Cache-Control` | `no-cache` | `private, no-store` | `private, no-store` |
| `Vary` | — | `Cookie` | `Cookie` |

```
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(),
  payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)
```

Notas de projeto: `require-trusted-types-for 'script'` torna `innerHTML` um **erro de runtime**, não
de revisão; **nunca** `Cross-Origin-Embedder-Policy: require-corp`, que quebraria as miniaturas do
`fbcdn.net`; `Vary: Cookie` em **toda** resposta do Worker, sem exceção por rota — uma regra sem
exceção vale mais que uma otimização de um cabeçalho; **sem `preload`** no HSTS porque
`workers.dev` não é nosso, e pedir preload de um host dentro de um sufixo público de terceiro não é
decisão que este projeto possa tomar `[C]`. `/oauth/callback` ganha `Cache-Control: private,
no-store` e `Referrer-Policy: no-referrer`, porque a resposta atual traz o `username` da conta no
corpo `[C]`. `GET /painel/reels` merece destaque: a `thumbnail_url` é uma **URL-capacidade** — quem
tem o link vê a imagem sem login `[C]` — e essa resposta não pode entrar em Cache API nem em KV, com
chave nenhuma.

### 11.6 As duas rotas da parada, e a decisão sobre o `GET`

`/painel/parar` (asset, o formulário) e `/painel/parada` (Worker, a ação) diferem por uma letra, e a
primeira é a URL que a pessoa leiga vai digitar de um papel, no celular, no pior dia do projeto.
**Decisão:** manter as duas grafias — o custo de renomear tudo é real e `/painel/parada` nunca é
digitada por um humano, já que é só o `action` do formulário — e **eliminar o beco sem saída**:
`GET /painel/parada` responde **`303` para `/painel/parar`**, em vez de `405`. Não custa estado, não
revela nada, e transforma um erro de digitação plausível numa chegada ao lugar certo. Um POST
endereçado ao caminho do asset continua sendo impossível de acontecer no projeto, porque nenhum
formulário aponta para lá.

### 11.7 O que pode e o que não pode ser logado

| Destino | O que pode |
|---|---|
| **`console` / Workers Logs** | método, caminho **sem query string**, status, código `erro` em snake_case. **Nenhum valor, nunca** |
| **`painel_auditoria`** | ver §9.9 |

**Nunca no `console`, em hipótese nenhuma:** cookie de sessão ou seu HMAC; `sid`; desafio; assertion,
assinatura ou `clientDataJSON`; chave pública; `credential_id` cru; código de recuperação; código de
parada; token de convite; `op_hash`; `SETUP_ADMIN_TOKEN`; `PANEL_SESSION_KEY` ou qualquer subchave;
access token da Meta (nem prefixo); `TOKEN_ENCRYPTION_KEY`; endereço IP; `User-Agent`;
`thumbnail_url`/`media_url` `[C]`; `caption` de Reel; **username do Instagram**; `destinationUrl`;
`privateReplyText`; `publicReplyText`; `triggerKeywords`; qualquer corpo de requisição, inteiro ou
truncado. Os quatro campos de configuração são a única assimetria da lista: proibidos no `console`,
permitidos em `painel_auditoria`, e ela é deliberada.

Volume e formato: **log de leitura, nenhum** — só falha e mudança de estado geram linha, o mesmo
critério de hoje `[C]`. Formato `console.warn('painel:', metodo, caminho, status, codigo)`, sem
template string com dado variável dentro, para não existir o caminho em que alguém interpola um
valor por engano. `wrangler.jsonc` tem `observability.enabled: true` `[C]`, então esse `console` vai
para os Workers Logs da conta da pessoa, com retenção definida pela Cloudflare
`[V: não verificado no plano gratuito]`.

A política de privacidade precisa dizer três coisas novas, e apenas três: que a **Cloudflare**
registra metadado de requisição (IP, ray id) fora do controle deste código; que o painel guarda, **no
seu próprio banco**, o histórico das mudanças que **você** fez na sua configuração; e que, ao abrir a
tela "O que aconteceu", o painel **pergunta ao Instagram** o @ de quem comentou naqueles comentários
e **não guarda** essa informação.

### 11.8 Separação entre painel, webhook e OAuth — sete regras verificáveis

1. **Ordem no switch.** `case WEBHOOK_PATH` antes de tudo; o painel só existe no `default:`.
2. **Proibido middleware global.** Não pode existir `withSecurityHeaders(handler)` embrulhando o
   `fetch`. Os cabeçalhos são aplicados **de dentro** dos helpers de cada família de rota. É mais
   repetitivo e é proposital: não existe ponto único onde um erro afete o webhook.
3. **Proibido helper compartilhado de leitura de corpo.** O painel usa seus leitores com teto; o
   webhook mantém `request.text()` seguido de verificação de assinatura, na ordem tamanho →
   assinatura → parse `[C]`. Um helper único consumiria o stream e é exatamente o tipo de "melhoria"
   que quebra o HMAC sem quebrar teste nenhum.
4. **Limitador de taxa nunca no webhook.** Aplicar limite lá faria a Meta receber 429, desistir da
   reentrega e perder comentários em silêncio `[C]`.
5. **Assets não podem alcançar o webhook:** `not_found_handling: "none"` e `public/` com exatamente
   três arquivos.
6. **O painel nunca escreve em `processed_comments`, e o webhook nunca lê cookie.** A separação que
   importa é a do caminho de **escrita**. A leitura pelo painel é permitida **somente** na forma
   descrita em §12.6, e **nenhuma** consulta do painel pode retornar `commenter_scoped_id_hash`.
7. **O painel não inicia OAuth.** Não existe rota de reconexão no painel. Se ele pudesse disparar o
   fluxo, um painel comprometido conectaria a conta do **atacante**, e o `state` assinado — a única
   proteção do `/oauth/callback`, que não pode exigir cabeçalho porque quem chega é o navegador
   `[C]` — passaria a ser emitido a pedido de uma sessão. O painel **mostra** o estado da conexão e
   instrui a usar o assistente.

`/setup/authorize`, `/setup/subscribe` e `/oauth/callback` **ficam**, sem depreciação e sem mudança
de contrato: o primeiro OAuth acontece antes de existir passkey, o assistente chama essas rotas por
caminho e método fixos `[C]`, e os caminhos estão espalhados por toda a documentação. `/setup/authorize`
passa apenas a recusar outros métodos com `405 + Allow: GET` (hoje o switch não checa método `[C]`).

### 11.9 O único campo novo em `/health`

**Não existe `GET /painel/diagnostico`**: uma rota de diagnóstico é mais uma superfície não
autenticada, e o valor dela cabe num enum. `GET /health` mantém o corpo de hoje `[C]` e ganha
**exatamente um** campo novo, `painel`, **na raiz do objeto** — irmão de `status` e `webhook`, nunca
dentro de `configurado` (`health.ts:13-21` `[C]`). É esse caminho, `corpo.painel`, que o teste
"nenhum outro campo apareceu" percorre.

**O fato que decide a forma deste campo: `/health` é público.** Não tem `isAdmin`, não tem Bearer, e
o cabeçalho do arquivo diz "Health check publico" `[C]`. Qualquer anônimo pode consultá-la em laço
barato. Por isso o campo tem **duas resoluções da mesma pergunta**, e a diferença é a autorização:

| Quem pergunta | Valores possíveis |
|---|---|
| **qualquer um** (sem `Authorization`) | `desativado` \| `sem_acesso` \| `pronto` — os três do contrato §4.5 |
| **`Authorization: Bearer <SETUP_ADMIN_TOKEN>`** | os seis, com precedência declarada abaixo |

| `painel` (detalhado) | Significa | O que o assistente diz | Some no público em |
|---|---|---|---|
| `desativado` | `PANEL_RP_ID` vazio ou `PANEL_SESSION_KEY` ausente: o painel responde 503 | "O painel ainda não está ligado. Falta cadastrar os segredos." | `desativado` |
| `sem_passkey` | ligado, mas nenhuma credencial utilizável para o `rp_id` atual | "O painel está ligado mas ninguém consegue entrar. Gere um convite agora." | `sem_acesso` |
| `sem_codigo_parada` | há passkey, mas nenhum código de parada gravado | "Você ainda não tem botão de pânico. Gere os códigos." | `sem_acesso` |
| `pronto_arquivo` | tudo cadastrado, e a configuração vem do `src/config.ts` | "Tudo certo. A configuração ainda vem do arquivo." | `pronto` |
| `pronto_banco` | tudo cadastrado, e a configuração vem do painel | "Tudo certo. **A configuração vive no painel** — editar o arquivo aqui não muda nada." | `pronto` |
| `pronto_parado` | tudo cadastrado, e a configuração está em `parado_por_erro` | "A automação está parada por um campo inválido. Abra o painel para ver qual." | `pronto` |

**Por que `sem_passkey` não pode ser público.** Segundo §10.4, o convite comum (`pre=0`) funciona
**exatamente enquanto não existe nenhuma credencial** — e some no instante em que a primeira passkey
nasce. Publicar `sem_passkey` numa rota anônima entrega, por polling de graça, o instante preciso em
que um convite interceptado ou fotografado num tutorial ainda vale. O valor mesclado `sem_acesso` do
contrato não separava os dois estados, e essa fusão **era** a proteção. `sem_codigo_parada` acompanha
pelo mesmo motivo: junto com `sem_passkey` ele descreve o grau de desamparo do painel para quem não
tem nada. Os três `pronto_*` também só saem sob Bearer — não por ameaça, mas porque um enum que muda
de tamanho conforme quem pergunta é mais fácil de testar do que um que muda de conteúdo.

O assistente local **já tem** o `SETUP_ADMIN_TOKEN` (é ele quem o cadastra no deploy), então manda o
Bearer e continua recebendo os seis valores. É isso que preserva a capacidade de **bloquear** a
edição de `src/config.ts` quando a configuração já vive no banco (§9.11): com três valores ele só
conseguiria avisar, porque "existe passkey" não implica "existe linha de config".

Nenhum dos seis identifica ninguém nem revela o valor de campo algum. **Nenhum outro campo novo entra
nessa rota**, e há um teste que afirma as três metades: sem Bearer o campo existe em `corpo.painel`
com um dos **três** valores públicos; com Bearer válido, com um dos **seis**; e em ambos os casos
nenhum outro campo apareceu.

---

## 12. A tela: telas, fluxos e textos

O desenho visual e o conteúdo de cada tela estão em §3, que é normativo. Esta seção cobre o que §3
não cobre: as regras que governam a escrita, a mecânica dos fluxos, o catálogo de erros, os quatro
estados especiais da tela de Reels, a tela de atividade e as exigências de celular.

### 12.1 As seis regras que governam toda a tela

1. **Vocabulário de dona de negócio.** A tela nunca escreve *override*, *config*, *endpoint*,
   *media ID*, *placeholder*, *token*, *hash*, *step-up*, *rate limit*, *fallback* — nem *payload*.
   Glossário obrigatório em §12.7.
2. **Apertar o freio é grátis; soltar o freio custa a biometria.**
3. **Nada some em silêncio.** Se a automação está ligada mas nada vai ser enviado, a tela diz isso
   em letras grandes na primeira dobra.
4. **O que a tela mostra é o que o Worker vai fazer.** A prévia usa `renderTemplate` `[C]` e a caixa
   de teste usa `matchKeyword` `[C]`, ambas de produção. Não existe segunda implementação em
   JavaScript — e não existe API JSON de dados que pudesse abrigar uma.
5. **Custa cota, então não faz sozinho.** Sem auto-refresh, sem polling, sem buscar lista a cada
   render. Atualizar é sempre um botão explícito.
6. **Erro nunca alarga, e erro nunca inventa um valor que o dono não viu na tela.**

Navegação no celular: barra fixa embaixo com cinco itens, ícone **e** palavra (nunca só ícone):
Início · Reels · Palavras · Mensagem · Mais. "Mais" abre O que aconteceu · Aparelhos · Ajustes finos
· Sair. A **barra do topo é a mesma em todas as telas** e carrega o estado global mais o botão de
desligar — é o único elemento repetido do painel, e a repetição é proposital: a pessoa nunca precisa
procurar como parar.

### 12.2 Fluxos

**Primeiro acesso**, uma vez na vida da instalação: no computador, `node scripts/configurar.mjs` →
"Cadastrar meu acesso ao painel" → `POST /setup/painel/codigos` (Bearer) → o Worker sorteia e
devolve **uma vez** 6 códigos de recuperação + 1 de parada, que o assistente imprime na tela e manda
anotar (nunca grava em arquivo) → o assistente imprime o link com o convite depois do `#`, validade
20 min → no celular, abrir o link → `/painel/convite` → "Cadastrar este aparelho" → digital →
**entrar com a digital** → Início.

**Dia a dia:** abrir `/painel` → a digital → Início. Sem senha, sem e-mail, sem código digitado.

**Perdeu o celular:** `/painel/entrar/codigo` → código de recuperação → tela "crie a passkey nova" →
digital → **entrar com ela** → Início, com aviso bloqueante para gerar códigos novos.

**Deu ruim e não dá para entrar:** `/painel/parar` → código de parada → `POST /painel/parada` → uma
das três respostas de §10.12.

**Salvar qualquer coisa:** formulário POST → `303` → `GET /painel/<tela>?ok=<codigo>`, e a faixa
verde nasce do `?ok=`. Quando a mudança é protegida, entra a tela intermediária **"Confira o que vai
mudar"**, que mostra o antes e o depois lado a lado, em português, e é onde a digital é pedida. Ela
existe por dois motivos: para a pessoa, é a última chance de ler o que vai assinar; para a
arquitetura, é onde o rascunho vive **sem ser gravado** — em campos escondidos, em texto comum, sem
assinatura própria, porque o `op_hash` dentro do cookie já cobre o conteúdo inteiro e o servidor o
recalcula do corpo recebido. Mexer num campo escondido muda o hash e a gravação é recusada.
**Cancelar não grava nada**, e o rascunho continua na tela.

Duas gravações protegidas seguidas pedem duas digitais, e o texto da segunda diz isso sem pedir
desculpa: *"Cada mudança protegida é confirmada uma vez. É por isso que é seguro."*

### 12.3 Sinalização do que é perigoso

Três sinais **sempre juntos**, nunca só cor: cadeado + a palavra "protegido" ao lado do rótulo;
borda âmbar no grupo de campos; e a frase escrita antes do botão. E o botão diz o que vai acontecer:
**"Salvar (vai pedir a sua digital)"**. Nas telas em que só *parte* dos campos é protegida, o rótulo
é "Salvar" e quem garante o aviso é o cadeado no campo mais a tela de conferência — nunca uma
surpresa biométrica.

Regra escrita no rodapé dos Ajustes: *"Diminuir o alcance da automação nunca pede a sua digital.
Aumentar, sim."*

### 12.4 Limites e avisos das palavras-gatilho

Como não existe conserto de campo inválido, o que está fora do limite é **recusa** — nunca
"continuar assim mesmo", nunca substituição por valor de fábrica.

| Situação | Nível | Texto |
|---|---|---|
| Menos de 4 caracteres normalizados no modo "basta aparecer" | **Recusa** | **"quer" é curto demais para esse modo.** Qualquer comentário com essas letras aciona — inclusive "não quer" e "quer não". Escreva pelo menos duas palavras. [ Usar "eu quero o link" ] [ Trocar para "o comentário tem que ser só isso" ] |
| Menos de 2 caracteres normalizados | **Recusa** | **Esta palavra é curta demais.** Escreva pelo menos duas letras. |
| 2 a 3 caracteres no modo "só isso" | Aviso | **"eu" é bem curto.** Neste modo funciona. Só tome cuidado se um dia trocar de modo. |
| Mais de 40 caracteres | **Recusa** | **Esta frase é longa demais.** Use no máximo 40 letras. |
| Mais de 20 palavras | **Recusa** | **Você chegou a 20 palavras, o máximo.** Apague uma para adicionar outra. |
| Palavra que é pedaço de outra | Aviso | **"quero" está dentro de "eu quero".** No modo "basta aparecer no meio", a segunda nunca vai ser usada. |
| Só emoji ou pontuação | **Recusa** | **Isto não vai funcionar nunca.** A automação ignora emojis e pontuação ao comparar, então esta palavra fica vazia e é pulada em silêncio `[C]`. |
| Lista vazia com automação ligada | **Recusa** | **Sem nenhuma palavra a automação nunca responde.** Ou escreva pelo menos uma, ou desligue — as duas são seguras, mas só uma fica clara no seu painel. [ Desligar a automação ] |

Avisos da tela da mensagem: falta `{link}` ("do jeito que está, a pessoa vai receber só o texto");
apelido desconhecido como `{nome}` ("o painel só conhece {username} e {link}; esse trecho vai chegar
escrito assim mesmo" `[C]`); link ainda de fábrica entre colchetes ("enquanto estiver assim, a
automação não envia nada — de propósito" `[C]`); mensagem longa ("480 de 500 caracteres; Direct
longo costuma ser ignorado"). Contador ao vivo a partir de 400 caracteres.

### 12.5 Os quatro estados especiais da tela de Reels

| Situação | O que a tela mostra |
|---|---|
| Conta sem Reels | "Não encontramos nenhum Reel nesta conta. A automação só responde em Reels. Se você acabou de publicar, espere alguns minutos e toque em Atualizar." |
| Instagram não respondeu | "Não conseguimos falar com o Instagram agora. **A sua automação continua funcionando normalmente** com os Reels que você já tinha escolhido." + a lista salva é exibida a partir de `painel_midias`, marcada como "salvo por você", e o botão de salvar fica desabilitado |
| Linha de mídia inválida no banco | Cartão **desligado** com faixa âmbar: "Este Reel está parado por um problema na configuração dele: `intervalo por pessoa`. Abra 'Este Reel responde diferente' e corrija." |
| Linhas de mídia órfãs | Faixa âmbar: "Encontramos escolhas de Reels sem uma configuração salva. Elas estão sendo ignoradas até você salvar seus ajustes uma vez." |
| Cursor vencido | "A lista ficou velha enquanto esta página estava aberta. Toque em Atualizar. O que você já marcou está guardado nesta tela." |

Mecânica da paginação: uma página = **uma** chamada a `me/media` = 1 subrequest `[C]`, com
`limit=25` e o filtro de Reels feito **no Worker** `[C]` — não há filtro server-side por REELS
`[I]`. Um toque em "Carregar mais" busca **no máximo 4 páginas**, parando antes se já tiver juntado
10 Reels ou se `paging.next` sumir. **Some quando `paging.next` some** `[C]`: receber menos itens que
o `limit` não significa fim. É um `<form method="post">` normal que reenvia o cursor `after` num
campo escondido e re-renderiza a página inteira no servidor, com os ids já marcados preservados em
campos escondidos — funciona sem JavaScript. **O cursor nunca vai para o D1** `[C]`: cursores são
temporários, e guardá-los é bug futuro. Quando as 4 páginas rendem menos de 3 Reels, a tela explica
em vez de parecer quebrada: *"Estas últimas publicações não são Reels — toque de novo para continuar
procurando."*

Cache da listagem: **10 minutos** `[I]`, com a tela dizendo de quando ela é ("Lista de 14:32.
[Atualizar]"). Esse cache é da **listagem**; o cache da **configuração** é outro e tem os tempos de
§9.6. `thumbnail_url` e `media_url` **nunca** vão para o D1 `[C]`.

Selo "⚙ Regras próprias" só aparece quando aquela linha de `painel_midias` tem alguma coluna de
sobreposição preenchida. Se a pessoa abre "responder diferente" num Reel **não marcado**, aparece em
âmbar: *"Estas regras não vão valer ainda. Este Reel não está na sua lista de Reels escolhidos.
[Incluir este Reel na lista]"*.

Ao salvar: teto de **200** Reels no total (com aviso a partir de 197) e **20 ids novos por
gravação**, cada id novo revalidado contra a conta com `getMediaInfo` `[C]`. Acima disso é recusa,
com o formulário voltando preenchido e o texto *"Marque até 20 Reels novos por vez. Salve estes e
continue — o que já estava escolhido continua valendo."*

### 12.6 "O que aconteceu": o @ ao vivo — decisão do dono, especificada

A tela mostra os três estados grandes, as pendências com botão, e a lista dos últimos comentários
processados com o **@ buscado ao vivo na Graph API**, sem armazenar nada de novo.

**Consulta ao banco**, uma só, com colunas nomeadas e sem `SELECT *`:

```sql
SELECT comment_id, media_id, status, created_at, next_retry_at, last_error_code
  FROM processed_comments
 WHERE created_at < ?          -- cursor da pagina; na primeira pagina, um valor no futuro
 ORDER BY created_at DESC
 LIMIT 20;
```

Ela **nunca** retorna `commenter_scoped_id_hash`. Sem índice por `created_at`, a consulta varre a
tabela — para uma conta pequena são centenas de linhas por abertura, irrelevante contra 5.000.000 de
linhas lidas por dia `[C]`. **Não criar índice**: um índice novo em `processed_comments` encareceria
**cada INSERT do caminho quente**, levando o claim de ~3 para ~4 escritas `[C]`. Se um dia doer, a
saída correta é uma tabela de contadores diários escrita pelo cron, não um índice.

**A busca do @:** para cada linha exibida,
`GET https://graph.instagram.com/{META_API_VERSION}/{comment_id}?fields=username,timestamp` com o
Bearer da conta. Host obrigatoriamente `graph.instagram.com` — `assertGraphHost` quebra qualquer
tentativa de usar `graph.facebook.com` `[C]`.

**Orçamento de subrequests, e o comportamento diante do teto de 50.** Cada consulta ao D1 **também**
conta como subrequest `[C]`. A abertura da tela gasta: 1 (sessão) + 2 (configuração e mídias) + 1
(token da conta) + 1 (a consulta acima) = **5 consultas ao D1**, mais **1 chamada à Meta por linha**.
Com o teto de projeto de **20 linhas por página**, o total é **25 subrequests**, metade do limite. O
teto duro seria ~44 linhas; as 20 existem para deixar folga e para respeitar a cota da Meta. O
handler **calcula o orçamento antes de disparar**: `disponivel = 50 - consultasJaFeitas - 4` (margem
de segurança), e se o número de linhas exceder o disponível, ele busca o @ só das primeiras e as
demais aparecem com "@ indisponível". As chamadas são emitidas em **blocos de 6 em paralelo**, por
causa do limite de 6 conexões simultâneas `[C]`; sequencial, a ~300–800 ms por chamada `[I]`, a tela
levaria mais de 10 segundos. "Ver mais" é **outra invocação**, com outros 20 subrequests e o cursor
`created_at` da última linha viajando em campo escondido de um POST.

**Cota da Meta.** O painel disputa a mesma cota de 24 h que a automação usa para responder
(`4800 × impressões` `[C]`). 20 chamadas por abertura, 20 aberturas num dia, são 400 chamadas
subtraídas do orçamento de envio. Por isso: **sem auto-refresh, sem polling**, botão "Atualizar"
explícito, e o teto por tela.

**Comentário apagado.** O nó responde erro (tipicamente 404 / objeto inexistente). A linha
**continua aparecendo**, com *"@ indisponível — o comentário foi apagado"* no lugar do arroba, e o
resultado traduzido intacto. Nunca sumir com a linha. O mesmo texto cobre perfil apagado e conta que
bloqueou. Consequência honesta, escrita na própria tela: **quanto mais antiga a linha, maior a
chance de aparecer "indisponível"** — a lista envelhece para "sem nome" sozinha.

**Falha geral da Graph API** não pode quebrar a tela: ela degrada para a mesma lista **sem os @**,
com a faixa *"não conseguimos falar com o Instagram agora"* e o resultado de cada linha intacto.

**Armazenamento novo: nenhum.** O username **não** é gravado no D1, **não** entra em Cache API,
**não** entra em cache de isolate e **não** vai para o `console` nem para `painel_auditoria` — ele
vive apenas durante a renderização daquela resposta. É isso que torna a promessa literal e testável.
O cabeçalho de `src/index.ts` continua verdadeiro sem ressalva; a política de privacidade ganha a
frase de §11.7. A resposta vai com `Cache-Control: private, no-store` e `Vary: Cookie`. O username
atravessa o HTML e é escapado **automaticamente** pela tag `` html`` ``.

`[V] Pré-requisito que pode matar esta saída:` não está confirmado que um token de Instagram Login
com `instagram_business_basic` lê um **nó de comentário por id** e devolve `username`. O escopo
cobre leitura de comentários `[C]`, mas não esse acesso específico. **Testar em conta real antes de
prometer na documentação.** Se falhar, não há escopo de Instagram Login que resolva: a tela degrada
permanentemente para a versão sem @ — os três estados, as pendências e a lista com horário e
resultado, sem o arroba — e o documento registra a queda.

**O enum que governa é `CommentStatus`, e ele não é o mesmo dos motivos de ignorar.** A tela lê
`processed_comments.status`; esse valor vem de `CommentStatus`, declarado em
`src/repositories/comments-repository.ts:11-20` `[C]`. `SkipReason` e `ProcessOutcome`
(`automation.ts:28,40` `[C]`) são resultados **em memória** do processamento — dois enums de arquivos
diferentes, que o material de origem misturava numa citação só. É o de `comments-repository.ts` que o
dicionário obrigatório percorre, e é ele que o teste "valor novo sem tradução quebra" enumera.

**Dicionário de tradução**, obrigatório e completo, dos oito valores de `CommentStatus` `[C]`:

| `status` no banco | Na tela |
|---|---|
| `completed` | ✓ Direct enviado e comentário respondido |
| `private_sent` | ⏳ Direct enviado. A resposta no comentário ainda não saiu |
| `uncertain` | ▲ Direct enviado, mas não conseguimos confirmar a resposta pública. A pessoa recebeu o link |
| `retry_pending` | ⏳ Não deu na primeira. Vamos tentar de novo às 14:35 |
| `failed` | ✕ Não conseguimos enviar. + explicação do motivo |
| `processing` | ⏳ Estamos enviando agora |
| `received` | ⏳ Recebemos e vamos processar |
| `ignored` | – Não era um caso de responder |

**A verdade sobre esta tela, e ela precisa estar escrita: hoje só cinco desses valores existem no
banco.** Conferido no código: o **único** `INSERT` em `processed_comments` é
`CommentsRepository.claimComment` (`comments-repository.ts:45-62` `[C]`), e ele grava
`status = 'processing'`; em `processComment` (`automation.ts:141-177` `[C]`) **todos** os
`return { kind: 'skipped', ... }` acontecem **antes** do `claimComment`, então **um comentário
ignorado não deixa linha nenhuma**. `'received'` e `'ignored'` estão declarados no tipo e **não são
escritos em lugar nenhum de `src/`** `[C]`. Logo, a lista mostra `completed`, `private_sent`,
`retry_pending`, `failed` e `uncertain` — e nada mais.

**A decisão, tomada aqui: não passamos a gravar linha para comentário ignorado.** O caminho quente já
está em ~3 escritas por comentário atendido e o teto de 100.000 escritas/dia é o recurso que §5.2 e
§16.1 protegem; gravar uma linha por comentário **ignorado** faria o custo de banco crescer com o
volume de comentários que a automação **não** responde — exatamente o volume que não temos como
prever. Um Reel que viraliza com 5.000 comentários fora da regra passaria a custar 5.000 escritas por
nada. Se um dia esse histórico for desejado, ele é decisão nova, com conta própria, e a saída correta
provavelmente é a tabela de contadores diários escrita pelo cron que já aparece nesta seção.

**A consequência vai escrita na própria tela**, acima da lista, e §3 diz o mesmo na linguagem do
dono: *"Aqui aparecem os comentários que a automação **atendeu**. Comentários que ela ignorou — por
não serem de um Reel da sua lista, por não terem nenhuma das suas palavras, ou porque a pessoa já
tinha recebido — não deixam registro, e por isso não aparecem aqui."*

**As oito frases continuam obrigatórias mesmo assim.** As três hoje inalcançáveis (`processing`,
`received`, `ignored`) existem porque `processing` **é** o valor que o claim grava e pode ser lido
numa corrida real, e porque um valor de enum sem frase é o bug que a tela mostraria como texto cru. O
teste percorre o tipo `CommentStatus` inteiro e exige frase para cada membro; um valor novo no enum
quebra. O que o teste **não** afirma — e não pode afirmar, sob pena de virar promessa falsa — é que
todo valor traduzido aparece em produção.

**Os motivos de ignorar (`SkipReason`) não entram no dicionário da tela**, porque nenhum deles chega
ao banco. Eles continuam sendo o vocabulário de `console` e das métricas do Worker, e o dia em que a
decisão acima mudar é o dia em que eles ganham linhas aqui.

Os três estados grandes têm duas variações de cinza que precisam de texto próprio: **parada por erro
na configuração** (*"A automação está parada por segurança: o campo **intervalo por pessoa** está com
um valor que não dá para entender. Corrija esse campo e ela volta."* — a tela **nomeia o campo** e
não inventa substituto) e **parada pelo código de emergência** (*"A automação foi desligada pelo
código de parada em 03/09 às 14:42."*, vindo de `parado_por_codigo_em`). E o estado "ainda com os
ajustes de fábrica" (*"Seus ajustes ainda são os que vieram no programa. Salve uma vez para o painel
passar a mandar."*), que não é erro.

### 12.7 Catálogo de erros na tela, e o glossário

Seis regras da mensagem de erro: diga **o que aconteceu** sem código nem número; diga **se alguma
coisa quebrou** (quase sempre a resposta é "a automação continua funcionando"); diga **o que fazer
agora** e coloque um botão que faça isso; nunca culpe a pessoa; **nunca perca o que ela escreveu**
(erro re-renderiza o formulário preenchido); e detalhe técnico vai para o `console`, nunca para a
tela `[C]`.

| Situação | Código no log (§11.4) | O que a tela escreve |
|---|---|---|
| Login falhou | `credencial_invalida` | **Não deu para entrar com este aparelho.** Tente de novo. Se continuar assim, entre com um código de recuperação e cadastre este aparelho outra vez. [ Usar um código ] |
| Demorou e a confirmação venceu | `credencial_invalida` | **Demorou um pouquinho e a confirmação venceu.** É só tentar de novo. |
| Cancelou a digital | — (só no navegador) | **Você cancelou a leitura da digital.** Nada foi salvo: o link continua exatamente como estava. |
| Muitas tentativas | `muitas_tentativas` | **Muitas tentativas seguidas.** Espere um minuto. Sua automação **não** foi afetada. |
| Origem estranha no formulário | `origem_invalida` | **Este formulário não veio do painel.** Abra o painel de novo e refaça a mudança. |
| Formulário grande demais | `corpo_grande_demais` | **Isto ficou grande demais para enviar de uma vez.** Encurte o texto ou salve os Reels em duas vezes. |
| Campo inválido ao salvar | `dados_invalidos` | **Não dá para salvar assim:** o campo **intervalo por pessoa** precisa ser um número de 0 a 8760. Nada foi alterado — corrija e salve de novo. |
| A configuração mudou em outro lugar | `versao_desatualizada` | **Alguém (ou você, em outra aba) mudou os ajustes.** Recarregue a tela — o que você escreveu continua aqui. |
| Instagram não respondeu | `falha_meta` | **Não conseguimos falar com o Instagram agora.** Sua automação continua funcionando com o que já está salvo. [ Tentar de novo ] |
| Miniaturas venceram | — | **As miniaturas venceram** — é normal, elas duram pouco. Sua escolha de Reels continua salva. |
| Link fora da lista | `dominio_nao_permitido` | **Este endereço não está liberado.** Só é possível usar links de `noxelora.com.br`. Essa trava é proposital: ela impede que um invasor aponte o seu link para um site de golpe. |
| URL dentro do texto do Direct | `dominio_nao_permitido` | **Tem um endereço escrito dentro da mensagem:** `bit.ly/xyz`. Endereços só entram pelo campo do link. [ Trocar por {link} ] |
| Faltou a digital numa mudança protegida | `step_up_necessario` | **Esta mudança precisa da sua digital.** Confira o que vai mudar e confirme. |
| A digital não conferiu com a mudança | `step_up_necessario` | **A confirmação não bate com o que está na tela.** Nada foi salvo. Abra a tela de novo e refaça a mudança. |
| Sessão venceu no meio | `sessao_ausente` | **Você ficou um tempo parada e precisamos confirmar quem você é.** O que você escreveu está guardado nesta tela. |
| Nenhum Reel marcado | `dados_invalidos` | **Você escolheu "só nos Reels que eu escolher", mas não marcou nenhum.** Marque pelo menos um, ou escolha "em todos os meus Reels", ou desligue `[C]`. |
| Reel apagado ao salvar | `dados_invalidos` | **Um dos Reels escolhidos não existe mais no Instagram.** Ele foi tirado da sua lista. Todo o resto foi salvo. |
| Banco esgotou a cota | `indisponivel` | **Chegamos ao limite gratuito do dia.** Ele zera à meia-noite (fuso de Londres). Por segurança, a automação está pausada até lá `[C]`. |
| Worker esgotou a cota | página 1027 crua | **Este painel recebeu tráfego demais hoje e chegou ao limite do plano gratuito.** O limite zera à meia-noite. |
| Código de parada errado | `codigo_incorreto` | **Esse código não confere. Confira e digite de novo.** |
| Qualquer erro inesperado | `falha_interna` | **Alguma coisa deu errado do nosso lado.** Sua automação e sua configuração não foram alteradas. [ Tentar de novo ] [ Desligar tudo ] |

**Em toda tela de erro com sessão, o botão de desligar continua visível** — erro é exatamente o
momento em que a pessoa mais precisa dele. A única exceção é a página de resultado da parada de
emergência, que por contrato não mostra nada além da frase.

**Glossário obrigatório da interface.** À esquerda, o que nunca se escreve; à direita, o que se
escreve: override → "este Reel responde diferente"; config → "seus ajustes"; media ID → (não
mostrar); media scope → "em todos os meus Reels" / "só nos que eu escolher"; exact/contains → "o
comentário tem que ser só isso" / "basta aparecer no meio"; placeholder → "apelido"; step-up → "vai
pedir a sua digital de novo"; passkey/credencial/WebAuthn → "aparelho cadastrado", "sua digital";
allowlist → "endereços liberados"; cooldown → "intervalo por pessoa"; rate limit → "muitas
tentativas seguidas"; token/hash/envelope/assinatura → (nunca aparece); endpoint/API/payload →
(nunca aparece); auditoria/log → "histórico das suas mudanças"; falha segura → "por segurança, não
enviamos nada"; deploy → "publicar o projeto" / "o computador onde o projeto foi publicado"; sessão
expirada → "você ficou um tempo parada". "Digital" é a palavra genérica adotada para biometria; na
primeira menção de cada página, **"sua digital ou o seu rosto"**.

Os códigos `erro` de §11.4 são internos, vão para o `console` e **nunca aparecem na tela**; o
glossário governa apenas o campo `mensagem`.

### 12.8 Os cinco trabalhos do `painel.js`

Um arquivo, sem build, sem minificação, ~4 KB, que faz **só** isto:

1. **WebAuthn:** `navigator.credentials.create()` e `.get()`, sempre dentro de um clique (o Safari
   exige gesto do usuário `[C]`), sempre com `userVerification: "required"`.
2. **Ler o token do convite do fragmento** (`location.hash`), limpar a barra de endereços com
   `history.replaceState` e enviar o token no **corpo** do POST. (São cinco trabalhos, e não quatro:
   o material de origem listava quatro e encaixava este dentro do primeiro. Fica explícito, porque
   a alternativa seria pôr um segredo de uso único na query string.)
3. **Miniaturas que falharam:** um ouvinte de `error` em fase de captura no documento, que troca a
   `<img>` por um bloco de texto escrito com `textContent`. Precisa ser assim porque a CSP não
   libera `onerror` inline.
4. **Marcar/desmarcar em lote e o contador da barra fixa.**
5. **Inserir `{username}` / `{link}`** no campo de texto.

Sem framework, sem roteador, sem modelo de estado, sem `innerHTML`, sem cache próprio. O
`require-trusted-types-for 'script'` torna o `innerHTML` um **erro de runtime**.

`<noscript>` na tela de entrar, honesto nos dois sentidos:

> **Este navegador está com o JavaScript desligado.** Funcionam assim mesmo: entrar com um código de
> recuperação, a página de parada de emergência, e todo salvamento que **não** pede a digital —
> marcar Reels, apagar palavras, testar um comentário, ver a prévia e desligar a automação. O que
> exige JavaScript é a leitura da sua digital: cadastrar aparelho, entrar por digital e confirmar
> mudanças protegidas.

### 12.9 Celular e acessibilidade

| Requisito | Como |
|---|---|
| Não dar zoom sozinho no iOS | Fonte mínima de **16px** em todo `input`, `select` e `textarea` |
| Alvo de toque | Mínimo **44×44px**; o cartão do Reel inteiro é o alvo, não a caixinha |
| Uma coluna | Grade de uma coluna até 640px; duas colunas de Reels só a partir daí |
| Teclado certo | `inputmode="url"` no link; `autocapitalize="none"` e `autocomplete="off"` nas palavras e no código de parada; `enterkeyhint="done"` |
| Ação sempre alcançável | Barra fixa embaixo, respeitando `env(safe-area-inset-bottom)` |
| Sem depender de passar o mouse | Nada de tooltip; explicação é texto visível ou `<details>` |
| Tema | `color-scheme: light dark` no `painel.css`, cores por `prefers-color-scheme` — mesma prática de `legal.ts` `[C]` |
| Conexão ruim | Sem fonte externa, sem imagem além das miniaturas; CSS ~6 KB, HTML ~15 KB por tela |
| Datas | `Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' })` no servidor; rodapé diz "Horários no fuso de Brasília" `[I]` — decisão consciente de fixar o fuso em vez de pedir configuração |

Acessibilidade: `<label for>` em todo campo; `<fieldset>` + `<legend>` em cada grupo de opções;
**resumo de erros no topo do formulário** com links âncora para os campos com problema — o formato
natural do `dados_invalidos`, que devolve a lista de campos; `aria-live="polite"` nas faixas de
aviso; estado **nunca** só por cor; contraste mínimo 4.5:1 nos dois temas; foco visível de 2px;
`lang="pt-BR"` no `<html>` `[C]`.

### 12.10 Orçamento por tela

> **Emenda ratificada em 2026-09-09.** Os números abaixo são os MEDIDOS, e não os orçados na
> primeira redação. Quem mede é `TELA-20` em `tests/painel-telas.test.ts`, que percorre as sete
> telas de leitura contando subrequests no D1 real. As três divergências corrigidas estão nomeadas
> depois da tabela; nenhuma delas é mudança de comportamento, e o pior caso continua folgado
> contra o teto de 50.

| Tela | Invocações | Consultas D1 (janela fresca → após 15 min) | Chamadas à Meta |
|---|---|---|---|
| Entrar | 1 | **0** | 0 |
| Início | 1 | 3 → 4 | 0 |
| Meus Reels | 1 | 3 → 4 | **1 a 4** por toque em "Carregar mais" |
| Este Reel | 1 | 3 → 4 | 0 |
| Palavras | 1 | 3 → 4 | 0 |
| Mensagem | 1 | 3 → 4 | 0 |
| Ajustes | 1 | 4 → 5 | 0 |
| O que aconteceu (abertura) | 1 | 4 → 5 | 0 |
| O que aconteceu (toque em "Atualizar") | 1 | 5 → 6 `[C]` | **até 20** |
| Prévia / caixa de teste | 1 | 1 | 0 |
| Salvar qualquer coisa | 1 (+1 do redirect) | 2 leituras + 1–2 escritas | 0, exceto revalidar até 20 ids novos |
| Parada com código errado | 1 | 1 leitura, 0 escrita | 0 |

**A segunda coluna tem DOIS números porque a escrituração de sessão de §10.8 mora na guarda
comum.** Ela soma +1 consulta e +1 escrita a toda tela autenticada, e no máximo uma vez a cada 15
minutos por sessão — é a cadência de `vista_em`/`ociosa_ate`. "Entrar" e a parada de emergência
ficam fora da regra porque nenhuma das duas tem sessão. A nota é uma só, e não um número por
linha, de propósito: repetir o +1 em nove lugares garante que um deles fique para trás no dia em
que a cadência mudar.

As três divergências entre a redação original e o medido:

1. **A escrituração de sessão não estava somada em lugar nenhum.** A tabela orçava a tela e §10.8
   orçava a cadência da escrita, e as duas contas nunca se encontraram. É a coluna
   `→ após 15 min` inteira.
2. **Palavras, Mensagem e Ajustes pagavam 2 na redação e pagam 3 e 4.** O terceiro subrequest é a
   pergunta sobre a conta, que a barra do topo exige desde que §12.1 passou a querer a barra IGUAL
   em toda tela — sem ela a barra diria "Ligada e respondendo" numa instalação que não consegue
   enviar nada. O quarto, só em Ajustes, é o bloco de histórico da Etapa 10. Este número já
   estava velho antes desta rodada, e o laço antigo o media sem dizer que divergia.
3. **"O que aconteceu" virou duas linhas.** A abertura simples paga 4; o 5 da redação original vale
   para o toque em "Atualizar", que é outra invocação. O `→ 6` daquela linha é derivado da nota
   acima e não é medido por `TELA-20`, que abre as telas sem `?acao=atualizar` — marcado `[C]`
   por isso.

O pior caso do painel é o toque em "Atualizar" com a tela cheia: 5 consultas + até 20 chamadas à
Meta + 1 da escrituração de sessão = **26 dos 50 subrequests**. O gargalo do projeto continua
sendo outro e é **anterior ao painel**: o `processEvents` do webhook pode estourar as 50
consultas num lote com 10 ou mais comentários `[C]` — ver §16.

---

## 13. Testes: as afirmações verificáveis

Duas decisões de método governam tudo:

**T1 — Registro de garantias com ID estável, mais metatestes.** Cada garantia recebe um
identificador; o nome do teste em vitest **cita o ID**, o código que implementa a trava cita o ID num
comentário, e nenhuma etapa é entregue enquanto o teste do seu ID não estiver verde. Os metatestes
falham quando alguém cria uma rota nova sem protegê-la, uma tabela nova sem limpar entre testes, uma
coluna que o `CREATE TABLE IF NOT EXISTS` não criou, ou um binding novo sem propagar. Sem isso, o
risco real não é a trava quebrar — é a trava nunca ter sido aplicada a uma superfície criada depois.

**T2 — WebAuthn testado por duas fontes independentes:** um autenticador de software escrito no
próprio repositório e **vetores congelados** capturados de hardware real. Só o software daria testes
simétricos (o mesmo autor comete o mesmo erro dos dois lados e tudo passa); só os vetores dariam
cobertura pobre. Juntos, o software gera variação e os vetores provam que a variação corresponde ao
mundo real.

Convenções obrigatórias, já usadas no repositório `[C]`: `@cloudflare/vitest-pool-workers` (workerd
real, D1 real em memória), **nada de `vi.mock`**, dublês são classes locais injetadas por parâmetro,
`now` sempre injetado, `AGORA = 1_700_000_000_000` sem fake timers, nomes de teste em português
descrevendo comportamento, handlers exportados chamados direto (não via `SELF.fetch`), portão único
`npm run check`.

### 13.1 Onde cada afirmação pode morar

| Quero provar que… | Onde |
|---|---|
| uma função, rota ou repositório se comporta assim | `tests/*.test.ts` (workerd + D1 real) |
| uma **página** se comporta assim (escape, cabeçalho, faixa) | `tests/*.test.ts`, porque a página nasce no Worker |
| o **schema aplicado** tem exatamente as colunas esperadas | `tests/*.test.ts`, via `PRAGMA table_info` |
| um **arquivo do repositório** está correto (binding propagado, migration não editada, `cru(` fora da lista) | `scripts/verificar-antes-de-publicar.mjs` (Node, lê o disco) |
| o **Worker publicado** está com o segredo certo | opção nova no `scripts/configurar.mjs` |
| um navegador ou autenticador real se comporta assim | checklist manual em aparelho de verdade |

Nunca empurrar um item de uma linha para outra: teste que finge cobrir o que não cobre é pior que
ausência de teste, porque desliga a atenção.

Arquivos: `tests/fixtures/{banco,autenticador,vetores-webauthn,dubles}.ts` e as suítes
`painel-sessao`, `painel-csrf`, `painel-convite`, `painel-webauthn`, `painel-allowlist`,
`painel-config-store`, `painel-stepup`, `painel-parada`, `painel-rate-limit`, `painel-midias`,
`painel-atividade`, `painel-rotas`, `painel-metatestes`, `regressao-webhook`, `regressao-oauth`,
`regressao-roteamento`. `tests/fixtures/*` não casa com o `include` do vitest `[C]`, então os
helpers não viram suítes vazias.

### 13.2 As garantias, agrupadas

**SES — Sessão (13).** Sessão expirada recusada; assinada com outro segredo recusada; `expira_em`
adulterado recusado por assinatura; envelope de propósito errado recusado; **assinatura conferida
antes do prazo** (preserva o comportamento de `oauth-state.ts` `[C]`); cookie sai com os quatro
atributos; cookie não aparece no corpo nem em outro cabeçalho; **apagar a linha invalida a sessão na
hora**; **requisição sem cookie não executa nenhuma query no D1** (provado com o dublê contador);
cookie malformado não lança; dois `sid` no mesmo milissegundo diferem; **duas requisições em menos de
15 min gravam `vista_em` uma vez só**; ociosa há mais de 2 h recusada mesmo dentro das 12 h.

**CSRF (9).** POST sem ficha recusado e nada gravado; ficha de outra sessão recusada; ficha correta
sem cookie recusada; `Origin` de outro domínio recusado mesmo com ficha correta;
`https://exemplo.workers.dev.evil.com` recusado (regressão de `includes`); GET não exige ficha; ficha
na query string não é aceita; sem `Origin`, só passa com `Sec-Fetch-Site: same-origin`; sem os dois,
`origem_invalida`.

**CONV — Convite e registro (12).** Convite válido gera options; **usado duas vezes falha na
segunda**; expirado recusado; assinado com outro segredo recusado; prazo adulterado recusado;
**registro sem convite e sem código é recusado ANTES de gerar as options**; com passkey já
cadastrada, o convite `pre=0` não abre registro; registro recusado não deixa linha; código de
recuperação correto abre registro e é consumido; o mesmo código não serve duas vezes; código errado
responde igual a código inexistente; **duas tentativas simultâneas com o mesmo convite: exatamente
uma vence** (padrão `ON CONFLICT DO NOTHING` com `Promise.all`, como já se testa em
`repositories.test.ts` `[C]`). Mais o teste do Lema 1: `INSERT INTO painel_credenciais` aparece em
exatamente um arquivo de `src/`. E: **registro bem-sucedido NÃO emite cookie de sessão**.

**WA — WebAuthn (29).** ES256 e RS256 válidos aceitos; desafio expirado recusado; desafio de outro
propósito recusado; desafio vindo do corpo ignorado; `webauthn.create` recusado no login; origem
`...workers.dev.evil.com` recusada; origem com barra final ou porta recusada; `rpIdHash` de outro RP
recusado; `UP=0` recusado; **`UV=0` recusado tanto no login quanto no step-up**; assinatura de outra
chave recusada; um byte alterado no `authData` ou no `clientDataJSON` invalida; **DER com `r` de 33
bytes (padding `0x00`) verifica**; **DER com `r` de 31 bytes verifica**; assinatura raw de 64 bytes
recusada; credencial de `rp_id` antigo ignorada sem erro incompreensível; `credentialId` desconhecido
responde igual a assinatura inválida; `signCount` que regride avisa mas **não** recusa; `signCount`
sempre 0 aceito; flags BE/BS extraídas e expostas; `fmt` diferente de `none` recusado; COSE com
`alg` fora de -7/-257 recusado; corpo de `/painel/api/*` acima de **8 KB** recusado antes do parse;
credencial de outro dono não aceita; **limitação conhecida documentada como teste:** o mesmo desafio
reapresentado dentro dos 120 s ainda é aceito — se um dia alguém implementar uso único de verdade,
esse teste falha e obriga a decisão consciente; corpo de formulário acima de **32 KB** recusado;
corpo de `/painel/parada` acima de **1 KB** recusado antes de tocar o D1.

**LNK — Allowlist (16).** Link fora da lista recusado e nada gravado; host exato aceito; subdomínio
só com a regra explícita; `https://evil-exemplo.com` recusado; `https://exemplo.com.evil.com`
recusado; `https://exemplo.com@evil.com` recusado; `http://` recusado mesmo com host permitido;
`javascript:`, `data:` e `//` recusados; punycode ou homógrafo recusado; **URL dentro do texto do
Direct passa pela allowlist**; idem no texto público; **allowlist vazia recusa qualquer link** (não
"passa tudo"); **na leitura:** config com link proibido resulta em automação parada; encolher a
allowlist para a automação já rodando; automação por mídia com link próprio fora da lista barrada;
**restaurar uma versão da auditoria com link hoje proibido é recusado pelo mesmo validador**.

**STEP — Step-up (17).** Ausente bloqueia texto do Direct e link; **fora dos 120 s bloqueia**; `UV=0`
recusado; step-up do link não autoriza gravar o texto; **o mesmo step-up não serve para duas
gravações**; **`op_hash` recalculado no servidor** (step-up de um conteúdo não autoriza outro);
`contains` exige step-up; baixar o cooldown exige; **`mediaScope` para `'todas'` exige**; **desligar
não exige**; estreitar não exige; **gravação parcial é impossível**; **não existe janela
privilegiada: duas gravações seguidas exigem dois step-ups**; `publicReplyText` exige; o cookie de
step-up é amarrado ao `sid`; 10 falhas apagam a sessão. Mais o teste de `json_canonico` com vetores
congelados: **o mesmo hash a partir do JSON da cerimônia e do formulário urlencoded**.

**STOP — Parada (14).** Código correto desliga sem sessão; **`GET /painel/parada` redireciona para
`/painel/parar`**, que serve o asset; código na query string nunca é lido; **código errado responde
`codigo_incorreto` e não provoca escrita**; a resposta não contém link, texto nem campo de config;
código errado custa **1 leitura e 0 escrita**; depois da parada, `evaluateComment` devolve
`automacao_desligada`; acionar duas vezes é idempotente; o código não serve para logar, ler nem
editar; a comparação passa por `timingSafeEqual` (provado injetando um comparador dublê); **nenhuma
das três respostas contém configuração, link, contagem ou estado da conta**; a página não informa se
existe código cadastrado; falha de D1 devolve a terceira resposta; e, o mais importante,
**`PANEL_RP_ID` ausente (o binding chega como `undefined`, não como string vazia) derruba `GET
/painel` em `503` e a parada continua desligando a automação** — a rota é desviada antes do portão de
sanidade (§11.1), e nenhuma linha do roteador lança `TypeError` nesse cenário.

**CFG — Config e falha segura (18).** Linha ausente usa o padrão de fábrica com `origem: 'arquivo'`;
linha corrompida **deixa a automação parada**; tipo errado idem; campo desconhecido do banco
descartado; **o parser nunca produz chave com valor `undefined`**; patch com campo ausente **não**
zera o global; `processComment` continua sem lançar com config corrompida; **`matchMode` inválido
deixa parado**; **`userCooldownHours` negativo, NaN ou fora de 0..8760 deixa parado**; duas mídias com
o mesmo `media_id` recusadas na gravação; **a config é carregada uma vez por lote**; **um lote de 10
comentários executa menos de 50 queries**; gravar config inválida é recusado antes de tocar o banco;
**nenhum campo inválido é substituído por valor de fábrica em nenhum caminho**; tabela inexistente
usa a fábrica e sinaliza; linha de mídia inválida recebe `{ enabled: false }` e as outras seguem;
linhas órfãs ignoradas com aviso; erro de D1 vira `parado_por_erro` cacheado com o TTL longo.

**MID — Reels (13).** `media_id` de 18 dígitos sobrevive ao round-trip sem virar `Number`; id que não
veio da listagem é recusado; `'selecionadas'` com lista vazia e automação ligada não pode ser salvo;
falha da Meta não permite salvar seleção; mídia apagada continua marcada como indisponível;
`entry[].id` diferente do `ig_user_id` é ignorado; a tela responde `private, no-store` + `Vary`;
`thumbnail_url` nunca é gravada; **a paginação para quando `paging.next` some**, não quando vêm menos
itens; a tela exige sessão; acima de 200 mídias recusado; acima de 20 ids novos recusado;
**`?midia=` casa por query string e nenhum caminho tem segmento variável**.

**ATV — "O que aconteceu" (11).** **O painel nunca executa escrita em `processed_comments`**;
**nenhuma consulta do painel retorna `commenter_scoped_id_hash`**; a consulta usa colunas nomeadas e
`LIMIT 20`; a tela **nunca emite mais de 20 chamadas à Meta por invocação**; as chamadas saem em
blocos de no máximo 6 simultâneas; o orçamento é conferido antes de disparar (com N linhas, o total
de subrequests fica ≤ 46); **comentário apagado mantém a linha com "@ indisponível"**; falha geral da
Graph API degrada para a lista sem @, com faixa, e a tela continua abrindo; **o username não vai para
o `console` nem para `painel_auditoria`, e não sobrevive ao fim da requisição**; um username contendo
`<script>` sai escapado; sem toque em "Atualizar" nenhuma chamada à Meta é feita. Mais o dicionário
de tradução como função pura, percorrendo o tipo **`CommentStatus` de
`src/repositories/comments-repository.ts`** — e não `SkipReason`: todo valor do enum tem frase, e um
valor novo sem tradução quebra. E o par que sustenta a frase honesta da tela: **a automação não grava
linha para comentário ignorado** (com um evento que casa cada `SkipReason`, o contador de escritas de
§13.4 fica em zero) e **a tela renderiza o aviso de "só os atendidos aparecem" sempre**, inclusive
com a lista vazia.

**HDR — Cabeçalhos, HTML e vazamento (10).** CSP canônica em toda página, sem `unsafe-inline` nem
`unsafe-eval` e com `require-trusted-types-for`; `img-src` só com `'self'`, `data:` e os CDNs da
Meta; `private, no-store` + `Vary: Cookie` em toda resposta; `nosniff` e `no-referrer`; **nenhum
corpo de erro contém stack trace, nome de exceção, nome de coluna nem a palavra "payload"** (laço
sobre todas as rotas com entrada inválida, afirmando que o corpo não casa
`/Error|at \w+ \(|SQLITE|D1_|undefined|payload/`); **valor vindo do banco interpolado no HTML passa
por `escapeHtml`**; `/health` devolve o corpo de hoje mais **exatamente um** campo novo, em
`corpo.painel`, com um dos **três** valores públicos quando não há `Authorization` e um dos **seis**
sob Bearer válido — e **`sem_passkey` nunca aparece numa resposta sem Bearer** (§11.9); **toda
página é montada pela tag `` html`` ``** (laço que renderiza cada tela com um valor de banco contendo
`<script>` e afirma que a saída não contém `<script>`); nenhuma resposta traz `Access-Control-*` e
`OPTIONS` devolve 405.

**RL — Rate limit (10).** A décima primeira tentativa dentro de 60 s é recusada com 429; passada a
janela libera; IPs diferentes não compartilham contador; requisição sem `CF-Connecting-IP` cai num
balde global e continua limitada; **tentativa de login recusada executa zero escritas**; **com o
binding ausente, o limitador de reserva assume e o login continua limitado**; o limitador do painel
não se aplica ao webhook; login bem-sucedido zera o contador daquele IP; **a parada tem limite
próprio, mais generoso**; **os três bindings são distintos e cada família de rota fala com o seu**.

**AUD — Auditoria (5).** Toda gravação registra evento com data, credencial usada e campos
alterados; o registro **não** guarda código, cookie, `credential_id` inteiro, IP nem `User-Agent`;
tentativa recusada também registra, com `antes = depois = NULL`; teto de 500 linhas com a mais antiga
saindo; **nenhum valor de configuração vai para o `console`**.

**META — Metatestes (9).** Toda rota registrada exige sessão, salvo a allowlist **escrita no teste**
— `['/painel/entrar', '/painel/entrar/codigo', '/painel/convite', '/painel/parada',
'/painel/api/entrar/opcoes', '/painel/api/entrar/verificar', '/painel/api/registrar/opcoes',
'/painel/api/registrar/verificar']`; todo POST autenticado exige ficha CSRF, salvo as exceções
escritas no teste; toda tabela do schema aparece em `limparBanco()`; todo binding **obrigatório**
existe no ambiente de teste (os três limitadores são opcionais e a ausência é proposital);
`PANEL_SESSION_KEY` é diferente de `TOKEN_ENCRYPTION_KEY` e de `SETUP_ADMIN_TOKEN`; todo campo
gravável está classificado como exige/não exige step-up (`allowedMediaIds` **não entra**, porque não
é gravável); o painel entra pelo `default:` e não captura `/painelzinho` nem engole o 404;
**`PRAGMA table_info` de cada tabela confere o conjunto exato de colunas**; todo caminho da tabela de
rotas é string exata, começa por `/painel` e não tem segmento variável.

**REG — Regressão (30).** Congelam o comportamento de hoje **antes** de qualquer linha do painel
existir. Webhook: POST assinado **sem cookie e sem ficha CSRF** continua 200 `EVENT_RECEIVED`;
assinatura inválida continua 401; corpo acima de 512 KB continua 413 mesmo com assinatura válida;
`content-length` mentiroso continua 413 antes de ler o corpo; PUT continua 405; a assinatura continua
conferida sobre o corpo **cru**, antes do `JSON.parse`; a ordem tamanho → assinatura → parse não
mudou; o limitador do painel não é aplicado (100 POSTs assinados seguidos, todos 200); **com a tabela
de config vazia, `evaluateComment` devolve para 20 eventos o mesmo resultado de `automationConfig`**;
o webhook não depende da listagem de mídias. OAuth: `/setup/authorize` sem cabeçalho continua 401;
com Bearer continua devolvendo `authorizationUrl`; token na query string continua não sendo aceito;
o `state` continua assinado com `SETUP_ADMIN_TOKEN`, não com a chave nova; callback com state
expirado ou de outro segredo continua recusado; `/setup/subscribe` continua exigindo Bearer; o token
continua cifrado e não é devolvido; **o painel não emite, não lê e não aceita cookie em `/setup/*`
nem em `/oauth/callback`**; `STATE_TTL_MS` continua 10 minutos, independente dos 120 s do desafio;
`/setup/painel/codigos` exige Bearer e **nunca loga o corpo**; `/setup/painel/zerar` exige Bearer e
não toca `account_tokens`. Roteamento: as sete rotas de hoje respondem o mesmo status;
`/qualquer-coisa` continua 404; `/painelzinho` cai no 404; `/painel` e `/painel/` levam ao mesmo
lugar; `/health` continua com o mesmo corpo mais exatamente um campo; as páginas legais continuam sem
exigir sessão; o cron continua chamando `runScheduledTasks` e a poda da auditoria é a única coisa do
painel que entrou nele; **`routePainel` devolve `null` para `/webhooks/instagram`, `/health`,
`/oauth/callback` e `/setup/*`**.

**A regra dura:** os seis arquivos de teste atuais **não são editados** durante as etapas 0 a 15. Se
uma mudança do painel obrigar a alterar `tests/webhook.test.ts`, `tests/automation.test.ts` ou
`tests/security.test.ts`, isso **é** a regressão — e o sinal para parar, não para ajustar o teste. A
única exceção é a migração mecânica de `limparBanco()`.

### 13.3 Como testar WebAuthn sem hardware

**`AutenticadorFalso`** (`tests/fixtures/autenticador.ts`), classe local injetada por parâmetro, que
**produz os mesmos bytes que um autenticador real produziria** usando `crypto.subtle`:

1. Par de chaves: ES256 `ECDSA/P-256`; RS256 `RSASSA-PKCS1-v1_5` 2048 bits, expoente `[1,0,1]`.
2. Chave pública COSE: exporta JWK e monta o mapa CBOR de inteiros — `{1:2, 3:-7, -1:1, -2:x, -3:y}`
   para EC2, `{1:3, 3:-257, -1:n, -2:e}` para RSA. Exige um **codificador** CBOR mínimo (~40 linhas).
   O decodificador de produção e o codificador de teste são escritos separados, por definição
   independentes.
3. `authData`: `SHA-256(rpId)` (32) `|| flags` (1) `|| signCount` big-endian (4) e, só no registro,
   `aaguid` de 16 zeros `|| credIdLen` (2) `|| credentialId || cosePublicKey`.
4. `clientDataJSON` serializado como texto e convertido para bytes.
5. Assinatura sobre `authData || SHA-256(clientDataJSON)` — nunca sobre o JSON.
6. **DER:** o WebCrypto assina ECDSA em raw `r||s`; um autenticador real devolve ASN.1 DER. O dublê
   **converte raw → DER**, o inverso do que a produção faz. Sem esse passo o teste jamais exercita o
   caminho DER e a armadilha maior do projeto passa despercebida.
7. `attestationObject`: CBOR de `{fmt:'none', attStmt:{}, authData}`.

`autenticarComRAlto` assina em laço até obter um `r` com o bit mais alto ligado (~50%, converge em
poucas voltas). `autenticarComRCurto` precisaria de ~1500 tentativas (~1/256) e por isso **vem dos
vetores congelados**, não do laço — honesto e barato. Mutação para os casos negativos: helpers puros
`trocarByte`, `comOrigin`, `comTipo`, `comRpId`, `semUv`, cada um alterando exatamente uma coisa.

**Vetores congelados** (`tests/fixtures/vetores-webauthn.ts`), capturados **uma vez** de aparelhos
reais e commitados como base64url. Não contêm segredo: são chave pública, assinatura, desafio e
metadados — exatamente o que o servidor já recebe pela rede. Conjunto mínimo: `registroEs256Android`
(Chrome/Android), `registroRs256WindowsHello` (TPM, o único caminho RS256), `loginEs256Icloud`
(signCount 0, BE=1 BS=1), `loginEs256DerRAlto`, `loginEs256DerRCurto` e **`loginSemUv`**, que é um
vetor **negativo**: prova que UV=0 é recusado nos dois fluxos. Cada vetor vem com o `rpId`, o
`origin` e o desafio que valiam na captura. Um teste dedicado — "os vetores capturados de hardware
real são aceitos pelo verificador" — é o único que prova que o `AutenticadorFalso` não está apenas
concordando consigo mesmo.

**O que não dá para provar, e não vamos fingir:** que o **navegador** recusa um `rpId` errado (quem
impõe isso é o navegador); que `UV=1` significa biometria conferida (ligamos o bit no teste); que
`residentKey`/`excludeCredentials` fazem efeito (são instruções para o autenticador — testável só
como "as options contêm esses campos"); anti-replay real do desafio; fluxo cross-device por QR; a
exigência de gesto do usuário no Safari; compatibilidade real de cada gerenciador de senhas. O
Virtual Authenticator do Chrome DevTools daria um E2E de navegador, e foi **descartado do portão
automático** porque o `package.json` não tem nenhuma dependência de runtime nem de browser `[C]`;
fica como ferramenta opcional de depuração, documentada, fora do `npm run check`.

### 13.4 Rate limit e o contador de consultas

O limitador vira uma **porta** com três implementações — `LimitadorDeBinding` (usa o binding da
família da rota), `LimitadorDeReserva` (janela em memória por isolate mais Cache API, para quando o
binding não existe) e `LimitadorFalso` (dublê injetado). Três camadas de teste, nenhuma tocando a
rede: o **algoritmo puro** com `agora` injetado (inclusive relógio que anda para trás, que não pode
liberar o balde); a **rota com o dublê** (429, corpo genérico e **zero queries**); e o **adaptador do
binding**, provando que a chave enviada é a esperada, que uma exceção do binding cai no limitador de
reserva em vez de abrir o login, e que a parada fala com o binding dela e nunca com o do login.

```ts
class D1Contador {
  prepares = 0
  escritas = 0
  constructor(private readonly real: D1Database) {}
  prepare(sql: string) {
    this.prepares++
    if (/^\s*(insert|update|delete)/i.test(sql)) this.escritas++
    return this.real.prepare(sql)
  }
  // batch, dump, exec delegados e contados
}
```

É o único jeito honesto de transformar "não gasta cota" — que é uma afirmação sobre faturamento — em
uma afirmação sobre **código**. **O que o teste de rate limit não prova:** que o limite segura um
atacante real. O contador do binding é por data center e eventualmente consistente `[C]`; a proteção
da cota diária vem de outro lugar, e esse residual precisa estar **escrito na documentação**, não
escondido atrás de um teste verde.

### 13.5 O que não dá para cobrir com teste automático

**Checagens novas em `scripts/verificar-antes-de-publicar.mjs`** (estilo obrigatório: `secao()`,
`ok()`, `falha()`, `aviso()`, saída 1 só quando há falha `[C]`):

| # | Checagem | Severidade |
|---|---|---|
| 8 | Todo binding de `src/types/env.ts` aparece em `wrangler.jsonc`, `.dev.vars.example` e nos bindings do `vitest.config.ts` (exceção declarada: os três `ratelimits`) | falha |
| 9 | `ALLOWED_LINK_DOMAINS` não está vazio nem com o domínio de exemplo | falha |
| 10 | `PANEL_RP_ID` não está vazio, não é `workers.dev` puro e não tem esquema nem barra | falha |
| ~~11~~ | **APAGADA.** `PANEL_ORIGIN` não existe | — |
| 12 | No `.dev.vars`, `PANEL_SESSION_KEY` difere de `TOKEN_ENCRYPTION_KEY` e de `SETUP_ADMIN_TOKEN` | falha |
| 13 | Os **três** arquivos de `public/` não têm `<script>` inline, `onclick=` nem `javascript:` | falha |
| 14 | A varredura de segredos cobre `public/` e o handler de `/setup/painel/codigos` | falha |
| 15 | **Nenhuma migration já publicada foi modificada**, via `migrations/CHECKSUMS.txt` | falha |
| 16 | `configurar.mjs:12-19` não contém mais o texto anti-painel | aviso |
| 17 | Os documentos de §14, etapa 15, foram tocados depois da última mudança em `src/routes/painel/` | aviso |
| 18 | **Nenhum nome de tabela aparece em mais de um arquivo de `migrations/`** | falha |
| 19 | **`cru(` só aparece nos arquivos da lista autorizada de `src/routes/painel/`** | falha |

O número 11 fica **vago de propósito**: renumerar faria "checagem 13", "15" e "18" significarem
coisas diferentes em partes diferentes do projeto. A checagem 13 cobre **só** `public/`: a proibição
de `onclick=` e `javascript:` no HTML **gerado** é teste (HDR), não grep — e essa é uma das
consequências práticas de o HTML nascer no Worker. A checagem 19 é a casa **única** da garantia sobre
`cru(` (ver §15.3): a alternativa era um teste dependente de `import.meta.glob(..., { query: '?raw' })`
sob `vitest-pool-workers`, comportamento não verificado — uma garantia que pode nascer quebrada por
detalhe de bundler ensina a equipe a ignorá-la.

**Opção nova no assistente local**, item **"6. Conferir o painel"**, usando `GET /health` e o campo
único novo (§11.9). E, **localmente**, sem campo novo nenhum: conferir se o `PANEL_RP_ID` do
`wrangler.jsonc` é igual ao host que o assistente está usando para falar com o Worker — a situação
que **invalida todas as passkeys** e não tem migração, e que merece aviso em letras grandes.

**Checklist manual, feito uma vez por aparelho e registrado com data:** passkey em hardware real
(iPhone/Safari, Android/Chrome, Windows Hello — o único caminho RS256 —, Mac/Touch ID, login
cross-device por QR, e uma chave de segurança sem PIN **só para capturar o vetor negativo**); captura
dos vetores congelados durante esse ensaio; **ensaio de perda e recuperação** (apagar todas as
passkeys e recuperar com código, depois gerar convite novo pelo terminal) — feito **antes** de o dono
depender do painel, não no dia em que perder o telefone; **parada de emergência de verdade**, com a
automação ligada, acionada de um aparelho deslogado, confirmando que o Direct parou e que a segunda
tentativa não grava nada; e o **passo a passo do step-up com olhos de leigo**, confirmando que a tela
mostra o valor literal antes da biometria — a única parte da trava que nenhum teste alcança.

**Propriedades não testáveis por natureza:** que uma comparação é realmente de tempo constante (o
teste só prova que a função certa foi chamada); que uma mensagem não vaza informação por **tempo de
resposta**; que a entropia de `crypto.getRandomValues` é boa. E os limites de plataforma — 100.000
requisições/dia, 50 subrequests e 10 ms de CPU — **não são impostos pelo Miniflare**: o teste de
consultas por lote é a melhor aproximação disponível; os outros dois só aparecem em produção.

---

## 14. Etapas de entrega, na ordem de execução

Cada etapa é entregável e verificável sozinha: começa por um teste que **falha pelo motivo certo**,
termina com `npm run check` verde, e tem uma forma de o dono conferir com os próprios olhos. Nenhuma
etapa avança com a anterior vermelha.

### Etapa 0 — Rede de segurança (nenhuma linha de painel)

Congelar o presente antes de mexer nele. **Primeiro teste que falha:** *"POST assinado sem cookie e
sem ficha CSRF continua 200"* — falha porque `regressao-webhook.test.ts` ainda não existe.

Escreve as três suítes de regressão, `tests/fixtures/banco.ts` (com `limparBanco()` único),
`tests/fixtures/dubles.ts` (`D1Contador`), o metateste de tabelas e `migrations/CHECKSUMS.txt` com o
SHA-256 de `0001_initial.sql`. E **corrige aqui** os três achados pré-existentes e independentes do
painel (§16): o fatiamento do lote para caber nas 50 consultas por invocação; a troca do
`.replace('{link}', ...)` cru de `index.ts:214` por `renderTemplate`; e a remoção de `configForEvent`,
código morto. **Verificação do dono:** `npm run check` verde com ~40 testes novos, produção intocada.

### Etapa 1 — Sessão assinada com claims (sem HTTP)

`src/security/signed-envelope.ts` generaliza `oauth-state.ts` para carregar propósito, claims e TTL
parametrizável, **sem alterar** `createState`/`validateState` (as regressões de OAuth protegem isso).
`base64url.ts` ganha o `decode`. Binding novo `PANEL_SESSION_KEY`, raiz das quatro subchaves,
propagado pelos cinco lugares. Entrega o grosso de SES e os metatestes de binding.

### Etapa 2 — Config no D1, só leitura

`migrations/0002_painel_config.sql`, `painel-config-repository.ts`, `config-store.ts` (snapshot,
cache por isolate, `invalidarCacheDeConfig()`) e `config-validation.ts` (o validador único).
`src/config.ts` **intocado**. Entrega CFG e a primeira versão do `PRAGMA table_info`. **Verificação:**
o dono insere uma linha por `wrangler d1 execute` e vê a automação mudar de comportamento **sem
redeploy**; corrompe a linha à mão e vê a automação **parar** — não "consertar".

### Etapa 3 — Allowlist de domínios (função pura)

`src/services/link-allowlist.ts`, aplicado já na **leitura** da config, em link e em texto.
**Verificação:** com a allowlist estreita e um link fora dela no banco, a automação para.

### Etapa 4 — Parada de emergência, códigos, e o nascimento da auditoria

Entregue **antes** do painel, de propósito: o dono ganha o botão de pânico enquanto o resto ainda
está sendo construído. `migrations/0003_painel_codigos.sql`, `panel-codes.ts`, `POST /painel/parada`,
o asset `public/painel/parar/index.html`, e `POST /setup/painel/codigos` (o **Worker** gera os 6+1
códigos e devolve o texto uma única vez).

**É aqui que `painel_auditoria` começa a receber escrita** — não na etapa 10. Motivo: os dois
primeiros eventos auditáveis do projeto nascem nesta etapa (`codigos_gerados` e `parada_acionada`), e
a parada é justamente o evento que mais precisa de registro. A contabilidade das duas pontas fica
assim, e é ela que os testes afirmam:

- `POST /setup/painel/codigos`: **1 lote** = `DELETE` do conjunto antigo + 7 `INSERT` + **1 linha de
  auditoria** (`origem='assistente'`, `ator='assistente'`, `antes = depois = NULL`).
- `POST /painel/parada` com código correto e automação ligada: **2 escritas** = `UPDATE` de
  `painel_config` (`enabled=0`, `parado_por_codigo_em`, `versao+1`) + **1 linha de auditoria**
  (`origem='parada'`, `ator='parada'`, `antes = depois = NULL`).
- `POST /painel/parada` repetida, ou com código errado: **0 escritas**, auditoria inclusive.
- A **poda de 500 linhas** entra no cron nesta mesma etapa, porque a tabela já recebe linhas.

A etapa 10 não "cria" a auditoria: ela acrescenta as linhas de **mudança de configuração**, que são
as únicas que preenchem `antes` e `depois`, mais o bloco de histórico na tela. **Verificação:** do
celular, deslogado, o dono desliga a automação com o código impresso no papel — e lê uma frase que
diz claramente se deu certo.

### Etapa 5 — Rate limit

A porta `Limitador` com as três implementações. Os **três** bindings opcionais entram no
`wrangler.jsonc`; o ambiente de teste segue **sem** eles, de propósito. Aplica já na rota de parada.

### Etapa 6 — Verificação WebAuthn (pura, sem rota)

`AutenticadorFalso`, CBOR mínimo, COSE→JWK, DER→raw e a verificação completa. Os vetores congelados
entram aqui — o que exige o checklist manual de hardware **nesta etapa**, não no fim. É a maior massa
de testes do projeto.

### Etapa 7 — Convite de uso único e registro da primeira passkey

`migrations/0004_painel_acesso.sql`, `GET /painel/convite`, `/painel/api/registrar/opcoes` e
`/verificar`, recusa quando já existe passkey, e o teste do caminho único de `INSERT`.
**Verificação:** o dono gera o convite no terminal e registra a passkey do próprio celular; tenta de
novo com o mesmo link e é recusado.

### Etapa 8 — Login, cookie e o portão de rotas

`rotas.ts`, `router.ts` entrando pelo `default:`, `guardas.ts`, `html.ts` (a tag `` html`` ``,
`cru()`, `pagina()`, `cabecalhos(perfil)`) e `resposta.ts` com a tabela de erros.
`GET /painel/entrar` renderiza com **0 consulta ao D1**. Entrega CSRF, os cabeçalhos e os metatestes
de rota. **Verificação:** o dono entra no painel com a digital e vê uma página que ainda não edita
nada.

### Etapa 9 — Leitura da configuração na tela

**Primeiro teste que falha:** *"valor vindo do banco interpolado no HTML passa por `escapeHtml`"*.
As telas de Início, Palavras, Mensagem e Ajustes sobem em modo leitura, e `/painel/atividade` sobe na
**versão sem lista** (três estados grandes + pendências com botão), lendo só `painel_config`,
`painel_midias` e `account_tokens`. Entrega o dicionário de tradução e as garantias de escape.
**Verificação:** o dono vê, do celular, a configuração que hoje só existe em TypeScript.

### Etapa 10 — Escrita dos campos de risco baixo

Formulário POST → `303` → `GET ...?ok=`. Gatilhos, flags de normalização, `enabled`, cooldown **para
cima**. A auditoria de configuração nasce aqui, com `antes`/`depois` completos no D1 e **nenhum
valor** no `console`, mais o bloco somente-leitura de histórico no fim de `/painel/ajustes` com o
botão "Voltar a esta versão" (que reenvia o `antes` pela rota normal de gravação, com a allowlist de
hoje). **Verificação:** o dono muda uma palavra-gatilho pelo celular e vê valer sem redeploy; abre o
histórico e vê o valor anterior.

### Etapa 11 — Step-up e os campos de risco alto

Classificação de risco por campo, `POST /painel/api/stepup/opcoes`, o cookie `__Host-painel_stepup`,
`json_canonico` especificado e testado, `op_hash` recalculado no servidor, e a tela intermediária
"Confira o que vai mudar" mostrando o valor literal. **Verificação:** trocar o link sem digital é
barrado; com digital funciona; link fora da allowlist é barrado **mesmo com digital**; e duas
mudanças seguidas pedem duas digitais.

### Etapa 12 — Reels e automações por mídia (a prioridade do dono)

Listagem paginada, seleção por clique, `mediaScope`, sobreposições por mídia, unicidade de
`media_id`, `/painel/reel?midia=`. **Verificação:** o dono escolhe os Reels clicando. É o que ele
pediu em primeiro lugar.

### Etapa 13 — Recuperação, múltiplos aparelhos e revogação

Entrada por código de recuperação, várias passkeys (teto de 10), tela de Aparelhos com apelido e
flags BE/BS, remoção com step-up, geração de códigos pela tela e `POST /setup/painel/zerar`.
**Verificação:** ensaio completo de perda de aparelho, feito de verdade.

### Etapa 14 — "O que aconteceu" com o @ ao vivo

A consulta paginada a `processed_comments` com colunas nomeadas, a busca do @ em blocos de 6, o
orçamento de subrequests conferido antes de disparar, o texto de comentário apagado, a degradação
quando a Graph API falha, e o "Ver mais". Mais o dicionário de `CommentStatus` e o aviso obrigatório
de que **só os comentários atendidos aparecem** (§12.6) — a etapa não sobe sem essa frase na tela, sob
pena de entregar menos do que §3 promete. **Pré-requisito:** o teste `[V]` de §12.6 precisa ter sido
feito em conta real antes desta etapa. **Verificação:** o dono abre a tela e vê quem recebeu — e lê,
sem procurar, por que quem não recebeu não está ali.

### Etapa 15 — Portões de publicação e documentação

As checagens 8 a 10 e 12 a 19 do `verificar-antes-de-publicar.mjs`; a opção "6. Conferir o painel" no
assistente; a reescrita do manifesto de `configurar.mjs:12-19` para "por que o painel é seguro"; as
três frases novas na política de privacidade; e a atualização dos documentos que ficam desatualizados
(§16). **Verificação:** `npm run check` e `npm run verificar` verdes, e o checklist manual assinado
com data e aparelhos.

### Resumo do portão

| Etapa | Primeiro teste que falha | Fica verde ao entregar |
|---|---|---|
| 0 | regressão do webhook sem cookie | REG-*, metateste de tabelas, lote de 10 comentários |
| 1 | envelope de propósito não autoriza step-up | SES base, metatestes de binding |
| 2 | config ausente usa o padrão de fábrica | CFG, `PRAGMA table_info` parcial |
| 3 | `http://` com host permitido é recusado | LNK-01 a LNK-15 |
| 4 | código correto via POST desliga sem sessão | STOP, corpo de 1 KB, auditoria nasce |
| 5 | a 11ª tentativa em 60 s é recusada | RL |
| 6 | assertion ES256 válida é aceita | WA |
| 7 | convite usado duas vezes falha na segunda | CONV, `PRAGMA table_info` completo |
| 8 | toda rota exige sessão, salvo a allowlist | CSRF, HDR de cabeçalho, META de rota, corpo de 32 KB |
| 9 | valor do banco passa por `escapeHtml` | HDR-06 e o laço de `<script>`, dicionário |
| 10 | desligar a automação não exige step-up | AUD com `antes`/`depois`, restauração |
| 11 | step-up ausente bloqueia o texto do Direct | STEP |
| 12 | `media_id` de 18 dígitos sobrevive | MID |
| 13 | apagar a linha invalida a sessão emitida | recuperação, aparelhos, rotas administrativas |
| 14 | a tela não emite mais de 20 chamadas à Meta | ATV |
| 15 | checagem 8 vermelha por binding não propagado | checagens 8..10 e 12..19 |

---

## 15. Perguntas em aberto, pendências e divergências resolvidas

### 15.1 Perguntas para o dono decidir

Nenhuma bloqueia o início da implementação; as duas primeiras bloqueiam a **etapa 7**, porque depois
do primeiro cadastro elas ficam caras.

1. **O endereço do painel é definitivo?** O `rpId` fica gravado dentro de cada passkey e **não pode
   ser corrigido depois** `[C]`. Se houver intenção de usar domínio próprio algum dia, o momento
   barato de decidir é **antes** do primeiro cadastro. Trocar depois é re-registro de todos os
   aparelhos, com código de recuperação.
2. **Quais domínios entram em `ALLOWED_LINK_DOMAINS` no primeiro deploy**, e se subdomínios entram
   (`.noxelora.com.br` libera todos). Lista curta é mais segura; lista com subdomínio curinga é mais
   cômoda. Enquanto ela estiver vazia, o painel não altera link nem texto.
3. **Se o teste `[V]` da busca do @ falhar**, a tela "O que aconteceu" deve subir sem o arroba
   (lista com horário e resultado) ou sem a lista (só os estados e as pendências)? A recomendação
   deste documento é a primeira.
4. **Cloudflare Access** entra como camada opcional documentada? Ela provavelmente barra antes de
   invocar o Worker, o que economizaria cota `[V — a documentação da Cloudflare se contradiz sobre
   `.workers.dev`]`. Testar custa uma tarde; virar requisito está proibido.
5. **Retenção de 500 linhas de auditoria** é suficiente, ou o dono quer mais histórico? Mais linhas
   não custam quase nada em leitura, mas ocupam espaço e não têm tela de busca.
6. **Onde o papel dos códigos vai ficar guardado?** É processo, não código, e é o elo mais fraco da
   recuperação. O assistente pode imprimir uma folha pronta para dobrar, se o dono quiser.
7. **Como o painel é anunciado no README:** recurso principal, ou recurso avançado com o aviso de
   cota de §5.3 na mesma página? O aviso é obrigatório nas duas opções; muda só o destaque.

### 15.2 Pendências `[V]` — todas bloqueiam uma frase na documentação, nenhuma bloqueia código

| # | Pendência | Quem depende | Se falhar |
|---|---|---|---|
| 1 | `public/painel/parar/index.html` é servido em `GET /painel/parar` | a página de emergência | usar `/painel/parar/` com barra e imprimir a URL com barra em toda a documentação |
| 2 | `_headers` funciona em Workers Static Assets | só os três assets | nada quebra: a página de parada não tem script nem interpolação |
| 3 | Funções JSON1 (`json_valid`, `json_type`, `json_array_length`) no D1 | os `CHECK` do 0002 | remover só esses predicados; `length(...)` e o validador continuam |
| 4 | `db.batch()` é transação implícita e conta como 1 subrequest | atomicidade da gravação | ordem de escrita defensiva já especificada; divergência em `changes` vira erro duro |
| 5 | `exactOptionalPropertyTypes: true` sem ruído no resto do código | reforço do parser | fica só o teste `'campo' in patch` |
| 6 | Binding `ratelimits` disponível no plano gratuito | a camada de limitação | o painel funciona sem; **não prometer na documentação** |
| 7 | `media_product_type` e `caption` vêm na listagem com Instagram Login | tela de Reels | filtrar por `media_type=VIDEO` e rotular "vídeo/Reel". **Nunca** uma chamada extra por item |
| 8 | Leitura de nó de comentário por id devolve `username` | só o @ da tela de atividade | ver a pergunta 3 de §15.1 |
| 9 | Cloudflare Access em `.workers.dev` | camada opcional | documentar o resultado com data; nunca virar requisito |
| 10 | Retenção dos Workers Logs no plano gratuito | política de privacidade | escrever "retenção definida pela Cloudflare" |
| 11 | `__Host-` em navegadores antigos de celular | o cookie | medir; **não há plano B aceitável** — o prefixo fica |
| 12 | CPU da carga fria com 200 mídias dentro dos 10 ms | o teto de 200 | baixar para 100, e o teste de teto muda de número junto |
| 13 | Invocação de cron conta contra as 100.000 | a aritmética de §5.2 | ajustar a conta, que já sobra por duas ordens de grandeza |
| 14 | Reconhecer "tabela inexistente" pela mensagem de erro do D1 | o estado de migration não aplicada | o remédio primário continua sendo a ordem documentada do deploy: migration antes do código |

### 15.3 Divergências do material de origem, e como foram resolvidas

Um autor único não pode se contradizer. Estas oito divergências existiam entre os documentos de
origem e foram **decididas** aqui:

1. **`POST /painel/entrar/codigo` emite sessão?** **Não.** O código de recuperação só permite
   **cadastrar uma passkey nova**, e nunca cria sessão sozinho — um código não pode virar senha. O
   POST faz 1 leitura, **não consome** o código, e renderiza a tela "crie a passkey nova". O consumo
   acontece em `/painel/api/registrar/verificar`.
2. **Tabela de códigos de erro.** Vale a canônica de §11.4. As nove grafias divergentes
   (`stepup_necessario`, `stepup_invalido`, `link_nao_permitido`, `meta_indisponivel`,
   `d1_indisponivel`, `erro_interno`, `sessao_invalida`, `desafio_expirado`, `midia_inexistente`)
   estão **deletadas**, e mapeiam para `step_up_necessario`, `dominio_nao_permitido`, `falha_meta`,
   `indisponivel`, `falha_interna`, `sessao_ausente`, `credencial_invalida` e `dados_invalidos`.
3. **"A única exceção é `POST /painel/parada`" era falso.** São **três** rotas com a mesma forma
   (§11.3), e a regra foi reescrita pelo seu conteúdo real: *nenhuma rota não autenticada consulta o
   D1 antes de um HMAC fechar*; nas rotas de código, o HMAC que fecha é o do próprio código.
4. **Em que etapa `painel_auditoria` começa a receber escrita?** Na **etapa 4**, com a parada de
   emergência e a geração de códigos. A contabilidade das duas pontas está em §14, etapa 4, e a
   etapa 10 acrescenta apenas as linhas com `antes`/`depois` de configuração.
5. **`POST /painel/api/registrar/verificar` emite sessão?** **Não.** Três escritas no caso do convite
   (consumo do nonce, credencial, auditoria), duas no caso de sessão+step-up, cinco no caso de
   recuperação (§9.10). A sessão nasce **sempre** de um login com `webauthn.get` e UV conferido, num
   ponto único do código.
6. **`link-allowlist.ts` fica em `src/services/`**, não em `src/security/`.
7. **O dicionário da tela "O que aconteceu" percorria dois enums de arquivos diferentes sob uma
   citação só.** Vale `CommentStatus` (`comments-repository.ts:11-20`), que é o que a coluna
   `processed_comments.status` guarda; `SkipReason` e `ProcessOutcome` (`automation.ts:28,40`) são
   resultados em memória e **não chegam ao banco**. Mais grave que a citação: o corpus prometia, na
   Saída A do contrato e aqui, dez frases de `SkipReason` que **nenhum caminho do código atual pode
   produzir** — todos os `skipped` acontecem antes do único `INSERT` da tabela. Decidido em §12.6:
   **não** passamos a gravar linha para comentário ignorado (a conta de escrita de §5.2 e §16.1
   proíbe), e a tela **diz** que só mostra o que a automação atendeu.
8. **O portão de sanidade contra a parada de emergência.** §10.2 e §10.12 do corpus dizem que
   `POST /painel/parada` é a exceção; o esboço do roteador aplicava o portão a tudo, e ainda usava
   `env.PANEL_RP_ID.length` sem `typeof`, o que lança `TypeError` com o binding ausente. Vale a
   exceção: §11.1 desvia `/painel/parada` e `/painel/parar` **antes** do portão, com teste STOP.

### 15.4 Objeções ao contrato: o que foi acolhido e o que foi recusado

**Acolhidas, e por quê:**

- **Desafio de registro de 300 s** (os outros continuam em 120 s). O registro não é a mesma cerimônia
  do login: o leigo digita um apelido, encara o primeiro diálogo do sistema operacional que já viu e
  às vezes aprova num segundo aparelho. O envelope já carrega o prazo por propósito, então não há uma
  segunda constante para alguém esquecer.
- **"As três rotas `/painel/api/*` que exigem sessão" não existia em número três.** A regra passa a
  ser escrita sem número, e **`/painel/api/registrar/opcoes` passa a exigir ficha CSRF no modo
  sessão** — do contrário ela seria o único POST autorizado por cookie de sessão sem ficha, e
  cadastrar uma passkey nova é precisamente a operação que um atacante mais gostaria de executar em
  nome do dono.
- **Um terceiro limitador, `PANEL_LIMITER_CODIGO`.** Um bot martelando o login não pode consumir a
  cota que o dono precisaria para digitar o **código de recuperação**, que é caminho de emergência —
  o mesmo raciocínio que já dera binding próprio à parada. **Isto é uma troca, não um ganho puro, e
  §7.4 a escreve como troca:** o contrato punha `/painel/entrar/codigo` sob 10/60 s, e o binding novo
  **triplica** para 30/60 s a taxa de tentativa permitida contra um segredo que abre o cadastro de
  passkey. Aceita porque a defesa desse segredo sempre foram os 100 bits de §10.11, e porque o
  contador da Cloudflare é por data center `[C]` — um atacante distribuído já ignorava os 10.
- **`/health` ganha um campo, com seis valores — mas só sob Bearer.** O campo único aprovado perdia
  dois diagnósticos reais: "de onde vem a configuração" (a pergunta que resolve a classe inteira de
  "editei o arquivo, fiz deploy e nada mudou") e a possibilidade de o assistente **bloquear** a
  edição do arquivo. **O que a primeira versão desta decisão não pesou:** `/health` é uma rota
  **pública** (`health.ts:10` `[C]`, sem `isAdmin`), e ali `sem_passkey` entrega a qualquer anônimo,
  por polling barato, exatamente o instante em que um convite `pre=0` interceptado ainda funciona —
  a fusão em `sem_acesso` **era** a proteção, não uma imprecisão. A decisão final divide: **sem
  `Authorization`, os três valores do contrato** (`desativado | sem_acesso | pronto`); **com
  `Authorization: Bearer <SETUP_ADMIN_TOKEN>`, os seis**, que é tudo o que o assistente local
  precisava e ele já tem o token. Continua sendo **um** campo, na raiz do corpo, e §4 agora registra
  a linha de ameaça que faltava.
- **A proibição vence a regra do "estado completo".** `antes`/`depois` de uma linha de mídia carregam
  só os campos de comportamento, porque `legenda_curta` é um recorte da `caption` do Reel e `caption`
  está na lista de proibidos.
- **O `<noscript>` subestimava o desenho.** O texto corrigido está em §12.8.
- **Ler o token do convite do fragmento é um trabalho próprio do `painel.js`**, e a lista passa a ter
  cinco itens em vez de quatro (§12.8).
- **O histórico precisava de tela.** Bloco somente-leitura no fim de `/painel/ajustes`, sem rota nova
  (§14, etapa 10).
- **A garantia sobre `cru(` mora no script Node** (checagem 19), e não num teste dependente de um
  comportamento não verificado do bundler (§13.5).
- **A allowlist de rotas sem sessão inclui `/painel/parada`**, e só `/painel/login` era grafia velha.
- **O README não pode repetir "as telas do painel ficam fora da cota"** (§5.3).
- **`legal.ts` sem CSP vira item de escopo próprio, com prazo** (§16), e não uma nota que ninguém vai
  executar.
- **O ergonômico de `SameSite=Strict` precisa estar escrito**, com a mitigação obrigatória (§10.8).

**Revertidas ao valor do contrato, depois de conferência:**

- **Ligar a automação não exige step-up.** Uma versão intermediária deste documento marcou
  `/painel/chave` como "ao alargar" e listou "ligar a automação" entre as operações de step-up. Isso
  contrariava a linha canônica do contrato (`/painel/chave` … step-up **não**), a decisão explícita
  do material de origem ("volta ao estado anterior, que já era seu") e o próprio §10.12 deste
  documento, que diz que religar exige "sessão e confirmação explícita". Vale **não**: religar não
  muda valor nenhum, e cobrar biometria de quem acabou de usar o freio de emergência é punir o uso
  correto. §7.1 e §10.10 foram corrigidos, e §10.10 passou a explicar por quê.
- **"Sair de todos os aparelhos" tem endereço e não exige step-up.** A rota existia no corpus
  (`POST /painel/aparelhos`, `acao=sair_de_tudo`) e sumiu na compressão, ao mesmo tempo em que §7.1
  marcava a tela inteira como step-up "sim" — o que faria sair de todos os aparelhos pedir biometria,
  contra a regra de §10.10 de que **desligar é barato**. Restaurada em §10.13, com o step-up preso às
  operações que alargam (`remover_passkey`, `gerar_codigos`).
- **A proibição de atraso artificial na resposta** e a **regra de nunca exibir o `credential_id`
  inteiro na tela** existiam no corpus, evaporaram na compressão e voltaram — a primeira em §11.3
  (`sleep` no Worker é DoS a favor do atacante, contra o maior risco residual do projeto), a segunda
  em §10.13, fechando o terceiro dos três destinos que §9.9 e §11.7 já cobriam.
- **As chaves dos baldes de rate limit** (`"painel:"`, `"codigo:"`, `"parada:"` + `cf-connecting-ip`)
  voltaram a §7.4. Sem elas, o teste RL que afirma "a chave enviada é a esperada" não tinha
  especificação para verificar, e a separação por prefixo — que é o que impede o balde da parada e o
  do login se misturarem — não existia em lugar nenhum.
- **A "regra de forma" das rotas ganhou a exceção escrita** (§7.1): três POSTs só renderizam, e a
  tabela de rotas carrega `escreve: true | false` para que o metateste afirme a regra sem nascer
  contra o desenho.

**Recusadas, e por quê:**

- **Renomear `/painel/parada`.** O custo de coordenação é real e a URL nunca é digitada por um
  humano; o beco sem saída foi resolvido de forma mais barata, com o `303` de §11.6.
- **Separar `publicReplyText` numa tela própria** para que a regra do lote não arraste tudo. A
  premissa está errada: o texto público vive em `/painel/mensagem`, onde **todos** os campos já
  exigem step-up sempre — não há lote a arrastar. O que se acolhe é a metade certa da objeção: a tela
  precisa dizer, antes do gesto, que aquele toque cobre a tela inteira.
- **Trocar `SameSite=Strict` por `Lax`.** O custo é real e está registrado, mas com `Strict` nem a
  página autenticada chega a renderizar numa navegação hostil, favorito e atalho continuam
  funcionando `[I]`, e a mitigação custa uma linha.

---

## 16. Apêndice: achados fora do escopo deste trabalho

Nenhum destes itens é causado pelo painel. Três deles são corrigidos na **etapa 0** porque o painel
os agrava; os demais ficam registrados.

### 16.1 O teto de 50 subrequests quebra lotes de 10 ou mais comentários — **bug já existente**

Hoje, por comentário processado, o Worker gasta `findByCommentId` + `isUserInCooldown` +
`claimComment` + `markPrivateSent` + `markCompleted` = **5 consultas ao D1**, mais **2 por lote**
(`TokensRepository.get()` e `loadAccessToken`) `[C]`. Cada consulta ao D1 conta contra o teto de
**50 subrequests por invocação** `[C]`, e as chamadas à Meta contam no mesmo teto. Portanto:

```
10 comentários × 5 consultas + 2 do lote = 52 > 50   →  a invocação quebra
```

Um Reel viral produz webhooks com lotes grandes, e é exatamente aí que o dano é maior. **Isto é
independente do painel e existe hoje**, sem nenhuma linha nova. A correção é fatiar o lote — por
exemplo 5 comentários por invocação, com o resto reagendado pelo cron que já existe — e ela entra na
etapa 0, com um teste que afirma que um lote de 10 comentários executa menos de 50 consultas. O
painel só piora isso se a configuração for lida por comentário, e é por isso que §9.5 exige uma carga
por lote.

### 16.2 Código morto: `configForEvent`

`src/services/automation.ts:240` exporta `configForEvent`, e um grep em `src`, `tests` e `scripts`
não encontra **nenhuma** chamada `[C]`. Removê-lo na migração evita que sobre um segundo caminho
lendo configuração direto do módulo, justamente quando a origem da configuração passa a ser o banco.

### 16.3 `replace` cru em `src/index.ts:214`

A retentativa do cron monta o Direct com `.replace('{link}', ...)` **fora** de `renderTemplate`
`[C]`. Isso significa, ali: sem remoção de caracteres de controle, sem teto de tamanho, e trocando
apenas a **primeira** ocorrência. `renderTemplate` usa `replaceAll` e sanitiza `[C]`. Com o texto
vindo do banco, isso vira um segundo ponto de renderização não sanitizado — por isso a troca por
`renderTemplate` entra na etapa 0, antes de o painel existir.

### 16.4 `/privacy-policy` e `/data-deletion` servem `<style>` inline sem CSP

`src/routes/legal.ts:139` `[C]`. Como o painel passou a usar CSS externo e uma CSP sem nonce, o
mecanismo de nonce por resposta não entra no escopo deste projeto — mas duas páginas **públicas** de
um projeto que declara segurança como valor central continuam sem CSP nenhuma. **Recomendação:**
tratar como item de escopo próprio, com prazo, e não como nota. `legal.ts` não é movido nem editado
durante as etapas 0 a 15.

### 16.5 `/setup/authorize` não confere o método

O `switch` de `src/index.ts:74` não checa método `[C]`, então qualquer verbo cai no mesmo handler. A
correção é de uma linha (`405` com `Allow: GET`) e está prevista em §11.8, mas vale registrar que é
um achado independente do painel.

### 16.6 Índices de `processed_comments` encarecem o caminho quente

A tabela tem dois índices, então cada `INSERT` custa cerca de **3 escritas** `[C]`. Isso é uma
decisão correta hoje (os dois índices servem consultas reais), mas fixa uma regra para o futuro:
**nenhum índice novo em `processed_comments`**, nunca — inclusive para a tela de atividade, que
prefere varrer a tabela a encarecer cada comentário processado (§12.6).

### 16.7 Documentação que fica desatualizada com o painel

Precisa ser revisada na etapa 15: `scripts/configurar.mjs:12-19` (o manifesto anti-painel, que vira
"por que o painel é seguro"); `README.md` nos trechos sobre configuração por arquivo e sobre
`mediaAutomations`; `readmeiniciante.md`; `SECURITY.md` nos trechos sobre ausência de rate limit,
sobre superfície administrativa e sobre o modelo de ameaças; `SETUP_CLOUDFLARE.md` e `SETUP_META.md`
nos passos de deploy e de secrets; e a política de privacidade servida em `/privacy-policy`, que
ganha as três frases de §11.7.

### 16.8 O `SETUP_ADMIN_TOKEN` fica mais importante, e isso precisa ser dito

Com o painel, esse token deixa de proteger só o OAuth: ele passa a ser também a chave que **assina
convites de registro** e a credencial que **gera os códigos**. Quem tem esse token cadastra uma
passkey. Ele não vira menos importante — vira mais. É por isso que a chave de sessão é separada
(rotacionar o admin token não pode derrubar sessões, e vazar um convite não pode entregar a chave das
sessões), e é por isso que a documentação precisa dizer isso na mesma página em que ensina a gerar o
convite.
