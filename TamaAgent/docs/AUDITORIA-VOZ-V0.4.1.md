# Auditoria e correção do sistema de voz — v0.4.1

Relatório da correção aplicada sobre a v0.4.0 (Marco 3). Cobre os sete defeitos
relatados no teste real de Windows, com **sintoma → causa comprovada → evidência
→ arquivo/função → correção → teste → limitação** para cada um.

> **Estado da validação:** tudo aqui foi medido e testado no ambiente Linux de
> desenvolvimento (Node 20.20.2, Edge TTS real, Chromium real). **O teste A–E no
> Windows do usuário ainda não foi feito** — as instruções estão na seção 9. Nada
> neste documento afirma que a correção está validada na máquina do usuário.

---

## 1. Resumo das correções

| # | Sintoma relatado | Causa comprovada | Correção | Arquivo |
| --- | --- | --- | --- | --- |
| 1 | Kirana respondia duas vezes / repetia a resposta inteira | `endTurn()` aceitava um `text` de fallback (`\|\| text`) e o app passava a resposta inteira | `endTurn()` não recebe texto; fim de turno só sinaliza | `public/voice.js`, `public/app.js` |
| 2 | A própria voz entrava como mensagem do usuário | o microfone reabria quando **a fila de fala esvaziava** (meio da resposta), não no fim do turno | microfone suspenso por todo o turno + janela surda de 600 ms + token por sessão | `public/voice.js` |
| 3 | Palavra "Libra" no áudio sem estar no texto | o glifo `£` (e `♎`) **passava** pelo filtro e o motor Edge TTS lê `£` como "libra" | allowlist de caracteres faláveis (2ª barreira no worker Python) | `src/voice/tts-text.js`, `src/voice/edge_tts_worker.py` |
| 4 | Áudio diferente do texto | mesma origem do item 3 + residual de seletor de variação (`U+FE0F`) | allowlist única, resíduo tratado, `analyzeSpeechText()` informa o que caiu | idem |
| 5 | Silêncio de ~5 s entre frases | a próxima síntese só era pedida **depois** do `ended` da anterior | pipeline: próxima frase é pedida no `playing` da atual | `public/voice.js` |
| 6 | Travava em "Falando"/"Ouvindo" | estados mudavam de forma implícita; sem retomada agendada | máquina de estados explícita + `releasePlayback()` + `scheduleResume()` + cão-de-guarda de 20 s | `public/voice.js` |
| 7 | Sem como diagnosticar | nenhum registro do que foi enviado ao motor | `diagnostics` por segmento + `GET /api/voice/diagnostics` + `kiranaVoiceReport()` | `src/voice/tts.js`, `src/server.js`, `public/app.js` |

Testes: **219 → 241** na suíte (22 novos de comportamento de voz) e **34/34** de
navegador com áudio real, sem erro de console.

---

## 2. Autoescuta (half-duplex)

**Sintoma.** Depois da primeira resposta, a fala da própria Kirana aparecia no
chat como mensagem do usuário; às vezes apareciam quatro reconhecedores ativos e
uma mensagem fantasma.

**Causa comprovada.** Em `public/voice.js` (v0.4.0), `drainQueue()` chamava
`startListening()` assim que `speechQueue.length === 0` — ou seja, **no meio da
resposta**, entre duas frases, enquanto o áudio da frase anterior ainda tocava no
alto-falante. Fechar o microfone durante o `send` não bastava: ele voltava a
abrir no primeiro intervalo entre frases.

**Evidência.** `/tmp/repro4.mjs` (dublês de `SpeechRecognition`/`Audio`/`fetch`):
v0.4.0 → **4 reconhecedores criados** e uma mensagem fantasma entregue ao
`send()`; v0.4.1 → **1 reconhecedor**, **0 fantasmas**. Testes
`11. resultado atrasado de sessão antiga é descartado na origem`,
`13. prevenção de autoescuta` e `13b. o microfone fica fechado entre frases`
(falham na v0.4.0, passam na v0.4.1).

**Correção** (`public/voice.js`):
- `suspendMic(reason)` no começo do turno (antes do `send`) e em toda fala;
- `micSuspended()` é verdadeiro enquanto: turno aberto, sintetizando, fila com
  itens, ou dentro da janela surda (`muteAfterSpeechMs: 600`) contada **do fim do
  áudio**;
