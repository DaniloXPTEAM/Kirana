# Kirana — agente conversacional da Opportunity AI

**Versão:** 0.1.0 (Fase 1 — execução local)
**Organização:** Opportunity AI
**Gateway utilizado:** `Kirana-ChatGPT-Gateway v0.2.0` (não modificado)
**Data desta entrega:** 24/10/2026

A Kirana é um agente conversacional com identidade própria, sessões, streaming, ferramentas
com permissões separadas e confirmação obrigatória para ações de escrita. Ela conversa com o
gateway ChatGPT já existente por HTTP, **sempre pelo backend** — a chave do gateway nunca chega
ao navegador.

> **Leia antes de usar:** a validação contra o gateway real precisa ser feita na sua máquina
> Windows (o gateway roda em `http://127.0.0.1:1455`). O que foi validado aqui está descrito em
> [`docs/RELATORIO-VALIDACAO.md`](docs/RELATORIO-VALIDACAO.md), sem confundir teste simulado com
> validação real.

---

## 1. O que está pronto

| Área | Estado |
|---|---|
| Interface de chat própria (desktop + mobile) | ✅ implementada |
| Streaming SSE ponta a ponta (gateway → backend → navegador) | ✅ implementado e testado |
| Sessões persistentes + histórico + retomada de conversa | ✅ implementado e testado |
| Prompt de identidade Kirana (seção 4 da especificação) | ✅ implementado |
| Ferramentas: 4 de leitura + 3 de escrita com confirmação | ✅ implementado e testado |
| Confirmação obrigatória antes de gravar/enviar | ✅ implementado e testado |
| Memória persistente opcional, com consulta/correção/exclusão | ✅ implementado e testado |
| Fallback de modelo (primário → alternativo) sem duplicar ações | ✅ implementado e testado |
| Rate limiting, validação de entrada, CORS/origem, CSP | ✅ implementado e testado |
| Testes automatizados | ✅ 67 testes, 0 falhas |
| Validação com o gateway ChatGPT real | ⏳ pendente — depende da sua máquina |
| Meta de 2 s para a primeira resposta útil | ⏳ não medida em condição real |

---

## 2. Requisitos

- **Node.js 20.6 ou superior** (testado com Node 20.20). Nenhuma dependência externa — `npm install` não baixa nada.
- Windows 10/11 (as instruções usam `.bat`), macOS ou Linux.
- O `Kirana-ChatGPT-Gateway v0.2.0` rodando em `http://127.0.0.1:1455` com a `GATEWAY_API_KEY` em mãos.

---

## 3. Instalação no Windows

1. Copie a pasta `kirana` para o computador (por exemplo `C:\CRiando coisa nova\kirana`).
2. Confirme que o Node está instalado:
   ```bat
   node --version
   ```
   Se não estiver, instale o Node 20 LTS em <https://nodejs.org>.
3. **Ligue o gateway** (o projeto que já funciona). No diretório dele:
   ```bat
   cd "C:\CRiando coisa nova\Kirana-ChatGPT-Gateway-v0.2.0"
   ```
   Suba o gateway como você já faz hoje e confirme:
   ```bat
   curl http://127.0.0.1:1455/health
   ```
4. **Configure a Kirana.** Na pasta `kirana`, copie o exemplo e preencha a chave:
   ```bat
   copy .env.example .env
   notepad .env
   ```
   Ajuste pelo menos:
   ```env
   KIRANA_GATEWAY_URL=http://127.0.0.1:1455
   KIRANA_GATEWAY_API_KEY=cole_aqui_a_chave_do_gateway
   ```
   A chave é a mesma `GATEWAY_API_KEY` do `.env` do gateway. **Não** use a chave da conta ChatGPT.
5. **Confira o ambiente:**
   ```bat
   diagnostico.bat
   ```
   O diagnóstico mostra: versão do Node, `.env`, alcance do `/health`, modelos listados e se o
   modelo primário existe.
6. **Inicie a Kirana:**
   ```bat
   iniciar.bat
   ```
   A interface abre em <http://127.0.0.1:3000>.

### Modo demonstração (sem gateway real)

Se quiser conhecer a interface sem tocar na conta ChatGPT:

```bat
iniciar-demo.bat
```

Isso sobe um **gateway simulado** (`scripts/mock-gateway.js`) e a Kirana apontando para ele.
As respostas são geradas por script — serve para ver streaming, ferramentas e confirmação.
Nesse modo não há modelo real: as respostas são obviamente sintéticas.

### Prévia no navegador (somente demonstração)

Este pacote inclui `docs/preview-interface.html`, uma **prévia estática** (HTML autocontido) da
interface, para revisar o design sem subir nada. Se a Kirana estiver rodando em um ambiente que
exibe a página dentro de um iframe de outra origem (sandbox/IDE online), use
`KIRANA_ALLOW_EMBED=true` — em uso normal mantenha `false`, que a interface só pode ser enquadrada
pela própria origem.

