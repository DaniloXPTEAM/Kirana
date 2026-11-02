# Kirana — como habilitar o acesso de escrita ao GitHub

**Data:** 26/10/2026 · **Repositório:** `https://github.com/DaniloXPTEAM/Kirana`
**Estado:** leitura ✅ · escrita ❌ (nenhuma credencial nesta sessão)

---

## 1. Resposta direta

**A integração GitHub não pode ser autorizada nesta sessão.**

O conector `github` do Arena responde **`unsupported`** — ou seja, esta
instalação do Arena **não oferece** esse conector. Não é "desligado" nem
"desconectado" (casos em que bastaria você ativar/conectar na interface): é
indisponível por completo. Por isso **abrir outra sessão provavelmente não
resolve** — só resolveria se a plataforma passar a oferecer o conector.

Verificações feitas nesta sessão:

| Item | Resultado |
| --- | --- |
| Conector GitHub do Arena | `unsupported` (não oferecido) |
| `~/.git-credentials` | ausente |
| `~/.netrc` | ausente |
| `~/.config/gh/hosts.yml` | ausente |
| Chaves SSH (`~/.ssh/id_*`) | ausentes |
| Token em variável de ambiente | nenhum |
| `credential.helper` do git | nenhum (global e local) |
| CLI `gh` | ausente |
| Saída HTTPS 443 para github.com | **ok** |
| Saída SSH 22 / SSH sobre 443 | **ok** |

E há um limite estrutural: **`~/.ssh`, `~/.config` e variáveis de ambiente não
persistem** entre mensagens/sessões. Só `/home/user` (arquivos) sobrevive.

---

## 2. Mecanismos disponíveis, do mais seguro ao menos seguro

### Opção A — Push a partir da sua máquina Windows ⭐ **recomendada**

Você já autenticou nessa máquina antes (os pushes `15bb060`, `e16eb5c`,
`31c8d0e` saíram de lá). Nenhum segredo precisa ser compartilhado, nada entra no
histórico da conversa.

1. Baixe `/home/user/kirana-v0.5.1.patch` (ou o `.zip`).
2. Na sua máquina, no clone da Kirana:

```bat
git checkout main
git pull --ff-only
git apply --check kirana-v0.5.1.patch   :: valida antes de aplicar
git am kirana-v0.5.1.patch              :: OU: git am, que preserva a mensagem
:: alternativa com ZIP: descompactar sobre a árvore e commitar
git log --oneline -1                    :: deve mostrar bf4a915 (com git am)
git push origin main
git push origin v0.5.1
```

**Vantagem:** mantém a autoria/mensagem do commit, não expõe token, e você vê o
diff antes de publicar.

### Opção B — Token fine-grained temporário (somente se A não for possível)

Só faz sentido se você aceitar o risco de o token passar pela conversa. Se for
por aqui, restrinja ao máximo:

- **Fine-grained PAT**, não clássico.
- Escopo: **apenas** o repositório `DaniloXPTEAM/Kirana`.
- Permissão: **Contents → Read and write** (nada além disso: sem *Actions*,
  *Secrets*, *Administration*, *Workflows*).
- Expiração: **7 dias** (ou menos).
- **Revogar imediatamente** depois do push.

⚠️ **Risco real:** qualquer token colado no chat fica no histórico da conversa e
em logs. Mesmo revogando, o valor existiu lá. Por isso A é melhor.

### Opção C — Deploy key SSH com escrita

Funciona tecnicamente (SSH 22 e 443 abertos), mas exige colar uma **chave
privada** no chat — risco igual ou maior que B, e sem ganho. Não recomendo.

### Opção D — Nova sessão com conector GitHub

Só é útil se o seu plano/instalação do Arena **oferecer** o conector GitHub. Hoje
ele responde `unsupported`, então uma nova sessão deve repetir o resultado.

---

## 3. Permissões — o que foi possível confirmar

| Permissão | Situação |
| --- | --- |
| **Leitura** (fetch, clone, ls-remote, API) | ✅ confirmada — repo público, `git fetch` completo funciona |
| **Escrita** (push) | ❌ **não confirmada** — `git push --dry-run` → `fatal: could not read Username for 'https://github.com'` |
| Permissões da conta no repo (`admin`/`push`/`pull`) | não observáveis anonimamente; a API só as expõe a um usuário autenticado |

Na prática: **o bloqueio é de credencial, não de permissão da conta.** O `origin`
já está configurado e o caminho está pronto.

---

## 4. Re-comparação remoto × local (refeita agora, `fetch` fresco)

```
remoto (origin/main): 31c8d0e64196102816e170ec95ebf6af39be88ae   (v0.4.1)
local  (main):        bf4a9157a5a59618a21be4c50668b3f20092dfae   (v0.5.1)
```

| Verificação | Resultado |
| --- | --- |
| `origin/main` é ancestral de `main` | ✅ **SIM — fast-forward puro** |
| Commits locais à frente | **5** |
| Commits remotos à frente | **0** |
| Divergência de história | **nenhuma** |
| Conflito na simulação de merge | **nenhum** |
| Diff de conteúdo | 85 arquivos, +14.299 / −307 (apenas adição local) |

Commits pendentes, em ordem:

```
d1acdf4  v0.4.2 — motor do navegador, escolha de voz
87cd75c  v0.4.3 — fala sem markdown, identidade única, transcrição
9a371ef  v0.4.4 — barge-in ("Kirana, pare")
ead823b  v0.5.0 — Fase 4: agente residente no site
bf4a915  v0.5.1 — Fase 5: solicitações de serviço
```

Tag pendente: **`v0.5.1`** (o remoto não tem nenhuma tag).

O remoto **não mudou** desde a última verificação (`pushed_at`
`2026-10-25T14:09:36Z`) — ninguém publicou nada no intervalo.

---

## 5. O que **não** foi feito

- ❌ Nenhum push — nem de commit, nem de tag.
- ❌ Nenhum repositório criado.
- ❌ Nenhuma alteração no remoto.
- ❌ Nenhum segredo solicitado, colado ou gravado.
- ✅ Código da Kirana **intocado** (`git status` limpo, exceto documentos).
- ✅ `origin` configurado apenas no clone local (`fetch`/`push` para o repo
  existente).

---

## 6. Próximo passo

Escolha um caminho e me diga:

- **A** → você aplica o patch na sua máquina e faz o push (eu confiro o resultado
  depois, por leitura).
- **B** → você fornece um fine-grained PAT com escopo mínimo e validade curta;
  eu faço o push **somente após sua autorização explícita** e você revoga em
  seguida.
- **D** → você confere se o conector GitHub aparece nas integrações do Arena; se
  aparecer, conecte e eu refaço a verificação numa nova sessão.

Aguardo sua autorização — nada será publicado sem ela.
