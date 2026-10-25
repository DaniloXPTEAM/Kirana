# Kirana v0.4.3 — P1 (markdown na fala), P2 (interface) e P3 (transcrição)

Correções dos três problemas do teste real de Windows da v0.4.2, na ordem pedida
(P1 → P2 → P3). Cada seção tem: sintoma, **causa comprovada no código** (não
suposição), correção, testes e o que **não** foi validado.

> **Limites desta entrega:** tudo foi executado no ambiente Linux do agente
> (Node 20, Chromium real, edge-tts 7.3.1 real). Nada foi ouvido no seu Windows:
> o `speechSynthesis` de Chromium headless não expõe voz (`getVoices() = []`) e
> não há microfone. Os testes de fala e de transcrição usam dublês **fiéis aos
> eventos reais** do navegador; o áudio e o microfone continuam dependendo do seu
> teste (roteiro na seção 4).

---

## P1 — a Kirana lia asteriscos de markdown

### Sintoma
A resposta era renderizada corretamente na tela, mas a voz lia
`**Modelo utilizado:**` como "asterisco asterisco Modelo utilizado...".

### Causa comprovada
`public/voice.js` **não importava nenhuma função de limpeza de texto**. A limpeza
existia apenas no servidor (`src/voice/tts-text.js`, dentro de `/api/voice/tts`).

- Motor do servidor (edge-tts): texto limpo. ✅
- Motor do navegador (`speechSynthesis`), que virou o **padrão** na v0.4.2: o
  texto cru de `appendDelta()` ia direto para `speak()`. ❌

Ou seja: a v0.4.2 criou um caminho novo e esqueceu a limpeza nele. Prova direta
no código da v0.4.2: `grep -n "sanitize\|toSpeechText" public/voice.js` → nada.

### Correção
1. **Implementação única**: a limpeza virou `public/speech-text.js` (ESM puro,
   zero dependências), importado **pelo cliente e pelo servidor**. Não existem
   mais duas cópias para divergir.
2. `public/voice.js` limpa **ao enfileirar** (`enqueueSpeech`), portanto vale
   para os dois motores. O diagnóstico guarda os dois textos:
   `textDisplayed` (o que está na tela, com markdown) e `textSent` (o que o motor
   recebeu).
3. `public/voice-engine.js` aplica a mesma limpeza como 2ª barreira em
   `speak()` (idempotente), para que nenhum chamador futuro repita o defeito.
4. `src/voice/edge_tts_worker.py` (2ª barreira do servidor, espelho da mesma
   política) foi alinhado: cercas ```/~~~, links em `<...>`, linha separadora de
   tabela e remoção dos marcadores `* _ ~ ` # | >`.

Regra de ouro mantida: **o texto exibido nunca é alterado**. O que muda é só a
versão falada:

| Entrada | Fala |
| --- | --- |
| `**Modelo utilizado:** GPT-6.` | `Modelo utilizado: GPT-6.` |
| `## Serviços` + lista `- WhatsApp` | `Serviços WhatsApp CRM` |
| `Veja [o site](https://x.com) para detalhes.` | `Veja o site para detalhes.` |
| `Use \`npm test\` antes.` | `Use npm test antes.` |
| bloco ```` ```js … ``` ```` | não é lido (nem as cercas, nem o código) |
| `\| Serviço \| Valor \|` + `\|---\|---\|` | `Serviço, Valor Plano, 500` |
| `R$ 1.500,00 (30%) — 2ª feira` | idêntico (nada é destruído) |

### Testes
`test/voice-speech-text.test.js` — **19 testes**, incluindo a verificação no
ponto de entrega: o que `speechSynthesis.speak()` recebeu (motor do navegador) e
o que foi no corpo do POST (motor do servidor).

---

## P2 — "dois agentes sobrepostos"

### Sintoma
A interface parecia ter dois agentes, um atrás do outro.

### Causa comprovada — três defeitos independentes, todos reproduzidos

1. **Texto do avatar vazando da bolha.** O avatar era `text: 'Você'` dentro de um
   quadrado de 34 px com `overflow: visible`. Em `deviceScaleFactor` 2–3 o texto
   não centraliza e **transborda para fora do quadrado**. No primeiro screenshot
   deste ciclo, esse vazamento aparecia na tela como um selo "Voz" cortado sobre
   a bolha — o "elemento duplicado" que você viu. Medido: o caractere sai do
   círculo e fica por cima do conteúdo da mensagem.
2. **Cartão de boas-vindas empilhado com a conversa.** `hideWelcome()` só era
   chamado em `createAssistantShell()` — isto é, a tela mostrando "Oi! Eu sou a
   Kirana" (rosto + título + sugestões) **acima** da conversa em andamento só
   desaparecia no fim da primeira resposta. Durante todo o começo do turno havia
   dois blocos de Kirana na tela: exatamente "um escondido atrás do outro".