### Linux / macOS

```bash
cp .env.example .env       # preencha KIRANA_GATEWAY_API_KEY
node scripts/doctor.mjs
node src/server.js
```

---

## 4. Configuração (`.env`)

Todas as variáveis são opcionais, exceto a chave do gateway. Valores padrão entre parênteses.

| Variável | Função |
|---|---|
| `KIRANA_GATEWAY_URL` | Endereço do gateway (`http://127.0.0.1:1455`) |
| `KIRANA_GATEWAY_API_KEY` | Chave do gateway. **Só no backend** |
| `KIRANA_PRIMARY_MODEL` | Modelo preferencial (`gpt-6-luna`) |
| `KIRANA_FALLBACK_MODEL` | Modelo alternativo (`gpt-6.1-sol`) |
| `KIRANA_ALLOW_FALLBACK` | Permite fallback (`true`) |
| `KIRANA_MODEL_PROBE` | Confere `/v1/models` antes de usar o primário (`true`) |
| `KIRANA_HOST` / `KIRANA_PORT` | Onde a Kirana escuta (`127.0.0.1` / `3000`) |
| `KIRANA_ACCESS_TOKEN` | Token opcional entre navegador e backend (vazio) |
| `KIRANA_RATE_LIMIT_MAX` / `_WINDOW_MS` | Limite por IP (`20` / `60000`) |
| `KIRANA_FIRST_TOKEN_TIMEOUT_MS` | Tempo máximo para o 1º token (`20000`) |
| `KIRANA_REQUEST_TIMEOUT_MS` | Tempo máximo da requisição (`120000`) |
| `KIRANA_MAX_TOOL_ROUNDS` | Rodadas de ferramenta por mensagem (`4`) |
| `KIRANA_HISTORY_LIMIT` | Mensagens de histórico enviadas ao modelo (`24`) |
| `KIRANA_TEMPERATURE` / `KIRANA_MAX_TOKENS` | Geração (`0.6` / `0` = padrão do gateway) |
| `KIRANA_DATA_DIR` | Onde ficam sessões, memória e interesses (`./data`) |

---

## 5. Como usar

- **Conversar:** escreva e pressione `Enter` (`Shift+Enter` quebra linha).
- **Interromper:** botão *Interromper* durante a geração — o backend cancela a requisição no gateway.
- **Nova conversa / histórico:** barra lateral; conversas antigas podem ser reabertas.
- **Ferramentas:** as de leitura rodam sozinhas; as de escrita **sempre** pedem confirmação em
  um cartão na conversa. Se você clicar *Não* ou simplesmente continuar a conversa, nada é gravado.
- **Memória:** botão *Memória* mostra o que está guardado; você pode adicionar (com caixa de
  consentimento obrigatória), corrigir e apagar.

### Ferramentas da Fase 1

| Ferramenta | Tipo | O que faz |
|---|---|---|
| `consultar_servicos` | leitura | Catálogo dos 6 serviços publicados no site |
| `consultar_produtos` | leitura | Projetos do Opportunity Labs com o estágio publicado |
| `consultar_status_projeto` | leitura | Andamento de projeto — **dados simulados** (`PRJ-001` a `PRJ-003`) |
| `consultar_memoria` | leitura | Informações que você autorizou guardar |
| `registrar_interesse_comercial` | escrita | Grava a solicitação **localmente**; não envia e-mail/CRM |
| `salvar_memoria` | escrita | Guarda uma informação que você pediu para lembrar |
| `apagar_memoria` | escrita | Remove uma informação guardada |

Nada é executado por comando arbitrário: os argumentos são validados contra JSON Schema no
servidor, ferramentas de escrita só rodam após confirmação, e o modelo não tem acesso a shell,
arquivos ou rede.

---

## 6. Testes

```bash
npm test          # ou testar.bat
```

Resultado desta entrega: **67 testes, 67 aprovados, 0 falhas** (~0,9 s).

Cobrem, entre outros:

- parser de SSE (fragmentação, CRLF, múltiplos eventos, `[DONE]`);
- validação de JSON Schema das ferramentas;
- memória (consentimento obrigatório, bloqueio de dados sensíveis, limite, persistência);
- sessões (títulos, exclusão, reparo de contexto, métricas);
- ferramentas (leitura x escrita, argumentos inválidos, ferramenta desconhecida);
- cliente do gateway (texto, tool calls fragmentadas, 401, 404, 5xx, abort, timeout);
- integração HTTP real: chat com streaming, contexto entre turnos, ciclo completo de ferramenta
  de leitura, fluxo de confirmação (aprovar/recusar/expirar), fallback de modelo, rate limit,
  token de acesso, bloqueio de origem, erros de entrada e memória via API.

Os testes usam um **gateway falso local** — não consomem a conta ChatGPT e não precisam do `.env`.

---

## 7. Benchmark de modelos

```bash
node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10 --context
```

