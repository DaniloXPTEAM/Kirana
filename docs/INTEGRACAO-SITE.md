> **Fase 4 (v0.5.0):** este documento descreve a integração da v0.3.x (widget
> CopilotKit v1 + ações de demonstração). Para o agente residente no site
> Opportunity AI — conhecimento real, contexto de página, allowlist de rotas,
> ferramentas de site e widget v2 — leia **`docs/FASE4-AUDITORIA.md`**. O que está
> aqui continua válido para os sites de demonstração.

# Integração com o site (Fase F — ainda não executada)

Este documento **não autoriza publicação**. Ele registra o caminho técnico previsto para
incorporar a Kirana em `https://opportunity.ia.br` quando a Fase 1 estiver validada e aprovada.

## 1. Situação atual

- A Kirana roda **apenas localmente** (`127.0.0.1:3000`).
- O gateway roda em `127.0.0.1:1455` e **não pode** ser exposto à internet.
- A autorização *Sign in with ChatGPT* é pessoal: não é base para servir inferência irrestrita a
  visitantes de um site público. Ver `docs/SEGURANCA-PRIVACIDADE.md`, seção 4.

## 2. Topologia recomendada

```text
visitante → HTTPS site → /kirana-api (proxy reverso) → backend Kirana (container)
                                                          ↓ rede privada
                                                   gateway autorizado
```

Regras:

1. Somente o **backend** da Kirana fica exposto, atrás de HTTPS e proxy reverso.
2. O gateway continua em rede privada (`127.0.0.1`), nunca publicado.
3. A chave do gateway continua só no backend, em variável de ambiente/secret.
4. Nada de chave ou token no bundle JavaScript.

## 3. Componente incorporável (previsto)

Sem iframe inicialmente; o mais simples é um *bundle* próprio:

```html
<!-- futuro, não publicar ainda -->
<script src="https://opportunity.ia.br/kirana/kirana-widget.js" defer></script>
<kirana-chat
  api-base="https://opportunity.ia.br/kirana-api"
  greeting="Oi! Eu sou a Kirana, assistente da Opportunity AI."
></kirana-chat>
```

Alternativas e quando usar:

| Abordagem | Prós | Contras |
|---|---|---|
| Web component + fetch | Estilo consistente, sem iframe, acessível | Precisa de CORS e CSP do site |
| iframe same-origin (`/kirana/`) | Isolamento de CSS/JS, simples de versionar | Altura dinâmica, foco e SEO pioram |
| Página dedicada (`/kirana`) | Zero integração | Não aparece no site |

Recomendação: **web component** em `kirana-widget.js`, reutilizando `public/app.js` como base,
com CSS escopado (`:host`/shadow DOM) para não colidir com o tema do site.

## 4. Ajustes necessários no backend antes de publicar

1. **Autenticação real por usuário/sessão** (o `KIRANA_ACCESS_TOKEN` atual é local).
2. **CORS explícito** para `https://opportunity.ia.br` (hoje só mesma origem).
3. **Cotas por visitante** além do rate limit por IP (ex.: 10 mensagens/hora).
4. **Armazenamento durável** (banco) com retenção definida e expurgo automático.
5. **Fila/limite de concorrência** para não saturar o gateway.
6. **Métricas** de TTFT, tempo total, erros e uso de ferramentas sem PII.
7. **Consentimento e aviso de privacidade** no primeiro uso do widget.
8. **Isolamento de sessão** por visitante (hoje, uma instalação = um conjunto de dados).

## 5. Checklist de publicação

- [ ] Fase 1 validada contra o gateway real (relatório atualizado)
- [ ] Comparação Luna x Sol concluída com dados reais
- [ ] Meta de 2 s avaliada e decisão registrada (manter ou revisar a meta)
- [ ] Revisão dos termos de uso aplicáveis à conta usada no gateway
- [ ] Arquitetura multiusuário + autenticação + cotas
- [ ] Revisão de privacidade (LGPD) e texto de consentimento
- [ ] Teste de carga e de abuso (prompt injection, spam, custo)
- [ ] Aprovação explícita da Opportunity AI
- [ ] Publicação em ambiente separado (staging) antes de produção

## 6. O que não fazer

- Não publicar `127.0.0.1:1455` em nenhum cenário.
- Não colocar a `GATEWAY_API_KEY` no frontend "só para testar".
- Não usar a conta pessoal do ChatGPT como backend de um site público sem revisar os termos.
- Não reaproveitar o gateway como API pública de terceiros.
