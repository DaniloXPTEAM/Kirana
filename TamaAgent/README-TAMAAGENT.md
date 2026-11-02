# TamaAgent v0.1.0

O **TamaAgent** é o agente do app **Tama IA**. Nasceu da Kirana v0.5.5 (pasta `Kirana/` do mesmo repositório, que continua intacta) e agora fala com um **OmniRoute** em vez do Gateway do ChatGPT. **O Gateway antigo (`Gateway/`) não é usado.**

```
celular (Tama IA) ──► TamaAgent (porta 3000, ponte /api/gateway/*) ──► OmniRoute (porta 20128) ──► modelos
```

## O que mudou em relação à Kirana
- Nome: `TamaAgent` (pacote `tamaagent`). Variáveis `TAMAAGENT_*` valem como as antigas `KIRANA_*` (as antigas continuam funcionando).
- Provedor padrão: `http://127.0.0.1:20128` (OmniRoute). Aceita qualquer provedor de formato OpenAI (`/v1/models`, `/v1/chat/completions`).
- Sem `/health` no provedor, a ponte confere o catálogo (`/v1/models`) e só diz "ok" se ele respondeu.
- O Gateway antigo e a autorização por login do ChatGPT (SIWC) **não são mais necessários**.

## Como ligar (no PC do proprietário, Windows)
1. **OmniRoute ligado** no PC (instalação e painel são do OmniRoute: `npm i -g omniroute` e abrir `http://localhost:20128`). Crie ali uma chave de API e deixe ao menos um provedor/modelo configurado.
2. `CONFIGURAR-TAMAAGENT.cmd`: pede o endereço e a **chave (digitada oculta)**, gera o token da ponte e grava tudo só no `.env` desta pasta.
3. `TESTAR-TAMAAGENT.cmd`: confere o catálogo e faz **uma** conversa curta (código 0 = passou, 1 = falhou, 3 = bloqueado).
4. `INICIAR-TAMAAGENT.cmd`: liga o TamaAgent em `http://127.0.0.1:3000`.

## Segurança
- **A chave nunca vai para o Git, o Drive nem o chat.** Só existe no `.env` local (que está no `.gitignore`). Uma chave colada em conversa deve ser trocada no painel do provedor depois dos testes.
- A ponte exige o token próprio (`TAMAAGENT_BRIDGE_TOKEN`) e repassa ao provedor com a chave do provedor, que nunca chega ao celular.
- Sem Tailscale: para teste por **cabo USB** use `adb reverse tcp:3000 tcp:3000` e `TAMAAGENT_BRIDGE_REQUIRE_HTTPS=off` (HTTP só em loopback; não exponha a porta na rede).

## O que ainda NÃO está feito
- O conteúdo herdado da Kirana (catálogo do site Opportunity AI, ferramentas `consultar_servicos` etc.) continua no código. Só a identidade/persona e o provedor foram trocados. Ferramentas próprias do Tama (lembretes, notas, metas) vivem no app e no Runtime, não aqui.
- Nada foi provado com o **OmniRoute real nem com a chave real**: os testes automáticos usam um provedor falso. A prova é o `TESTAR-TAMAAGENT.cmd` no PC.
- Os `.cmd` e o `.ps1` nunca rodaram em Windows (revisados só por leitura).
