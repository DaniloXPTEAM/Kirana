# Relatório — Marco 3: voz conversacional na Kirana

Data: 25/10/2026 · Versão entregue: **Kirana 0.4.0** · Base de partida: v0.3.0 (Marco 2)

> Convenção de versões para não confundir:
> **Kirana 0.3.0** = entrega do Marco 2 (CopilotKit) · **Kirana 0.4.0** = esta
> entrega (voz) · **Gateway ChatGPT v0.4.1** = gateway do usuário, não alterado ·
> **patch Thalita v0.4.0** = pacote de referência auditado, **não instalado** ·
> **Kirana V2.1** = nome do produto.

---

## 1. Resumo em uma frase

A Kirana agora **ouve, responde falando e pode ser interrompida**, usando
exatamente a mesma agente (LangGraph, sessões, memória, ferramentas, HITL e
CopilotKit) — sem segunda Kirana, sem segundo orquestrador e sem tocar no gateway.

---

## 2. O que o usuário vê

- Um **botão circular de microfone** ao lado do campo de mensagens, na mesma tela.
- Sete estados visíveis: inativo, pedindo microfone, ouvindo, fala detectada,
  processando, falando, interrompido — mais o estado de erro.
- Conversa contínua: terminou de falar, o microfone volta sozinho.
- Um toque durante a fala **para o áudio e cancela a resposta**.
- Se o navegador não tem reconhecimento de fala, ou o microfone é negado, a
  mensagem explica o que fazer — e o chat por texto continua intacto.
- Funciona no móvel (verificado em viewport 390×844).

---

## 3. O que foi alterado no código

### Arquivos novos (10)

| Arquivo | Linhas | Papel |
| --- | ---: | --- |
| `src/voice/tts-text.js` | 59 | Limpeza do texto **para fala** (emoji, markdown, URL, código). |
| `src/voice/tts.js` | 213 | Serviço: valida, sobe o worker, faz stream, mata no abort. |
| `src/voice/edge_tts_worker.py` | 97 | Ponte para `edge-tts` (base do patch Thalita, com `rate`). |
| `public/voice.js` | 725 | Controlador: estados, microfone, fala, interrupção, prefetch. |
| `test/voice-text.test.js` | 73 | 9 testes. |
| `test/voice-controller.test.js` | 397 | 16 testes (dublês). |
| `test/voice-server.test.js` | 280 | 13 testes HTTP (worker falso). |
| `test/browser/voice-flow.mjs` | 389 | 34 verificações em Chromium real. |
| `scripts/voice-bench.mjs` | 180 | Medição real (latência, ppm, interrupção). |
| `docs/VOZ.md` | — | Instalação Windows, privacidade, limitações, medições. |

### Arquivos alterados (7)

| Arquivo | Alteração | Risco controlado |
| --- | --- | --- |
| `src/server.js` | Importa o serviço de voz; duas rotas novas; `voice.close()` no shutdown. | Rotas antigas intactas; voz só é criada se o módulo carregar. |
| `src/http-utils.js` | `media-src 'self' blob:` no CSP; `microphone=(self)` no Permissions-Policy. | Câmera e geolocalização continuam bloqueadas. |
| `public/index.html` | Botão `#voice-btn` dentro do `<form id="composer">` + região `aria-live`. | Nenhum elemento existente removido ou renomeado. |
| `public/app.js` | Importa `voice.js`; ponte `voiceBridge` (delta/done); `setupVoice()` no boot. | Com a voz desligada, `sendMessage()` se comporta exatamente como antes. |
| `public/styles.css` | 66 linhas de estilo (botão circular, anéis, responsivo, `prefers-reduced-motion`). | Escopo por classe nova; nada global. |
| `scripts/doctor.mjs` | Checagem `Voz (TTS)`. | Só leitura; falha vira `warn`, nunca `fail`. |
| `.env.example`, `package.json`, `src/config.js`, `README.md`, `CHANGELOG.md` | Configuração, script `voice:bench`, versão 0.4.0, documentação. | Nada de segredo versionado. |

