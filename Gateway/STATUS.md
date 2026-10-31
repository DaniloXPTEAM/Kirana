# Handoff — Kirana ChatGPT Gateway v0.4.1 (motor + identidade) / v0.4.0 (etapas 3–6)

**Estado: código e contratos multimodais integrados; suíte mock/local aprovada. Capacidades de mídia ainda não foram testadas com provedor real e permanecem indisponíveis no catálogo até uma operação real bem-sucedida.** Nenhum engine/modelo foi instalado/baixado; nenhuma inferência paga ou real foi chamada.

## v0.4.1 — Motor de modelos, identidade real e política de execução

Motivo: o v0.4.0 **ecoava** o modelo pedido e descartava `response.model`. O cliente
não tinha como saber qual modelo respondeu — e a resposta "qual motor você usou?"
era, na prática, o nome que ele mesmo tinha pedido.

Entregue:

- `src/engine.js`: catálogo de capacidades (`declared` / `tested` / `unavailable` /
  `unknown`), circuit breaker com meio-aberto, `selectChain` (pedido explícito >
  capacidade especializada **testada** > primário preservado > fallback só em falha),
  `executeChain` (timeout por tentativa que vale mesmo com chamador teimoso, trava
  anti-loop, teto de saltos) e `RunLog` (ring buffer 200, só metadados).
- `src/responses.js`: captura `response.model`, `response.id`, `response.status` e
  `usage` → identidade em 5 campos: `model_requested`, `model_selected`,
  `model_used`, `model_reported`, `identity_verified`.
- `src/gateway.js`: `GET /v1/engine`, `GET /v1/runs`, `GET /v1/runs/:id`; execução
  com fallback limitado, só antes do primeiro byte; custo pago → **402
  `cost_blocked`**; nenhum candidato → **503 `no_candidate_available`**.
- `src/main.js`: `KIRANA_ROUTING`, `KIRANA_PRIMARY_MODEL`, `KIRANA_FALLBACK_MODEL`,
  `KIRANA_COST_POLICY`, `KIRANA_ENGINE_TIMEOUT_MS`, `KIRANA_ENGINE_ATTEMPTS`,
  `KIRANA_BREAKER_FAILURES`, `KIRANA_BREAKER_RESET_MS`, `KIRANA_MODEL_CATALOG`,
  `KIRANA_SPECIALIZED`, com validação na inicialização.
- `config/models.json`: catálogo **vazio de propósito**. Capacidade declarada não é
  capacidade testada.
- `tools/quality-suite.mjs`: bateria de qualidade com critérios objetivos, medida de
  latência/tokens/identidade, modo `--mock` (prova o instrumento) e recusa explícita
  (código 2, "Suíte NÃO executada") quando falta SIWC.
- Documentação: `docs/engine.md` e `docs/tama-integration.md`.

Verificação executada nesta revisão:

- `npm run check`: passou (inclui `src/engine.js`, dois arquivos de teste novos e a bateria).
- `npm test`: **76/76 passaram** (42 anteriores + 22 de política do motor + 12 de
  integração HTTP do motor). Nenhum teste antigo foi alterado.
- `npm run quality:mock`: 6 aprovadas, 1 `nao_aplicavel` (`images.analyze`, sem modelo
  testado), 0 falhas — em modo mock, que prova apenas o harness.
- **Nenhum modelo real foi executado.** Prova com conta real exige SIWC consentido
  pelo dono da conta e permanece pendente.

Compatibilidade: sem `KIRANA_ROUTING=on`, o comportamento é o do v0.4.0 (modelo pedido
= modelo executado, sem fallback). Bind continua restrito a `127.0.0.1`; portas
inalteradas.

## Entregue na revisão v0.4.0

