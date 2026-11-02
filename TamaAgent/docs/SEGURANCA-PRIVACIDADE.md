# Segurança e privacidade — Kirana Fase 1

## 1. Princípios aplicados

1. **A chave do gateway nunca sai do backend.** `KIRANA_GATEWAY_API_KEY` é lida do `.env` em
   `src/config.js`, usada apenas em `src/gateway.js`. `/api/config` e `/api/status` devolvem só
   booleanos e nomes de modelo.
2. **Nenhum token OAuth é manipulado por este projeto.** A Kirana fala com o gateway; a
   autenticação *Sign in with ChatGPT* continua sendo responsabilidade do gateway.
3. **Redação de segredos no log.** `src/logger.js` substitui a chave, o token local, cabeçalhos
   `Bearer` e campos `api_key`/`authorization`/`token` por `[REDACTED]`.
4. **Mesma origem.** Rotas de escrita exigem `Origin` igual ao `Host`; a interface usa apenas
   caminhos relativos (`/api/...`). CSP restritiva, sem `unsafe-eval`, `connect-src 'self'`.
5. **Rate limiting** por IP nas rotas de chat e de memória (`KIRANA_RATE_LIMIT_MAX`, 20/min).
6. **Validação em duas camadas:** entrada HTTP (JSON, tamanho, tipos) e argumentos de ferramenta
   (JSON Schema + regras extras, por exemplo consentimento e formato de e-mail/WhatsApp).
7. **Sem execução arbitrária.** O modelo não tem acesso a shell, sistema de arquivos, rede ou
   interpretação de código. Só pode escolher entre as ferramentas registradas.
8. **Separação leitura/escrita.** Ferramentas de escrita nunca rodam direto: geram ação pendente
   que só executa com confirmação explícita do usuário na interface.
9. **Sem confundir chamada com execução.** A Kirana recebe um resultado estruturado
   (`aguardando_confirmacao`, `recusada_pelo_usuario`, `erro`) e as instruções de prompt proíbem
   afirmar que uma ação foi concluída sem resultado.

## 2. Dados armazenados (uso local)

| Arquivo | Conteúdo | Observação |
|---|---|---|
| `data/sessions/*.json` | Conversas completas, incluindo mensagens de ferramenta | Ficam na máquina do usuário |
| `data/memory.json` | Itens que o usuário autorizou guardar | Consentimento obrigatório + lista de bloqueio |
| `data/interests.jsonl` | Nome, empresa, canal, interesse, mensagem | `envio_externo: false` |
| Logs do console | Eventos técnicos sem conteúdo sensível | Segredos redigidos |

Bloqueios na memória: senhas, CPF/CNPJ, cartão, CVV, tokens e chaves de API são recusados por
padrão de texto. Ainda assim, a orientação do prompt é **não pedir dados sensíveis**.

Apagar conversas: botão de exclusão na barra lateral (`DELETE /api/session/:id`).
Apagar memória: painel *Memória* (`DELETE /api/memory/:id` ou `DELETE /api/memory`).

## 3. Limites explícitos

- `KIRANA_ACCESS_TOKEN` é um **token único compartilhado** para uso local — não é autenticação
  de usuários, não identifica quem fala e não serve para multiusuário.
- Não há criptografia em repouso dos arquivos de `data/`. Em máquina compartilhada, trate a pasta
  como dado pessoal.
- Não há retenção automática nem expurgo programado; a limpeza é manual.

## 4. Checklist antes de qualquer publicação

- [ ] Revisar os termos de uso aplicáveis ao *Sign in with ChatGPT* — a autorização é **pessoal**;
      não é base para oferecer inferência irrestrita a visitantes de um site público.
- [ ] Definir arquitetura multiusuário (contas, isolamento de sessão, cotas por usuário).
- [ ] Trocar armazenamento local por banco com controle de acesso e retenção definida.
- [ ] Definir política de privacidade específica do agente e base legal para tratamento (LGPD).
- [ ] Autenticação real (OAuth/sessão), não token único.
- [ ] TLS ponta a ponta; o gateway nunca exposto (`1455` continua em `127.0.0.1`).
- [ ] Rate limiting e cotas por usuário/IP no proxy reverso, além do limite interno.
- [ ] Observabilidade sem PII (métricas por turno, sem conteúdo de mensagens).
- [ ] Teste de abuso: prompt injection, tentativa de exfiltração de prompt, ferramentas de escrita
      sem confirmação, upload de conteúdo malicioso.
- [ ] Revisão de segurança independente e plano de resposta a incidentes.
- [ ] Aprovação explícita antes de publicar (a especificação exige isso na Fase F).

## 5. Prompt injection e conteúdo do usuário

- O sistema trata texto do usuário como dado, não como instrução de sistema: identidade e regras
  ficam no prompt de sistema, e a confirmação de escrita é **imposta pelo servidor**, não pelo
  prompt. Mesmo que o modelo "concorde" em gravar algo, nada é gravado sem confirmação.
- Resultados de ferramentas são truncados (`KIRANA_TOOL_RESULT_MAX_CHARS`, 4 000) e serializados
  como JSON — não como texto solto que pudesse se passar por instrução.
- O catálogo é local e somente leitura; não há *browsing* nesta fase.
- Limitações: injeção de prompt ainda pode influenciar o tom ou gerar informação incorreta. A
  contenção real vem das permissões de servidor e da confirmação, não do prompt.
