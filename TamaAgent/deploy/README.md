# deploy/ — kit de produção da Kirana

Arquivos aqui **não foram executados** em nenhum servidor. São o pacote pronto
para quando você autorizar a publicação. A arquitetura e as decisões estão em
[`../docs/PRODUCAO.md`](../docs/PRODUCAO.md) — leia antes de subir.

| Arquivo | Para quê |
|---|---|
| `Dockerfile` | imagem da Kirana (Node 20, dependências de produção, usuário `node`, `/data` como volume) |
| `docker-compose.yml` | Kirana + Caddy (HTTPS automático). A porta da Kirana **não** é publicada |
| `Caddyfile` | TLS, cabeçalhos, SSE sem bufferização (`flush_interval -1`) |
| `.env.production.example` | modelo de configuração (copie para `.env.production`) |

## Passos

```bash
# 1. configurar (nada de segredo em texto versionado)
cp deploy/.env.production.example deploy/.env.production
$EDITOR deploy/.env.production        # KIRANA_ACCESS_TOKEN, KIRANA_GATEWAY_*, domínio

# 2. validar a configuração antes de subir
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production config

# 3. subir
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build

# 4. conferir
curl -fsS https://SEU_DOMINIO/health
curl -fsS "https://SEU_DOMINIO/api/copilot/info?site=opportunity-ai" | head -c 300
docker compose -f deploy/docker-compose.yml logs -f kirana
```

## Regras que o compose respeita

- **O Gateway não está aqui.** Ele é loopback-only por desenho. Se estiver no
  mesmo host, o compose o alcança por `gateway.local:host-gateway`; se estiver no
  seu PC, use um túnel privado autenticado e ajuste `KIRANA_GATEWAY_URL`.
- **Porta 1455 nunca publicada.** Nenhum `ports:` a expõe.
- **Nenhum segredo em imagem**: tudo vem de `env_file`.
- **`data/` em volume** (`kirana-data`): sessões, memória e solicitações sobrevivem
  a `up -d --build`.
- **`homologacao/`, `.git`, `.env`, `data/` locais** ficam fora da imagem.

## O que falta antes de produção de verdade

1. Rodar `homologar.bat --full` no Windows com o Gateway real (evidência sem mock).
2. Escolher o Caminho A ou C do `docs/PRODUCAO.md` (o B contraria a doc do Gateway).
3. Definir domínio, DNS e o provedor de hospedagem.
4. Decidir a voz (edge-tts não é oficial para produção → hoje o default é `disabled`).
5. Autorizar a inclusão do widget no site público.
