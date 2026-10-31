# Kirana v0.5.5 + Gateway v0.4.1 — distribuição Windows

> **Correções desta entrega** (detalhe em `docs/CHANGELOG-CORRECAO.md`):
> 1. o instalador **não se bloqueia mais** na segunda execução na mesma pasta;
> 2. a **chave local é gerada, alinhada e conferida automaticamente** — nenhuma etapa manual
>    de transporte de chave entre os dois `.env`;
> 3. a Kirana **descobre o modelo no catálogo real** do seu plano em vez de insistir num slug
>    do `.env.example`;
> 4. o parser SSE do Gateway não perde o frame final nem corrompe acento;
> 5. **revisão 2**: instalador compatível com Windows PowerShell 5.1 (RNG e conversão de
>    parâmetros); o inicializador **só reaproveita** processo com dono comprovado; o
>    `PARAR-TUDO` **não encerra nada** sem identidade confirmada; o código do erro de
>    streaming chega até a tela; a escolha de modelo não promete capacidade não verificada.
>    Detalhe em `docs/REVISAO-2.md`;
> 6. **revisão 3**: um stream cortado **nunca** é entregue como resposta concluída
>    (`[DONE]` passa a ser exigido); 401/403 são separados em chave local × SIWC ×
>    não conclusivo pelo `error.code`; a falha de descoberta de modelos **não** fica 5 minutos
>    no cache — autorizou, a próxima mensagem já consulta de novo. Detalhe em
>    `docs/REVISAO-3.md`;
> 7. **revisão 4**: consolidação — a validação de modelos reais passou a fazer parte **desta**
>    distribuição (`tools/validar-modelos-reais.mjs` + `VALIDAR-MODELOS-REAIS.cmd`), sem precisar
>    aplicar um segundo ZIP. Nesta revisão foram corrigidas duas divergências do verificador:
>    ele prometia limitar custo por `max_tokens` (que o Gateway **não repassa**) e tratava o campo
>    `model` da resposta como prova de identidade (é só o nome pedido — a prova está em
>    `/v1/runs`, campo `identityVerified`). Detalhe em `docs/REVISAO-4.md`;
> 8. **revisão 4.1**: o verificador enviava `max_tokens` e o Gateway **rejeita** esse campo com
>    `400 unsupported_parameter` — o teste morria antes do modelo e parecia "modelo ruim".
>    Agora o corpo é montado por `tools/contrato-chat.mjs`, só com os 7 campos aceitos; o
>    cancelamento virou opt-in; e `tools/teste-verificador.mjs` (14 testes) impede o retorno
>    do campo. Detalhe em `docs/REVISAO-4.1.md`.
>
> E da montagem anterior, mantida: o Gateway 0.4.1 recusava subir na segunda vez (o
> `registration.json` criado antes do consentimento SIWC era considerado inválido). Corrigido em
> `Gateway/src/auth.js` — uma linha — sem mudar a versão nem a API. Detalhes em
> `docs/CAUSA-RAIZ-E-CORRECAO.md`, seção 6. **Não apague `Gateway/.local-state`**: é lá que está o
> `hostId` do seu consentimento.

Este pacote contém **um** executável de cada componente. Não há ZIP do Gateway escondido em
`integrations/`: a pasta `Gateway/` **é** a v0.4.1 (com `src/engine.js`, `/v1/engine` e `/v1/runs`).