Mede tempo até o primeiro token útil, tempo total e taxa de sucesso por modelo e cenário,
chamando o gateway pelo mesmo caminho usado pela Kirana. Salva JSON em `data/benchmark-*.json`.

---

## 8. Segurança — resumo

- `GATEWAY_API_KEY` e tokens OAuth ficam apenas no backend; nunca no HTML/JS/logs (o logger redige segredos).
- Frontend e backend na mesma origem, com verificação de `Origin`, CSP, `nosniff` e sem `eval`.
- Rate limiting por IP nas rotas de chat.
- Validação de entrada (JSON, tamanho, campos) e de saída das ferramentas.
- Ferramentas de escrita exigem confirmação; leitura e escrita são registros separados.
- `.env` no `.gitignore`; `data/` (sessões, memória, interesses) fora do versionamento.
- A porta `1455` não deve ser exposta; a Kirana escuta em `127.0.0.1` por padrão.

Detalhes e checklist de publicação: [`docs/SEGURANCA-PRIVACIDADE.md`](docs/SEGURANCA-PRIVACIDADE.md).

> ⚠️ **Não publique este serviço na internet.** A autorização *Sign in with ChatGPT* é pessoal.
> Uso multiusuário/comercial exige revisar os termos aplicáveis e uma arquitetura própria
> (ver documentos citados acima).

---

## 9. Estrutura

```text
kirana/
├─ iniciar.bat / iniciar-demo.bat / testar.bat / diagnostico.bat
├─ .env.example                  # sem credenciais
├─ src/
│  ├─ server.js                  # HTTP, rotas, SSE, arquivos estáticos
│  ├─ agent.js                   # orquestração do turno, fallback, ferramentas, confirmação
│  ├─ gateway.js                 # cliente do gateway (formato OpenAI)
│  ├─ prompts.js                 # identidade e regras da Kirana
│  ├─ sessions.js                # sessões, histórico, reparo de contexto
│  ├─ memory.js                  # memória persistente opcional
│  ├─ interests.js               # registro local de interesses comerciais
│  ├─ tools/                     # registry, definições e busca textual
│  ├─ catalog/                   # catálogos confirmados (serviços, produtos, projetos)
│  ├─ config.js / logger.js / sse.js / validation.js / ratelimit.js / http-utils.js
├─ public/                       # interface (HTML/CSS/JS, sem dependências)
├─ scripts/                      # mock-gateway, doctor, benchmark, build-preview
├─ test/                         # 67 testes automatizados
└─ docs/                         # arquitetura, integração, segurança, relatório
```

Nenhuma dependência de terceiros: só a biblioteca padrão do Node.

---

## 10. Limitações conhecidas desta entrega

1. **Não validada contra o gateway real.** O ambiente de desenvolvimento não tinha acesso ao
   seu gateway (ele roda em `127.0.0.1` na sua máquina). Toda a validação foi feita com gateway
   simulado e com o contrato HTTP documentado.
2. **Dados de projeto são simulados** (`PRJ-001…003`) — marcados como tal nas respostas.
3. **Interesse comercial não é enviado** para e-mail, WhatsApp ou CRM: fica em
   `data/interests.jsonl` com status `registrado_localmente_pendente_de_envio`.
4. **Memória é local e sem usuários** — um único conjunto de dados por instalação.
5. **Benchmark de modelos e meta de 2 s** ainda não medidos em condição real.
6. **`.bat` do Windows** foram escritos e revisados, mas executados apenas em ambiente Linux
   (com os comandos equivalentes). Se algo falhar no Windows, o comando direto é
   `node src\server.js`.
7. **Sem autenticação multiusuário**: `KIRANA_ACCESS_TOKEN` é um token único opcional para uso
   local, não um sistema de contas.

---

## 11. Próximos passos recomendados

1. Rodar `diagnostico.bat` na sua máquina e validar **uma conversa real** com o gateway.
2. Executar `node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10 --context` e
   comparar Luna x Sol com dados reais.
3. Medir a primeira resposta útil e comparar com a meta de 2 s.
4. Refinar o prompt com base em conversas reais (perguntas frequentes da Opportunity AI).
5. Só depois: integração de envio real do interesse comercial e preparação do componente
   incorporável para `https://opportunity.ia.br`.

---

## 12. Documentação

- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — componentes, fluxo de um turno, protocolo SSE, decisões.
- [`docs/INTEGRACAO-SITE.md`](docs/INTEGRACAO-SITE.md) — como incorporar no site no futuro.
- [`docs/SEGURANCA-PRIVACIDADE.md`](docs/SEGURANCA-PRIVACIDADE.md) — modelo de ameaças e checklist.
- [`docs/RELATORIO-VALIDACAO.md`](docs/RELATORIO-VALIDACAO.md) — o que foi realmente testado.
- [`docs/preview-interface.html`](docs/preview-interface.html) — prévia estática da interface.