- Preservados o fluxo textual v0.3, SIWC público/Responses, API de arquivos, `.env` e estado local; baseline v0.3.0 separado continua sem alterações.
- Visão: validação de assinatura/tamanho/MIME em imagens armazenadas; `/v1/images/analyze` e contrato multimodal Responses, sem rota privada. Usuário seleciona modelo presente em `/v1/models`.
- Geração/edição de imagem: `/v1/images/generate`, `/v1/images/edit`, polling/cancelamento; adaptador ComfyUI loopback usando workflow API-format configurável.
- Vídeo: `/v1/videos/analyze` (FFmpeg keyframes + SIWC visual + transcrição opcional Whisper.cpp), `/v1/videos/generate`, job status/cancelamento. Análise é keyframes amostrados, não raciocínio temporal nativo.
- Áudio Gateway: `/v1/audio/transcriptions` assíncrona via Whisper.cpp/FFmpeg; `/v1/audio/speech` WAV via Piper. As rotas não são streaming/Realtime. Foi acrescentada uma amostra browser híbrida separada, não marcada como provider do Gateway.
- `src/jobs.js`: fila serializada, estado persistente de jobs, progresso, cancelamento, saída por referência de arquivo, `error_code:null` quando sucesso, jobs interrompidos após restart.
- Binary upload para mídia, preservando validação e storage/TTL/quota. Limite padrão continua 10 MiB; aumentável conscientemente para no máximo 250 MiB.
- Atualizados `.env.example`, README, contratos, notas de candidatos/licenças/hardware e upgrade Windows.
- ZIP Windows v0.4.0 com source apenas: sem `.env`, `.local-state`, `node_modules`, engines, modelos ou weights. Refeito com a amostra de voz e documentação; 50 arquivos, CRC verificado.

## Matriz honesta de capacidades

| Capacidade | Código | Configuração/serviço | Testes desta sessão | Disponibilidade atual |
|---|---|---|---|---|
| Texto (`text.chat`) | Implementado desde versões anteriores | SIWC consentido; depende de sessão/modelo do usuário | Mock/regressão; sem conta real | Código disponível; estado de conta requer execução local |
| Arquivos create/upload/download | Implementado | Storage local/quota/TTL | HTTP/file system local com fixtures | Disponível localmente |
| Visão (`images.analyze`) | Adapter implementado | SIWC autenticado e modelo com visão compatível | Contrato Responses e assinatura com mocks | **Indisponível até inferência real bem-sucedida** |
| Imagem generate/edit | Adapter/job implementado | ComfyUI local, workflows corretos, modelo/nodes/recursos | Rota fail-closed e job/storage mock; sem ComfyUI real | **Indisponível; workflow/engine real pendente** |
| Vídeo analyze | FFmpeg frames + SIWC; Whisper opcional | FFmpeg, SIWC/modelo; Whisper se quiser áudio | Nenhuma inferência/FFmpeg real | **Indisponível; configuração/teste pendente** |
| Vídeo generate | Adapter/job implementado | ComfyUI e workflow de vídeo/modelo local | Contrato descrito; sem geração mock de vídeo ponta a ponta | **Indisponível; workflow/engine real pendente** |
| Transcrição (`audio.transcribe`) | Adapter implementado | Whisper.cpp multilingue + FFmpeg locais | Persistência genérica de jobs, sem Whisper real | **Indisponível; engines/modelo pendentes** |
| Voz (`audio.synthesize`) | Adapter implementado | Piper e modelo/voz licenciados locais | Sem Piper real | **Indisponível; engine/modelo pendentes** |

`GET /v1/capabilities` separa `implemented`, `configured`, `ready`, `available`, provider e status. Em mídia, `available` só é marcado após resultado live real e não é persistido entre reinícios; mocks/configuração/health check não significam inferência funcional.

## Verificação executada

- `npm run check`: passou.
- `npm test`: **42/42 passaram** após adicionar testes CSP, sanitização de fala, rotas TTS/stream, cancelamento de worker e fallback roteado. `npm run check` passou. A suíte não substitui playback de browser físico.
- Nenhum teste real OAuth, modelo, ComfyUI, FFmpeg, Piper ou Whisper executado. Ver `docs/test-results.md`.

## Candidatos, custos e restrições

