#!/usr/bin/env node
/** Build do widget (esbuild) -> public/widget/kirana-widget.js */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/**
 * Variantes:
 *   (padrão)     widget CopilotKit v1 -> public/widget/kirana-widget.js
 *   --lite       widget sem CopilotKit -> public/widget/kirana-widget.js
 *   --agui       widget AG-UI direto   -> public/widget/kirana-widget.js
 *   --v2         widget CopilotKit v2  -> public/widget/kirana-v2.js
 *
 * `--v2` grava em arquivo próprio de propósito: o widget v1 continua sendo o
 * que os sites de demonstração usam, e a v2 é opt-in (Fase 4) até a migração
 * da interface vanilla ser concluída.
 */
const variant = process.argv.includes('--lite') ? 'lite' : process.argv.includes('--agui') ? 'agui' : process.argv.includes('--v2') ? 'v2' : 'copilotkit';
const ENTRY = { lite: 'main-lite.jsx', agui: 'main-agui.jsx', v2: 'main-v2.jsx', copilotkit: 'main.jsx' };
const entry = path.join(ROOT, 'widget', 'src', ENTRY[variant]);
const outfile = path.join(ROOT, 'public', 'widget', variant === 'v2' ? 'kirana-v2.js' : 'kirana-widget.js');

if (!fs.existsSync(entry)) {
  console.error(`[build-widget] entrada não encontrada: ${entry}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(outfile), { recursive: true });

const started = Date.now();
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: variant === 'v2' ? 'esm' : 'iife',
  platform: 'browser',
  target: ['es2020'],
  jsx: 'automatic',
  minify: true,
  legalComments: 'none',
  loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty', '.svg': 'empty', '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'error',
});

console.log(`[build-widget] ${variant} ok em ${Date.now() - started} ms -> ${path.relative(ROOT, outfile)} (${(fs.statSync(outfile).size / 1024).toFixed(0)} KB)`);
