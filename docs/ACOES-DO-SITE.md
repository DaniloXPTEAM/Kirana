# Ações do site (ferramentas de frontend)

Toda ação abaixo é **implementada de verdade** em `public/demo/demo.js`
(`window.KiranaSite.actions`) e exposta ao modelo via CopilotKit/AG-UI. O modelo só vê as
ações permitidas pelo site (`sites/<id>/site.json`) **e** declaradas pelo widget.

| Ação | Parâmetros | Efeito real no navegador | Confirmação |
|---|---|---|---|
| `navigateToPage` | `page`: `inicio` \| `solucoes` \| `labs` \| `contato` | muda o hash da URL, rola até a seção, marca o link ativo | não |
| `openContactForm` | — | navega para `#contato` e foca o campo `nome` | não |
| `selectService` | `serviceId`: `agentes` \| `atendimento` \| `crm` \| `workflows` \| `relatorios` \| `voz-android` | destaca o cartão do serviço em `#solucoes` | não |
| `showPricing` | — | exibe aviso de preços ("não informado", nunca um valor inventado) | não |
| `fillContactForm` | `nome`, `email`, `interesse`, `mensagem` (obrigatórios); `whatsapp`, `empresa` | escreve nos inputs, dispara `input`/`change`, prepara autorização de envio | não (só preenche) |
| `submitContactRequest` | — | envia o formulário e grava o pedido no backend | **sim** (HITL) |

## Fluxo de confirmação (Human-in-the-Loop)

1. `fillContactForm` valida os dados e pede ao backend um **token de uso único** ligado ao
   hash dos valores (`POST /api/demo/contact/prepare`). Nada é gravado.
2. A interface mostra um cartão com **todos os dados visíveis** e dois botões.
3. **Confirmar** → `submitContactRequest` → backend consome o token e grava
   (`POST /api/demo/contact/submit`) → devolve protocolo real (`INT-AAAA-XXXXXX`).
4. **Cancelar** → nada é enviado; a UI registra o cancelamento.
5. O token é **consumido no primeiro uso**: reapresentar, trocar dados ou esperar >10 min
   exige nova confirmação (testado em `test/copilot-hitl.test.js`).

## Estado compartilhado exposto ao modelo

`page`, `section`, `service`, `formStep`, `lastAction` — sanitizados antes de sair do
navegador: chaves sensíveis (token, senha, apiKey, cpf, e-mail, whatsapp) e e-mails soltos em
texto são removidos (`sanitizeSharedState`).

## Integração em outro site

1. Copie `sites/demo-opportunity/` para `sites/<seu-id>/` e ajuste `site.json`.
2. No site hospedeiro, defina `window.KiranaSite` com `config`, `getState`, `onStateChange`,
   `readForm` e `actions` (mesmos nomes acima).
3. Inclua `<script src="https://<kirana>/widget/kirana-widget.js" defer></script>`.
4. Opcional: `window.KIRANA_WIDGET_CONFIG = { runtimeUrl: 'https://<kirana>/api/copilot', agent: 'kirana' }`.
5. Se quiser restringir origem, preencha `allowedOrigins` no `site.json`.