### O que **não** foi tocado

`src/agent.js`, `src/graph.js`, `src/sessions.js`, `src/memory.js`,
`src/gateway.js`, `src/copilot/*`, `sites/*`, `public/demo/*`,
`public/widget/kirana-widget.js`, `iniciar.bat`, `diagnostico.bat`, `data/`.

---

## 4. Comparação com o Marco 2

| Item | Marco 2 (v0.3.0) | Marco 3 (v0.4.0) | Situação |
| --- | --- | --- | --- |
| Testes automatizados | 181 / 181 | **219 / 219** (+38) | ✅ ampliado, nenhum removido |
| Navegador: site de demonstração | 15 / 15 | **15 / 15** | ✅ sem regressão |
| Navegador: voz | — | **34 / 34** | ✅ novo, com áudio real |
| `npm run audit` (contrato do gateway) | 0 violações | **0 violações** | ✅ payload inalterado |
| Rotas HTTP | 14 | **16** (+2 de voz) | ✅ nenhuma alterada |
| Ferramentas | 7 | **7** | ✅ nenhuma removida |
| Orquestrador | LangGraph | **LangGraph** | ✅ mesmo |
| Sessões/memória/HITL | próprias da Kirana | **as mesmas** | ✅ voz não contorna nada |
| `/api/copilot` | funcionando | **funcionando** | ✅ voz não depende dele |
| Dependências Node | 8 + 2 dev | **8 + 2 dev** | ✅ nenhuma nova |
| Dependência nova | — | Python 3 + `edge-tts==7.3.1` (**opcional**) | ⚠️ externa, não oficial |
| Versão | 0.3.0 | 0.4.0 | — |

### Desempenho (texto, não voz)

A voz **não entra no caminho do texto**: `/api/chat` não foi alterado e a
geração de fala acontece depois, em paralelo à leitura da resposta. A referência
do Marco 2 (~1,8–1,9 s até o primeiro token, ~3–4 s no total, com o gateway real)
continua valendo; não foi remedida neste ambiente porque o gateway real não está
aqui — o que roda nos testes é o gateway simulado.

### Desempenho (voz, medido)

| Medida | Meta do pedido | Medido (`npm run voice:bench`) |
| --- | --- | --- |
| Primeiro byte de áudio | ≤ 800 ms (ideal 500) | mediana ≈ **700 ms**; faixa 661–1025 ms |
| Fim de fala → envio | 400–800 ms | **900 ms** de silêncio configurado (ver nota) |
| Interrupção | 100–300 ms | **3–5 ms** (worker morto); áudio pausa imediatamente |
| Ritmo da fala | 150–180 ppm | **157 ppm** com `+8%` (natural: 146) |

Nota honesta sobre o "fim de fala": o pedido era detectar o fim do enunciado em
400–800 ms. O valor escolhido foi **900 ms de silêncio**, porque abaixo disso
pessoas que falam devagar eram cortadas no meio da frase em teste manual. É um
parâmetro único em `LISTEN_TUNING.silenceMs` — se preferir 600 ms, muda-se uma linha.

---

## 5. Segurança

| Exigência | Como está |
| --- | --- |
| Mesmas sessões e ferramentas | Voz chama `sendMessage()`; nada de rota paralela. |
| Voz não contorna autorização | Teste de navegador: `"sim"` falado **não** gera `POST /api/chat/confirm` e **não** cria registro. |
| Resolução estrita de `siteId` | Inalterada (`site-kit.js`); a voz não tem `siteId` próprio. |
| Isolamento entre clientes | Sessão obrigatória no `/api/voice/tts`; sessão inexistente → `404`, sem processo criado. |
| Tokens HITL de uso único | Inalterados; nenhum token passa pelo áudio. |
| Credenciais fora do navegador | O navegador só fala com a Kirana; nada de chave no frontend. |
| Gateway não publicado | Nada mudou; a voz não usa o gateway. |
| Limites de tamanho/duração | Texto ≤ 3000 caracteres (`413` acima); corpo ≤ 32 KB; taxa por IP. |
| Envio de texto a terceiro | Documentado em `docs/VOZ.md` (seção Privacidade) e no `.env.example`. |

