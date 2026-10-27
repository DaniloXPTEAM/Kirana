# Incorporar a Kirana no site Opportunity AI

Um `<script>`, zero credencial. O site continua sendo o site: a Kirana conversa
com o backend dela por dentro de um iframe/painel. Nenhuma chave, token ou
endereço de Gateway fica no HTML público.

> Status: **pronto e testado em mock** (`test/browser/site-embed.mjs`, 12/12, com
> duas origens reais). **Não publicado.** A publicação depende de a Kirana estar
> hospedada (ver `docs/GATEWAY-MUDANCAS-PARA-PRODUCAO.md` para o lado do Gateway e
> `deploy/` para o lado da Kirana).

## 1. O que colocar na página

```html
<script src="https://kirana.SEUDOMINIO/widget/kirana-embed.js"
        data-kirana-url="https://kirana.SEUDOMINIO"
        data-kirana-site="opportunity-ai"
        defer></script>
```

Atributos:

| Atributo | Obrigatório | Para que serve |
|---|---|---|
| `data-kirana-url` | sim | endereço público da Kirana (sem barra no fim) |
| `data-kirana-site` | não | identifica o site nas métricas/sessões |
| `data-kirana-mode` | não | `iframe` (padrão) ou `script` (widget v2 direto na página) |
| `data-kirana-label` | não | texto do botão flutuante (padrão: "Falar com a Kirana") |
| `data-kirana-open` | não | `1` abre o painel já na carga |

Modo `script` monta o widget v2 dentro da própria página (sem iframe). Ele exige
que a origem do site esteja em `KIRANA_ALLOWED_ORIGINS` — é mais integrado, mas
mistura estilos; o modo `iframe` é o recomendado e o testado.

## 2. O que precisa estar configurado na Kirana (servidor)

```bash
KIRANA_ENV=production
KIRANA_ACCESS_TOKEN=<token forte>            # sem isto o servidor não sobe
KIRANA_TRUST_PROXY=true                      # atrás de Caddy/Nginx
KIRANA_ALLOWED_ORIGINS=https://opportunity.ia.br,https://www.opportunity.ia.br
KIRANA_EMBED_ORIGINS=https://opportunity.ia.br,https://www.opportunity.ia.br
KIRANA_AGENT_RATE_MAX=60
KIRANA_GATEWAY_URL=<Gateway de produção>
KIRANA_GATEWAY_API_KEY=<chave do Gateway de produção>
```

`KIRANA_EMBED_ORIGINS` é o que autoriza o iframe (`frame-ancestors`). Sem ela, o
navegador bloqueia o painel embutido — de propósito: lista fechada, nunca `*`.

## 3. Verificação antes de publicar o site

```bash
# 1) a Kirana sobe com a config de produção?
node scripts/doctor.mjs            # mostra "Perfil: production" e as travas

# 2) o iframe é permitido só pela origem do site?
curl -sI https://kirana.SEUDOMINIO/ | grep -i "content-security-policy"
#    frame-ancestors https://opportunity.ia.br https://www.opportunity.ia.br

# 3) o preflight responde à origem do site e recusa outra?
curl -si -X OPTIONS https://kirana.SEUDOMINIO/api/chat \
  -H "Origin: https://opportunity.ia.br" -H "Access-Control-Request-Method: POST" \
  | grep -i "access-control-allow-origin"
curl -si -X OPTIONS https://kirana.SEUDOMINIO/api/chat \
  -H "Origin: https://sitedeoutrapessoa.com" -H "Access-Control-Request-Method: POST" \
  | grep -i "access-control-allow-origin"     # deve vir vazio

# 4) conversa real, pelo endereço público
curl -s https://kirana.SEUDOMINIO/api/status | head -5
```

## 4. Ensaio local do painel embutido (o que o teste automatiza)

```bash
# terminal 1 — Kirana autorizando o site de teste a embutir
KIRANA_EMBED_ORIGINS=http://127.0.0.1:3010 node src/server.js

# terminal 2 — página estática (servidor separado, outra origem) e o teste
node test/browser/site-embed.mjs
```

O teste cria uma página em `127.0.0.1:3010` que contém **apenas** o `<script>`,
abre a Kirana em `:3000` (ou na porta configurada) e verifica 12 pontos: script
carrega, botão aparece, iframe abre, `frame-ancestors` autorizou, o visitante
conversa, a ferramenta roda (`Listar soluções · ok`), não há `gateway.` nem
segredo no DOM, e o conteúdo/textos do site continuam intactos.

## 5. Reversão

Remover a linha do `<script>` devolve o site ao estado anterior. Nada no site
guarda estado da Kirana.