`docs/provider-candidates.md` lista fontes oficiais, licenças do código/modelos/vozes separadas, estimativas públicas de Whisper/Wan, pt-BR, custo local versus SIWC, limitações de hardware e roteiro para avaliar Windows. Não baixar weights ou instalar engines pesados sem analisar PC/disk/licença. ComfyUI é GPL-3.0 e FFmpeg varia por build; nenhum é redistribuído.

## Entrega e upgrade

- Pacote completo atualizado: `Kirana-ChatGPT-Gateway-v0.4.0-Windows.zip` (57 arquivos; CRC validado). Patch seletivo Windows: `Kirana-Voice-Thalita-Update-v0.4.0.zip` (11 entradas; inclui instruções e amostra MP3). Instalação recomendada é o patch; manter `.env` e `.local-state`.
- Instruções de upgrade/rollback preservando `.env` e `.local-state/<APP_ID>`: `docs/deployment.md`.
- Rotas e contratos: `docs/media-api.md`; candidatos: `docs/provider-candidates.md`.
- ZIP contém o projeto sem `node_modules`, credenciais, estado, executáveis/modelos ou dependências pesadas.

## Nova investigação — pedido de provider Arena (2026-10-24)

- O levantamento de docs oficiais está em `docs/arena-provider-investigation.md`.
- Arena tem API oficial para alguns fluxos text/coding, mas a documentação pública consultada declara output `text` para o router e restringe a lista de harnesses; a geração de imagem do site está documentada como Image Arena Battle Mode, sem contrato público de geração/retorno de bytes para um Gateway.
- Nenhum adaptador `arena` de imagem foi implementado porque não há contrato público compatível verificado. O `reverse-api-engineer`, browser de sessão e captura autorizada não estão disponíveis nesta conversa; nenhuma chamada privada/undocumented foi inspecionada ou reproduzida.
- Gemini tem API oficial separada para imagem, com custo de saída conforme tabela atual; não é Arena nem SIWC. Agnes AI tem API oficial separada de imagem, atualmente anunciada a US$0 na documentação consultada, sujeita a mudança e key própria. Nenhum request ocorreu.
- SIWC preview documenta limitações contra áudio/video input, files/transcription e image-generation tool; não há rota TTS/audio output documentada nesse fluxo. Não reutilizar access token SIWC para outro API.
- Bloqueio explícito para o primeiro proof: precisa de contrato Arena image-output oficial/entitlement, ou o usuário pode escolher um provider separado (Agnes ou Gemini) e configurar a chave localmente; não enviar chave pela conversa. Sem isso, não simular geração nem declarar `available`.

## Nova investigação — automação de Flow Web e suporte de voz SIWC (2026-10-24)

- Pesquisa estática em `docs/flow-ui-automation-investigation.md`; nenhum repositório foi clonado/instalado/executado, nenhuma sessão Google acessada, nenhuma geração/download ou consumo de crédito/cota ocorreu.
- `ffroliva/gflow-cli` v0.89.1 tem o melhor sinal de atividade e evidência publicada de geração real/download, mas seu README/disclaimer declara uso de REST privado; docs também descrevem evasão opcional de reCAPTCHA e técnicas anti-detecção. **Não integrar como está.**
- `swissmarley/gflow-cli` v1.1.1 alega dirigir apenas a UI do Chrome próprio, sem API privada, CAPTCHA bypass ou rate-limit evasion. É potencialmente o candidato de reavaliação, mas última mudança observada é 10-06-2026; issue aberta 02-10-2026 relata quebra após migração para `flow.google.com` e problemas no Windows/idioma. Modo `--no-headed` não deve ser usado. Funcionamento atual não validado.
- `GabrielGargiuloDev/google-flow-mcp` declara iniciar Chrome para fazer `navigator.webdriver` parecer falso; incompatível com restrição de não contornar proteções. `flow-api-client` usa RPCs internos e tokens de sessão reverse-engineered, declara violar ToS e não tem licença `LICENSE` observada; excluir.
- Termos Google consultados proíbem bypass de proteções e automatização em desacordo com instruções machine-readable; ajuda do Flow confirma rate limits, mas não há aprovação oficial específica para automação de UI/API pública de geração identificada. `flow.google.com/robots.txt` não pôde ser confirmado porque redirecionou para página protegida por reCAPTCHA. Sem autorização/certeza de termos, não executar.
- SIWC oficial documenta somente Responses API pública com `store:false`/`stream:true`; não autoriza inferir acesso a TTS ou Realtime, nem usar token SIWC em `/v1/audio/speech` ou `/v1/realtime`. Preservar voz local Piper e entrada/transcrição local Whisper.cpp.

