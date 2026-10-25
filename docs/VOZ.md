# Voz da Kirana (Marco 3)

Voz é **modalidade da mesma agente**. Não existe segunda Kirana, segundo
orquestrador, segundo gateway nem aplicativo de voz separado. O que muda é
apenas a porta de entrada: em vez de digitar, o visitante fala.

```
  microfone            SpeechRecognition            /api/chat (o mesmo de sempre)
     │                        │                              │
     ▼                        ▼                              ▼
  navegador  ──►  transcrição  ──►  sendMessage()  ──►  LangGraph + ferramentas + memória
                                          │
                                          ▼  texto da resposta
                              /api/voice/tts  ──►  worker Python  ──►  edge-tts (Thalita)  ──►  MP3
                                          │
                                          ▼
                                    <audio> no navegador
```

## Texto falado (v0.4.3)

A limpeza do texto é **a mesma** para os dois motores (`public/speech-text.js`):
markdown vira conteúdo falado, código de bloco não é lido, link vira rótulo,
emoji e símbolos não são lidos, acento e pontuação natural permanecem. O texto
exibido na tela **não é alterado** — `kiranaVoiceReport()` mostra os dois
(`textDisplayed` e `textSent`).

Antes da 0.4.3 só o servidor limpava: com o motor do navegador, `**negrito**`
era lido como "asterisco asterisco negrito".

## Dois motores de fala (v0.4.2)

A Kirana pode falar de dois jeitos, e você escolhe no painel ao lado do microfone
(botão de alto-falante → Motor / Voz / Velocidade / **Ouvir prévia**):

| Motor | O que usa | Vantagem | Limite |
| --- | --- | --- | --- |
| **Navegador** | `speechSynthesis` do seu Windows/Edge | começa quase na hora: **sem processo Python e sem rede** | depende das vozes que o navegador expõe (no Edge existem as "Online (Natural)" em pt-BR) |
| **Servidor** | worker Python + `edge-tts` (Thalita, Francisca, …) | igual em qualquer navegador | custa processo + conexão antes do primeiro som |
| **Automático** (padrão) | navegador se houver voz pt-BR; senão servidor | ninguém fica sem voz | — |

Preferência de voz: a salva → **Francisca** → Thalita → outras pt-BR → padrão do
sistema. A escolha fica salva no navegador (`localStorage`) e vale na próxima vez.
**A Thalita continua disponível** — trocar de voz não é trocar de mecanismo.

> As vozes do navegador e do servidor têm nomes parecidos, mas **não são o mesmo
> mecanismo**: "Francisca Online (Natural)" é a voz do Windows/Edge (nuvem da
> Microsoft via navegador) e `pt-BR-FranciscaNeural` é a do edge-tts.

## O que foi acrescentado

| Arquivo | Papel |
| --- | --- |
| `src/voice/tts-text.js` | Limpeza do texto **para fala** (emoji, markdown, URL, código). O texto do chat nunca é alterado. |
| `src/voice/tts.js` | Serviço: valida, chama o worker, devolve MP3 em stream, mata o worker no abort. |
| `src/voice/edge_tts_worker.py` | Worker Python (reaproveitado do patch Thalita v0.4.0; ver diferenças abaixo). |
| `public/voice.js` | Controlador no navegador: máquina de estados, microfone, fala, interrupção. |
| `public/index.html` + `styles.css` | Botão circular no composer (mesma página, sem rota nova). |
| `test/voice-text.test.js` | 9 testes da limpeza de texto. |
| `test/voice-controller.test.js` | 16 testes da máquina de estados (com dublês). |
| `test/voice-server.test.js` | 13 testes HTTP das rotas de voz (worker falso). |
| `test/browser/voice-flow.mjs` | 34 verificações em Chromium real, com **áudio real**. |
| `scripts/voice-bench.mjs` | Medição real do provedor (latência, ppm, interrupção). |

Rotas novas (as antigas não mudaram):

| Rota | Método | O que faz |
| --- | --- | --- |
| `/api/voice/status` | GET | Diz se o motor está utilizável, qual voz e qual velocidade. |
| `/api/voice/tts` | POST | `{sessionId, text}` → `audio/mpeg` em stream. |

