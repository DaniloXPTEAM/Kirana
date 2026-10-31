# Integração com o Gateway ChatGPT local — contrato verificado

**Fonte da verdade:** o próprio pacote `integrations/Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip`
(extraído em 26/10/2026). Tudo abaixo foi lido no código e na documentação **do
Gateway**, não inferido. O Gateway **não foi alterado**.

---

## 1. Nomes reais das variáveis

### No Gateway (`.env` do pacote)

| Variável | Valor de exemplo | O que é |
|---|---|---|
| `GATEWAY_API_KEY` | gerar com `npm run keygen` | **chave-cliente local** (não é credencial ChatGPT). Obrigatória em tudo, menos `/health` |
| `HOST` | `127.0.0.1` | o app **recusa** bind fora do loopback |
| `PORT` | `1455` | porta local |
| `APP_NAME` | `Kirana Personal Gateway` | identidade |
| `APP_ID` | `kirana-personal-gateway` | pasta de estado `.local-state/<APP_ID>/` |
| `FILE_MAX_BYTES`, `FILE_MAX_TOTAL_BYTES`, `FILE_MAX_COUNT`, `FILE_TTL_SECONDS` | 10 MiB / 50 MiB / 50 / 3600 | armazenamento temporário de arquivos |
| `FFMPEG_PATH`, `WHISPER_*`, `PIPER_*`, `COMFYUI_*` | (opcionais) | mídia local, desligados por padrão |

### Na Kirana (`.env` dela)

| Variável | Default | Observação |
|---|---|---|
| `KIRANA_GATEWAY_URL` | `http://127.0.0.1:1455` | **é** o `HOST`+`PORT` do Gateway |
| `KIRANA_GATEWAY_API_KEY` | vazio | **é** o `GATEWAY_API_KEY` do Gateway — mesma string, nome diferente de propósito |
| `KIRANA_PRIMARY_MODEL` | `gpt-6-luna` | precisa existir em `GET /v1/models` da conta |
| `KIRANA_FALLBACK_MODEL` | `gpt-6.1-sol` | usado só se a chamada falhar antes de qualquer token |
| `KIRANA_MODEL_PROBE` | `true` | confere o slug em `/v1/models` antes de usar |
| `KIRANA_SEND_TEMPERATURE` / `_MAX_TOKENS` / `_TOOL_CHOICE` | `false` | o Gateway responde 400 `unsupported_parameter` a campos fora do contrato |

> **Não existe** renomeação automática: a Kirana lê `KIRANA_GATEWAY_*` e o
> Gateway lê `GATEWAY_*`. Copiar o valor é manual e é o único passo de
> "configuração de credencial" da integração.

---

## 2. Autenticação (verificada em `src/auth.js` e `src/gateway.js`)

- Cabeçalho: `Authorization: Bearer <GATEWAY_API_KEY>` — comparação em tempo constante (`timingSafeEqual`).
- **`GET /health` é público** e não revela identidade: `{status, authenticated, gateway, version}`.
- **Autorização da conta ChatGPT** é separada e feita uma vez, no navegador do dono:
  `http://127.0.0.1:1455/auth/start` → consentimento na OpenAI → callback
  **loopback fixo** `http://127.0.0.1:1455/auth/callback`.
- Tokens OAuth ficam **em memória** e são limpos quando o processo encerra
  (`Ctrl-C`). Não há refresh persistido: cada reinício exige nova autorização.
- Escopos pedidos incluem `chatgpt.tokens.use.direct` e `offline_access`
  (`grantedScopes` é consultável em `GET /auth/status`).
- Erros de auth: `invalid_api_key` 401, `authentication_required` 401,
  `sharing_scope_missing` 401.

**Consequência prática:** a Kirana nunca vê nem guarda token OAuth. Ela só usa a
chave-cliente local. Se o Gateway reiniciar, é preciso reautorizar — e a Kirana
responde erro rastreável (`gateway_unreachable` / `authentication_required`).

---

## 3. Modelos

- Descoberta em `GET /v1/models` (exige bearer + sessão viva), filtrado por
  `visibility == "list"`. Retorna formato compatível com Chat Completions:
  `{object:"list", data:[{id:"<slug>", object:"model"}]}`.
- A Kirana já consome exatamente isso (`src/gateway.js` → `models()`).
- **Não há slug fixo garantido**: a conta vê o que o plano libera. Por isso a
  Kirana tem `KIRANA_MODEL_PROBE` e fallback. Se o slug configurado não existir,
  o preflight reprova e diz quais existem (`scripts/preflight-gateway.mjs`).