## Implementação experimental — cliente de voz web (2026-10-24)

- Análise do código SIWC e escopos: `docs/voice-online-implementation.md`. Escopos efetivos são agora consultáveis (apenas nomes, nunca tokens) pela rota local autenticada `GET /auth/status`. A lista de modelos SIWC é filtrada e perde metadados de modalidade; Responses textual permanece única rota documentada pelo Gateway.
- Cliente local em `examples/voice-client/`: SpeechRecognition `pt-BR` → SIWC textual existente em streaming → adapter separado `edge-tts`/Thalita com MP3 transmitido ao browser por `MediaSource` quando suportado; Microsoft Francisca do navegador fica como fallback. API TTS passa pelo mesmo servidor loopback 1456 e worker Python por utterance, cancelável pelo Node. Scripts ES externos obedecem CSP `script-src 'self'`; CSP também permite `blob:` somente em `media-src` para MediaSource.
- A credencial do Gateway fica apenas no processo servidor, lida do `.env` local/env e não embutida no browser. O proxy restringe destino upstream a loopback e rotas text/model, valida Origin/Host e não recebe nem encaminha áudio bruto.
- O SIWC continua somente texto. O TTS usa o projeto `rany2/edge-tts` contra o serviço Edge Read Aloud (interface não documentada publicamente, sem SLA; texto da resposta sai para Microsoft); não é Azure Speech nem TTS do ChatGPT. Uso experimental e sujeito a mudanças/bloqueio. STT permanece browser/OS-managed.
- Executados de verdade neste ambiente: catálogo online edge-tts v7.3.1 confirmou `pt-BR-ThalitaMultilingualNeural` e `pt-BR-FranciscaNeural`; geração real de MP3 via CLI e worker Python; stream Node/Python real retornou HTTP 200, `audio/mpeg`, 32,976 bytes e primeiro byte em ~1,184 ms. Esse tempo é primeiro byte no servidor, não primeiro áudio audível.
- `npm run check` e `npm test`: **42/42**. Os testes simulados cobrem sanitizer, fallback, cancelamento worker, APIs e CSP. **Ainda não testado no Chromium/Edge Windows:** reprodução física, áudio MSE audível, cancelamento audível, fallback real Francisca, SIWC ao vivo no cliente e latency até primeiro som. Não usar como validado até confirmação local.

## Próximo handoff seguro

1. Aguardar rota/entitlement público oficial para imagem de Arena ou uma decisão do usuário sobre provider separado; não fazer reverse engineering.
2. Para Flow, não instalar/executar nenhum projeto até haver revisão e versão atual compatível, caminho sem stealth/bypass (preferivelmente interface visível, com verificação humana) e base oficial suficiente de autorização. Parar se qualquer CAPTCHA/login adicional/limite/bloqueio surgir.
3. Não realizar chamadas pagas nem consumir crédito/cota sem aprovação específica, imediata e explícita; não fazer reverse engineering de endpoints privados/cookies/tokens.
4. Só marcar capacidade disponível após retornar mídia real, validada e guardada como arquivo do Gateway. Mocks/fixtures não provam geração real.
5. Preservar `.env`/estado, Gateway, SIWC textual e baseline; não modificar Kirana. Não avançar etapas posteriores a 6 sem novo pedido.
