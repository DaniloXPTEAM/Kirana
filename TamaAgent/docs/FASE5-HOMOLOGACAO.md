# Kirana Fase 5 — procedimento de homologação

**Versão:** 0.5.1 · **Data:** 26/10/2026
**Objetivo:** permitir que uma pessoa que **não escreveu o código** confira, em
ordem, que a Kirana executa uma solicitação de serviço — e que ela **diz a
verdade** quando não consegue executar.

Tempo estimado: 20–30 minutos. Tudo roda local; **nada é publicado**.

---

## 0. Pré-requisitos

```bat
cd C:\caminho\da\kirana
corepack pnpm install --frozen-lockfile
node scripts/doctor.mjs
```

O `doctor` deve acusar apenas o que já era esperado (por exemplo `.env` ausente
em ambiente de teste). **Não** altere o Gateway real (porta 1455), nem o `.env`,
nem `data/`.

---

## 1. Suíte automatizada (deve passar 100%)

```bat
node scripts/run-tests.mjs
```

Esperado: **429/429**, ~3 minutos. Inclui as 4 suítes novas da Fase 5:
`requests-store`, `requests-validation`, `request-tools`, `requests-http`.

Se algum teste falhar, **pare aqui**: não é homologação, é bug.

---

## 2. Ambiente de demonstração (gateway simulado, portas alternativas)

Em dois terminais — sem tocar no gateway real:

```bat
:: terminal 1
node scripts/mock-gateway.js --port 1457 --key local-mock

:: terminal 2
set KIRANA_PORT=3100
set KIRANA_GATEWAY_URL=http://127.0.0.1:1457
set KIRANA_GATEWAY_API_KEY=local-mock
set KIRANA_DATA_DIR=%TEMP%\kirana-homolog
node src/server.js
```

Abra `http://127.0.0.1:3100`.

O gateway simulado **não é um modelo**: ele escolhe ferramentas por gatilho de
texto (roteiro fixo). Use exatamente as frases do roteiro abaixo — o objetivo é
validar o caminho, não a redação.

---

## 3. Testes de navegador (opcional, requer Playwright)

```bat
npx playwright install chromium
set KIRANA_BASE_URL=http://127.0.0.1:3100
node test/browser/site-v5.mjs
node test/browser/site-flow.mjs
node test/browser/site-v2.mjs
node test/browser/demo-flow.mjs
```

Esperado: `site-v5` **26/26**, `site-flow` **18/18**, `site-v2` **8/8**,
`demo-flow` **15/15**.
Rode com o servidor **recém-iniciado**: rodadas repetidas no mesmo minuto batem
no limite de requisições (429) — isso é o controle funcionando, não um defeito.

---

## 4. Roteiro manual — o fluxo de 13 passos

| Passo | Digite | Deve acontecer | Não deve acontecer |
| --- | --- | --- | --- |
| 1 | "Quais serviços vocês oferecem?" | lista as 6 frentes do conhecimento real | inventar serviço |
| 2 | "Quero colocar uma IA no meu site" | cria **rascunho** `REQ-…`; a mensagem diz que **nada foi enviado** | nada sai para a internet |
| 3 | "O que preciso enviar?" | campos do formulário oficial + o que a operação precisa; aviso de que o site **não publica requisitos** | exigência inventada |
| 4 | "Pode preencher o formulário?" | campos do `/contato` preenchidos na tela (se a ponte estiver no site) | formulário enviado |
| 5 | "Quero anexar um arquivo" | cartão de anexo com tipos e limite (5 MB, 5 arquivos) | pedir arquivo sem política |
| 6 | escolha um PDF | "Anexado: …" com tamanho e prazo de retenção | executar o arquivo |
| 7 | tente anexar um `.exe` | recusa com o motivo (`blocked_type`) | aceitar "só porque o navegador deixou" |
| 8 | "Validar" | diz o que falta, campo por campo | dizer que está completo quando não está |
| 9 | complete os dados e valide | "está tudo preenchido; posso pedir sua confirmação" | enviar |
| 10 | "Pode enviar?" | **cartão de confirmação** com resumo | executar antes do clique |
| 11 | clique "Não, cancelar" | nada acontece; estado não muda | executar mesmo recusando |
| 12 | peça para enviar de novo e clique "Sim, confirmar" | a ferramenta executa e responde **`enviado:false` / `endpoint_nao_configurado`** | inventar protocolo |
| 13 | "Qual o andamento?" | estado real (`waiting_for_approval`), o que falta, histórico | prazo estimado |
| 14 | "Quero cancelar" → confirmar | estado `cancelled`, arquivos apagados | manter dados do visitante |

Confira o estado real a qualquer momento:

```
GET http://127.0.0.1:3100/api/requests?sessionId=<id da sessão>
GET http://127.0.0.1:3100/api/requests/<REQ>?sessionId=<id>
```

O `sessionId` aparece em `localStorage['kirana.session']` na aba da Kirana.
Com **outro** `sessionId`, a segunda rota deve responder **404**.

---

## 5. Critérios de aceite

- [ ] `node scripts/run-tests.mjs` → **429/429**
- [ ] `node scripts/site-sync.mjs --check` → sem divergência
- [ ] os 4 testes de navegador com os números do item 3
- [ ] fluxo 13 passos concluído com estado preservado entre páginas
- [ ] nenhuma mensagem afirma envio sem backend real
- [ ] nenhuma ação sensível executa sem clique de confirmação
- [ ] upload inválido recusado **pelo servidor**
- [ ] nada publicado em `https://opportunity.ia.br`

## 6. O que **não** entra na homologação (limitações)

- Envio real para a Opportunity AI: **não existe endpoint**; seria necessário
  configurar `endpoints.submitRequest` (ou `KIRANA_REQUEST_ENDPOINT`) com um
  backend autorizado.
- Publicação do widget/ponte no site: depende de autorização do responsável.
- Varredura antivírus dos arquivos: não implementada (ver
  `docs/FASE5-SEGURANCA.md`, riscos residuais).
- Voz com microfone real no Windows: pendência herdada da v0.4.4.

## 7. Como reverter

Nada em `data/` é migrado e nenhuma configuração existente foi reescrita. Para
voltar ao estado da v0.5.0:

```bat
git checkout ead823b
corepack pnpm install --frozen-lockfile
```

As solicitações criadas no teste ficam em `<KIRANA_DATA_DIR>\requests` e
`<KIRANA_DATA_DIR>\uploads` — apague essas duas pastas para limpar a
homologação.
