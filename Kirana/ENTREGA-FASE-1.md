# Entrega — Kirana Fase 1

**Data:** 24/10/2026 · **Versão:** 0.1.0 · **Organização:** Opportunity AI
**Escopo executado:** itens 1 a 6 da seção 13 da especificação (Kirana local, conversacional e
funcional, com interface própria, streaming, sessões, personalidade e ferramenta simulada).

---

## 1. Como ver funcionando agora

Duas instâncias de demonstração estão rodando neste ambiente:

| O que | Endereço |
|---|---|
| Kirana (modo demonstração, gateway simulado) | porta **3000** — prévia ao vivo |
| Gateway simulado (`scripts/mock-gateway.js`) | `127.0.0.1:1455` |

> Essas instâncias usam **gateway simulado**: as respostas são geradas por script, para
> demonstrar streaming, ferramentas e confirmação sem chamar um modelo real. Na sua máquina,
> troque para o gateway real seguindo o README (seção 3).

Também há uma prévia estática da interface em `docs/preview-interface.html`.

---

## 2. Arquivos criados

```text
kirana/
├─ README.md                       # instalação no Windows, configuração, uso, limitações
├─ ENTREGA-FASE-1.md               # este relatório
├─ .env.example                    # sem credenciais
├─ .gitignore                      # ignora .env e data/
├─ package.json                    # scripts start/dev/test/doctor/bench/mock; zero dependências
├─ iniciar.bat  iniciar-demo.bat  testar.bat  diagnostico.bat
├─ src/
│  ├─ server.js                    # HTTP, rotas, SSE, estáticos, rate limit, origem, token
│  ├─ agent.js                     # turno, contexto, fallback, ferramentas, confirmação
│  ├─ gateway.js                   # cliente HTTP do gateway (formato OpenAI, streaming)
│  ├─ prompts.js                   # identidade Kirana + regras operacionais
│  ├─ sessions.js                  # sessões, histórico, reparo de contexto, métricas
│  ├─ memory.js                    # memória opcional com consentimento
│  ├─ interests.js                 # registro local de interesses comerciais
│  ├─ config.js  logger.js  sse.js  validation.js  ratelimit.js  http-utils.js
│  ├─ tools/{registry.js,definitions.js,search.js}
│  └─ catalog/{services,products,projects,opportunity-ai}.json
├─ public/{index.html,styles.css,app.js,favicon.svg}
├─ scripts/{mock-gateway.js,doctor.mjs,benchmark.mjs,build-preview.mjs,preview-demo.html}
├─ test/                           # 67 testes
└─ docs/{ARQUITETURA,INTEGRACAO-SITE,SEGURANCA-PRIVACIDADE,RELATORIO-VALIDACAO}.md
```

Nenhum arquivo do gateway existente foi lido, alterado ou reescrito — a integração é apenas HTTP
pelo contrato documentado.

---

## 3. Funcionalidades implementadas

- **Interface própria** (HTML/CSS/JS puro): histórico da conversa, streaming progressivo, indicador
  de processamento, botão de interromper, nova conversa, lista de conversas anteriores, memória,
  mensagens de erro com "tentar novamente", identificação visual da Kirana, layout responsivo.
- **Conexão com o gateway** por variável de ambiente, com `GET /health`, `GET /v1/models` e
  `POST /v1/chat/completions` em streaming SSE.
- **Identidade Kirana** com o prompt-base da especificação + regras operacionais (não inventar
  preços/prazos, não afirmar ação sem resultado, pedir confirmação para ações sensíveis).
- **Sessões e histórico** persistidos localmente, com retomada de conversa e reparo de contexto.
- **Memória persistente opcional** com consulta, correção e exclusão na interface, consentimento
  obrigatório e bloqueio de dados sensíveis.
- **7 ferramentas** (4 de leitura, 3 de escrita) com JSON Schema, validação no servidor, timeout,
  separação leitura/escrita e **confirmação obrigatória** para escrita.
