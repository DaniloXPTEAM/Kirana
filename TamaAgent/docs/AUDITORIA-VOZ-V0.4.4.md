# Kirana v0.4.4 — barge-in por voz: auditoria, causa e correção

Correção do defeito relatado: a Kirana continua falando depois de "Kirana, pare".
Este documento segue a ordem pedida — **auditoria antes da solução**, com a causa
demonstrada no código e reproduzida em teste.

> **Limite desta entrega (declarado desde já):** a medição com microfone e voz
> reais **não** foi feita aqui. O ambiente do agente é Linux, Chromium headless
> (sem `speechSynthesis` com vozes, `getVoices() = []`) e **sem microfone**. Os
> testes provam a lógica e o cancelamento de áudio real no navegador; o
> comportamento acústico (inclusive se o Edge ouve a própria voz) depende do
> roteiro da seção 7, no seu Windows. Não declaro isso validado.

---

## 1. Auditoria — o caminho de "Kirana, pare" na v0.4.3

Arquivos inspecionados: `public/voice.js` (1.478 linhas), `public/voice-engine.js`,
`public/app.js`, `public/speech-text.js`, `src/voice/tts.js` (rota do servidor) e o
worker `src/voice/edge_tts_worker.py`.

### A. Reconhecimento (`public/voice.js`)

| Onde | O que fazia na v0.4.3 |
| --- | --- |
| `startRecognition()` | cria **um** `SpeechRecognition` (`continuous = true`, `interimResults = true`) e o mantém vivo |
| `onresult` | **primeira** verificação depois da validade da sessão: `if (micSuspended()) { history.phantomBlocked += 1; return; }` — descarta o resultado **antes de qualquer análise de texto** |
| `onend` | não reabre enquanto `micSuspended()` |
| `micSuspended()` | devolvia `'turn_busy'` quando `turnOpen \|\| speaking \|\| speechQueue.length` e `'mute_window'` nos 600 ms seguintes |
| `finishUtterance()` | ao enviar o turno chamava `suspendMic('turn_started')` e fazia `recognizerLive = false; recognition = null` — **abortava o reconhecedor** |

Consequência direta: **entre o envio da fala e o fim da resposta não existia
ouvinte nenhum**. Prova executada contra o código da v0.4.3:

```
estado durante a fala .................. falando
reconhecedor vivo durante a fala ...... false
após "Kirana, pare" (sessão abortada) . falando
trace de resultados descartados ....... result_final, result_from_stale_session
cancelamentos registrados ............. 0
```

O mesmo roteiro contra o código desta versão:

```
estado durante a fala .................. falando
reconhecedor vivo durante a fala ...... true
após "Kirana, pare" ................... interrompido
cancelamentos registrados ............. 1
```

### B. Roteamento

- Toda transcrição ia para `finishUtterance()` → `send(text, { source: 'voice' })`,
  isto é, **toda fala virava pergunta para o modelo**.
- **Não existia nenhum vocabulário de comando no projeto.** Busca por
  `pare de falar|barge.?in|stopCommand|'pare'` em `public/` e `src/`: nenhum
  resultado de interpretação — só comentários dizendo que o barge-in "fica para
  depois" e o `interrupt()` do botão.
- O estado `SPEAKING` não bloqueava o processamento (os resultados já haviam sido
  descartados no passo A).

### C. Reprodução

| Motor | Onde toca | Como cancelava | Quem chamava |
| --- | --- | --- | --- |
| navegador | `browserSpeech.speak()` (`playBrowserSegment`) | `browserSpeech.cancel()` (`voice-engine.js`, com `synthesis.cancel()` + resolução da promessa) | só `interrupt()` e `stopAll()` |
| servidor | `playResponse()` → `audio.play()` | `interrupt()`/`stopAll()`: `abortRequests()` (AbortController), `releasePlayback()`, `currentAudio.pause()` | idem |

- **`interrupt()` existia e funcionava, mas não tinha nenhum caminho a partir do
  reconhecimento**: era alcançável apenas por `toggle()` (toque no botão), pelo
  watchdog de travamento e por `Escape`.
