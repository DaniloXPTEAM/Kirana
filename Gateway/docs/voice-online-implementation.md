# Voz online — estado da implementação

Data: 2026-10-24. **Thalita foi verificada e gerou MP3 real por `edge-tts` 7.3.1; stream real também foi testado do Python ao proxy Node. O áudio não foi reproduzido/escutado em browser físico neste ambiente.** Nenhum login SIWC, inferência textual live ou TTS Azure pago foi usado. Testes com mock continuam identificados como simulados.

## Análise do SIWC no código existente

`src/auth.js` monta o consentimento OAuth PKCE com os escopos:

- `openid`, `profile`, `email`, `offline_access`
- `resource.invoke`
- `chatgpt.tokens.use.direct`

O Gateway valida o escopo `chatgpt.tokens.use.direct`, mantém access/refresh tokens apenas em memória e, após o consentimento, disponibiliza `/auth/status` autenticado ao bearer **local** do Gateway. Agora esse status retorna apenas os **nomes dos escopos concedidos** (`grantedScopes`) junto ao estado; nenhum token, e-mail ou identificador é incluído. A lista de escopos é atualizada no refresh e apagada ao encerrar a sessão.

`src/responses.js` usa exclusivamente `https://api.openai.com/v1/models` e `/v1/responses`. O request de conversa envia `store:false` e `stream:true`, lendo eventos SSE de texto. A descoberta transforma `/v1/models` em `{id,name}` e descarta quaisquer campos de modalidade/áudio; portanto, hoje o Gateway **não recebe nem expõe uma declaração de capacidades de áudio por modelo**. Não existe endpoint de áudio ou sessão Realtime em `src/auth.js`, `src/responses.js` ou `src/gateway.js`.

O escopo concedido não lista permissão específica de áudio. Isso sozinho não prova que outra rota seria negada, mas a documentação pública SIWC consultada define a rota de plan-use como Responses e exclui entrada de áudio/vídeo e transcrição. Não documenta TTS, `output_audio` nem criação de sessão Realtime. Assim, esta implementação não testa nem presume que o token SIWC autorize `/v1/audio/speech` ou `/v1/realtime`; não toca em `backend-api` ou qualquer rota privada do ChatGPT.

As alternativas oficiais também foram avaliadas sem chamar nenhuma rota: a API Realtime documenta áudio bidirecional, interrupções e sessão ephemeral criada pelo servidor, mas é uma API de desenvolvedor separada, não concedida pelo SIWC. A documentação de áudio em Chat Completions usa endpoint/modelos de áudio próprios e inclui exemplo com `store:true`, incompatível com a regra SIWC de `store:false`/Responses. `/v1/audio/speech` documenta TTS em streaming, porém autenticação/preço pertencem à API de desenvolvedor; os modelos TTS citados (tts-1, tts-1-hd, gpt-4o-mini-tts) têm desligamento anunciado para 2027-01-06, com orientação de migração para Realtime, que continua separado do SIWC. Portanto, nenhuma rota OpenAI/SIWC paga ou não documentada foi acionada. A seção de voz abaixo documenta separadamente a chamada externa, solicitada pelo usuário, via `edge-tts`; ela não usa credenciais SIWC nem uma rota OpenAI.

