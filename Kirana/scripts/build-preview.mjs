#!/usr/bin/env node
/**
 * Gera docs/preview-interface.html: uma imagem estática (HTML autocontido) da
 * interface, com uma conversa de exemplo, para revisão de design sem precisar
 * subir o backend. Não é a aplicação: a aplicação real é servida por src/server.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';

const html = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'styles.css'), 'utf8');

const demo = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'preview-demo.html'), 'utf8');

let output = html
  .replace(/<link rel="stylesheet" href="\/styles.css" \/>/, `<style>\n${css}\n</style>`)
  .replace(/<link rel="icon"[^>]*>/, '')
  .replace(/<script type="module" src="\/app.js"><\/script>/, demo)
  .replace('<title>Kirana · Opportunity AI</title>', '<title>Prévia da interface · Kirana</title>');

const outFile = path.join(PROJECT_ROOT, 'docs', 'preview-interface.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output, 'utf8');
console.log(`Prévia gerada em ${outFile} (${(output.length / 1024).toFixed(1)} kB)`);
