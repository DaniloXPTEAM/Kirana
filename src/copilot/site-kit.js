/**
 * Kit reutilizável por site.
 *
 * Cada site integrado tem `sites/<id>/site.json` com identidade, ações
 * permitidas, permissões, componentes de UI generativa e chaves de estado.
 *
 * Isolamento:
 *  1. O site só executa ações declaradas na PRÓPRIA configuração.
 *  2. O que vai ao modelo é a INTERSEÇÃO entre o que o widget anunciou e o
 *     que o site permite — o widget não inventa ação.
 *  3. Sessão é namespaceada por site: o mesmo threadId em dois sites gera
 *     sessões distintas (sem vazamento de histórico).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { aguiToolToOpenAi, validateToolArgs, TOOL_NAME_RE } from './tool-schema.js';

export const DEFAULT_SITE_ID = 'demo-opportunity';

export function normalizeSite(raw, { fallbackId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId;
  if (!id || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(id)) return null;

  const tools = [];
  for (const tool of Array.isArray(raw.tools) ? raw.tools : []) {
    if (!tool || typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) continue;
    tools.push({
      name: tool.name,
      description: String(tool.description || '').slice(0, 400),
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      requiresConfirmation: tool.requiresConfirmation === true,
      category: typeof tool.category === 'string' ? tool.category : 'action',
    });
  }

  return {
    id,
    name: String(raw.name || id),
    persona: String(raw.persona || 'Kirana'),
    greeting: String(raw.greeting || ''),
    identity: raw.identity && typeof raw.identity === 'object' ? raw.identity : {},
    visual: raw.visual && typeof raw.visual === 'object' ? raw.visual : {},
    features: {
      tools: raw.features?.tools !== false,
      sharedState: raw.features?.sharedState !== false,
      generativeUi: raw.features?.generativeUi !== false,
      hitl: raw.features?.hitl !== false,
    },
    tools,
    stateKeys: Array.isArray(raw.stateKeys) ? raw.stateKeys.filter((k) => typeof k === 'string').slice(0, 24) : [],
    generativeComponents: Array.isArray(raw.generativeComponents)
      ? raw.generativeComponents.filter((k) => typeof k === 'string').slice(0, 24)
      : [],
    allowedOrigins: Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.filter((o) => typeof o === 'string') : [],
  };
}

export function createSiteKit({ sitesDir, logger } = {}) {
  const log = logger?.child?.('sites') ?? logger;
  const sites = new Map();

  if (sitesDir && fs.existsSync(sitesDir)) {
    for (const entry of fs.readdirSync(sitesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(sitesDir, entry.name, 'site.json');
      if (!fs.existsSync(file)) continue;
      try {
        const site = normalizeSite(JSON.parse(fs.readFileSync(file, 'utf8')), { fallbackId: entry.name });
        if (!site) {
          log?.warn?.('Config de site inválida ignorada', { dir: entry.name });
          continue;
        }
        sites.set(site.id, site);
      } catch (error) {
        log?.warn?.('Falha ao ler config de site', { dir: entry.name, message: error?.message });
      }
    }
  }

  /**
   * Resolução ESTRITA: se um id foi informado e não existe, devolve null.
   * Cair no site padrão nesse caso misturaria clientes — o fallback só vale
   * quando NENHUM id é informado.
   */
  function resolve(siteId) {
    if (siteId === undefined || siteId === null || siteId === '') return get(null);
    return sites.get(String(siteId)) ?? null;
  }

  function get(siteId) {
    if (siteId && sites.has(siteId)) return sites.get(siteId);
    if (sites.has(DEFAULT_SITE_ID)) return sites.get(DEFAULT_SITE_ID);
    const first = sites.values().next();
    return first.done ? null : first.value;
  }

  /** Ferramentas permitidas = declared ∩ site.tools. */
  function buildExternalTools(siteId, declaredByClient = []) {
    const site = get(siteId);
    if (!site || !site.features.tools) return [];

    const allowed = new Set(site.tools.map((t) => t.name));
    const out = [];
    const seen = new Set();

    for (const declared of declaredByClient) {
      const name = typeof declared === 'string' ? declared : declared?.name;
      if (!name || !allowed.has(name) || seen.has(name)) continue;
      seen.add(name);
      const config = site.tools.find((t) => t.name === name);
      const schema = aguiToolToOpenAi({ name, description: config.description, parameters: config.parameters });
      if (!schema) continue;
      out.push({
        name,
        schema,
        requiresConfirmation: config.requiresConfirmation,
        validate: (raw) => validateToolArgs(config.parameters, raw),
      });
    }
    return out;
  }

  /** Id de sessão determinístico e isolado por site. */
  function sessionIdFor(siteId, threadId) {
    const scope = get(siteId)?.id || 'default';
    const digest = createHash('sha256').update(`${scope}::${String(threadId || 'anonymous')}`).digest('hex');
    return `s_${digest.slice(0, 40)}`;
  }

  function originAllowed(siteId, origin) {
    const site = get(siteId);
    if (!site || site.allowedOrigins.length === 0) return true;
    if (!origin) return false;
    try {
      const { host } = new URL(origin);
      return site.allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).host === host;
        } catch {
          return allowed === host;
        }
      });
    } catch {
      return false;
    }
  }

  return { get, resolve, has: (id) => sites.has(String(id ?? '')), list: () => [...sites.values()], buildExternalTools, sessionIdFor, originAllowed };
}
