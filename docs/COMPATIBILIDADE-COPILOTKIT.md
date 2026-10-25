# Compatibilidade e limitações — CopilotKit na Kirana V2 (v0.3.0)

## 1. O que está validado

| Componente | Versão | Estado |
|---|---|---|
| Node (sandbox de validação) | v20.20.2 | ✅ |
| `@copilotkit/runtime` | 1.79.1 | ✅ carrega e serve `/api/copilot` |
| `CopilotRuntime` + `copilotRuntimeNodeHttpEndpoint` | 1.79.1 | ✅ envelope `{method, params, body}` validado |
| `BuiltInAgent` modo `custom` (`@copilotkit/runtime/v2`) | 1.79.1 | ✅ emite `RUN_STARTED`/`RUN_FINISHED`, valida o stream |
| `@ag-ui/core` / `@ag-ui/client` | 1.0.3 | ✅ tipos e nomes de evento conferidos |
| React / react-dom | 19.2.0 | ✅ (peer do runtime) |
| `@langchain/langgraph` | 1.5.2 | ✅ preservado, sem alteração |
| esbuild | 0.25.12 | ✅ build do widget em ~60 ms |
| playwright | 1.64.1 | ✅ testes reais de navegador |

`@copilotkit/react-core` e `@copilotkit/react-ui` estão **declarados e instalados**, mas
**não entram no bundle do widget** nesta máquina — ver limitação 2.1.

## 2. Limitações declaradas (não são "integração completa")

### 2.1 Bundle do `@copilotkit/react-core` não compila neste ambiente

- **Sintoma:** `esbuild` é encerrado pelo sistema (`Error: The service was stopped`) após
  ~3 min de build; memória do sandbox = 1,9 GB total.
- **Medições:** `react` + `react-dom` = 1,1 MB em 0,4 s; `react-core` (entry completo)
  estoura; `react-core/v2/headless` compila em 0,6 s mas não é autossuficiente (a árvore de
  contexto vem do chunk pesado).
- **Consequência prática:** o widget entregue (`widget/src/main-lite.jsx` → `public/widget/kirana-widget.js`,
  199 KB) fala **o protocolo do runtime oficial** (`POST /api/copilot`,
  `{method:"agent/run"}`, eventos AG-UI). O runtime oficial é quem executa o agente — a
  integração é real, mas **a camada de hooks React do CopilotKit não está em uso no navegador**.
- **Não declaramos** integração completa com `@copilotkit/react-core`.
- **Caminho para fechar:** em máquina com ≥4 GB livres, `node scripts/build-widget.mjs`
  (variante `copilotkit`, entrada `widget/src/main.jsx`) e revalidar os mesmos 15 testes de
  navegador. Nenhuma mudança de backend é necessária.

### 2.2 Modelo simulado nos testes

O gateway **simulado** (`scripts/mock-gateway.js`) é usado apenas no ambiente de teste e na
demo: **somente o modelo é simulado**. Streaming, protocolo AG-UI, sessões, ferramentas,
HITL e SSE são reais. Com o gateway real (porta 1455 do proprietário), a diferença é a
qualidade da resposta do modelo — o caminho de código é o mesmo.

### 2.3 Sem deploy

Nada foi publicado no `opportunity.ia.br`. O site de demonstração é local
(`/demo/index.html`) e reproduz a estrutura do site real, não o site real.

## 3. Contrato do runtime

```
POST /api/copilot
{ "method": "agent/run",
  "params": { "agentId": "kirana" },
  "body": { "threadId", "runId", "messages", "tools", "state", "forwardedProps" } }
→ text/event-stream com eventos AG-UI
```

Regras aprendidas na validação (falhas reais corrigidas em v0.3.0):

1. **`STEP_STARTED` exige `STEP_FINISHED`** — o runtime v2 valida o stream e responde
   `RUN_ERROR / INCOMPLETE_STREAM` se um step ficar aberto.
2. **`RUN_STARTED`/`RUN_FINISHED` são do `BuiltInAgent`** — o tradutor da Kirana não deve
   emiti-los (duplicaria o ciclo do run).
3. **`RUN_FINISHED` é sintetizado** pelo `runFactory` a partir do último evento; o tradutor
   deve fechar texto e step antes do fim.
4. **Base URL do endpoint** deve ser passada como `baseUrl` (não `basePath`) em
   `copilotRuntimeNodeHttpEndpoint`.
5. **`BuiltInAgent` é importado de `@copilotkit/runtime/v2`** (não do entry raiz).

## 4. Isolamento entre sites

- `sites/<id>/site.json` define ações permitidas, chaves de estado e componentes de UI.
- Ferramentas enviadas ao modelo = `declaradas pelo widget ∩ permitidas pelo site`.
- Sessão é derivada de `sha256(siteId + threadId)` → mesmo `threadId` em sites diferentes
  gera sessões distintas (testado).
- **Site informado que não existe é recusado** (`RUN_ERROR / unknown_site`); não há
  fallback silencioso para o site padrão (falha corrigida em v0.3.0).