Fontes: [SIWC Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) · [SIWC Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [Realtime API](https://developers.openai.com/api/docs/guides/realtime) · [Text to speech / deprecation](https://developers.openai.com/api/docs/guides/text-to-speech) · [Audio in Chat Completions](https://developers.openai.com/api/docs/guides/audio-chat-completions).

## Implementado agora

- Cliente web local para Chrome/Edge: `examples/voice-client/voice.html`, com JS em módulo externo `examples/voice-client/app.js` e adapters em `providers.js`.
- Servidor de demonstração restrito a loopback: `examples/voice-client/server.mjs`; comando `npm run voice` a partir da raiz do Gateway. Serve `app.js` como `text/javascript; charset=utf-8`. A página mantém `script-src 'self'` sem `unsafe-inline`.
- Arquitetura: SpeechRecognition browser em `pt-BR` → texto pelo proxy local à rota existente `/v1/chat/completions`/SIWC textual → resposta incremental preservada na UI/histórico → trechos por sentença no adapter Edge TTS (`pt-BR-ThalitaMultilingualNeural`) → MP3 em streaming por proxy local → MSE no browser quando `audio/mpeg` for suportado.
- Adaptador separado: `edge-tts-adapter.js` (client/sanitizer), `edge-tts-runner.mjs` (spawn/controla Python), `edge_tts_worker.py` (usa `edge-tts` Python), `tts-routing.js` (fallback/cancel); dependência em `requirements-edge-tts.txt` (pin 7.3.1). Cada worker é um filho por síntese; desconexão, botão Interromper ou shutdown Node mata o processo.
- O catálogo consultado em 2026-10-24 confirmou voz exata `pt-BR-ThalitaMultilingualNeural`, female, locale pt-BR, status GA no catálogo Edge. `pt-BR-FranciscaNeural` também constava no catálogo. Na interface, Thalita é a opção padrão se o catálogo remoto a expuser; Francisca é opção/fallback somente se o navegador expuser a voz SpeechSynthesis correspondente.
- TTS recebe frases logo que delimitadas no SSE, sem aguardar o final da resposta textual. Backend envia chunks MP3 conforme chegam; MSE inicia ao receber bytes utilizáveis. Se MSE não for suportado, o adapter lê a frase inteira antes do playback. Se Thalita falhar antes/depois de começar, Francisca é tentada para não omitir o trecho, mas uma falha depois de playback parcial pode repetir parte da frase.
- `sanitizeTextForSpeech()` remove emojis e marcadores Markdown/URLs/HTML apenas na cópia de fala; a resposta visível e o array `messages` mantêm os deltas originais.
- UI mantém o chat atual: estado de sessão/modelos, mic/transcrição, resposta/streaming, contínuo, interrupção de request e áudio, voz/modelo, errors e métricas de STT/primeiro token/primeiro playback/fim do texto. O chip TTS mostra serviço disponível e atualiza para provider realmente tocando. Existe botão de fallback Francisca só se a voz estiver exposta.
- O proxy carrega `GATEWAY_API_KEY` do `.env` local/processo e mantém a chave no processo Node. Ela não é colocada no HTML nem enviada ao browser. Só repassa modelos e chat textual em streaming; rejeita campos inesperados, origem diferente, host incorreto e destinos upstream fora de loopback. A página só é servida em `127.0.0.1`, sem CORS.
- `/auth/status` continua inalterado. Proxy local só acrescenta `/api/tts/voices` e `/api/tts/stream` à porta 1456, mesma origem. `app.js`, `providers.js`, `edge-tts-adapter.js` e `tts-routing.js` são módulos externos servidos como JavaScript; CSP mantém `script-src 'self'` sem `unsafe-inline` e `media-src` permite `blob:` necessário ao MediaSource. Gateway key continua exclusivamente no servidor.
- `providers.js` encapsula as interfaces Web Speech: pré-verificação explícita de `getUserMedia` (encerra as tracks assim que confirma uma track ativa), `SpeechRecognition` pt-BR e `SpeechSynthesis`. Não afirma conhecer o provedor STT interno do navegador.
- A UI permite exportar JSON sanitizado pelo botão “Exportar métricas E2E”: contém mecanismos declarados, voz selecionada, escopos (nomes), flags, latências e confirmação subjetiva de áudio. Não inclui áudio, transcrição, resposta, tokens ou segredos. “Limpar turno” apaga conteúdo local e métricas do turno, sem encerrar a sessão SIWC.

### Fronteira importante do que é online

- O texto da Kirana é processado online pelo Responses/SIWC existente, com a autorização e as regras de quota desse fluxo.
- O microfone e o reconhecimento são administrados pelo navegador via Web Speech API. O fornecedor, o caminho do áudio, a retenção e o eventual uso de rede dependem do navegador/OS; o Gateway não recebe arquivo de áudio, apenas a transcrição. A UI informa isso antes de pedir permissão.
- Thalita usa pacote `rany2/edge-tts` (LGPL-3.0) que contata o Edge Read Aloud consumer service. Essa não é a API pública suportada de Azure Speech; não há SLA/contrato público para este uso e chamadas podem falhar ou ser bloqueadas. A Microsoft indica que Edge Online voices enviam o texto ao serviço Microsoft. Informe consentimento e não use conteúdo sensível. A Francisca fallback é apenas browser/OS SpeechSynthesis quando exposta.
- Nenhuma credencial Azure/OpenAI nem serviço TTS pago é usada. Uso do endpoint Edge Read Aloud e direitos de redistribuição de áudio não têm confirmação pública clara; revisar termos locais. Se for necessário contrato/licenciamento comercial, usar Azure AI Speech com aprovação específica e chave/consumo autorizados; não ativado aqui.
- A interrupção é explícita pelo botão: cancela a reprodução e aborta a requisição textual. Não há detecção acústica de barge-in enquanto a síntese toca; para evitar falso reconhecimento do próprio áudio, não fica escutando simultaneamente durante playback.

## Uso local

1. Mantenha/configure o Gateway existente (`npm start`) e a sessão SIWC já consentida; esse patch não muda OAuth, `.env` nem o processo da porta 1455.
2. Instale Python launcher e pacote: `py -3 --version` e `py -3 -m pip install --user -r examples\\voice-client\\requirements-edge-tts.txt`. O Node chama `py -3` no Windows. Opcional: defina `KIRANA_EDGE_TTS_PYTHON` para caminho de um `python.exe` específico sem alterar `.env`.
3. Em outro terminal na raiz, rode `npm run voice`. O servidor segue bind em `127.0.0.1:1456`; o TTS faz conexões de saída para Edge Read Aloud, mas não abre porta pública.
4. Abra `http://127.0.0.1:1456` em Edge/Chromium atualizado. Conceda microfone após rever a nota de privacidade. O catálogo online carrega no início; Thalita fica default se presente.
5. Interromper cancela o TTS fetch/worker e a reprodução atual; o servidor mata Python também no shutdown. Se Thalita der erro, a UI tenta Francisca browser se instalada/exposta.
6. Para o E2E verificável em Windows: com uma frase não sensível, confira a transcrição pt-BR, a resposta em streaming e a reprodução audível; teste “Interromper”, “Atualizar conexão” e “Limpar turno”. Depois de um turno bem-sucedido, use “Exportar métricas E2E” e responda se ouviu áudio. O JSON registra provider declarado e latências, sem guardar áudio, transcrição ou resposta. Antes de compartilhar, revise o arquivo; não envie `.env`, cookies, tokens nem conteúdo privado. Um relatório exportado ainda precisa ser revisado, e não substitui a confirmação de que o áudio foi realmente produzido/entendido.

### Atualização cirúrgica no Windows (preserva `.env` e SIWC)

1. Baixe/descompacte o pacote atualizado em uma pasta temporária; não extraia por cima da instalação.
2. Na janela do servidor de voz, pressione `Ctrl+C` para encerrar apenas a porta 1456. **Deixe o Gateway na 1455 rodando**: a sessão SIWC é mantida em memória pelo processo Gateway. Não execute novamente Setup/consentimento, não substitua `.env` e não apague `.local-state`/arquivos locais.
3. Copie da pasta temporária somente estes arquivos de `examples\\voice-client\\`: `voice.html`, `app.js`, `providers.js`, `edge-tts-adapter.js`, `edge-tts-runner.mjs`, `edge_tts_worker.py`, `tts-routing.js`, `requirements-edge-tts.txt` e `server.mjs`. Não substitua `src/`, `.env`, `package.json`, `package-lock.json`, o estado local nem outras configurações.
4. Instale a dependência Python indicada no passo Uso local e rode novamente `npm run voice`. Abra `http://127.0.0.1:1456` e faça hard refresh (`Ctrl+F5`). No DevTools, confirme módulos JS 200, CSP sem erros, sessão SIWC/modelos, `/api/tts/voices` com Thalita, e depois `/api/tts/stream` com `audio/mpeg`. Não compartilhe logs/arquivos de configuração.
5. A alteração não muda OAuth nem autenticação. Se o processo Gateway for reiniciado, a sessão em memória pode exigir o consentimento normal novamente; por isso, para preservar a sessão autenticada existente, pare/reinicie somente o servidor de voz.

## Integração com Kirana V2 / CopilotKit / LangGraph

`voice.html` é uma amostra independente e não altera o projeto V2. Para integração, o componente visual pode manter a UI (permissão explícita, status, transcript, cancel, playback), mas a autenticação local deve ser provida por uma bridge segura do host — nunca embutir a chave do Gateway em bundle/browser storage ou enviar token SIWC ao frontend.

- Contrato de inferência já existente: `POST /v1/chat/completions` com `{model,messages,stream:true}` e eventos Chat Completions SSE.
- STT atual entregue pela amostra: texto final, `role:user` comum. Não há upload de áudio nesta amostra.
- Eventos de UI sugeridos: `listening.started`, `transcript.final`, `response.first_delta`, `speech.started`, `speech.interrupted`, `session.error` (eventos locais ao frontend, não parte da API pública atual).
- CopilotKit/LangGraph podem orquestrar chamadas a ferramentas/graph somente na camada V2. Não tornar a chave SIWC uma ferramenta nem criar rota que aceite áudio diretamente no SIWC sem contrato oficial.
- Quando houver sessão Realtime oficial elegível, ela deve ser um provider separado, com tipo de transporte e autenticação próprios, sem mudar o adapter SIWC Responses textual. Até então, usar esse pipeline híbrido e rotular cada fonte corretamente.

## Verificação, limitações e próximos passos

- Executado: `npm run check` e `npm test` **42/42**; teste real `edge-tts --list-voices` no pacote 7.3.1 confirmou exact `pt-BR-ThalitaMultilingualNeural` e `pt-BR-FranciscaNeural` (ambas pt-BR Female, GA).
- Executado de verdade: CLI produziu `/home/user/thalita-teste.mp3` usando a frase solicitada (38 KB, MPEG Layer III 24 kHz mono 48 kbps); helper Python também produziu MP3. Integração real Node→Python→Edge TTS retornou catálogo, HTTP 200 `audio/mpeg`, 32,976 bytes; primeiro byte de áudio chegou em ~1,184 ms. Outra chamada mediu primeiro chunk do SDK Python ~2,249 ms e completou em ~5,416 ms. São métricas de chegada de dados na sandbox, não playback audível/Windows.
- Testes automatizados simulados cobrem CSP/external modules, sanitização, endpoints/catálogo via fake, MP3 stream fake, SIWC route unaffected, cancellation of fake worker, and fallback logic. Esses não validam MSE nem Francisca real.
- Ainda não testado: play audível em Edge/Chrome Windows, MSE decodificar o stream em browser de destino, click Interromper parar som físico, fallback com uma voz Francisca realmente exposta, fluxo mic/STT, resposta SIWC real e primeiro som audível. Portanto, a troca está implementada e serviço/geração foram testados live, mas **aceitação E2E do usuário ainda depende de Windows real**.
- A amostra não implementa arquivo de áudio, streaming de entrada, Realtime duplex, TTS cloud, resposta de áudio gerada pelo modelo, cancelamento acústico nem detecção automática de interrupção. Consequentemente, **a conversa de voz completa ainda não está comprovada como operacional**.
- Próxima validação local, com usuário presente e autorização de uso da cota: testar uma frase curta em `pt-BR`, uma resposta de texto única, uma voz de navegador, interromper, testar silêncio e indisponibilidade de rede; anotar latências medidas no browser, versão/OS/navegador e voz escolhida. Não incluir prompt ou áudio pessoal no relatório sem consentimento.
- Thalita Edge TTS é um provider online separado e experimental; não o atribuir ao SIWC. Realtime/voz gerada pelo modelo continua não suportado. Não marcar `audio.transcribe`/`audio.synthesize` do Gateway como rotas SIWC disponíveis. Para uso de produção/comercial, antes exigir clareza contratual do serviço e, se necessário, autorização e orçamento para Azure AI Speech oficial.
- Fontes do adapter: [rany2/edge-tts](https://github.com/rany2/edge-tts) · [Microsoft Edge privacy: online voices send text to Microsoft](https://learn.microsoft.com/en-us/legal/microsoft-edge/privacy) · [Azure Speech official TTS overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech). A publicação do wrapper open-source não transforma a interface de serviço Edge Read Aloud em API Microsoft oficialmente suportada.
