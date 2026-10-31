# O que precisa mudar no projeto do Gateway para operar online

> **Escopo:** este documento **não altera nada** no Gateway. Ele descreve, item por
> item, o que o projeto separado (`Kirana-ChatGPT-Gateway`) precisa fazer para
> atender visitantes públicos com segurança. Cada afirmação abaixo foi lida no
> pacote `integrations/Kirana-ChatGPT-Gateway-v0.4.1-Windows.zip` — arquivo e
> linha citados quando aplicável.
>
> **Do lado da Kirana não é necessário nenhum código novo:** ela aceita o
> endereço por configuração (`KIRANA_GATEWAY_URL`) + a chave
> (`KIRANA_GATEWAY_API_KEY`) e fala o contrato Chat Completions/SSE documentado
> em [`INTEGRACAO-GATEWAY-REAL.md`](INTEGRACAO-GATEWAY-REAL.md).

---

## 0. A decisão que vem antes de qualquer código

O Gateway v0.4.x foi desenhado para **uma pessoa, na máquina dela**:

- `docs/deployment.md` (verbatim): *"This gateway is **local-only**. It binds only
  to `127.0.0.1`, has no CORS, and **must not be deployed, tunneled,
  reverse-proxied, exposed to LAN/public internet**, or shared with another
  user's requests."*
- `docs/authentication.md` (verbatim): *"Never run this OAuth step in an
  Arena-managed runtime or public server."*
- `.env.example`: *"Private personal runtime only; the app rejects non-loopback
  bind addresses."*
- Tokens OAuth vivem **só em memória** e são apagados no `Ctrl-C`; não há refresh
  persistido.

Traduzindo: hoje o Gateway autentica **a sua conta pessoal do ChatGPT** e usa o
plano dela. Servir visitantes públicos por essa via significa (a) compartilhar um
consumo pessoal com terceiros e (b) fazer o tráfego sair de um IP de datacenter
com credencial de pessoa física — dois motivos típicos de bloqueio e de violação
de termos.

**Portanto existem dois caminhos técnicos, e eles não se misturam:**

| | G1 — Gateway continua pessoal, atrás de túnel privado | G2 — Gateway vira serviço com credencial de API |
|---|---|---|
| Autenticação | a sua conta (OAuth local) + `GATEWAY_API_KEY` | credencial de API do provedor (organizacional) |
| Quem consome | só a Kirana, no mesmo host privado | muitos visitantes, via Kirana |
| Termos | uso pessoal (não é "publicar o Gateway") | uso contratado para produção |
| Mudanças no código | quase nenhuma (ver §1) | ver §2 |
| Depende do seu PC | **sim** (é o modelo A do `PRODUCAO.md`) | **não** |

A Kirana funciona igual nos dois. O que muda é o `.env` dela.

---

## 1. G1 — Gateway pessoal atrás de túnel privado (mínimo para publicar já)

O Gateway continua no seu PC; a Kirana roda online e alcança o Gateway por um
túnel **autenticado** (Cloudflare Tunnel com service token, Tailscale ou
WireGuard). A porta 1455 **nunca** é publicada.

| # | Mudança no projeto do Gateway | Por quê | Onde |
|---|---|---|---|
| 1.1 | Aceitar bind configurável **apenas quando** `TRUSTED_PROXY_ONLY=true`, mantendo a recusa de bind público por padrão | hoje `HOST` é validado como loopback; sem isso o túnel não conecta | validação de `HOST` no start |
| 1.2 | Confiar em `X-Forwarded-For` **somente** vindo do túnel (lista de IPs/CIDR confiáveis) | logs e limites por cliente dependem do IP real | middleware de entrada |
| 1.3 | Manter `/health` acessível pelo túnel mas **sem** expor `authenticated` ao público | metadado de estado da conta | rota `/health` |
| 1.4 | Timeout de ociosidade + cancelamento no stream (`AbortSignal` do cliente → request à OpenAI) | visitante fecha a aba e o consumo precisa parar | `src/responses.js` |
| 1.5 | Rotação de `GATEWAY_API_KEY` sem reiniciar (recarregar `.env`) | trocar a chave exige atualizar a Kirana em produção | boot/config |
| 1.6 | Log de auditoria por requisição (rota, status, modelo, ms, id de correlação) — **sem corpo** | rastrear abuso sem vazar conversa | já existe parcialmente |

**Risco aceito nesse caminho:** se o PC dormir ou a conta cair, a Kirana responde
erro rastreável (`gateway_unreachable` / `authentication_required`) e a interface
diz isso ao visitante. Não é alta disponibilidade.

---

## 2. G2 — Gateway como serviço (para "sem depender do meu computador")

### 2.1 Autenticação e credencial

