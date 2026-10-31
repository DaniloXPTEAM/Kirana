#!/usr/bin/env node
/**
 * Benchmark de modelos pelo gateway.
 *
 * Mede tempo até o primeiro token útil e tempo total, por modelo e cenário,
 * chamando o gateway diretamente (mesmo caminho usado pela Kirana).
 *
 * Uso:
 *   node scripts/benchmark.mjs                      # modelos do .env, 5 rodadas
 *   node scripts/benchmark.mjs --models gpt-6-luna,gpt-6.1-sol --n 10
 *   node scripts/benchmark.mjs --context            # inclui cenário com contexto
 *
 * Salva o resultado em data/benchmark-<timestamp>.json e imprime um resumo.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, loadEnvFile, PROJECT_ROOT } from '../src/config.js';
import { createGatewayClient } from '../src/gateway.js';
import { createLogger } from '../src/logger.js';

loadEnvFile(path.join(PROJECT_ROOT, '.env'));

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const config = loadConfig(process.env);
const logger = createLogger({ level: 'error', secrets: [config.gateway.apiKey] });

const models = String(getArg('models', `${config.models.primary},${config.models.fallback}`))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const rounds = Number(getArg('n', 5));
const withContext = args.includes('--context');

const PROMPTS = [
  {
    name: 'Simples',
    messages: [
      { role: 'system', content: 'Você é Kirana, assistente virtual da Opportunity AI. Responda em português brasileiro, de forma breve e natural.' },
      { role: 'user', content: 'Em duas frases, o que a Opportunity AI faz?' },
    ],
  },
];

if (withContext) {
  PROMPTS.push({
    name: 'Contexto',
    messages: [
      { role: 'system', content: 'Você é Kirana, assistente virtual da Opportunity AI. Responda em português brasileiro, de forma breve.' },
      { role: 'user', content: 'Meu nome é Ana e trabalho no atendimento de uma clínica.' },
      { role: 'assistant', content: 'Prazer, Ana! Como posso ajudar a clínica hoje?' },
      { role: 'user', content: 'Recebemos muitas dúvidas repetidas no WhatsApp fora do horário.' },
      { role: 'assistant', content: 'Entendi. Vocês têm um volume grande de perguntas iguais?' },
      { role: 'user', content: 'Sim, umas 40 por dia. O que vocês recomendam?' },
    ],
  });
}

const stats = (values) => {
  if (!values.length) return { media: null, mediana: null, p95: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    media: Math.round(sum / sorted.length),
    mediana: Math.round(sorted[Math.floor(sorted.length / 2)]),
    p95: Math.round(pick(95)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
  };
};

const gateway = createGatewayClient({ config, logger });

if (!gateway.hasKey) {
  console.error('KIRANA_GATEWAY_API_KEY não configurada. Preencha o .env antes de rodar o benchmark.');
  process.exit(1);
}

console.log(`\nBenchmark Kirana — gateway ${config.gateway.url}`);
console.log(`Modelos: ${models.join(', ')} | rodadas por cenário: ${rounds}${withContext ? ' | cenário com contexto' : ''}\n`);

const results = [];

for (const model of models) {
  for (const prompt of PROMPTS) {
    const ttfts = [];
    const totals = [];
    let ok = 0;
    let firstError = null;

    for (let i = 0; i < rounds; i += 1) {
      const startedAt = Date.now();
      try {
        const result = await gateway.chatStream({
          messages: prompt.messages,
          model,
          onDelta: () => {},
        });
        const total = Date.now() - startedAt;
        if (result.text.trim()) {
          ok += 1;
          if (Number.isFinite(result.ttftMs)) ttfts.push(result.ttftMs);
          totals.push(total);
        } else if (!firstError) {
          firstError = 'resposta vazia';
        }
      } catch (error) {
        if (!firstError) firstError = `${error.code || 'erro'}: ${error.message}`;
      }
    }

    const row = {
      model,
      cenario: prompt.name,
      rodadas: rounds,
      sucesso: ok,
      taxa_sucesso: `${Math.round((ok / rounds) * 100)}%`,
      primeiro_token: stats(ttfts),
      total: stats(totals),
      erro: firstError,
    };
    results.push(row);
    console.log(`${model} · ${prompt.name}: ${row.taxa_sucesso} de sucesso | 1º token média ${row.primeiro_token.media ?? '—'} ms (p95 ${row.primeiro_token.p95 ?? '—'}) | total média ${row.total.media ?? '—'} ms`);
  }
}

fs.mkdirSync(config.dataDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(config.dataDir, `benchmark-${stamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      geradoEm: new Date().toISOString(),
      gateway: config.gateway.url,
      ambiente: { node: process.version, plataforma: process.platform },
      modelo_primario_configurado: config.models.primary,
      modelo_fallback_configurado: config.models.fallback,
      resultados: results,
    },
    null,
    2,
  ),
);

console.log(`\nResultado salvo em ${outFile}\n`);
console.log('Observação: estes números são medições reais desta máquina e rede, não metas.');