- `micToken` incrementado a cada suspensão: um `onresult` que chegue de um
  reconhecedor antigo é descartado por `isCurrent()` e contado em
  `history.phantomBlocked`;
- `scheduleResume()` é o único caminho que reabre o microfone — sem ele a Kirana
  ficava muda depois da primeira resposta.

**Limitação.** Isto é *half-duplex*: enquanto fala, a Kirana não ouve. Interromper
**falando** (barge-in por voz) **não está implementado** — está apenas projetado na
seção 10. A interrupção disponível é pelo botão/toque.

---

## 3. Palavra "Libra"

Rastreamento em 11 etapas: `texto do agente → app.js → appendDelta → buffer →
takeSpeakableSentences → sanitizeTextForSpeech (JS) → POST /api/voice/tts →
sanitize_text (Python) → edge-tts → MP3 → <audio>`.

**Causa comprovada.** O filtro da v0.4.0 removia emoji por
`\p{Extended_Pictographic}` e deixava passar **símbolos** como `£` (U+00A3),
`♎` (U+264E), `©`, `®`, `°`, `ª`. O motor Edge TTS **lê** `£` como "libra" e `♎`
como "libra"/"balança". Não era o texto do agente, nem markdown, nem vazamento do
gatilho: era um caractere que estava no texto e chegava ao motor.

**Evidência (medida com edge-tts 7.3.1 real, voz Thalita, `+8%`)** — tamanho do MP3
para a mesma frase-base (11 664 bytes):

| Texto falado | Bytes | Δ |
| --- | --- | --- |
| base | 11 664 | — |
| com `£` | 16 272 | **+4 608** |
| com a palavra "Libra" | 16 560 | **+4 896** |
| com `♎` | 16 848 | +5 184 |
| com `⚖️` | 19 728 | +8 064 |
| com `✅` | 17 424 | +5 760 |
| com `©` | 15 264 | +3 600 |

`£` e "Libra" produzem praticamente o mesmo acréscimo de áudio — o sintoma
("aparece Libra") é o motor pronunciando o símbolo. Testes 5, 5b e 5c cobrem
isso: `5b. o glifo £ (lido como "libra") nunca chega ao motor`.

**Correção.** Política única de allowlist, nas duas barreiras:
- `src/voice/tts-text.js` — `isSpeakableChar()`: letras (`\p{L}`), números
  (`\p{N}`), marcas (`\p{M}`) e a pontuação `.,;:!?'"()[]{}«»-–—…%/$°`; seletores
  de variação e keycap (`U+FE00–FE0F`, `U+20E3`, `U+E0100–E01EF`) são removidos;
- `src/voice/edge_tts_worker.py` — `sanitize_text()` usa a mesma política
  (`_is_speakable_char` + `ALLOWED_PUNCTUATION`) como 2ª barreira no servidor.

Preserva o que importa: `R$ 1.500,00`, `30%`, `30°C`, `1ª`, `1º`. `1️⃣` vira `1`
(antes sobrava o resíduo `U+FE0F`).

**Limitação.** A allowlist é conservadora: um idioma com outro alfabeto
continua funcionando (`\p{L}`), mas sinais matemáticos (`+`, `=`, `≈`) e `&` não
são falados. Nenhum deles aparece nas respostas atuais da Kirana.

---

## 4. Áudio ≠ texto

**Correção.** Fonte única: o texto que vai ao motor é **o mesmo** texto exibido,
passado pela limpeza de fala; não existe mais segundo caminho (`text` no
`endTurn`). Cada segmento carrega `turnId` e `segmentId` (`{turno}-{segmento}`),
enviados no corpo do `POST /api/voice/tts` e devolvidos no header
`X-Kirana-Segment`; o servidor registra `receivedChars`, `text_sent_to_tts`,
`dropped`/`droppedChars`, tempos e bytes.

**Cancelamento.** `interrupt()` → pausa o áudio, `abort()` no `fetch` (o servidor
mata o worker Python), limpa a fila, incrementa o `epoch`; respostas que cheguem
depois são descartadas antes de tocar. Testes 7, 8 e 9.

**Limitação.** O cancelamento é garantido no cliente e no servidor; um MP3 já
entregue ao buffer do `<audio>` pode emitir alguns milissegundos antes do
`pause()` — inerente ao navegador, não ao código.

---

## 5. Latência entre frases

Medição separada do que a v0.4.0 misturava:

| Medida | v0.4.0 | v0.4.1 |
| --- | --- | --- |
| Silêncio entre frases (áudio de 400 ms, síntese de 300 ms) | **728 ms / 703 ms** | **5 ms** |
| Primeiro som no navegador (Edge TTS real) | 728 ms | 728 ms (mesmo motor) |
| Custo por frase | ~= tempo total da síntese da frase | ~0 (sobreposto à reprodução) |

**Causa.** `drainQueue()` só chamava `requestChunk()` para a frase seguinte
**depois** de `await playResponse(...)` terminar. O custo de síntese de cada frase
era pago inteiro, em silêncio, entre frases.

**Correção.** Pipeline: `onPlayStart` (evento `playing` do `<audio>`) dispara
`next()`. Enquanto a frase A toca, a frase B já está sendo sintetizada.

**Honestidade sobre os números.** O `728 ms` de primeiro som **não mudou** — é o
tempo do provedor (medido em `npm run voice:bench`: primeiro byte 661–1025 ms,
mediana ≈700 ms). O que mudou é que ele é pago **uma vez por resposta**, não uma
vez por frase. Na máquina do usuário (Windows, síntese de 5–6 s por frase), o
defeito antigo implicava **~5 s de silêncio por frase** — isto é **inferência a
partir da estrutura medida**, **não** uma medição feita no Windows.

---

## 6. Travadas entre frases ("Falando" / "Ouvindo")

**Causa.** Estado mudava implicitamente; `speaking` podia ficar `true` sem áudio
tocando; e o microfone nunca reabria se a resposta falhasse ou fosse interrompida.

**Correção.** `VOICE_STATE` com transições registradas em `history.states`
(`trace` para depuração), `releasePlayback()` no `finally` do `drainQueue`,
`armStallWatchdog(20 s)` que declara erro em vez de ficar mudo, `scheduleResume()`
único e idempotente, `dispose()` que desliga tudo. Escolhi **não** implementar
`boundary="WordBoundary"` do Edge TTS: medido, ele **altera o áudio** (19 008 vs
19 296 bytes para o mesmo texto) e devolve glifos; fica fora de produção.

---

## 7. Instrumentação (temporária, local)

- **No navegador:** `controller.diagnostics` (teto 50 registros, em RAM) e
  `window.kiranaVoiceReport()` → `console.table`.
  Campos: `turnId, segmentId, textSent, textLength, ttsStart, ttsFirstByte,
  ttsEnd, playbackStart, playbackEnd, outcome`.
- **No servidor:** `GET /api/voice/diagnostics?sessionId=...` (autenticada como o
  resto da API) →
  `{count, entries, voice, rate}`; cada entrada tem `sessionId, turnId,
  segmentId, receivedChars, text_sent_to_tts, dropped, droppedChars,
  firstByteMs, totalMs, bytes, outcome`.

Nada disso grava em disco, nada inclui `.env`, chave de gateway, token ou cookie.
O `text_sent_to_tts` é o texto que a Kirana **falaria** — é conteúdo da conversa,
então a rota exige a mesma autenticação do `/api/chat`.

---

## 8. Cenários da seção 10 → testes

Arquivo: `test/voice-behavior.test.js` (22 testes de comportamento).

| Cenário | Teste |
| --- | --- |
| resposta simples falada uma vez | 1 |
| várias frases, ordem e sem repetição | 2, 2b |
| markdown não vira som | 3 |
| acentos/pontuação/símbolos | 4 |
| nenhuma palavra inventada | 5, 5b, 5c |
| ordem dos segmentos | 6 |
| sem silêncio entre frases | 6b |
| cancelar durante a síntese | 7 |
| cancelar durante a reprodução | 8 |
| mensagem seguinte após interromper | 9 |
| cinco turnos seguidos | 10 |
| evento atrasado do reconhecedor | 11 |
| um reconhecedor por vez | 12 |
| autoescuta | 13, 13b |
| falha do motor | 14 |
| recuperação após falha | 15 |
| integridade turno/texto/áudio | 16, 16b |

**Prova de que os testes pegam os bugs:** rodando os mesmos 22 testes contra o
`public/voice.js` da v0.4.0 (`git show e16eb5c:public/voice.js`), **11 falham**;
contra a v0.4.1, **22 passam**.

---

## 9. O que testar no Windows (A–E)

Caminho da instalação existente: `C:\CRiando coisa nova\Kirana\kirana-v0.4.0\kirana`.