3. **Painel de voz empilhado abaixo do compositor.** O painel da v0.4.2 era um
   bloco no fluxo: 181 px no desktop e **317 px no celular** (medido), empurrando
   e encolhendo o chat (de 731 px para menos, conforme o conteúdo). Somado ao
   item 2, a tela virava uma pilha de blocos.

Extras verificados e corrigidos: o avatar da Kirana nas mensagens era a **letra
"K"** enquanto o cabeçalho e a tela inicial usavam o **rosto** — duas
representações da mesma agente.

### Correção
1. Avatar do usuário = ícone de pessoa; avatar da Kirana = a **mesma face** do
   cabeçalho (`#kirana-face`). `.msg-avatar` ganhou `overflow: hidden`: nenhum
   conteúdo pode transbordar, em nenhum tamanho de fonte do sistema.
2. `hideWelcome()` no primeiro sinal de conversa (envio do usuário **e** início
   da resposta), não só no fim da primeira resposta.
3. Painel de voz virou **popover** acima do compositor (`position: absolute`),
   fecha com Esc e ao clicar fora, e tem `max-height: 58vh` com rolagem no
   celular. Medido: o chat **não muda de altura** (682 → 682 px) ao abrir/fechar.
4. Dica do painel distingue "ainda buscando" de "servidor respondeu sem vozes"
   (antes a mesma frase aparecia nos dois casos e parecia defeito).

### Testes
Cinco verificações novas em `test/browser/voice-flow.mjs` (navegador real, DOM
real): nenhum avatar transborda, face única da Kirana, avatar do usuário sem a
palavra "Você", cartão de boas-vindas fora da tela quando a conversa começa,
nenhuma bolha sobreposta — mais duas de layout do painel (flutua, cabe na tela,
Esc não mexe no chat).

---

## P3 — transcrição com palavras repetidas

### Sintoma
Transcrição com palavras repetidas e termos errados ("Smiles" para algo dito em
português).

### Causa comprovada
No `onresult` da v0.4.2, todo resultado **final** era concatenado ao acumulado e
a única proteção era `transcript.endsWith(clean)` — isto é, só o caso de o final
ser *exatamente igual* ao texto já acumulado.

Isso cobre uma das duas instabilidades reais do `SpeechRecognition`:

| Comportamento real do motor | v0.4.2 |
| --- | --- |
| reenvia o mesmo final | tratado (`endsWith`) |
| reenvia um final que **começa** com o que já foi confirmado | **duplicava** ("Quero saber sobre os" + "Quero saber sobre os serviços") |
| interino depois do final, contendo o final | duplicava na hora de fechar o enunciado |
| repetição imediata de palavra ("eu **eu** quero") | não tratada |
| final já confirmado **não pode ser corrigido** | o acumulado era a soma de todos os finais; o palpite fonético errado ficava gravado para sempre |

O último item explica a persistência de um termo trocado: com a soma de finais,
o motor não tinha como "voltar atrás".

### Correção
Função nova `mergeRecognition(committed, incoming, { final })` em
`public/voice.js`:

- **overlap por palavras** entre o fim do confirmado e o começo do novo,
  comparando sem pontuação (o motor muda a vírgula conforme o palpite);
- só o **sufixo inédito** entra;
- evento repetido não muda nada (`changed: false`);
- **interino é sempre substituído**, nunca somado; quando só repete o
  confirmado, é descartado;
- `collapseRepeats()` remove repetição imediata de palavra.

Além disso, um defeito colateral sério foi encontrado e corrigido: se o
reconhecedor deixasse um **interino pendente para sempre** (o usuário para de
falar e nunca vem `isFinal`), a v0.4.2 rearmava o silêncio indefinidamente — a
fala aparecia na tela e **nunca era enviada**. Agora existe `interimGraceMs`
(1.200 ms): interino que não muda nesse tempo é aceito e o turno segue.

### Testes
`test/voice-transcript.test.js` — **12 testes**: unidade do merge (6) e
controlador com os padrões reais do motor (evento repetido, final reemitido,
interino contendo o final, interino repetido, interino que troca de ideia, turno
duplicado na janela de 2 s).

---

## 1. Causa dos três problemas em uma frase cada

1. **P1**: a v0.4.2 estreou o motor do navegador sem a limpeza de texto que só
   existia no servidor.
2. **P2**: texto de avatar transbordando do quadrado + cartão de boas-vindas que
   só saía no fim da primeira resposta + painel de voz empilhado no fluxo.
