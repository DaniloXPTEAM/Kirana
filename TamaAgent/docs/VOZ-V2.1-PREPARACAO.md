# Kirana V2.1 — preparação do modo de voz conversacional

> **Status: NÃO IMPLEMENTADO.** Este documento é o desenho da integração futura.
> Nenhuma linha de voz entrou em execução na v0.3.0. Nenhum arquivo do patch
> `Kirana-Voice-Thalita-Update-v0.4.0.zip` foi instalado ou copiado.

## 1. Experiência alvo

Botão circular de voz na interface principal da Kirana; conversa sem digitar;
respostas faladas por voz feminina brasileira (Thalita Neural); escuta automática
após a resposta; detecção de fim de fala; interrupção quando o usuário volta a falar;
histórico único com o chat textual; todas as ferramentas preservadas; sem leitura de emojis.

## 2. Arquitetura proposta (compatível com o que já existe)

```
Navegador (interface Kirana ou widget)
  ├── Web Speech API (SpeechRecognition, pt-BR)   ← entrada de fala
  │       └── texto parcial/final
  ├── POST /api/chat (SSE)  ─┬─ mesmo caminho textual da v0.3.0
  │   ou /api/copilot       ─┘   (LangGraph → gateway SIWC → modelo)
  └── Áudio de saída
          ├── preferencial: SpeechSynthesis (voz local pt-BR) — zero dependência
          └── desejado: Thalita Neural via gateway SIWC (TTS)
```

Princípio: **a voz é uma camada de entrada/saída em volta do mesmo agente.** O cérebro
(LangGraph), as ferramentas, o gateway e as sessões não mudam. Isso evita o "segundo
chatbot" que o patch experimental criava.

## 3. Componentes reutilizáveis esperados do patch Thalita

Ao receber o ZIP, extrair **apenas** e adaptar:

| Componente do patch | Reuso na V2.1 | Observação |
|---|---|---|
| Captura `SpeechRecognition` (pt-BR, interim results) | sim | normalizar eventos para o compositor existente |
| Detecção de fim de fala / debounce | sim | precisa respeitar `stream-state.js` |
| Chamada de TTS pelo gateway SIWC | sim, se o endpoint existir | **verificar contrato antes de assumir** |
| Reprodução de áudio + fila | sim | precisa suportar interrupção |
| Interface experimental própria do patch | **não** | a voz entra na Kirana V2.1, não em UI separada |
| Chaves/credenciais do patch | **não** | usar as credenciais já existentes; nada novo no frontend |

Regra de segurança mantida: `GATEWAY_API_KEY` e sessão OAuth continuam **só no backend**.
O navegador nunca fala com o gateway diretamente.

## 4. Contratos a definir antes de implementar

1. `POST /api/voice/tts` (proposto) — backend recebe `{ text, voice: 'thalita' }`, chama o
   gateway SIWC e devolve `audio/*` em streaming. **Depende de confirmar que o gateway
   expõe TTS** — hoje ele expõe apenas `/v1/chat/completions` e `/v1/models`.
2. Sanitização de texto para fala: remover markdown, URLs longas, emojis e blocos de código.
3. Controle de turno: barge-in (usuário fala → cancela TTS e o stream em curso).
4. Persistência: mensagens de voz entram na mesma sessão (`role: user/assistant`) com marcador
   `modality: 'voice'` — o histórico continua único.

## 5. Pontos de extensão já existentes no código (v0.3.0)

| Ponto | Arquivo | Uso futuro |
|---|---|---|
| Compositor e estados do indicador | `public/stream-state.js` | estado "ouvindo", "pensando", "falando" |
| Encerramento de SSE no cliente | `public/app.js` (`finalize`, `stopGeneration`) | barge-in reaproveita o mesmo caminho |
| Streaming no servidor | `src/sse.js`, `src/server.js` (`streamAgentTurn`) | TTS pode usar o mesmo padrão de stream |
| Ferramentas | `src/tools/registry.js` | nada a fazer: voz usa as mesmas ferramentas |
| Sessões | `src/sessions.js` | histórico compartilhado texto+voz |
| Widget por site | `sites/<id>/site.json` | `features.voice` a acrescentar quando existir |

## 6. Critérios de aceite para o Marco 3

- [ ] Botão circular na interface principal (não em UI separada).
- [ ] Fala → texto → resposta falada, com o mesmo agente e as mesmas ferramentas.
- [ ] Interrupção: começar a falar cancela o áudio e o streaming.
- [ ] Histórico único (texto e voz na mesma thread).
- [ ] Emojis e markdown não são lidos literalmente.
- [ ] Nenhuma credencial nova; gateway SIWC preservado.
- [ ] Testes de navegador reais (Chromium) cobrindo o ciclo de voz.
- [ ] Declarar explicitamente o que é voz local do navegador × voz neural do gateway.

## 7. Pendências de informação (bloqueiam a implementação)

1. O ZIP `Kirana-Voice-Thalita-Update-v0.4.0.zip` não está disponível no ambiente Arena —
   precisa ser anexado ao projeto para extrair os componentes reutilizáveis.
2. Confirmar se o gateway SIWC expõe endpoint de TTS (e qual o contrato), ou se a Thalita
   é servida por outro serviço já autenticado pela mesma sessão.
3. Definir se a voz de saída inicial é a do navegador (sem dependência) ou já a Thalita.