- Existia proteção contra áudio atrasado por `epoch`, mas o `finally` do
  `drainQueue` não verificava a geração: um `await` antigo podia zerar `speaking`
  e `currentAudio` **de uma execução nova** — dois áudios simultâneos possíveis
  depois de interrupções rápidas.

### D. Causa demonstrada, em uma frase

Não havia microfone aberto nem interpretação de comando durante a fala: o
controlador era **meia-duplex por projeto** desde a v0.4.1 (o fechamento do
microfone era a defesa contra a autoescuta) e o único cancelamento disponível
(`interrupt()`) estava ligado apenas ao botão. "Kirana, pare" era, literalmente,
uma frase que ninguém podia ouvir.

---

## 2. Correção — arquitetura

### 2.1 Comando local, sem modelo (`public/voice-commands.js`, novo)

Módulo puro, sem DOM e sem rede: `isStopCommand()`, `normalizeSpeech()`,
`isWakeToken()`, `isStopToken()`, `isEchoOf()`, `distance()`.

- Normaliza acento, caixa, pontuação e espaços.
- Absorve erro de transcrição: `Kirana` aceita até 2 edições (`Quirana`,
  `Kimara`, `Kirara`, `Kyrana`…); há ainda a regra de **ordem no fim de fala
  curta** ("Mariana, pare"), que cobre a palavra de ativação irreconhecível.
- `para` é tratado como ambíguo (preposição): só vale no fim da frase ou junto de
  `de/tudo/agora`.
- **Não** interrompe por pergunta nem por negação: "por que o WhatsApp para de
  funcionar?", "quando você pode parar de falar?" e "não pare" são fala comum.
- Sem a palavra de ativação, a ordem só vale **curta e ancorada** e **apenas
  durante a fala** (`requiresWindow`), para nunca engolir a pergunta do usuário.

### 2.2 Microfone aberto durante a resposta (`onresult` reescrito)

Ordem das decisões — e é a ordem que conserta o defeito:

```
1. eco da própria voz   → descarta (proteção de autoescuta)
2. comando de parada    → interrompe (nunca vira pergunta)
3. turno em andamento   → descarta (não acumula, não envia)
4. resto                → transcrição normal
```

O passo 2 vem **antes** do 3; na v0.4.3 o 3 vinha antes de tudo e matava o
comando. `micSuspended()` deixou de fechar o microfone: agora só informa vozes
desligada/negada. `finishUtterance()` não aborta mais o reconhecedor.

### 2.3 Autoescuta (o que substitui o microfone fechado)

1. **Roteamento**: durante o turno nada é acumulado — só comando entra.
2. **Guarda de eco** (`isEchoOf`): compara com o que a Kirana está falando
   (`spokenText`, alimentado em `enqueueSpeech`) e descarta sobreposição ≥ 80% ou
   contenção literal. Comando de uma palavra só é eco se ela estiver dizendo
   exatamente essa palavra.
3. Contador `history.echoBlocked` e `report().echoGuard` para diagnóstico.

### 2.4 Cancelamento real (`cancelPlayback()`)

Um único caminho para o botão e para o comando, cobrindo as quatro formas de áudio
sobreviver a uma interrupção:

1. MP3 atual: `pause()` + `currentTime = 0` + `removeAttribute('src')` + `load()`;
2. fila: `speechQueue = []`;
3. requisições HTTP: `abortRequests()` (AbortController de cada pedido);
4. **callbacks atrasados**: `epoch += 1` **e** `drainGen += 1`; `drainQueue` só
   fala, mexe no estado ou libera `speaking` se `stillCurrent()`; `playResponse` e
   `playBrowserSegment` recusam áudio obsoleto na entrada.

Motor do navegador: `browserSpeech.cancel()` (que já resolve a promessa pendente,
senão a fila ficaria presa).

### 2.5 Máquina de estados

`idle → listening → processing → speaking → interrupted → listening`
(`VOICE_STATE`), com:

- `resumeListeningAfter()` — volta a "ouvindo" **mesmo com a sessão de
  reconhecimento já viva** (era o defeito que deixava o botão preso em
  "interrompido": sem sessão nova não havia `onstart`);
- trava de comando repetido (`commandRepeatMs`): o reconhecedor entrega o mesmo
  comando em interino + final, e sem isso uma ordem virava três interrupções;
- `bargeInListenMs`: logo depois do comando, a **continuação** da fala do usuário
  ("Kirana, pare — e o CRM?") volta a ser transcrita;
- histórico de estados agora grava `reason` (comando, silêncio, manual, eco…).

### 2.6 Interface

Sem tela nova. O aviso "Parei. Pode falar." usa o canal de avisos existente; a
interrupção emite `kirana:voice-bargein` e o `kiranaVoiceReport()` passa a mostrar
uma tabela com turno, palavra, motor, estado anterior e **latência medida**.

---

## 3. Arquivos e funções alterados

| Arquivo | O que mudou |
| --- | --- |
| `public/voice-commands.js` | **novo** — vocabulário e normalização do comando, guarda de eco |
| `public/voice.js` | `onresult` (roteamento), `micSuspended`/`commandWindow`, `finishUtterance` (não aborta o mic), `bargeIn`, `cancelPlayback`, `interrupt`, `resumeListeningAfter`, `drainQueue` (geração), `playResponse`/`playBrowserSegment` (guarda de época), `rememberSpoken`, `report`/`history`/`bargeIns` |
| `public/app.js` | `kiranaVoiceReport()` com a tabela de interrupções e o histórico de estados com motivo |
| `test/voice-commands.test.js` | **novo** — 22 testes do vocabulário |
| `test/voice-bargein.test.js` | **novo** — 19 testes de integração |
| `test/voice-behavior.test.js` | testes 13 e 13b reescritos para o contrato novo (mic aberto, eco bloqueado) |
| `test/browser/voice-flow.mjs` | +12 verificações reais de barge-in no navegador |
| `package.json`, `src/config.js`, docs | versão 0.4.4 |

Gateway, modelos, credenciais, `.env`, `data/` e o Voice da porta 1456: **intocados**.

---

## 4. Testes e resultados

| Suíte | v0.4.3 | v0.4.4 |
| --- | --- | --- |
| `node scripts/run-tests.mjs` | 298 | **340** (0 falhas) |
| `test/browser/voice-flow.mjs` | 48 | **60** (0 falhas) |
| `test/browser/demo-flow.mjs` | 15 | 15 |

Cobertura dos 12 itens pedidos (§9 do pedido):

| Item pedido | Onde |
| --- | --- |
| 1. reconhecer "Kirana, pare" durante a reprodução | bargein 1, 2 · navegador P4 |
| 2. variações fonéticas | commands 5, 6, 17 · bargein 3 |
| 3. interromper a voz do navegador | bargein 2, 10, 15 |
| 4. interromper a voz do servidor | bargein 1, 4, 6 |
| 5. cancelar segmentos pendentes | bargein 4, 6 |
| 6. ignorar callbacks/respostas atrasadas | bargein 5 |
| 7. não enviar o comando ao modelo | bargein 7, 8 |
| 8. voltar ao estado de escuta | bargein 9, 10, 16 |
| 9. sem falsos positivos | commands 11–15 · bargein 11 · navegador P4 |
| 10. sem mensagens duplicadas | bargein 19 · navegador "o comando NÃO vira mensagem" |
| 11. preservar a limpeza de Markdown | bargein 15 · `voice-speech-text` 19/19 |
| 12. preservar reconhecimento/pronúncia pt-BR | `voice-transcript` 12/12, `voice-engine` 17/17, `voice-behavior` 23/23, navegador 60/60 |

Latência medida **no navegador de teste** (Chromium + reconhecedor simulado,
áudio real): **1–2 ms** entre o resultado do reconhecedor e o áudio silenciado.
Isso mede o caminho interno (detecção → `pause()`); **não** é a latência
percebida no Windows, que inclui o tempo do reconhecedor até emitir o resultado.