3. **P3**: merge de resultados por "termina com?" em vez de sobreposição — e
   interino somado ao confirmado; mais um interino pendente que travava o envio.

## 2. Arquivos alterados

| Arquivo | Por quê |
| --- | --- |
| `public/speech-text.js` | **novo** — texto falado, usado pelo cliente e pelo servidor |
| `src/voice/tts-text.js` | passa a reexportar o módulo compartilhado (uma implementação) |
| `src/voice/edge_tts_worker.py` | 2ª barreira alinhada (cercas, links `<…>`, tabela, marcadores) |
| `public/voice.js` | limpa ao enfileirar; `mergeRecognition`, `collapseRepeats`, `interimGraceMs`; diagnóstico com `textDisplayed`/`textSent` |
| `public/voice-engine.js` | limpeza de segurança em `speak()`; `sanitize: false` para prévia já limpa |
| `public/app.js` | avatares (face da Kirana / ícone do usuário), `hideWelcome` no envio, painel popover, dica de catálogo |
| `public/styles.css` | `.msg-avatar` com `overflow: hidden`, estilos dos avatares, painel flutuante |
| `test/voice-speech-text.test.js` | **novo** — 19 testes (P1) |
| `test/voice-transcript.test.js` | **novo** — 12 testes (P3) |
| `test/browser/voice-flow.mjs` | +8 verificações (P2) |
| `package.json`, `src/config.js` | versão 0.4.3 |

## 3. Testes executados

| Suíte | Antes (v0.4.2) | Agora |
| --- | --- | --- |
| `node scripts/run-tests.mjs` | 267 | **298** (0 falhas) |
| `test/browser/voice-flow.mjs` | 40 | **48** (0 falhas) |
| `test/browser/demo-flow.mjs` | 15 | 15 |

Nada foi removido; as 267 verificações anteriores continuam passando, o que
protege as melhorias de velocidade e pronúncia da v0.4.2 (o pipeline entre
frases, o JSON ASCII até o Python e o catálogo de vozes seguem iguais).

**Teste instável corrigido (achado na validação do ZIP).** A verificação
"toque durante a fala interrompe" esperava o estado `interrompido`, que é
transitório — a Kirana volta a ouvir em seguida. Passava 48/48 numa rodada e
47/48 na seguinte, conforme a carga da máquina (não era defeito de produto: o
áudio era pausado e o estado final era `ouvindo`). Agora a checagem espera a
transição aparecer no **histórico de estados** (`kiranaVoice.history.states`),
que é prova estável do mesmo comportamento, e o estado final continua
verificado. Duas execuções seguidas no diretório extraído: 48/48 e 48/48.

## 4. O que você precisa testar no Windows (não foi validado aqui)

```bat
cd "C:\CRiando coisa nova\Kirana\..."   :: pasta onde a v0.4.3 foi extraída
node scripts/doctor.mjs
npm test
iniciar.bat
```

**P1** — no painel de voz, escolha `Microsoft Francisca … (navegador)` e depois
`Thalita … (servidor)`. Peça: *"Resuma os serviços da Opportunity AI em uma
lista com negrito nos nomes."* → **nenhum asterisco, cerquilha, crase ou barra
pode ser falado** nos dois motores.

**P2** — tela inicial e primeira pergunta: o cartão "Oi! Eu sou a Kirana" precisa
sair assim que a conversa começa; nenhum texto pode aparecer fora das bolhas;
abrir/fechar o painel de voz não pode mudar o tamanho do chat.

**P3** — fale devagar frases com pausas (*"Quero… saber… sobre os serviços"*) e
confira a mensagem enviada: sem palavras repetidas. Se aparecer termo trocado,
ele agora **não fica preso**: o próximo resultado corrige o acumulado.

Se algo falhar, me mande: `kiranaVoiceReport()` (mostra `textDisplayed` ×
`textSent`), a transcrição que apareceu na tela e a linha do `doctor` sobre
acentuação.

## 5. Pendências reais

1. **Áudio do `speechSynthesis`** continua não medido aqui (headless sem vozes).
2. **`SpeechRecognition` real** não roda aqui: os 12 testes de P3 usam os
   padrões documentados do motor. O comportamento do seu microfone pode ter
   outras variações — se aparecer, o `trace` do controlador já registra
   `result_final`/`result_interim` por palavra.
3. **Um termo foneticamente errado** ("Smiles") não é corrigível por merge: é
   limitação do reconhecedor do navegador. O que a v0.4.3 garante é que ele não
   se multiplica e que um resultado melhor pode substituí-lo.
4. **Barge-in por voz** segue só projetado (interrupção é pelo botão/toque).
5. O push para o GitHub continua pendente (sem token neste ambiente) — o bundle
   e o patch estão na área de trabalho.