---

## 4. Streaming

- O Gateway **sempre** fala com a OpenAI em `stream:true` + `store:false`.
- Para o cliente: `POST /v1/chat/completions` com `stream:true` devolve SSE
  (`data: {...}` … `data: [DONE]`). Com `stream:false`, o Gateway **bufferiza**
  até o fim e devolve JSON.
- Só `response.completed` indica sucesso; falha no meio do stream vem como
  `data: {"error":{...}}` seguido do fim da conexão.
- Campos aceitos: `model`, `messages`, `stream`, `tools`, `tool_choice`,
  `parallel_tool_calls`, `stream_options.include_usage`. Qualquer outro → 400.

**Como a Kirana usa:** `stream:true`, sem campos fora do contrato, e considera o
turno concluído só quando vê `[DONE]`. A interface diferencia "transporte
terminou" de "ferramenta executou" (correção da v0.5.2).

---

## 5. Ferramentas: o ponto que quebrava

Do `docs/api-reference.md` do Gateway (verbatim):

> *"Chat Completions tool definitions (`type:function`) are grouped beneath
> Responses namespace `gateway`. Tool call names returned to a Chat Completions
> client are represented as `gateway.<function>`. The gateway never runs tools."*

- O nome declarado deve casar `/^[A-Za-z0-9_-]{1,64}$/` → **ponto é proibido** no
  nome que a Kirana declara; o prefixo é acrescentado pelo Gateway.
- Máximo **32** ferramentas por requisição. A Kirana declara **24** — dentro do
  limite, com margem.
- O Gateway **não executa** ferramenta nenhuma: a Kirana executa e devolve
  `role:"tool"` + `tool_call_id` na rodada seguinte.

A v0.5.1 procurava o nome exato e por isso dava `unknown_tool` em tudo. A v0.5.2
normaliza (`src/tools/names.js`) e devolve, ao modelo, a lista de ferramentas
reais quando algo não existe.

---

## 6. Capacidades declaradas (e a ausência de busca web)

`GET /v1/capabilities` → `KNOWN_CAPABILITIES` do pacote:
`text.chat`, `files.create|upload|download`, `images.analyze|generate|edit`,
`video.analyze|generate`, `audio.transcribe|synthesize`.

**Não existe busca/pesquisa web.** Confirmado em três frentes independentes
(código do Gateway, `git log --all -S` da Kirana com 0 commits, ausência de
qualquer ferramenta registrada). O preflight verifica isso a cada execução e
avisa se algum dia aparecer.

---

## 7. Como provar tudo isso na sua máquina (5 minutos)

```bat
rem 1. Gateway rodando e autorizado (janela dele aberta)
rem 2. .env da Kirana com KIRANA_GATEWAY_API_KEY preenchida

verificar-gateway.bat
```

O script (`scripts/preflight-gateway.mjs`) faz, em ordem:

| # | Sonda | Gasta uso? |
|---|---|---|
| 1 | `GET /health` (público) | não |
| 2 | `GET /auth/status` (escopos, sem valores) | não |
| 3 | `GET /v1/models` (slugs da conta) | não |
| 4 | `GET /v1/capabilities` (confirma ausência de web) | não |
| 5 | `POST /v1/chat/completions` com `temperature` → espera 400 | não |
| 6 | streaming com ferramenta declarada → espera `gateway.<nome>` + `[DONE]` | **sim (1 chamada)** |
| 7 | round-trip `role:"tool"` → espera texto final | **sim (1 chamada)** |

Sai com código 1 se qualquer sonda falhar, e grava
`homologacao/preflight-gateway-*.json` **sem chave, sem token, sem OAuth**.

---

## 8. O que ainda depende de você (e por que não posso pular)

1. **Autorizar a conta** no navegador do Windows (`/auth/start`) — fluxo do dono da conta.
2. **Rodar `homologar.bat --full`** com o Gateway ligado. É a única evidência
   aceitável de "sem mocks". Nesta sessão eu testei os mesmos scripts contra o
   gateway **simulado** (que agora imita o contrato real, incluindo
   `gateway.<nome>`, `/auth/status` e `/v1/capabilities`), mas isso **não**
   substitui o seu teste.
3. Se o slug do modelo não existir na sua conta, o preflight diz quais existem —
   ajuste `KIRANA_PRIMARY_MODEL` (é `.env`, não código).
