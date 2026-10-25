#!/usr/bin/env node
/** Build do widget (esbuild) -> public/widget/kirana-widget.js */
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const variant = process.argv.includes('--lite') ? 'lite' : 'copilotkit';
const entry = path.join(ROOT, 'widget', 'src', variant === 'lite' ? 'main-lite.jsx' : 'main.jsx');
const outfile = path.join(ROOT, 'public', 'widget', 'kirana-widget.js');

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
  format: 'iife',
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
