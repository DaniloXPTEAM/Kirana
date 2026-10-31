# Imagem da Kirana para produção (Node 20 LTS slim).
#
# Por que multi-stage: o build do widget (esbuild) precisa de devDependencies;
# a imagem final só leva dependências de produção, o código e os assets.
#
# O Gateway ChatGPT local NÃO vai nesta imagem: ele é loopback-only e roda na
# máquina do dono (ou no mesmo host, por decisão explícita — ver docs/PRODUCAO.md).

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------- dependências
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --------------------------------------------------------------------- build
FROM deps AS build
# O widget já vem compilado no repositório (public/widget). Não recompilamos por
# padrão: o bundle publicado é o artefato testado. Use --build-arg BUILD_WIDGET=1
# se quiser regerar.
ARG BUILD_WIDGET=0
COPY . .
RUN if [ "$BUILD_WIDGET" = "1" ]; then node scripts/build-widget.mjs; fi
RUN node -e "import('./src/server.js').then(() => console.log('server carrega'))"

# -------------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production \
    KIRANA_HOST=0.0.0.0 \
    KIRANA_PORT=3000 \
    KIRANA_DATA_DIR=/data \
    KIRANA_LOG_LEVEL=info

# Só dependências de produção + código. Nada de .git, .env, data/ ou homologacao/.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/sites ./sites
COPY --from=build /app/scripts ./scripts
# `integrations/` fica de fora da imagem: contém o ZIP do Gateway (que não roda
# aqui) e o worker de voz, e só aumentaria a superfície do container.
COPY --from=build /app/*.md ./
COPY --from=build /app/.env.example ./

# Volume de dados: sessões, memória, interesses, solicitações e arquivos.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

# Healthcheck do próprio servidor (não chama o Gateway: só prova que respondeu).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KIRANA_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