`/api/voice/tts` exige sessão válida, respeita `KIRANA_ACCESS_TOKEN` e a checagem
de origem — igual ao `/api/chat`. Ela **não** cria sessão, **não** altera o
histórico e **não** executa ferramenta nenhuma: só transforma texto em áudio.

## Instalação no Windows

A voz precisa de Python. Sem ele, a Kirana continua funcionando por texto e o
diagnóstico avisa claramente.

1. Instale o **Python 3.10+** (https://www.python.org/downloads/windows/) e marque
   *"Add python.exe to PATH"*.
2. Abra o Prompt de Comando na pasta da Kirana e instale a dependência:

   ```bat
   py -3 -m pip install --upgrade pip
   py -3 -m pip install edge-tts==7.3.1
   ```

3. Rode o diagnóstico:

   ```bat
   diagnostico.bat
   ```

   A linha `Voz (TTS)` deve ficar assim:

   ```
   ✓ Voz (TTS)  pt-BR-ThalitaMultilingualNeural disponível (2 vozes no catálogo, 824 ms)
   ```

4. Inicie normalmente com `iniciar.bat` e clique no botão redondo de microfone,
   ao lado do campo de mensagem.

### Configuração (`.env`)

```ini
# edge = Thalita via Edge TTS | disabled = desliga a voz
KIRANA_TTS_PROVIDER=edge
# Deixe vazio para o padrão (Windows: "py -3"; Linux/macOS: "python3").
KIRANA_EDGE_TTS_PYTHON=
# Velocidade da fala. Valores aceitos: -20% -15% -10% -5% +0% +5% +8% +10% +15% +20%
KIRANA_TTS_RATE=+8%
```

O padrão é `+8%` porque a voz em velocidade natural mede **146 palavras/min**,
abaixo da faixa desejada (150–180). Com `+8%` a medição fica em **157 ppm**.

### Se o Python estiver em outro caminho

```ini
KIRANA_EDGE_TTS_PYTHON=C:\Python312\python.exe
```

O worker é executado como subprocesso; a Kirana nunca importa Python dentro do
processo Node.

## Privacidade — leia antes de usar com visitantes reais

- **O texto da resposta é enviado para fora.** A síntese usa o serviço de voz da
  Microsoft (Edge TTS) através da biblioteca comunitária `edge-tts`. Isso
  significa que frases geradas pela Kirana — que podem conter dados que o
  visitante informou — saem da máquina.
- **Nenhum áudio do visitante sai daqui pelo nosso código.** A transcrição é
  feita pelo `SpeechRecognition` do navegador, que no Chrome/Edge envia o áudio
  para o serviço de fala do Google/Microsoft. Isso é do navegador, não da
  Kirana, e precisa ser informado no aviso de privacidade do site.
- **Não há garantia de que o áudio do visitante não seja processado por
  terceiros.** Se isso for inaceitável, use apenas digitação ou implemente um
  motor STT local (fora do escopo deste marco).
- **Credenciais continuam no backend.** O navegador não recebe chave do gateway,
  não fala com o gateway e não fala com a Microsoft: só conversa com a Kirana.
- **O provedor é externo e não oficial.** A documentação da Microsoft não
  garante esse endpoint para uso de terceiros; ele pode mudar, limitar ou parar
  sem aviso. A Kirana trata a falha e mantém a resposta no texto.

## Estados do botão (máquina de estados explícita)

| Estado (`data-state`) | Significado | O que o botão faz |
| --- | --- | --- |
| `inativo` | voz desligada | liga e pede o microfone |
| `pedindo-microfone` | aguardando permissão | — |
| `ouvindo` | microfone aberto | encerra a voz |
| `fala-detectada` | captou algo, esperando o fim da frase | encerra a voz |
| `processando` | transcrição enviada; a Kirana está respondendo | **interrompe** (cancela a resposta) |
| `falando` | áudio tocando | **interrompe** (para o áudio e a geração) |
| `interrompido` | parada pelo usuário | volta a ouvir sozinho |
| `erro` | microfone/motor falhou | tenta de novo |

Fluxo normal: `inativo → pedindo-microfone → ouvindo → fala-detectada →
processando → falando → ouvindo` (contínuo, sem precisar clicar de novo).

Fim de enunciado: **900 ms de silêncio** depois da última transcrição
(`LISTEN_TUNING.silenceMs`), com trava de 20 s por enunciado.

Transcrição (v0.4.3): resultados **finais** são mesclados por sobreposição de
palavras (nunca somados às cegas) e o **interino** é sempre substituído, nunca
acumulado. Se o navegador deixar um interino sem `isFinal`, ele é aceito depois
de `interimGraceMs` (1,2 s) — antes a fala ficava na tela e não era enviada.

### Meio-duplex (correção da v0.4.1)

O microfone fica **fechado durante todo o turno**: enquanto a Kirana processa,
fala ou ainda tem fala na fila, e por mais **600 ms** depois do último áudio
(`muteAfterSpeechMs`). Ele só reabre por `scheduleResume()`, com um *token* novo:
resultados que cheguem de um reconhecedor antigo são descartados (é o que impedia
a Kirana de responder à própria voz). `history.phantomBlocked` conta esses
descarte.

Interromper **falando** ainda não existe: o barge-in por voz está apenas
projetado (`docs/AUDITORIA-VOZ-V0.4.1.md`, seção 11). A interrupção real é pelo
botão/toque.

## Interrupção

Ao interromper, em ordem:

1. o áudio em reprodução é pausado;
2. o `fetch` da síntese é abortado e o **worker Python é morto** no servidor;
3. a geração da resposta é cancelada (`stopGeneration()` do chat de texto);
4. os pedaços de fala que chegariam atrasados são descartados (`epoch`/`muted`);
5. o microfone volta a ouvir.

Cancellation ≠ erro: o texto é marcado como interrompido, nunca como falha.

## Autorização (HITL) — a voz não autoriza nada

Ações que exigem confirmação **continuam exigindo o botão na tela**.
Quando existe ação pendente, a Kirana fala: *"Preciso que você confirme esta
ação na tela. Por segurança, eu não confirmo nada pela voz."*

Um "sim" captado pelo microfone é tratado como **mensagem comum**: entra no
histórico e — pelo comportamento já existente do backend — a ação pendente é
cancelada, não aprovada. Provado no teste de navegador
(`nenhuma requisição de confirmação foi feita pela voz`, `"sim" falado NÃO
autorizou a ação`).

## Desempenho medido (não estimado)

Comando: `npm run voice:bench`

Máquina do ambiente de desenvolvimento (Linux, sandbox), rede pública,
texto de 178 caracteres / 31 palavras, voz `pt-BR-ThalitaMultilingualNeural`,
velocidade `+8%`:

| Medida | Meta | Medido |
| --- | --- | --- |
| Primeiro byte de áudio | ≤ 800 ms (ideal 500) | **661–1025 ms**, mediana ≈ **700 ms** (5 execuções) |
| 1ª síntese do processo (aquecimento) | — | 700–2136 ms (paga conexão TLS) |
| Síntese completa do texto | — | 1,0–1,3 s (11,9 s de áudio) |
| Palavras por minuto | 150–180 | **157 ppm** |
| Interrupção (abort → worker morto) | 100–300 ms | **3–5 ms** no servidor; pausa do áudio é imediata |
| Silêncio entre frases (v0.4.1) | < 100 ms | **5 ms** (v0.4.0: 728/703 ms, com áudio de 400 ms) |

Conclusões honestas:

- **A meta de 800 ms é atingida na maioria das execuções, não em todas.** A
  primeira síntese depois de iniciar o servidor passa de 1 s com frequência.
  Não dá para garantir 500 ms com este provedor.
- O áudio toca **enquanto** é gerado (primeiro byte → play imediato), e a
  resposta é dividida em frases com a próxima já sendo pedida durante a
  reprodução da atual. Sem isso, a espera entre frases seria de ~1 s.
- A **v0.4.1** passou a pedir a síntese da próxima frase enquanto a atual toca
  (pipeline). O primeiro som continua custando o mesmo (~700 ms de provedor): a
  mudança elimina a espera **por frase**, não a primeira.
- Os números acima são de um sandbox Linux. **No Windows do usuário eles devem
  ser medidos de novo** (`npm run voice:bench`); não foram medidos lá.

## Diagnóstico de um turno (temporário, local)

Cada registro agora diz **qual motor e qual voz** falaram aquele trecho:
`engine: "browser" | "edge"` e `voice`. No motor do navegador não existe "primeiro
byte": `ttsFirstByte` é igual a `playbackStart` (a síntese é a reprodução).

Para entender o que a Kirana falou e o que ela *achou* que falou:

- No navegador, com a voz ligada: `kiranaVoiceReport()` no console → tabela com
  `turnId, segmentId, textSent, textLength, ttsStart, ttsFirstByte, ttsEnd,
  playbackStart, playbackEnd, outcome`.
- No servidor: `GET /api/voice/diagnostics?sessionId=...` (exige o mesmo token do
  `/api/chat`) → `receivedChars`, `text_sent_to_tts`, `dropped`,
  `droppedChars`, `firstByteMs`, `totalMs`, `bytes`, `outcome`.

Os registros ficam **em memória** (últimos 50), não vão para disco e não incluem
credenciais. Detalhes em `docs/AUDITORIA-VOZ-V0.4.1.md`.

## Quando a voz não funciona

| Situação | O que acontece |
| --- | --- |
| Navegador sem `SpeechRecognition` (Firefox, Safari antigo) | O botão avisa "Este navegador não faz reconhecimento de fala. Você pode continuar digitando…". O chat por texto segue normal. |
| Permissão do microfone negada | Estado `erro` com instrução; texto continua funcionando. |
| Python ausente | `GET /api/voice/status` responde `available:false`; a resposta continua no texto. |
| `edge-tts` ausente ou desatualizado | Idem; o diagnóstico aponta o comando de instalação. |
| Serviço da Microsoft fora do ar | Estado `erro`, aviso "A voz falhou agora, mas a resposta continua no texto". |
| Reprodução travada (navegador não emite `ended`) | Cão-de-guarda de 20 s (`speakingStallMs`) declara erro e devolve o microfone, em vez de ficar em "falando". No motor do navegador o prazo é 4x maior, porque uma frase longa leva mais tempo. |
| Navegador sem nenhuma voz (headless, Firefox antigo, Windows sem voz pt-BR) | O motor cai automaticamente para o servidor; se você escolheu "Navegador" de propósito, a Kirana avisa e continua falando pelo servidor. |
| Limite de requisições | A voz tem um balde próprio (6x o do chat). Uma resposta com várias frases gera um pedido por frase — com o balde do chat, a fala pararia no meio. |
| Navegador sem MP3 em `MediaSource` (Firefox) | O áudio é acumulado e tocado ao final do trecho (um pouco mais de espera). |

## Acentuação: a checagem que pega o problema silencioso

No Windows, o `stdin` de um processo Python num pipe usa a página ANSI
(cp1252), não UTF-8. Se o texto não fosse blindado, o worker receberia
`eleiÃ§Ãµes` em vez de `eleições` — o áudio sairia, só que errado. Correção em
três camadas (JSON só ASCII, ambiente `PYTHONUTF8=1`, `stdin.reconfigure`).

Para conferir na sua máquina:

```bat
diagnostico.bat
:: ou
node scripts/doctor.mjs
```

A linha **"Voz: acentuação até o motor"** mostra `texto íntegro` (bom) ou o texto
corrompido que o worker recebeu (aí a pronúncia sai errada e o problema está no
caminho, não na voz).

## Como testar

```bat
testar.bat                      :: suíte completa (298 testes)
node test\browser\voice-flow.mjs   :: 34 verificações de navegador com áudio real
npm run voice:bench             :: mede o provedor de verdade
```

Os testes de navegador exigem Chromium do Playwright:

```bat
npx playwright@1.64.1 install chromium
```

Observação importante sobre os testes: o `SpeechRecognition` do Chromium
depende de um serviço externo de transcrição que não existe em ambiente
headless, então **ele é substituído por um dublê controlado pelo teste**. O
microfone (`getUserMedia`), o MP3, o `<audio>` e a reprodução são reais. Não há
microfone físico no ambiente de desenvolvimento — essa validação precisa ser
feita na máquina do usuário.
