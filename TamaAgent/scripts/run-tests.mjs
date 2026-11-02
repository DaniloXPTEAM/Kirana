#!/usr/bin/env node
/**
 * Executor de testes multiplataforma.
 *
 * Por que existe
 * --------------
 * `node --test test/` (diretório como argumento) faz o runner tratar TODO arquivo
 * da pasta como arquivo de teste — inclusive `test/helpers.js`, que não tem
 * testes. Isso inflava a contagem em 1 (94 em vez de 93) e, no Windows com
 * Node 24, o launcher que passava a pasta produzia MODULE_NOT_FOUND.
 *
 * Aqui a lista de arquivos é resolvida com `fs` e passada explicitamente ao
 * runner, sem depender de glob do shell, de barras ou de acentos no caminho.
 *
 * Uso:
 *   node scripts/run-tests.mjs            # toda a suíte
 *   node scripts/run-tests.mjs contrato   # filtra por trecho do nome
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEST_DIR = path.join(PROJECT_ROOT, 'test');

const filter = process.argv[2] || '';

let entries = [];
try {
  entries = fs.readdirSync(TEST_DIR, { withFileTypes: true });
} catch (error) {
  console.error(`[testes] pasta de testes não encontrada: ${TEST_DIR}`);
  process.exit(1);
}

const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => (filter ? name.includes(filter) : true))
  .sort()
  .map((name) => path.join(TEST_DIR, name));

if (files.length === 0) {
  console.error(`[testes] nenhum arquivo *.test.js encontrado${filter ? ` com filtro "${filter}"` : ''} em ${TEST_DIR}`);
  process.exit(1);
}

console.log(`[testes] Node ${process.version} em ${process.platform}`);
console.log(`[testes] ${files.length} arquivo(s): ${files.map((f) => path.basename(f)).join(', ')}`);
console.log('');

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
  // Sem shell: evita diferenças de quoting entre cmd.exe e sh.
  shell: false,
});

child.on('error', (error) => {
  console.error(`[testes] falha ao iniciar o runner: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[testes] runner encerrado por sinal ${signal}`);
    process.exit(1);
  }
  // Importante: propagar o código do runner (1 quando há falha).
  process.exit(code === 0 ? 0 : code ?? 1);
});