```
Kirana-v0.5.5-com-Gateway-v0.4.1-Windows/
├── Kirana/                  versão 0.5.5 (agente, interface, ponte /api/gateway/*)
├── Gateway/                 versão 0.4.1 (motor, identidade de modelo, /v1/engine, /v1/runs)
├── INSTALAR-WINDOWS.cmd     UM comando: instala, repara, alinha a chave e faz pré-voo
├── INICIAR-TUDO.cmd         UM comando: sobe Gateway :1455 + Kirana :3000 e abre a interface
├── PARAR-TUDO.cmd           encerra só o que esta distribuição iniciou
├── DIAGNOSTICO.cmd          versões, portas, processos, .env, SIWC, ponte
├── MIGRAR-ENV.cmd           traz configurações das instalações antigas (plano por padrão)
├── BACKUP-ANTES-DE-LIMPAR.cmd  copia .env e estado antes de qualquer remoção
├── scripts/                 os .ps1 usados pelos .cmd
├── tools/                   verificadores e utilitários (rodam com Node, sem Windows)
│   ├── configurar.mjs       gera/preserva a chave e alinha nos dois .env
│   ├── checar-config.mjs    pré-voo antes de iniciar qualquer serviço
│   ├── verificar-pacote.mjs --release (ZIP) | --instalacao (pasta em uso)
│   ├── diagnosticar-modelos.mjs  catálogo real + qual modelo seria usado (sem mostrar chave)
│   ├── teste-revisao3.mjs   41 testes da revisão 3 (stream cortado, 401 por código, cache)
│   ├── teste-revisao2.mjs   42 testes da revisão 2 (PS 5.1, dono de processo, SSE, modelos)
│   ├── teste-correcoes.mjs  18 testes da revisão 1
│   ├── validar-modelos-reais.mjs  V00 + catálogo + inferência + identidade + SSE (roda no Windows)
│   ├── contrato-chat.mjs          os 7 campos aceitos + montagem única do corpo
│   ├── teste-verificador.mjs      14 testes: barra max_tokens e valida os limites
│   └── duble-gateway-autorizado.mjs  dublê de contrato ESTRITO, para testar sem SIWC
└── docs/
    ├── CAUSA-RAIZ-E-CORRECAO.md   por que o pacote anterior tinha Gateway 0.4.0
    ├── MIGRACAO-ENV-E-SIWC.md     .env, estado e por que o SIWC "não pegava"
    ├── INSTALACAO-LIMPA.md        procedimento seguro para reinstalar do zero
    ├── TESTES-EXECUTADOS.md       o que foi testado, com quais resultados
    ├── CHANGELOG-CORRECAO.md      causa-raiz de cada correção, antes × depois
    ├── TESTES-E-EVIDENCIAS.md     o que passou, o que falhou e o que não deu para testar
    ├── REVISAO-2.md               os 9 defeitos da revisão 2, um por um
    ├── REVISAO-3.md               stream cortado, 401 por código e cache de falha
    ├── REVISAO-4.md               consolidação + divergências de max_tokens e identidade
    ├── REVISAO-4.1.md             correção do verificador (400 unsupported_parameter)
    ├── TAMA_T03_B0_BLOQUEIO_SIWC.md   o que fazer no Windows para liberar os modelos
    ├── GATEWAY_REV3_ACESSO_PRIVADO_STATUS.md  Tailscale: estado e rollback do Serve
    ├── validacao/                 onde VALIDAR-MODELOS-REAIS.cmd grava os relatórios
    └── MIGRACAO-E-ROLLBACK.md     reinstalar, repetir o instalador e voltar atrás
```

## Requisitos

- Windows 11
- Node.js **20.20 ou superior** (o Gateway exige `>=20.20`)
- PowerShell 5.1 (já vem no Windows)

## Instalação em dois comandos

```powershell
# extraia o ZIP em uma pasta nova, por exemplo:
#    C:\Kirana-sistema\Kirana-v0.5.5-com-Gateway-v0.4.1-Windows

.\INSTALAR-WINDOWS.cmd     # instala/repara, cria .env, gera e alinha a chave, faz pré-voo
.\INICIAR-TUDO.cmd         # sobe Gateway 1455 + Kirana 3000 e ABRE a interface
```

A interface abre sozinha em `http://127.0.0.1:3000`. O `DIAGNOSTICO.cmd` é para conferência
quando algo não funcionar — não é etapa obrigatória do uso normal.

Depois de subir, autorize o SIWC **uma vez por execução**:

```
http://127.0.0.1:1455/auth/start
```

> **Os tokens do SIWC ficam em memória.** Ao reiniciar o Gateway, autorize de novo. Isso é decisão
> de segurança do próprio Gateway (`src/auth.js:25`), não um defeito desta distribuição.

## Vindo de uma instalação antiga

Não copie pastas da instalação antiga para dentro desta. A ordem segura é:

```powershell
.\BACKUP-ANTES-DE-LIMPAR.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana" -IncluirEstado
.\INSTALAR-WINDOWS.cmd
.\MIGRAR-ENV.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana"     # mostra o plano, não grava
.\MIGRAR-ENV.cmd -RaizAntiga "C:\CRiando coisa nova\Kirana" -Aplicar
.\INICIAR-TUDO.cmd
.\DIAGNOSTICO.cmd
```

A migração copia **variáveis compatíveis**, renomeia as que mudaram de nome e **recusa** copiar
coisas como `OPENAI_API_KEY`. Ela nunca imprime valores — só presença e comprimento. Detalhes em
`docs/MIGRACAO-ENV-E-SIWC.md`.