```bat
cd "C:\CRiando coisa nova\Kirana\kirana-v0.4.0\kirana"
corepack pnpm install --frozen-lockfile
python -m pip install "edge-tts==7.3.1"
npm test
iniciar.bat
```

Depois, no navegador (Edge ou Chrome), com microfone e alto-falantes:

- **A.** Fale exatamente **"Olá, estou testando minha voz."** → a transcrição
  precisa aparecer igual e a resposta ser falada **uma vez**.
- **B.** Fale as **três frases do clima** (por exemplo: "Como está o tempo em
  Fortaleza hoje?" / "E amanhã?" / "Preciso de guarda-chuva?") → nenhuma frase
  pode ser repetida e não pode haver pausa longa entre elas.
- **C.** Fale com **microfone e alto-falantes** (sem fone) → a Kirana **não pode
  responder à própria voz**; nenhuma mensagem do usuário pode aparecer sozinha.
- **D.** Interrompa **tocando no botão** durante a fala → o áudio para na hora, a
  Kirana volta a ouvir e a próxima mensagem funciona.
- **E.** Faça **cinco turnos seguidos** → cada pergunta enviada uma vez, cada
  resposta com um áudio, sem travar em "Falando" ou "Ouvindo".

Extras úteis: `node scripts/doctor.mjs` e `npm run voice:bench` (mede o provedor
na máquina real). No console do navegador, `kiranaVoiceReport()` mostra a tabela
por segmento.

**Se algo falhar**, mande: o estado do botão (`data-state`), a saída de
`kiranaVoiceReport()`, o trecho do log do servidor com `turnId`/`segmentId` e a
saída de `node scripts/doctor.mjs`.

---

## 10. Linux (desenvolvimento) × Windows (uso real)

| Aspecto | Linux (onde foi medido) | Windows (onde será usado) | Risco |
| --- | --- | --- | --- |
| Motor de voz | edge-tts 7.3.1 no worker Python | mesmo worker, `py -3` | baixo |
| Latência de síntese | ~300 ms por frase curta | **relatada em 5–6 s** no teste do usuário | **alto** — o pipeline mudou a *espera*, não a síntese |
| Primeiro som | 728 ms | não medido | médio |
| Reprodução | Chromium headless, `<audio>` real | Edge/Chrome com placa de som | baixo |
| Reconhecimento de fala | **não roda** em headless (sem microfone físico) | Web Speech API real | **limitação da validação** — os testes de STT usam dublês |
| Barge-in por voz | não implementado | idem | decisão de escopo |

O que **não** deu para validar aqui: microfone físico, eco real de alto-falante,
`SpeechRecognition` de verdade e a latência do provedor na rede do usuário. É
exatamente por isso que o teste A–E é obrigatório antes de declarar a correção
validada.

---

## 11. Barge-in por voz (projeto, não implementação)

Se for feito depois: manter o microfone aberto durante a fala **apenas** para
detectar energia/voz (Web Audio `AnalyserNode`), nunca para transcrever; ao
detectar fala acima do limiar por ~250 ms, chamar o mesmo `interrupt()` do botão.
Requisitos de segurança: (1) janela de histerese depois de cada frase para não
disparar com a própria voz; (2) nada de transcrição durante a fala, para não
arriscar mensagens fantasma; (3) precisa de medição em alto-falante real — o
sandbox não tem microfone, então **isto não foi testado** e não deve ser ligado
por padrão sem esse teste.

---

## 12. Arquivos alterados

| Arquivo | Por quê |
| --- | --- |
| `public/voice.js` | reescrita da máquina de estados, microfone half-duplex, pipeline, diag |
| `public/app.js` | `voiceBridge.done()` sem `text`; `kiranaVoiceReport()` |
| `src/voice/tts-text.js` | allowlist de caracteres faláveis + `analyzeSpeechText` |
| `src/voice/edge_tts_worker.py` | 2ª barreira (mesma allowlist) no servidor |
| `src/voice/tts.js` | registros de diagnóstico por segmento |
| `src/server.js` | `turnId`/`segmentId`, header `X-Kirana-Segment`, `GET /api/voice/diagnostics` |
| `test/voice-behavior.test.js` | **novo** — 22 testes dos cenários da seção 10 |
| `test/voice-controller.test.js` | 1 asserção ajustada (`abort()` em vez de `stop()`) |
| `package.json`, `src/config.js` | versão 0.4.1 |
| `docs/VOZ.md`, `CHANGELOG.md`, este arquivo | documentação e medições |
