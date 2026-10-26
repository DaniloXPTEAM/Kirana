# Produção — Kirana online no site Opportunity AI

**Estado:** *arquitetura preparada, nada publicado.* O site público não foi
alterado e não há deploy executado. Este documento explica o que é possível, o
que **não** é (com prova), e o que falta para ir ao ar.

---

## 1. A restrição que decide tudo

O pacote do Gateway é explícito (`docs/deployment.md`, verbatim):

> *"This gateway is **local-only**. It binds only to `127.0.0.1`, has no CORS,
> and **must not be deployed, tunneled, reverse-proxied, exposed to LAN/public
> internet**, or shared with another user's requests."*

E no código (`src/auth.js` / `docs/authentication.md`): o callback OAuth é
**fixo** em `http://127.0.0.1:1455/auth/callback`, e os tokens vivem **só em
memória** (somem quando o processo reinicia).

Conclusão honesta: **"Kirana online 24/7 sem o meu computador ligado" não é
compatível com o Gateway como ele existe hoje.** Não é limitação da Kirana —
é o desenho do Gateway. Qualquer caminho que ignore isso exige decisão sua sobre
termos/risco, e eu não vou declarar seguro aquilo que a própria documentação
proíbe.

---

## 2. Três caminhos possíveis

| | A. Kirana online + Gateway no seu PC | B. Gateway + Kirana no mesmo servidor | C. Kirana online + provedor de API oficial |
|---|---|---|---|
| Cumpre "sem PC ligado"? | **não** | sim | sim |
| Compatível com o pacote do Gateway | **sim** (é o uso previsto) | **não** (contraria `deployment.md`) | não usa o Gateway |
| Altera o Gateway | não | não altera o código, mas o instala fora do escopo dele | não |
| Custo | hospedagem da Kirana | hospedagem (~1 GB RAM) | hospedagem + uso de API paga |
| Risco principal | uptime depende do PC/rede | conta ChatGPT acessada de datacenter (bloqueio/termos), OAuth precisa ser feito **no** servidor | custo por token; exige decidir o modelo |
| Esforço | baixo | médio | baixo |
| Recomendação | **para publicar agora** | só com aval explícito seu | **para 24/7 real** |

### Caminho A — recomendado para publicar já

```
visitante → https://opportunity.ia.br (site) → widget → https://kirana.seudominio.com.br (Kirana)
                                                          ↓  loopback do PC
                                                     Gateway 127.0.0.1:1455
```

O elo PC→Kirana precisa ser privado e autenticado (Cloudflare Tunnel com
service token, Tailscale/WireGuard). **Nunca** abrir a porta 1455 na internet.
Se o PC dormir, a Kirana responde erro rastreável — a interface continua
funcionando por texto e diz que o serviço está indisponível.

### Caminho C — para independência total

A Kirana fala Chat Completions (OpenAI-compatible) em
`KIRANA_GATEWAY_URL`. Trocar o destino por um endpoint oficial de API **não
exige mudança de código** — é `.env`. A v0.5.2 aceita nomes de ferramenta **com
ou sem** o prefixo `gateway.`, então o mesmo binário serve aos dois mundos. O que
muda: custo por uso, escolha de modelo e a perda das capacidades locais do
Gateway (arquivos/mídia). Não implementei nada disso — é decisão sua.

---

## 3. O que a Kirana precisa do ambiente de produção

| Requisito | Por quê |
|---|---|
| Node 20.20+ (24 LTS ok) | `engines` do projeto |
| HTTPS terminado antes da Kirana | cookie/token nunca em texto claro |
| `KIRANA_ACCESS_TOKEN` **definido** | sem ele, a API aceita qualquer origem local |
| `KIRANA_HOST=0.0.0.0` | necessário dentro de container |
| `KIRANA_AGENT_RATE_MAX>0` (ex.: 60) | `/api/copilot` e `/api/agui` são públicos e cada chamada consome plano |
| `KIRANA_ALLOW_EMBED=false` | evita iframe de terceiros |
| `KIRANA_DATA_DIR` em volume persistente | sessões, memória, solicitações e arquivos |
| `KIRANA_GATEWAY_U*` **apenas no servidor** | a chave do Gateway nunca vai ao navegador |
| backup de `data/` | solicitações da Fase 5 moram ali |

### Segredos — regra dura

| Segredo | Onde pode ficar | Onde **nunca** |
|---|---|---|
| `GATEWAY_API_KEY` | `.env` do Gateway e `.env` da Kirana (servidor) | navegador, GitHub, log, screenshot |
| token OAuth da conta ChatGPT | memória do processo do Gateway | qualquer arquivo, inclusive backup |
| `KIRANA_ACCESS_TOKEN` | `.env` do servidor | código, repositório, bundle do widget |
| dados de solicitantes (`data/`) | volume do servidor | repositório, GitHub Pages |

`.gitignore` já cobre `.env`, `.env.*`, `data/`, `homologacao/`, `*.log`.
O widget publicado **não** contém nenhuma credencial: ele fala com a Kirana, e a
Kirana fala com o Gateway.

---

## 4. Ordem de publicação (quando você autorizar)

1. **Homologar no Windows** (`homologar.bat --full`) com o Gateway real. Sem isso
   nada é declarado concluído.
2. **Subir a Kirana** no host escolhido (Caminho A ou C) com `.env` de produção,
   `data/` em volume e HTTPS.
3. **Verificar**: `GET /health`, `GET /api/site/info?site=opportunity-ai`,
   `POST /api/copilot {"method":"info"}` e uma conversa real pelo navegador.
   (`GET /api/copilot/info` responde 405 **de propósito** — ver README.)
4. **Widget no site**: incluir o bundle (`public/widget/kirana-v2.js` ou o
   vanilla `public/app.js`) apontando para a URL pública da Kirana. **Isso altera
   o site público → só com a sua autorização explícita.**
5. **CORS/origem**: `sites/opportunity-ai/site.json` → `allowedOrigins` deve
   listar `https://opportunity.ia.br`.
6. **Monitorar**: `/health`, taxa de `429`, taxa de `unknown_tool` (deve ser 0),
   latência de 1º token, erros `authentication_required` (Gateway precisa
   reautorizar).

## 5. Rollback

- Kirana: reverter para a imagem/commit anterior (a tag `v0.5.2` é o ponto de retorno).
- Site: o widget é um `<script>`; remover a inclusão volta ao site atual.
- Gateway: nada muda nele; se a Kirana falhar, o Gateway continua íntegro.

## 6. O que este documento **não** afirma

- Não afirma que há deploy feito.
- Não afirma que o Caminho B é seguro ou permitido pelos termos do SIWC.
- Não afirma latência, custo, SLA ou capacidade — nada disso foi medido.
- Não afirma que o widget está publicado no site.
