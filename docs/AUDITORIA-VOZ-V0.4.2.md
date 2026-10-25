# Kirana v0.4.2 — voz: pronúncia, motor do navegador e latência

Investigação e implementação pedidas depois do teste real de Windows da v0.4.1.
Segue a ordem do pedido: auditoria comparativa com o laboratório Voice, causa
comprovada, o que foi implementado, medições, testes e o que **não** foi
validado.

> **Limite desta entrega:** tudo aqui foi medido no ambiente Linux do agente
> (Node 20, edge-tts 7.3.1 real, Chromium real). **O microfone, os alto-falantes
> e as vozes do Windows só existem na sua máquina.** O `speechSynthesis` do
> Chromium *headless* não expõe voz nenhuma (medido: `getVoices() = []` também
> com `speech-dispatcher` instalado), então o caminho do navegador está provado
> por teste de comportamento, **não** por áudio neste ambiente. O Teste F da
> seção 7 é o que fecha isso.

---

## 1. Auditoria comparativa (Fase 1) — o que o laboratório faz de diferente

Arquivos lidos: `examples/voice-client/{app.js, providers.js, server.mjs, voice.html,
edge-tts-adapter.js, edge-tts-runner.mjs, edge_tts_worker.py}` do
`Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip` (o mesmo conteúdo do
`Kirana-Voice-CSP-Fix-v0.4.0` que você rodou em `127.0.0.1:1456`).

| Aspecto | Laboratório Voice | Kirana v0.4.1 | Consequência |
| --- | --- | --- | --- |
| Síntese "Thalita" | worker Python `edge-tts`, **um processo por frase** (`child.stdin.end(JSON.stringify({text}))`) | idêntico | **mesmo custo** de processo e de rede |
| Síntese "Francisca" | `window.speechSynthesis` (voz do navegador/SO) | **não existia** | é aqui que o laboratório ganha: sem Python, sem rede |
| Streaming do MP3 | MediaSource + append incremental | igual | — |
| Segmentação | fim de frase (`[.!?。\n]`) + corte em 220 caracteres **no espaço** | fim de frase + limite de 320 no espaço (v0.4.1) | iguais em espírito |
| Pipeline entre frases | `processSpeechQueue` sequencial, **sem** pré-busca | pipeline com pré-busca (v0.4.1) | Kirana melhor aqui |
| Interrupção | `speechGeneration++`, `edgeTts.cancel()`, `speechSynthesis.cancel()` | equivalente | — |
| Codificação Node→Python | `JSON.stringify` cru em UTF-8 | idêntico na v0.4.1 | **o defeito era o mesmo nos dois** |
| Fallback | Thalita → Francisca no mesmo turno | não existia | v0.4.2 tem: navegador ↔ servidor |
| Vozes | Thalita (servidor) + Francisca (navegador) | só Thalita | v0.4.2 tem catálogo + escolha |

**Conclusão da auditoria:** o laboratório não tem um "motor de voz" melhor — ele
usa **dois** caminhos e, no seu teste, o que soou melhor foi a **Francisca do
navegador**, que não passa por Python nem por rede. Quando o laboratório usa a
Thalita, ele paga a mesma latência e tem o mesmo risco de codificação da Kirana.

---

## 2. Causa comprovada — pronúncia

### 2.1. Codificação do stdin do Python (Windows)

`src/voice/tts.js` enviava `child.stdin.end(JSON.stringify({ text, rate }))`:
bytes UTF-8 crus. O Python lê `sys.stdin` com a codificação do **locale**; num
pipe do Windows essa codificação é a página ANSI (**cp1252** em pt-BR), não UTF-8.

**Evidência medida (não teórica):**

| Teste | Resultado |
| --- | --- |
| Worker lendo UTF-8 (Linux/sandbox) | 20 736 bytes de áudio |
| **O mesmo texto com stdin decodificado como cp1252** | **25 344 bytes** (+4 608, áudio diferente) |
| Texto que o worker recebia nesse caso | `"A inteligÃªncia artificial estÃ¡ aprendendo portuguÃªs."` |
| Mesma frase correta vs. corrompida, direto no edge-tts | 20 736 vs 26 640 bytes (**+28% de áudio**) |

Ou seja: o motor **pronunciava outra coisa** — o texto com acentos mutilados. É
exatamente o sintoma "erros de pronúncia muito superiores" relatado.

**Correção (três barreiras, nenhuma custosa):**
1. `toAsciiJson()` em `src/voice/tts.js` — o JSON vai com escapes `\uXXXX`, então
   não existe byte acima de 0x7F no stdin;
2. `pythonUtf8Env()` — o filho recebe `PYTHONUTF8=1` e `PYTHONIOENCODING=utf-8`;
3. `_read_payload()` no worker — `sys.stdin.reconfigure(encoding="utf-8")`.

**Verificação no seu computador:** `node scripts/doctor.mjs` agora tem a linha
*"Voz: acentuação até o motor"*. Ela roda o worker com uma frase de prova e
compara o que ele **realmente recebeu**.

### 2.2. Corte no meio da palavra

