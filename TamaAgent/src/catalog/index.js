/** Carrega os catálogos locais (JSON) uma única vez por processo. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_DIR = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED = ['services.json', 'products.json', 'projects.json', 'opportunity-ai.json'];

export function loadCatalog({ dir = CATALOG_DIR, logger } = {}) {
  const read = (name) => {
    const full = path.join(dir, name);
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      logger?.warn?.(`Catálogo não carregado: ${name}`, { error: error.message });
      return null;
    }
  };

  const services = read('services.json');
  const products = read('products.json');
  const projects = read('projects.json');
  const institution = read('opportunity-ai.json');
  const missing = REQUIRED.filter((name) => !read(name));
  if (missing.length) logger?.warn?.('Catálogos ausentes', { missing });

  return {
    services: services?.services ?? [],
    products: products?.products ?? [],
    projects: projects?.projects ?? [],
    institution,
    meta: {
      version: services?.version || products?.version || 'desconhecida',
      verifiedAt: services?.verifiedAt || products?.verifiedAt || null,
      sources: [services?.fonte, products?.fonte].filter(Boolean),
    },
  };
}