- **Seleção de modelo** centralizada (`gpt-6-luna` primário, `gpt-6.1-sol` fallback) com
  verificação em `/v1/models` e fallback apenas antes do primeiro token/ferramenta.
- **Segurança**: chave só no backend, redação de segredos em log, mesma origem, CSP, rate limit,
  validação de entrada e de argumentos de ferramenta, `.env` fora do versionamento.
- **Operação**: `diagnostico.bat` (diagnóstico do ambiente), `scripts/benchmark.mjs` (comparação de
  modelos), gateway simulado para desenvolvimento, `iniciar-demo.bat`.

---

## 4. Testes executados

```text
node --test test/
# tests 67 · pass 67 · fail 0 · duration_ms ≈ 900
```

Cobertura por área: parser SSE (7), validação de schema (9), memória (6), sessões/contexto (9),
ferramentas (12), cliente do gateway (9), integração HTTP ponta a ponta (15).

Integração verificada com servidor real e SSE real: streaming, contexto entre turnos, ciclo de
ferramenta de leitura, fluxo completo de confirmação (aprovar / recusar / expirar), fallback de
modelo, 401/500/timeout com mensagem clara, rate limit (429), token de acesso (401), bloqueio de
origem (403), validações de entrada (400/404) e memória via API.

Execução manual ponta a ponta com gateway simulado:

```text
Turno 2 (ferramenta de leitura): done { rounds: 2, toolCalls: 1, ttftMs: 29, totalMs: 1479 }
Turno 3 (escrita) + confirmação:  tool_result { executed: true, ok: true }
Registro local: {"protocolo":"INT-2026-4F3914","envio_externo":false,...}
```

Esses tempos vêm do gateway **simulado** e não representam desempenho real.

---

## 5. Resultados reais versus pendências

| Item | Situação |
|---|---|
| Interface, streaming, sessões, ferramentas, confirmação, memória | validado por testes automatizados + execução manual |
| Conversa com o gateway ChatGPT real | **não validado** — o gateway roda na sua máquina Windows, fora deste ambiente |
| Meta de 2 s para a primeira resposta útil | **não medida** |
| Comparação Luna × Sol | ferramenta pronta, medição pendente |
| Scripts `.bat` | escritos e revisados, não executados em Windows |
| Teste em celular físico | pendente (CSS responsivo + prévia estática entregues) |

---

## 6. Problemas encontrados (e corrigidos)

1. `runRead` executava ferramenta de leitura sem validar argumentos → passou a validar contra o schema.
2. Criar sessão consumia a cota do rate limit do chat → limite restrito às rotas de conversa.
3. Evento SSE `session` era enviado duas vezes → removida a duplicação.
4. Contexto podia começar com mensagem de assistente → histórico aparado e pares de ferramenta
   incompletos descartados.
5. Gerador da prévia estática produzia barras invertidas no JS embutido → script movido para arquivo próprio.

---

## 7. Pendências e riscos

- **Risco principal:** nenhuma chamada real ao gateway. Nomes de modelo (`gpt-6-luna`) e detalhes
  do streaming precisam ser confirmados na sua máquina com `diagnostico.bat`.
- Envio real do interesse comercial (CRM/e-mail/WhatsApp) não implementado — registro fica local e
  marcado como pendente de envio.
- Dados de `consultar_status_projeto` são simulados e assim declarados ao usuário.
- Sem autenticação multiusuário; `KIRANA_ACCESS_TOKEN` é apenas um token local opcional.
- Publicação no site permanece bloqueada por decisão da especificação (Fase F).

---

## 8. Próxima etapa recomendada

1. Na sua máquina: `diagnostico.bat` → `iniciar.bat` → validar **uma conversa real**.
2. `node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10 --context` e comparar.
3. Medir a primeira resposta útil e decidir se a meta de 2 s se mantém.
4. Refinar prompt e catálogo com perguntas reais da Opportunity AI (Fase C).
5. Só então: envio real do interesse comercial e preparação do componente incorporável.