`takeSpeakableSentences()` cortava em `maxChars` quando não achava espaço antes do
limite — uma palavra longa podia sair partida em dois áudios. Corrigido: o corte
acontece **sempre** em espaço; só um "token" absurdo (mais que o dobro do limite,
ex.: URL gigante sem separador) é cortado. Teste novo:
*"16c. o texto falado nunca é cortado no meio de uma palavra"*.

### 2.3. Sobre a "soletração" de "eleições"

Não vou afirmar uma causa única sem prova. O que foi **medido**:

| Entrada | Áudio |
| --- | --- |
| "eleições" (palavra sozinha) | 11 232 bytes |
| "e l e i ç õ e s" (letras separadas) | 16 128 bytes (**+43%**) |
| frase com acentos corrompidos | +28% de áudio vs. correta |

Duas coisas produzem exatamente esse sintoma — texto corrompido e texto
fragmentado — e **as duas** estavam presentes na v0.4.1 (codificação e corte
possível). Ambas foram eliminadas. Se ainda houver soletração na sua máquina, o
`doctor` e o `kiranaVoiceReport()` vão mostrar o texto real que chegou ao motor,
que é o dado que falta para fechar a causa.

---

## 3. O que foi implementado (Fases 2 a 5)

### 3.1. Dois motores, escolhidos na interface

| Motor | Como fala | Quando usar |
| --- | --- | --- |
| **Navegador** (`browser`) | `window.speechSynthesis` — voz do próprio Windows/Edge | padrão quando o navegador expõe voz pt-BR: **sem Python, sem rede**, começa em dezenas de ms |
| **Servidor** (`edge`) | worker Python + edge-tts, MP3 em stream | funciona em qualquer navegador; mantém Thalita e o que já existia |
| **Automático** (`auto`, padrão) | navegador se houver voz pt-BR; senão servidor | não deixa ninguém sem voz |

Arquivo novo: **`public/voice-engine.js`** — catálogo de vozes, escolha,
preferência, fala/cancelamento do navegador. `public/voice.js` passou a chamar o
motor escolhido; fila, interrupção, meia-duplex e diagnóstico continuam os mesmos
para os dois.

### 3.2. Vozes configuráveis (Fase 4)

- **Catálogo unificado**: vozes pt-BR do navegador + vozes pt-BR do servidor
  (`GET /api/voice/voices` → 17 vozes aceitas, incluindo `pt-BR-FranciscaNeural`).
- **Ordem de preferência**: voz salva → **Francisca** → Thalita → Maria/Helena/
  Antônio/Daniel → voz pt-BR padrão do sistema → qualquer pt-BR.
- **Seleção manual** no painel novo (botão de alto-falante ao lado do microfone):
  Motor, Voz, Velocidade e **Ouvir prévia** (frase curta, não entra no histórico e
  não chama o modelo).
- **Persistência** em `localStorage` (`kirana.voz.preferencias.v1`); a escolha
  sobrevive a recarregar e vale para a próxima sessão.
- **Nada de código-fonte**: trocar voz/motor é só usar o painel.
- **Francisca não substitui Thalita**: as duas continuam disponíveis e a Thalita
  segue sendo o padrão do **servidor**.

### 3.3. Preparação do texto (Fase 3)

- Fonte única do texto falado (o mesmo texto exibido, passado pela limpeza);
- sem asteriscos, crases, listas, links ou emojis (allowlist da v0.4.1 mantida);
- acentos preservados de ponta a ponta (correção da seção 2);
- palavras inteiras (correção 2.2);
- uma limpeza por barreira, não três: JS limpa, o worker reaplica a mesma política
  como 2ª barreira (defesa contra chamada direta ao endpoint), sem reescrever o
  texto duas vezes na prática.

### 3.4. Latência (Fase 6)

| Componente | Medido aqui | Observação |
| --- | --- | --- |
| Primeiro texto do modelo | 2,4 s no seu teste do laboratório | depende do gateway/modelo, não da voz |
| Processo Python + `import edge_tts` | **217 ms** (mín. de 3) | só no motor do servidor |
| Primeiro byte do edge-tts | **642–667 ms** (mediana; `npm run voice:bench`) | na sua rede foi 4,3 s (média) |
| Caminho do navegador | **0 ms** de rede/processo | depende do sistema; começa ao chamar `speak()` |

O motor do navegador **remove** os dois últimos componentes: é a diferença
estrutural entre "esperar o provedor" e "pedir ao sistema operacional".

Não declaro número de "início da fala" no Windows: isso é o Teste F.

---

## 4. Testes

### 4.1. Automatizados

| Suíte | Antes | Agora |
| --- | --- | --- |
| `node scripts/run-tests.mjs` | 241 | **267** |
| `test/browser/voice-flow.mjs` | 34 | **40** |
| `test/browser/demo-flow.mjs` | 15 | 15 |

Novos: `test/voice-engine.test.js` (17 testes: catálogo, escolha, preferência,
fala, cancelamento, integração com a fila e a interrupção) e 3 testes de servidor
(JSON ASCII, voz fora da lista, `/api/voice/voices`, self-check) + 1 de
segmentação.

