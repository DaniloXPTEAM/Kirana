# MATRIZ DE MODELOS E STREAMING

**Data:** 2026-10-30 · **Gateway:** 0.4.1 · **Base:** http://127.0.0.1:1455
**Gerado por:** `tools/validar-modelos-reais.mjs` (execução real, não editada à mão)


| Modelo | Disponibilidade | Texto | Streaming | Identidade | Tool calling | Limites | Custo | Veredito |
|---|---|---|---|---|---|---|---|---|
| `gpt-6.1-sol` | DISPONÍVEL | — | — | INCONCLUSIVA | não testado | não divulgado | desconhecido | **NAO_EXECUTADO** |
| `gpt-6-astra` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-6.1-terra` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-6-sol` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-6-luna` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-5.6-sol` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-5.6-terra` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |
| `gpt-5.6-luna` | DISPONÍVEL | não testado | não testado | — | não testado | não divulgado | desconhecido | **DISPONÍVEL, não testado** |

## Legenda — por que separar importa

| Veredito | Significado |
|---|---|
| **APROVADO** | texto + streaming com `[DONE]` + `identityVerified=true` |
| **APROVADO_PARCIAL** | texto ok, streaming não confirmado |
| **REPROVADO** | testado e falhou em algo que é do modelo |
| **INCONCLUSIVO_IDENTIDADE** | respondeu, mas `/v1/runs` não confirma qual modelo serviu |
| **INCONCLUSIVO** | teste não chegou a concluir |
| **MODELO_INDISPONIVEL** | `400/404 model_not_available` — fora do plano |
| **BLOQUEADO_AUTENTICACAO** | `401 authentication_required` |
| **BLOQUEADO_CUSTO** | `402 cost_blocked` / política de custo |
| **INCOMPATIBILIDADE_DO_VERIFICADOR** | `400` por campo/corpo inválido — **culpa do teste, não do modelo** |
| **NAO_EXECUTADO** | não rodou (ex.: `--catalogo`) |
