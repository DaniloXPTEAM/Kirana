# Compatibilidade e limitações — CopilotKit na Kirana V2 (atualizado na v0.5.0)

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

### 2.1 Bundle do `@copilotkit/react-core` — CORRIGIDO na Fase 4 (v0.5.0)

> **Atualização (26/10/2026, Fase 4).** A limitação descrita abaixo era do
> ambiente de validação da v0.3.0 e **não se reproduz** com a API v2. O
> `@copilotkit/react-core/v2/headless` + `/v2/context` compilam em menos de 1 s
> e o widget v2 funciona de ponta a ponta (ver `docs/FASE4-AUDITORIA.md §7`).

- **Antes (v0.3.0 → v0.4.x):** `esbuild` morria com `Error: The service was stopped`
  ao empacotar o entry completo do `react-core` v1; por isso o widget daquela fase
  fala o protocolo do runtime por conta própria (`public/widget/kirana-widget.js`,
  ~199 KB).
- **Agora (v0.5.0):** `widget/src/main-v2.jsx` → `public/widget/kirana-v2.js`
  (**961 KB, build em 292 ms**) usando `CopilotKitCoreReact` + `CopilotKitContext`
  (`/v2/context`) e `useAgent` / `useAgentContext` / `useFrontendTool`
  (`/v2/headless`). O entry `v2` **completo** (`/v2` raiz) ainda é pesado
  (15,8 MB, 2,1 s) porque importa a UI pronta e o CSS — a Kirana usa só o
  headless, que é a camada de hooks.
- **Achado do teste real:** na v2 o agente precisa ser nomeado. O runtime da
  Kirana expõe `kirana`, não `default`; `useAgent({ agentId: 'kirana' })` é
  obrigatório, senão o hook falha com
  `Agent 'default' not found after runtime sync`.
- **Limitação restante (declarada):** `GET /api/copilot/info` responde **405**
  no `@copilotkit/runtime` 1.79.1 (a rota de metadados da v2 não é servida por
  essa versão). O cliente v2 sincroniza mesmo assim e o turno funciona — os
  testes de navegador provam o caminho completo. Fica registrado para quando o
  runtime for atualizado.

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