A remoção das pastas antigas **não é feita por script**. O procedimento está em
`docs/INSTALACAO-LIMPA.md`, e vem depois da validação.

## Projetos que este pacote não toca

- `Kirana-Arena-Bridge` (0.3.2) — projeto independente, ignorado por todos os scripts.
- `opportunity-site-pronto` (site Opportunity AI) — idem.
- Nenhum repositório Git é alterado ou publicado.

## Acesso remoto pelo celular (opcional)

O Gateway continua restrito a `127.0.0.1:1455`. Para o Tama IA no Android alcançar a Kirana pelo
Tailscale (Serve, não Funnel), a ponte `/api/gateway/*` já vem implementada nesta versão. Configure
no `Kirana/.env`:

```
KIRANA_BRIDGE=on
KIRANA_BRIDGE_TOKEN=<32+ caracteres>
KIRANA_BRIDGE_REQUIRE_HTTPS=on
KIRANA_BRIDGE_TRUST_PROXY=on
KIRANA_ACCESS_TOKEN=<32+ caracteres>
```

O servidor **não sobe** em combinações perigosas (ponte sem token, HTTPS obrigatório sem proxy
confiável, proxy confiável sem token da Kirana). Guia do aparelho, do Serve e do diagnóstico de
camadas: `Kirana/docs/ACESSO-REMOTO-TAILSCALE.md`.

## Se o diagnóstico reprovar

| Veredito | Significado | O que fazer |
|---|---|---|
| `Gateway/package.json` FALHA | pacote errado (não é este) | baixe o ZIP desta entrega |
| `servico ativo e v0.x, pasta declara v0.4.1` | processo antigo ocupando a porta | feche-o; o pacote não mata processo alheio |
| `.env` FALHA | arquivo ausente | `.\INSTALAR-WINDOWS.cmd` |
| `SIWC inativa` (aviso) | tokens em memória expiraram com o restart | autorize em `/auth/start` |
| `GET /v1/models recusado (401)` | autorização não ativa | autorize; se persistir, veja `grantedScopes` em `docs/MIGRACAO-ENV-E-SIWC.md` §4 |
| `porta ocupada por processo sem /health` | sobra de instalação antiga | encerre manualmente após confirmar o caminho |

## Verificação independente

```powershell
node tools\verificar-pacote.mjs            # estrutura + versões + marcadores de código
node tools\verificar-pacote.mjs --testes   # + executa as duas suítes (76 e 531 testes)
node tools\teste-scripts.mjs               # sintaxe dos .ps1 + migração sem vazar segredo
```

## Validar os modelos reais (depois de autorizar a conta)

O Gateway só mostra catálogo e responde com modelo quando a conta está autorizada (SIWC).
Depois de abrir `http://127.0.0.1:1455/auth/start` e concluir o login:

```bat
VALIDAR-MODELOS-REAIS.cmd
```

Ele faz, em ordem, e para no primeiro bloqueio:

| # | O que verifica |
|---|---|
| 0 | `/health`, `/v1/engine`, `/auth/status`, `/v1/capabilities` |
| 1 | catálogo real em `/v1/models` |
| 2 | inferência real (uma requisição curta) |
| 2.2 | **identidade do modelo** pelo `/v1/runs` (`identityVerified`) — o `model` da resposta é só o nome pedido |
| 3 | streaming SSE real com `[DONE]` |
| 4 | cancelamento não derruba o Gateway |
| 5 | erros diferenciados (`model_not_available`, `invalid_json`, `not_found`) |
| 6 | nenhuma chave/token nos logs |

Relatórios gerados em `docs\validacao\`.

Opções: `--catalogo` (só lista, não gera), `--modelo <slug>`, `--com-cancelamento`, `--base <url>`.
Código de saída: `0` tudo certo · `1` alguma falha · `3` bloqueado por falta de SIWC.

> **Sobre limites:** o Gateway 0.4.1 **rejeita `max_tokens`** (`400 unsupported_parameter`) —
> não existe teto de tokens configurável nesta versão. Os limites reais são 180 s e 4 MiB por
> requisição (lado Gateway); este verificador usa 60 s e 200 kB.
> Chamadas de geração: **2** no fluxo padrão (inferência + streaming), **3** com
> `--com-cancelamento`, **0** com `--catalogo`. Prompt curto reduz consumo, mas não é garantia de custo.