### 4.2. Como os Testes A–G do pedido ficam cobertos

| Teste do pedido | Cobertura |
| --- | --- |
| **A — Acentuação** ("eleições", "inteligência", "português") | `o texto chega ao worker em JSON ASCII`, `toAsciiJson escapa acentos`, `self-check`, `doctor`; e o teste de comportamento 4 |
| **B — Markdown** (`**Modelo utilizado:** GPT-6.`) | teste 3 (marcação não chega ao motor) |
| **C — Texto longo** | testes 2, 2b, 6, 6b, 16c (ordem, sem repetição, sem corte de palavra) |
| **D — Interrupção** | testes 7, 8, 9 + navegador (`áudio é pausado de verdade no barge-in`) |
| **E — Troca de voz** | `escolha do usuário é salva e respeitada na sessão seguinte` + navegador (`escolher voz do servidor muda o motor`, `preferência de voz fica salva`) |
| **F — Desempenho** | `npm run voice:bench` (servidor) e **Teste F manual** para o navegador |
| **G — Regressão** | 267 testes + 40 de voz + 15 do demo: chat, gateway, sessões, streaming, HITL, microfone, interface, fallback |

---

## 5. O que ainda não está provado

1. **Áudio real do `speechSynthesis`.** O Chromium headless deste ambiente não
   expõe voz (`getVoices() = []`, inclusive com `speech-dispatcher`). A prova é
   por teste de comportamento com dublê fiel de eventos, não por som.
2. **Se a sua máquina corrompia o texto.** O mecanismo está reproduzido e a
   correção é imunizante, mas o "antes" da sua máquina não foi medido. O
   `doctor` responde isso em 1 segundo.
3. **Latência no Windows** de cada motor — só o Teste F responde.
4. **Barge-in por voz** continua não implementado (só projetado).
5. **Vozes do Windows**: quais nomes exatos o seu Edge expõe depende do Windows
   (as "Online (Natural)" aparecem no Edge; no Chrome costumam ser menos).

---

## 6. Arquivos alterados nesta versão

| Arquivo | Por quê |
| --- | --- |
| `public/voice-engine.js` | **novo** — motores, catálogo, escolha, preferência, fala do navegador |
| `public/voice.js` | usa o motor escolhido; pipeline/diagnóstico por motor; corte sem partir palavra |
| `public/app.js` | painel de voz (motor, voz, velocidade, prévia); relatório com motor/voz |
| `public/index.html`, `public/styles.css` | botão e painel de escolha de voz |
| `src/voice/tts.js` | JSON ASCII + ambiente UTF-8, voz por requisição, catálogo, `selfCheck()` |
| `src/voice/edge_tts_worker.py` | stdin UTF-8 garantido, lista de vozes pt-BR, `--self-check` |
| `src/server.js` | `GET /api/voice/voices`, `voice` no `/api/voice/tts`, balde próprio de limite |
| `scripts/doctor.mjs` | checagem "acentuação até o motor" |
| `test/voice-engine.test.js` | **novo** — 17 testes |
| `test/voice-behavior.test.js`, `test/voice-server.test.js`, `test/browser/voice-flow.mjs` | testes novos/ajustados |
| `package.json`, `src/config.js` | versão 0.4.2 |

---

## 7. Como testar na sua máquina (Teste F incluído)

```bat
cd "C:\CRiando coisa nova\Kirana\kirana-fase1-v0.1.0\kirana\Kirana"
corepack pnpm install --frozen-lockfile
python -m pip install "edge-tts==7.3.1"
npm test
diagnostico.bat          :: veja "Voz: acentuação até o motor"
iniciar.bat
```

No navegador (Edge de preferência, que tem as vozes "Online (Natural)"):

1. clique no botão de **alto-falante** ao lado do microfone;
2. **Motor**: `Automático`; **Voz**: escolha `Microsoft Francisca …` (navegador);
3. **Ouvir prévia** → deve falar quase imediatamente;
4. fale **"As eleições brasileiras aconteceram normalmente. A inteligência
   artificial está aprendendo português. Olá! Você está ouvindo a Kirana."** →
   nenhuma palavra soletizada/mutilada;
5. pergunte algo que responda com negrito (`**Modelo utilizado:**`) → não pode
   falar "asterisco";
6. peça um texto longo (vários parágrafos) → sem repetição nem sobreposição;
7. interrompa pelo botão durante a fala → para na hora e não volta;
8. troque a voz para `Thalita … (servidor)`, repita a prévia e reconheça:
   **as duas precisam funcionar**;
9. recarregue a página → a voz escolhida continua escolhida;
10. cinco turnos seguidos, sem travar em "Falando"/"Ouvindo".

**Meça o Teste F** (no console do navegador, com a voz ativa):

```js
kiranaVoiceReport()   // tabela por segmento: motor, voz, texto enviado, tempos
```

Anote, por motor: tempo até o 1º texto (`ttsStart` do 1º segmento), até o 1º som
(`playbackStart`), total da resposta e tempo de interrupção. Esses são os números
que vão para o relatório final — os meus são de outra máquina.
