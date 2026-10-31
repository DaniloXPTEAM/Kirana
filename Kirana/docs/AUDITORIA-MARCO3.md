# Auditoria — Marco 3 (Etapas A e B)

Data: 25/10/2026 · Base: Kirana v0.3.0 · Auditoria feita **antes** de qualquer alteração de arquitetura.

---

## ETAPA A — Recuperação e integridade da base

### A.1 Base local validada

| Verificação | Resultado |
|---|---|
| Versão do projeto | `0.3.0` (`package.json` e `src/config.js`) |
| Dependências reinstaladas (pnpm, cache) | 18,6 s |
| Suíte completa | **181 testes / 181 aprovados / 0 falhas** |
| Checkpoint existente | `checkpoints/kirana-v0.3.0-20261025-030353.tgz` (323 KB) |
| Pacote ZIP | `kirana-v0.3.0.zip` (382 KB, SHA-256 `d342b18f…c2d8a1`) |

### A.2 GitHub × pacote local — comparação real

Repositório `DaniloXPTEAM/Kirana`, HEAD = **`ea3438814c4a29df93842343cceb5b7bc9e3cb45`** («v3», 25/10 02:46:58Z).

Meu pacote final v0.3.0 foi gerado às **03:03Z** — depois do commit. A comparação arquivo a arquivo
(`diff -rq`, excluindo `node_modules`, `data`, `.git`, lockfiles) confirma:

| Arquivo | GitHub (ea34388) | Local (v0.3.0 final) |
|---|---|---|
| `src/copilot/agui-events.js` | sem `STEP_FINISHED`/`endStep`/`export KIRANA_EVENT` | **com** as 3 correções |
| `src/copilot/site-kit.js` | sem resolução estrita (`unknown_site`) | **com** |
| `src/copilot/agent-factory.js` | sem recusa de site desconhecido | **com** |
| `src/server.js` | sem `/api/site/info` | **com** |
| `src/config.js` | versão anterior | `0.3.0` |
| testes | **174 blocos `test()`** | **181 blocos** |
| docs | — | `ACOES-DO-SITE.md`, `COMPATIBILIDADE-COPILOTKIT.md`, `VOZ-V2.1-PREPARACAO.md` |
| `sites/demo-parceiro/` | inexistente | existe |

**Conclusão:** o GitHub contém o estado **intermediário** (174 testes, com os 3 defeitos reais). A base
obrigatória é a **local v0.3.0 (181 testes)**, conforme instruído. Não substituí nenhuma versão e não
regredi nada. **Ação necessária do proprietário:** publicar o pacote v0.3.0 final no repositório.

### A.3 Artefatos de voz — encontrados

Estavam no próprio repositório, em `integrations/` (não no disco `P:`):

| Artefato | Tamanho | SHA-256 |
|---|---|---|
| `Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip` | 140 KB | `e336b3628cbb4aa2…ba9e015` |
| `Kirana-Voice-Thalita-Update-v0.4.0.zip` | 57 KB | `b0de59d0d5a56c09…d8486e` |

**Nenhum bloqueio de acesso.** Copiados para `kirana/integrations/` sem extrair sobre o código.

---

## ETAPA B — Auditoria técnica

### B.1 Patch Thalita × Gateway: são o mesmo código

Comparação SHA-256 dos 9 arquivos de voz do patch contra as cópias dentro do Gateway v0.4.1:

| Arquivo | Hash (12) | Situação |
|---|---|---|
| `voice.html` | `54652e6fbc13` | **igual** |
| `app.js` | `d06d22958e70` | **igual** |
| `providers.js` | `c4311d37627d` | **igual** |
| `edge-tts-adapter.js` | `73229de12db0` | **igual** |
| `edge-tts-runner.mjs` | `e02291b6ae8b` | **igual** |
| `edge_tts_worker.py` | `c09a9277e798` | **igual** |
| `tts-routing.js` | `da66a2b5229d` | **igual** |
| `server.mjs` | `0e5be60085bf` | **igual** |
| `requirements-edge-tts.txt` | `30ee848e1147` | **igual** |

**Conclusão:** o Gateway v0.4.1 **já contém** a atualização Thalita. Aplicar o patch seria instalar por
cima de si mesmo — **não será aplicado**. Reaproveitamos os módulos diretamente.

