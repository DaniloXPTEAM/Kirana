#!/usr/bin/env node
/**
 * Diagnóstico do ambiente da Kirana.
 *
 * Uso: npm run doctor
 *
 * não altera nada: só verifica versão do Node, .env, chave do gateway,
 * alcance do gateway, modelos disponíveis, diretório de dados e porta.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { loadConfig, loadEnvFile, PROJECT_ROOT } from '../src/config.js';
import { createGatewayClient } from '../src/gateway.js';
import { createLogger } from '../src/logger.js';

const checks = [];
const record = (name, status, detail = '') => checks.push({ name, status, detail });

const ICONS = { ok: '✓', warn: '!', fail: '✗' };

const envPath = path.join(PROJECT_ROOT, '.env');
const loaded = loadEnvFile(envPath);
record('Arquivo .env', loaded ? 'ok' : 'fail', loaded ? envPath : 'não encontrado — copie .env.example para .env');

const config = loadConfig(process.env);
const logger = createLogger({ level: 'error', secrets: [config.gateway.apiKey] });

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
record('Node.js', major > 20 || (major === 20 && minor >= 6) ? 'ok' : 'fail', `v${process.versions.node} (necessário >= 20.6)`);

record(
  'Chave do gateway',
  config.gateway.apiKey ? 'ok' : 'fail',
  config.gateway.apiKey ? `definida (${config.gateway.apiKey.length} caracteres, valor não exibido)` : 'KIRANA_GATEWAY_API_KEY vazia',
);

try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.accessSync(config.dataDir, fs.constants.W_OK);
  record('Diretório de dados', 'ok', config.dataDir);
} catch (error) {
  record('Diretório de dados', 'fail', `sem permissão de escrita: ${error.message}`);
}

const portFree = await new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.once('listening', () => server.close(() => resolve(true)));
  server.listen(config.port, config.host);
});
record('Porta da Kirana', portFree ? 'ok' : 'warn', portFree ? `${config.host}:${config.port} livre` : `${config.host}:${config.port} já está em uso`);

if (config.gateway.apiKey) {
  const gateway = createGatewayClient({ config, logger });
  try {
    const health = await gateway.health();
    record('Gateway /health', 'ok', `${config.gateway.url} → ${JSON.stringify(health).slice(0, 120)}`);
  } catch (error) {
    record('Gateway /health', 'fail', `${config.gateway.url} → ${error.code || error.message}`);
  }

  try {
    const models = await gateway.models();
    record('Gateway /v1/models', 'ok', `${models.length} modelo(s): ${models.join(', ')}`);
    record(
      'Modelo primário',
      models.includes(config.models.primary) ? 'ok' : 'warn',
      models.includes(config.models.primary)
        ? `${config.models.primary} disponível`
        : `${config.models.primary} NÃO está na lista; fallback ${config.models.fallback}`,
    );
    record(
      'Modelo de fallback',
      models.includes(config.models.fallback) ? 'ok' : 'warn',
      models.includes(config.models.fallback) ? `${config.models.fallback} disponível` : `${config.models.fallback} não listado`,
    );
  } catch (error) {
    record('Gateway /v1/models', 'fail', `${error.code || error.message}`);
  }
} else {
  record('Gateway', 'warn', 'checagens de rede ignoradas sem chave');
}

if (!config.accessToken) record('Token de acesso local', 'warn', 'KIRANA_ACCESS_TOKEN vazio — apenas uso local, não publique');

console.log('\nDiagnóstico da Kirana\n');
for (const check of checks) {
  console.log(`  ${ICONS[check.status]} ${check.name.padEnd(24)} ${check.detail}`);
}
const failures = checks.filter((c) => c.status === 'fail').length;
console.log(
  `\n${failures === 0 ? 'Tudo pronto para rodar (npm start).' : `${failures} item(ns) precisam de atenção antes de iniciar.`}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