---

## 5. Roteiro de validação no Windows (obrigatório — não foi feito aqui)

Pré-requisitos: `iniciar.bat` rodando, Edge, microfone permitido, painel de voz
aberto uma vez (para o catálogo). Em cada teste, ao final rode no console
(F12 → Console):

```js
await window.kiranaVoiceReport()
// tabela "interrupções por voz" → coluna latencia_ms
// tabela de segmentos → comparar texto exibido × enviado ao motor
```

| Teste | Como fazer | O que deve acontecer | O que registrar |
| --- | --- | --- | --- |
| **A** | Pergunte algo que gere resposta longa ("resuma as seis soluções"). Durante a fala diga **"Kirana, pare"** | áudio para em menos de ~0,5 s; aviso "Parei. Pode falar."; estado `interrompido → ouvindo` | `latencia_ms` |
| **B** | Interrompa **no primeiro segmento** (assim que a voz começar) | para antes do fim da primeira frase; nenhum áudio depois | estados + se sobrou áudio |
| **C** | Interrompa **entre dois segmentos** (no silêncio entre frases) | para e não toca o segmento seguinte | `queueSize` = 0 no relatório |
| **D** | Painel de voz → motor **Servidor (edge-tts)** → repita A | mesmo resultado; primeiro byte do servidor mais lento é esperado | motor `edge` no relatório |
| **E** | Depois de A, **sem recarregar**, pergunte outra coisa | resposta nova é falada normalmente | estados `ouvindo → processando → falando` |
| **F** | Interrompa **3 vezes seguidas** | nenhuma fala antiga reaparece; só a última resposta toca | `bargeIns` = 3 |
| **G** | Deixe a Kirana falar uma resposta longa **sem** dizer nada | ela **não** se interrompe sozinha; `history.echoBlocked` pode subir | `echoBlocked` e `micDuringPlayback` |

**Sinais de limitação acústica (para me reportar):** se no teste **G** o
`echoBlocked` não subir e a Kirana se interromper sozinha, o reconhecedor do Edge
está ouvindo o alto-falante. Nesse caso: (1) teste com fone de ouvido para
confirmar; (2) me mande a tabela de `bargeIns` com `heardChars` e `keyword` — eu
aumento a tolerância de eco ou exijo a palavra de ativação em toda interrupção.

---

## 6. Pendências e limitações reais

1. **Microfone e voz reais no Windows: não validados** (ambiente sem microfone;
   `speechSynthesis` headless sem vozes). Os 12 testes de navegador usam
   reconhecedor simulado com o áudio real do `<audio>`.
2. **AEC do reconhecedor do Edge não é controlável por código.** A proteção atual
   é de software (roteamento + eco). Se o Edge transcrever a própria voz da Kirana
   de forma agressiva, a alternativa documentada é exigir a palavra de ativação
   para interromper — mudança de uma linha em `voice-commands.js`.
3. **Latência percebida** depende do reconhecedor entregar o resultado (interino
   costuma chegar em 100–300 ms; o final, depois da pausa). Por isso o comando é
   aceito **também em resultado interino**.
4. `Interim` + eco: se o reconhecedor devolver um fragmento interino igual a uma
   palavra que a Kirana está dizendo naquele instante, ele é tratado como eco e
   ignorado — pode atrasar a interrupção em ~100 ms, nunca a impede.
5. Barge-in **não** autoriza nada: a confirmação de ações continua na tela
   (teste de HITL do navegador segue passando).
6. Push para o GitHub continua pendente (sem token neste ambiente): `.patch` e
   `.bundle` acompanham o ZIP.

---

## 7. O que o usuário precisa decidir depois do teste

- Se a interrupção funcionar bem: mantenho os limiares atuais.
- Se houver falso positivo com a própria voz: exijo a palavra de ativação.
- Se houver falso negativo (precisa repetir o comando): aumento a tolerância
  fonética e passo a aceitar ordens de até 2 palavras sem a palavra de ativação
  durante a fala.