| # | Mudança | Detalhe |
|---|---|---|
| 2.1.1 | Substituir o OAuth pessoal por **credencial de API do provedor** (`OPENAI_API_KEY` ou equivalente contratado) | é o único caminho em que "atender visitantes" é uso previsto |
| 2.1.2 | Separar **credencial de serviço** (Kirana → Gateway) da credencial do provedor | hoje `GATEWAY_API_KEY` é uma chave única compartilhada |
| 2.1.3 | Suportar **múltiplas chaves** com nome/escopo e revogação individual (ex.: `kirana-prod`, `kirana-staging`) | permite rotacionar sem derrubar o site |
| 2.1.4 | Limitar por chave: requisições/min, tokens/min, concorrência | proteção contra abuso e contra estouro de custo |
| 2.1.5 | Repassar `429` com `Retry-After` e um `X-RateLimit-*` mínimo | a Kirana já trata 429 e mostra mensagem ao visitante |

### 2.2 Transporte e rede

| # | Mudança | Detalhe |
|---|---|---|
| 2.2.1 | Bind em `0.0.0.0` **opt-in** (`ALLOW_PUBLIC_BIND=true`) com aviso no log | hoje o app recusa |
| 2.2.2 | TLS no próprio processo **ou** terminação por proxy — e checar `X-Forwarded-Proto` | a Kirana e o Gateway podem ficar na mesma rede privada; o TLS é na borda |
| 2.2.3 | **CORS desligado** no Gateway (é server-to-server) | a Kirana é quem fala com ele; o navegador nunca fala |
| 2.2.4 | Limite de corpo e de concorrência por conexão | `stream:true` mantém conexão aberta: precisa de teto |
| 2.2.5 | Healthcheck separado: `/health` (público, raso) e `/health/deep` (interno, com dependências) | LB não pode depender do estado da conta |

### 2.3 Estado e durabilidade

| # | Mudança | Detalhe |
|---|---|---|
| 2.3.1 | Filas de jobs (imagem/vídeo/áudio) hoje são **serializadas em memória** (1 concorrente, 10 na fila, até 24 h) — em serviço público isso precisa virar fila durável com limite por cliente | `src/jobs.js` |
| 2.3.2 | `.local-state/<APP_ID>/` é disco local: para mais de uma instância é preciso storage compartilhado | hoje é single-instance |
| 2.3.3 | Armazenamento de arquivos: TTL 1 h e 50 MiB globais — definir quota por visitante | `FILE_MAX_*` |
| 2.3.4 | Nenhum token no disco; se houver refresh persistido, criptografar com chave de KMS/secret manager | hoje não persiste (o que impede operação 24/7 por OAuth) |

### 2.4 Observabilidade e abuso

| # | Mudança | Detalhe |
|---|---|---|
| 2.4.1 | Métricas: requisições, 429, latência de 1º token, erros por código | sem isso não se opera |
| 2.4.2 | Id de correlação propagado da Kirana (`x-request-id`) | rastrear um turno ponta a ponta |
| 2.4.3 | Bloqueio por reputação de IP / captcha na borda **antes** de chegar ao Gateway | cada requisição custa plano/cota |
| 2.4.4 | Logs sem PII: hoje já registram só rota/status/modelo/ms — manter e declarar no `site.json` | LGPD |

---

## 3. O que a Kirana já espera do Gateway (contrato congelado)

Nada aqui muda em G1 nem em G2 — é o que já está implementado e testado:

| Expectativa | Verificação na Kirana |
|---|---|
| `POST /v1/chat/completions` compatível com Chat Completions, `stream:true` com `data: …` e `[DONE]` | `src/gateway.js` (`chatStream`) |
| `Authorization: Bearer <chave>` | `src/gateway.js` |
| `GET /v1/models` → `{data:[{id}]}` | `health()`/`models()` + `KIRANA_MODEL_PROBE` |
| Nomes de ferramenta podem vir `gateway.<nome>` **ou** `<nome>` | `src/tools/names.js` (v0.5.2) |
| `role:"tool"` com `tool_call_id` no round-trip | `src/agent.js` |
| Erros como `{error:{code,message,retryable}}`; 429 preservado | tratamento de erro do turno |
| Campos fora do contrato → 400 `unsupported_parameter` | `KIRANA_SEND_*` = false |

**Troca de Gateway = trocar `.env`.** É o teste de que a integração está
desacoplada: `KIRANA_GATEWAY_URL=https://gateway-prod.interno` +
`KIRANA_GATEWAY_API_KEY=...` e mais nada.

---

## 4. Checklist de aceite do Gateway em produção

- [ ] credencial de serviço (não pessoal) e rotação sem downtime
- [ ] limite por chave e por cliente, com `429` + `Retry-After`
- [ ] TLS na borda e `X-Forwarded-*` confiável
- [ ] cancelamento de stream propagado ao provedor
- [ ] `/health` sem dados da conta; `/health/deep` interno
- [ ] métricas + id de correlação + logs sem PII
- [ ] filas/estado duráveis (ou single-instance declarado)
- [ ] CORS desligado, bind público só com opt-in explícito
- [ ] documentação própria atualizada (o `deployment.md` atual **proíbe** o uso online)

> Enquanto esse checklist não estiver cumprido no projeto do Gateway, a Kirana
> publicada pode funcionar apenas pelo **G1** (túnel privado, PC ligado).
> A Kirana v0.5.2 está pronta para os dois — a diferença é `.env`.