Observação de versionamento: o ZIP chama-se `v0.4.1` mas a pasta interna é `Kirana-ChatGPT-Gateway-v0.4.0`.

### B.2 Existe endpoint HTTP de TTS? **Sim, dois — e são diferentes**

**(i) Gateway SIWC (`src/gateway.js:132`)**

| Propriedade | Contrato real |
|---|---|
| Rota | `POST /v1/audio/speech` |
| Requisição | `{ input: string (≤100 000), voice?: string, response_format: "wav" }` — campos extras são rejeitados |
| Provider | **`piper-local`** (Piper, voz local) — **não** Thalita |
| Resposta | **JSON** `{object:"audio.speech", …, download_path:"/v1/files/{id}"}` → WAV completo |
| Streaming | **Não** (arquivo completo + upload no cofre de arquivos) |
| Interrupção | não se aplica (resposta única) |
| Autenticação | sim, a mesma do gateway (`Bearer`) |
| Dependência | Piper instalado localmente |

**(ii) Cliente de voz experimental (`examples/voice-client/server.mjs:98`)**

| Propriedade | Contrato real |
|---|---|
| Rota | `POST /api/tts/stream` |
| Requisição | `{ voice: "pt-BR-ThalitaMultilingualNeural", text: string }` (voz fixa, validação estrita) |
| Motor | `edge_tts_worker.py` (Python `edge-tts==7.3.1`), spawn por requisição |
| Resposta | **`audio/mpeg` em stream** (chunks MP3 progressivos) |
| Streaming | **Sim** — consumido no navegador por `MediaSource('audio/mpeg')` com fallback para buffer |
| Interrupção | **sim**: `AbortController` → `reader.cancel()` → kill do processo Python |
| Autenticação | **nenhuma** (escuta em `127.0.0.1` numa porta própria) |
| Outras rotas | `/api/health`, `/api/session`, `/api/models`, `/api/tts/voices`, `/api/chat/completions` |
| Independência | **servidor separado** — é exatamente a "interface experimental separada" a evitar |

**Decisão de arquitetura:** a voz da Kirana usa a rota **(ii) portada para dentro do backend da Kirana**
(`POST /api/voice/tts`), não o servidor experimental. O `/v1/audio/speech` do gateway (Piper/WAV) fica
como **fallback secundário documentado**, não como motor inicial — não é Thalita e não faz streaming.

### B.3 Viabilidade real do motor Thalita neste ambiente (medido, não presumido)

| Verificação | Resultado |
|---|---|
| Python disponível | 3.13.16 |
| `pip install edge-tts==7.3.1` | ok (1,8 s) |
| Catálogo de vozes da Microsoft alcançável | **sim** |
| Voz alvo presente | `pt-BR-ThalitaMultilingualNeural`, **Female**, `pt-BR`, status GA |
| Síntese real (texto curto) | **ok** — MP3 válido (21 456 bytes) |
| **Primeiro byte de áudio** | **1 446 ms** |
| **Áudio completo** | 2 876 ms |

**A meta de 800 ms (ideal 500 ms) para primeiro áudio NÃO é atingida** com spawn por requisição.
Registrado como limitação medida; mitigação prevista: worker persistente + cache de frases curtas.

Riscos assumidos e documentados: Edge TTS é provedor **externo e não oficial** (sem SLA), exige rede e
envia o texto ao serviço da Microsoft — precisa constar na política de privacidade.

### B.4 Pontos de integração na Kirana

| # | Pergunta | Resposta com evidência |
|---|---|---|
| 1 | Como uma mensagem entra na agente | `public/app.js:469 sendMessage()` → `POST /api/chat` (SSE) → `agent.runTurn` |
| 2 | Como a sessão é identificada | `state.sessionId` (`/api/session`); no CopilotKit, `siteKit.sessionIdFor(site, threadId)` |
| 3 | Preservação de histórico | `src/sessions.js` (arquivo por sessão) + `buildContextMessages` |
| 4 | Eventos AG-UI | `src/copilot/agui-events.js` → `/api/copilot` (runtime oficial) |
| 5 | Cancelamento | cliente: `stopGeneration()` (`app.js:686`) aborta o `AbortController`; servidor: `streamAgentTurn` trata abort; AG-UI: `abortSignal` no factory |
| 6 | Ferramentas e autorizações | `src/tools/registry.js` + HITL em `/api/chat/confirm` e `demo-contact.js` (token de uso único) |
| 7 | Interface de entrada da voz | **`public/index.html` + `public/app.js`** (interface principal em `/`). O widget (`widget/`) é para sites de terceiros e receberá a voz depois, sem dependência |

