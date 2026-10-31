#!/usr/bin/env node
/**
 * Atualização do conhecimento do site (Fase 4).
 *
 * Por que não "raspar o site e reescrever a base sozinho"
 * ------------------------------------------------------
 * O conhecimento é o que a Kirana pode afirmar. Se um script reescrevesse os
 * documentos automaticamente, uma mudança de layout viraria "fato novo" e a
 * Kirana passaria a afirmar coisas que ninguém revisou (e o briefing exige o
 * contrário: nada inventado). Então o script faz o trabalho seguro:
 *
 *   1. lê o sitemap e as páginas publicadas;
 *   2. compara com `site.json` (allowlist/páginas) e com a base (`knowledge/`);
 *   3. relata o que mudou: rota nova, rota removida, página sem documento,
 *      documento cuja fonte não existe mais;
 *   4. com `--write-snapshots`, salva o TEXTO bruto de cada página em
 *      `sites/<id>/snapshots/` para revisão humana (nunca em `knowledge/`).
 *
 * Uso:
 *   node scripts/site-sync.mjs                        # relatório
 *   node scripts/site-sync.mjs --check                # sai 1 se houver divergência
 *   node scripts/site-sync.mjs --write-snapshots      # salva texto para revisão
 *   node scripts/site-sync.mjs --site opportunity-ai
 *
 * Sem dependências novas: `fetch` nativo + regex de extração de texto.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const siteId = arg('site', 'opportunity-ai');
const siteDir = path.join(ROOT, 'sites', siteId);
const knowledgeDir = path.join(siteDir, 'knowledge');

function readSite() {
  const file = path.join(siteDir, 'site.json');
  if (!fs.existsSync(file)) throw new Error(`site.json não encontrado em ${siteDir}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Extrai URLs do sitemap (regex: o formato é simples e estável). */
export function parseSitemap(xml, baseUrl) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = re.exec(String(xml ?? ''))) !== null) {
    // Só entradas com esquema ou caminho absoluto viram rota.
    if (!/^https?:\/\//i.test(match[1]) && !match[1].startsWith('/')) continue;
    try {
      const parsed = new URL(match[1], baseUrl);
      const pathname = parsed.pathname || '/';
      if (!urls.includes(pathname)) urls.push(pathname);
    } catch {
      /* URL inválida: ignora */
    }
  }
  return urls;
}

/** Texto visível aproximado — serve para revisão, não para publicar. */
export function extractText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function knowledgeSources() {
  const sources = new Set();
  if (!fs.existsSync(knowledgeDir)) return sources;
  for (const name of fs.readdirSync(knowledgeDir)) {
    if (!name.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(knowledgeDir, name), 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const source = match?.[1]?.match(/^source:\s*(.+)$/m)?.[1]?.trim();
    if (source && /^https?:\/\//i.test(source)) {
      try {
        sources.add(new URL(source).pathname);
      } catch {
        /* fonte inválida: ignora */
      }
    }
  }
  return sources;
}

/**
 * Compara o site publicado com a configuração e o conhecimento.
 * Função pura (recebe os dados) — é o que os testes exercitam.
 */
export function diffSite({ publishedPaths, siteConfig, coveredPaths }) {
  const norm = (route) => String(route ?? '').replace(/\/+$/, '') || '/';
  const allowlist = new Set((siteConfig?.routes?.allowlist ?? []).map(norm));
  const published = new Set(publishedPaths.map(norm));
  const coveredRaw = [...coveredPaths]; // preserva a barra: indica "documento de grupo"

  /**
   * Um documento cobre uma página quando a fonte é a própria página, ou quando
   * é um DIRETÓRIO dela (`/labs/` cobre `/labs/kirana`). A raiz cobre só a si:
   * sem isso o documento da home "cobriria" o site inteiro.
   */
  const coveredBy = (route) => {
    const target = norm(route);
    return coveredRaw.some((source) => {
      const base = norm(source);
      if (base === target) return true;
      return base !== '/' && target.startsWith(`${base}/`);
    });
  };

  const novasRotas = [...published].filter((route) => !allowlist.has(route));
  const rotasRemovidas = [...allowlist].filter((route) => !published.has(route));
  const semDocumento = [...published].filter((route) => !coveredBy(route));
  const fontesOrfas = coveredRaw
    .map(norm)
    .filter((source) => source !== '/' && !published.has(source) && ![...published].some((route) => route.startsWith(`${source}/`)));

  return { novasRotas, rotasRemovidas, semDocumento, fontesOrfas };
}

async function main() {
  const siteConfig = readSite();
  const baseUrl = siteConfig.siteUrl ?? siteConfig.url;
  const fetchImpl = globalThis.fetch;

  const sitemapUrl = new URL('/sitemap.xml', baseUrl).toString();
  const response = await fetchImpl(sitemapUrl);
  if (!response.ok) throw new Error(`sitemap respondeu HTTP ${response.status}`);
  const publishedPaths = parseSitemap(await response.text(), baseUrl);

  const report = diffSite({ publishedPaths, siteConfig, coveredPaths: knowledgeSources() });
  const total = publishedPaths.length;

  console.log(`[site-sync] ${siteId} — ${total} rota(s) no sitemap, ${siteConfig.pages?.length ?? 0} página(s) na config`);
  const lines = [
    ['novas rotas (fora da allowlist)', report.novasRotas],
    ['rotas removidas do site', report.rotasRemovidas],
    ['páginas sem documento de conhecimento', report.semDocumento],
    ['documentos cuja fonte sumiu do site', report.fontesOrfas],
  ];
  let issues = 0;
  for (const [label, list] of lines) {
    if (!list.length) continue;
    issues += list.length;
    console.log(`  ${label}: ${list.join(', ')}`);
  }
  if (!issues) console.log('  tudo em dia: allowlist, páginas e conhecimento batem com o site');

  if (flag('write-snapshots')) {
    const outDir = path.join(siteDir, 'snapshots');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    for (const route of publishedPaths) {
      const url = new URL(route, baseUrl).toString();
      const page = await fetchImpl(url);
      if (!page.ok) {
        console.log(`  ! ${route}: HTTP ${page.status}`);
        continue;
      }
      const text = extractText(await page.text());
      const name = `${stamp}${route === '/' ? '/home' : route}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      fs.writeFileSync(path.join(outDir, `${name}.txt`), `${url}\n\n${text}\n`, 'utf8');
    }
    console.log(`  snapshots salvos em ${path.relative(ROOT, outDir)} (revisão humana; nada foi para knowledge/)`);
  }

  if (flag('check') && issues) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('site-sync.mjs')) {
  main().catch((error) => {
    console.error(`[site-sync] falhou: ${error.message}`);
    process.exit(2);
  });
}
