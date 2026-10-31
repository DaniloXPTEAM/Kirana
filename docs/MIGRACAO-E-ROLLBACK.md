# MIGRAÇÃO, ATUALIZAÇÃO E ROLLBACK

Três cenários: instalação limpa, repetição do instalador numa pasta já usada, e
recuperação se algo der errado. Nenhum deles exige apagar nada nem copiar chave à mão.

---

## 1. Instalação limpa (pasta nova)

```
.\INSTALAR-WINDOWS.cmd
.\INICIAR-TUDO.cmd
```

`INSTALAR-WINDOWS.cmd` faz, nesta ordem:

| Etapa | O que faz | O que NÃO faz |
|---|---|---|
| 1 | confere versões declaradas (Kirana 0.5.4, Gateway 0.4.1) | — |
| 2 | confere Node.js (20.20+) | não instala Node |
| 3 | verificação estrutural em **modo instalação** | não apaga nada |
| 4 | `npm install --omit=dev` em Gateway e Kirana | não reinstala o que já existe |
| 5 | cria `.env` a partir do `.env.example`, se não existir | não sobrescreve `.env` existente |
| 6 | **gera/preserva a chave no Gateway e alinha na Kirana** | não imprime a chave |
| 7 | pré-voo: versões, chaves, portas, endereço | não inicia serviço |
| 8 | mostra o próximo passo | — |

`INICIAR-TUDO.cmd` roda o pré-voo outra vez, sobe Gateway (1455) e Kirana (3000),
confere `/health` dos dois e **abre a interface** em `http://127.0.0.1:3000`.

Se a conversa falhar, autorize a conta **uma vez** em `http://127.0.0.1:1455/auth/start`.
Isso é SIWC (token do ChatGPT) e não tem relação com a chave local.

---

## 2. Atualizar ou reparar uma instalação já usada

Rode o mesmo comando na mesma pasta:

```
.\INSTALAR-WINDOWS.cmd
```

É idempotente. O que é preservado:

| Item | Comportamento |
|---|---|
| `Kirana/.env` e `Gateway/.env` | não são sobrescritos; só as linhas necessárias são ajustadas, com comentários e ordem mantidos |
| `GATEWAY_API_KEY` existente (32+ caracteres) | preservada; nunca é regenerada sem motivo |
| `KIRANA_GATEWAY_API_KEY` | alinhada com a do Gateway se estiver diferente ou ausente |
| `node_modules` | reaproveitado (use `-ReinstalarDependencias` para refazer) |
| `Kirana/data` (sessões, memória, RAG) | **intocado** |
| `Gateway/.local-state` (`hostId`, `registration.json`) | **intocado** |
| `backups/` | recebe uma cópia nova dos `.env` a cada execução |

Antes de escrever qualquer `.env`, o instalador copia os dois para
`backups\env-AAAAMMDD-HHMMSS\` e **verifica o backup relendo**; se a cópia não bater,
ele aborta sem gravar.

Se a pasta contiver uma instalação **incompatível** (versão diferente da esperada, ou
`Gateway/src/engine.js` ausente), o instalador falha com mensagem objetiva e não mistura
versões: é o caso de extrair o ZIP novo em outra pasta.

---

## 3. Rollback

### 3.1 Configuração (`.env`)

Cada execução cria `backups\env-<carimbo>\Gateway-.env.bak` e `Kirana-.env.bak`.
Para voltar:

```
copy backups\env-AAAAMMDD-HHMMSS\Gateway-.env.bak Gateway\.env
copy backups\env-AAAAMMDD-HHMMSS\Kirana-.env.bak  Kirana\.env
```

Confira com:

```
.\DIAGNOSTICO.cmd
```

Ou, sem serviço no ar, só a configuração:

```
node tools\checar-config.mjs
```

> Atenção: restaurar um `.env` com `KIRANA_GATEWAY_API_KEY` de outro momento pode
> divergir da chave atual do Gateway. Rode `node tools\configurar.mjs` depois, que
> realinha a partir da autoridade (`Gateway/.env`).

### 3.2 Serviços

```
.\PARAR-TUDO.cmd
```

Encerra **somente** processos iniciados por esta distribuição (três travas: pid file em
`run\`, processo vivo, linha de comando contendo o arquivo do componente). Processo de
origem desconhecida é apenas identificado, nunca encerrado.

### 3.3 Código

Extraia o ZIP anterior em **outra** pasta e copie os dois `.env` e as pastas de dados:

```
Kirana\.env  →  pasta nova\Kirana\.env
Gateway\.env →  pasta nova\Gateway\.env
Kirana\data\        →  pasta nova\Kirana\data\          (sessões, memória, RAG)
Gateway\.local-state\ → pasta nova\Gateway\.local-state\ (hostId do SIWC)
```

Depois rode `.\INSTALAR-WINDOWS.cmd` na pasta nova. Preservar `.local-state` evita perder
o `hostId` já consentido.

---

## 4. Proteção de estado e o que eu não faço

- **Não apago** `.env`, `data`, `.local-state`, `node_modules` nem backups para "passar"
  em verificação. O verificador tem um modo próprio para instalações em uso.
- **Não encerro** processo de origem desconhecida nem libero as portas 1455/3000 à força.
  Se a porta estiver ocupada, o script informa PID, executável e linha de comando e você
  decide.
- **Não varro o disco** atrás de `.env` de outros projetos. Só leio `Gateway/.env` e
  `Kirana/.env` desta pasta.
- **Não toco em tokens SIWC.** A política *memory-only* de `Gateway/src/auth.js` continua
  igual: fechar o Gateway apaga a sessão e é preciso autorizar de novo — por decisão do
  código, não por falta de persistência acidental.
- **Não mexo** em `Kirana-Arena-Bridge`, `opportunity-site-pronto` nem em repositórios de
  desenvolvimento.

## 5. Se você perdeu as instalações antigas

Não há como recuperar arquivo apagado sem backup disponível, e esta entrega não promete
isso. O que ela garante é que **o que ainda existe é preservado** e que a instalação nova
não depende de nenhuma pasta anterior: `INSTALAR-WINDOWS.cmd` funciona em pasta vazia,
com `.env` novo e chave nova.

Se você ainda tem um `.env` antigo com valores que quer reaproveitar, copie-o para a pasta
nova **antes** de rodar o instalador: ele não sobrescreve `.env` existente, apenas completa
e alinha o que falta.