### B.5 Reutilização do patch — o que serve e o que não serve

| Módulo | Uso | Motivo |
|---|---|---|
| `sanitizeTextForSpeech()` (`edge-tts-adapter.js`) | **reutilizar** (portado para `src/voice/tts-text.js`) | cobre emojis, markdown, URLs, código — é exatamente a Fase 2 |
| `edge_tts_worker.py` | **reutilizar** (vendorizado em `src/voice/edge_tts_worker.py`) | contrato simples: JSON no stdin, MP3 no stdout |
| Lógica de `MediaSource` + abort + `unlock()` do adaptador | **reutilizar** (adaptada em `public/voice.js`) | streaming, barge-in e autoplay |
| `tts-routing.js` (primário + fallback) | **reutilizar** conceito | fallback para `speechSynthesis` local |
| `SpeechRecognition` contínuo + recuperação de erros (`app.js` do experimental) | **reutilizar lógica** | estados, `no-speech`, reinício |
| `voice.html` + `server.mjs` + rota `/api/chat/completions` | **não usar** | é a interface/servidor experimental e um segundo orquestrador |
| `sample/thalita-teste.mp3` | não versionar | amostra, não faz parte da distribuição |

### B.6 Bloqueios reais

| Bloqueio | Impacto | Contorno |
|---|---|---|
| Microfone físico e qualidade acústica não podem ser validados no sandbox | testes de navegador usam `SpeechRecognition` **injetado** | documentar; validar em execução no Windows |
| Headless Chromium não reproduz áudio audível | validação de áudio é por bytes/estado, não por escuta | registrar como limitação de ambiente |
| `@copilotkit/react-core` não compila (memória do sandbox, Marco 2) | voz **não** pode depender dele | voz entra na interface vanilla; widget segue leve |
| Edge TTS é externo e não oficial | disponibilidade/latência | fallback `speechSynthesis` + status visível |
| Gateway real (sessão ChatGPT) inacessível do sandbox | texto simulado pelo mock nos testes | testar contrato; validação real no Windows |

Nenhum bloqueio impede a implementação. **Não há dependência do disco `P:`** em nenhum passo.

---

## ETAPA C — O que foi construído sobre esta auditoria

Registro do que a auditoria decidiu e do que virou código (25/10/2026).

| Decisão da auditoria | O que foi feito |
| --- | --- |
| Patch Thalita v0.4.0 é idêntico ao Gateway v0.4.1 → **não extrair sobre o código** | Extraído só o worker `edge_tts_worker.py`, copiado para `src/voice/`. Nenhuma interface do patch foi instalada. |
| Gateway `/v1/audio/speech` é Piper em WAV completo → **não usar** | A Kirana ganhou rota própria `POST /api/voice/tts` (MP3 em stream), sem tocar no gateway. |
| `examples/voice-client/server.mjs` é um segundo orquestrador → **não usar** | Não foi usado. O áudio é só uma etapa depois do `/api/chat` existente. |
| Voz fixa `pt-BR-ThalitaMultilingualNeural`, sem autenticação no patch | Mantida a voz fixa; **foi acrescentada** autenticação por sessão, `KIRANA_ACCESS_TOKEN` e checagem de origem, como no `/api/chat`. |
| Limite de 5000 caracteres no patch | Reduzido a **3000**, com recusa explícita (`413`) em vez de truncar em silêncio. |
| Latência medida de 1446 ms no primeiro byte (spawn/req) | A medição foi refeita com aquecimento: **mediana ≈ 700 ms**, com execuções entre 661 e 1025 ms. A meta de 800 ms é atingida na maioria, não em todas. |
| Voz natural mede 146 ppm (abaixo de 150–180) | Adicionada velocidade ajustável (`+8%` → **157 ppm**), com lista fechada de valores. |
| `Permissions-Policy` bloqueava microfone | Corrigido para `microphone=(self)`; CSP ganhou `media-src 'self' blob:`. |

Nenhuma correção do Marco 2 foi desfeita: as 174 asserções do GitHub continuam
por aqui, mais as 7 que o GitHub não tem, mais 38 de voz — **219 no total**.