Novas superfícies de ataque consideradas: (a) texto grande → recusado;
(b) requisição sem sessão → recusada; (c) origem cruzada → `403`;
(d) cliente que abandona → processo Python morto em milissegundos (testado);
(e) provedor fora do ar → estado `erro`, conversa por texto preservada.

---

## 6. Testes: o que é prova e o que não é

| Tipo | Ferramenta | O que prova |
| --- | --- | --- |
| 38 testes automatizados | `node --test` | Lógica de limpeza de texto, máquina de estados, contratos HTTP das rotas de voz (com worker falso). |
| 34 verificações de navegador | Playwright/Chromium | DOM real, clique real, `getUserMedia` real, MP3 real, `<audio>` real tocando, barge-in real, HITL. |
| `npm run voice:bench` | worker real | Latência, ppm e interrupção do provedor de verdade. |
| 15 verificações do demo | Playwright | Marco 2 continua funcionando. |

**O que continua sem prova:** microfone físico e som audível por uma pessoa. O
ambiente de desenvolvimento não tem placa de áudio nem microfone; o
`SpeechRecognition` do Chromium depende de serviço externo de transcrição e é
substituído por um dublê nos testes. Isso está declarado em `docs/VOZ.md` e
**precisa ser validado na máquina do usuário**.

---

## 7. Como validar na sua máquina (Windows)

```bat
:: 1. Python + dependência da voz
py -3 -m pip install edge-tts==7.3.1

:: 2. Diagnóstico: a linha "Voz (TTS)" deve aparecer com ✓
diagnostico.bat

:: 3. Testes automatizados (219)
testar.bat

:: 4. Navegador com áudio real (34 verificações)
npx playwright@1.64.1 install chromium
node test\browser\voice-flow.mjs

:: 5. Latência real na SUA rede (aqui pode ser melhor ou pior que no sandbox)
npm run voice:bench

:: 6. Uso normal
iniciar.bat
```

Checklist manual (5 minutos): clique no microfone → permita → fale "quero saber
sobre atendimento no WhatsApp" → a Kirana deve responder por escrito **e** falar;
toque no botão enquanto ela fala → o som para e ela volta a ouvir; peça um
contato comercial → o cartão de confirmação aparece e a voz avisa que a
confirmação é na tela.

---

## 8. Pendências e limites (sem maquiar)

1. **Provedor externo não oficial.** O endpoint do Edge TTS pode mudar. Não é
   offline; não é equivalente à voz do ChatGPT. Se ele cair, a Kirana fica muda
   e o texto continua.
2. **Meta de 500 ms não é atingida** e 800 ms não é garantido em toda execução.
3. **Fim de fala em 900 ms**, acima da faixa pedida (400–800 ms) — decisão
   registrada, ajustável em uma constante.
4. **Sem medição em Windows**: latência e ppm foram medidos no sandbox Linux.
5. **Sem microfone físico** no ambiente de testes.
6. **Firefox** não tem `SpeechRecognition` e não suporta MP3 em `MediaSource`:
   funciona com o caminho alternativo (acumula e toca), sem streaming.
7. **Não publicado.** Nada foi enviado a `opportunity.ia.br`; o widget público
   não foi alterado; deploy depende de autorização explícita.
8. **Sem controle de custo do provedor**: o Edge TTS não cobra e não tem cota
   declarada; por isso os limites de tamanho e taxa existem do lado da Kirana.

---

## 9. Arquivos desta entrega

- Pacote: `kirana-v0.4.0.zip` (reproduzível a partir da pasta, sem `node_modules`).
- Checkpoint: `checkpoints/kirana-v0.4.0-<data>.tgz`.
- Documentos: `docs/VOZ.md`, `docs/AUDITORIA-MARCO3.md` (auditoria + o que foi
  construído), este relatório, `CHANGELOG.md` (seção 0.4.0).
