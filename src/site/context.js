/**
 * Contexto do site integrado (Fase 4).
 *
 * Responsabilidades — e o que DELIBERADAMENTE não é feito aqui:
 *  - resolver qual site está atendendo (a config vem de `sites/<id>/site.json`);
 *  - validar rotas contra a lista permitida (nada de navegação arbitrária);
 *  - traduzir "página atual" informada pelo navegador em um objeto conhecido;
 *  - carregar o conhecimento do site com cache e recarga.
 *
 * Não monta HTML, não executa navegação e não decide o que o modelo responde:
 * navegação é executada pelo navegador (ver `public/site-agent.js`), e o texto é
 * do modelo, sempre a partir das ferramentas.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadKnowledge } from '../knowledge/index.js';

/** Normaliza caminho de site: começa com `/`, sem `..`, sem query/hash. */
export function normalizePath(raw) {
  const rawValue = String(raw ?? '').trim();
  if (!rawValue) return '';
  // Query e hash não fazem parte do caminho: `?utm=...` não pode virar 404 nem
  // entrar na comparação com a allowlist.
  const cut = rawValue.split(/[?#]/)[0];
  let value = cut.startsWith('/') ? cut : `/${cut}`;
  // `..` e `%2e%2e` não podem sobreviver a esta função.
  if (/\.\.|%2e/i.test(value)) return '';
  value = value.replace(/\/{2,}/g, '/');
  return value;
}

/**
 * Compara caminhos ignorando a barra final.
 *
 * O site publicado usa `/solucoes/` (com barra) e `/solucoes/agentes-ia` (sem).
 * A allowlist guarda a forma canônica do sitemap; a comparação usa a forma
 * normalizada para não recusar `/solucoes` quando o visitante digita assim.
 */
export function samePath(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  // Caminho inválido (vazio, travessia, query só) não é igual a nada — nem a
  // outro caminho inválido. Sem isso, `/..` normalizava para '' e casava com a
  // home, porque a barra final era descartada dos dois lados.
  if (!left || !right) return false;
  const clean = (value) => value.replace(/\/$/, '') || '/';
  return clean(left) === clean(right);
}

export function createSiteContext({ siteKit, sitesDir, logger, now = () => Date.now() } = {}) {
  const log = logger?.child?.('site') ?? logger;
  const knowledgeCache = new Map(); // siteId -> { knowledge, loadedAt }

  function site(siteId) {
    if (!siteKit) return null;
    // `resolve('')` devolve o site padrão do kit; aqui, site vazio é ausência de
    // site. Sem isso, uma sessão sem siteId herdaria o site de outro cliente.
    if (!siteId || typeof siteId !== 'string') return null;
    return siteKit.resolve(siteId) ?? null;
  }

  /** Diretório do site no disco (para conhecimento e snapshot). */
  function siteDir(siteId) {
    const resolved = site(siteId);
    if (!resolved || !sitesDir) return null;
    return path.join(sitesDir, resolved.id);
  }

  /** Conhecimento (carregado sob demanda e mantido em cache). */
  function knowledgeFor(siteId, { force = false } = {}) {
    const resolved = site(siteId);
    if (!resolved) return null;
    const dir = path.join(siteDir(resolved.id) ?? '', resolved.knowledgeDir || 'knowledge');
    const cached = knowledgeCache.get(resolved.id);
    if (!force && cached && cached.dir === dir) return cached.knowledge;
    const knowledge = loadKnowledge({ dir, logger: log });
    knowledgeCache.set(resolved.id, { knowledge, loadedAt: now(), dir });
    return knowledge;
  }

  /**
   * Recarrega o conhecimento se algum arquivo mudou.
   *
   * É o gancho da "atualização automática": o servidor chama isto por turno
   * (barato: só `stat`) e o conhecimento novo entra sem reiniciar o processo.
   * `scripts/site-sync.mjs` é quem traz o conteúdo atualizado do site.
   */
  function refreshIfStale(siteId) {
    const resolved = site(siteId);
    if (!resolved) return false;
    const dir = path.join(siteDir(resolved.id) ?? '', resolved.knowledgeDir || 'knowledge');
    if (!dir || !fs.existsSync(dir)) return false;
    const cached = knowledgeCache.get(resolved.id);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    const newest = files.reduce((latest, name) => {
      try {
        return Math.max(latest, fs.statSync(path.join(dir, name)).mtimeMs);
      } catch {
        return latest;
      }
    }, 0);
    const known = cached?.knowledge?.chunks?.reduce((latest, chunk) => Math.max(latest, chunk.mtimeMs ?? 0), 0) ?? 0;
    if (!cached || newest > known) {
      knowledgeCache.delete(resolved.id);
      knowledgeFor(resolved.id);
      log?.info?.('Conhecimento do site recarregado', { siteId: resolved.id, files: files.length });
      return true;
    }
    return false;
  }

  /** Rotas permitidas do site (allowlist do sitemap). */
  function allowedRoutes(resolved) {
    return resolved?.routes?.allowlist ?? [];
  }

  /**
   * A rota pode ser navegada?
   *
   * Regras (todas necessárias):
   *  1. caminho interno começando com `/`;
   *  2. sem `..`, `://`, javascript:, data:;
   *  3. presente na allowlist do site.
   */
  function canNavigate(siteId, rawPath) {
    const resolved = site(siteId);
    const clean = normalizePath(rawPath);
    if (!resolved) return { ok: false, reason: 'unknown_site', path: clean };
    if (!clean) return { ok: false, reason: 'invalid_path', path: clean };
    if (/^(?:[a-z]+:)?\/\//i.test(rawPath) || /^(?:javascript|data|file):/i.test(String(rawPath ?? '').trim())) {
      return { ok: false, reason: 'external_url', path: clean };
    }
    const list = allowedRoutes(resolved);
    if (!list.length) return { ok: false, reason: 'no_allowlist', path: clean };
    if (!list.some((route) => samePath(route, clean))) return { ok: false, reason: 'not_allowed', path: clean };
    const canonical = list.find((route) => samePath(route, clean));
    return { ok: true, path: canonical };
  }

  /** Página conhecida por id, caminho ou alias ("solucoes", "inicio", "crm"). */
  function resolvePage(siteId, { pageId, path: rawPath } = {}) {
    const resolved = site(siteId);
    if (!resolved) return null;
    const pages = resolved.pages ?? [];
    if (rawPath) {
      const clean = normalizePath(rawPath);
      const byPath = pages.find((page) => samePath(page.path, clean));
      if (byPath) return byPath;
    }
    if (pageId) {
      const key = String(pageId)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      const byId = pages.find((page) => page.id === key);
      if (byId) return byId;
      const byAlias = pages.find((page) => (page.aliases ?? []).some((alias) => alias === key));
      if (byAlias) return byAlias;
      const byTitle = pages.find((page) => page.title.toLowerCase().includes(key));
      if (byTitle) return byTitle;
    }
    return null;
  }

  /** Página inicial declarada (fallback quando o navegador não informou nada). */
  function defaultPage(siteId) {
    const resolved = site(siteId);
    return (resolved?.pages ?? []).find((page) => page.path === '/') ?? (resolved?.pages ?? [])[0] ?? null;
  }

  /**
   * Contexto atual, sempre validado.
   *
   * O navegador pode informar qualquer coisa; o que vale é o que existe na
   * configuração. Caminho desconhecido vira `unmatched` com o caminho normalizado,
   * e a Kirana diz que não conhece aquela página em vez de inventar.
   */
  function currentContext(siteId, state = {}) {
    const resolved = site(siteId);
    if (!resolved) return { site: null, page: null, matched: false, path: normalizePath(state.path) };
    const informed = normalizePath(state.path || state.pagePath || '');
    const page = resolvePage(resolved.id, { pageId: state.pageId, path: informed }) ?? null;
    const service = page?.serviceId ? knowledgeFor(resolved.id)?.serviceDoc(page.serviceId) : null;
    if (page) {
      return {
        site: { id: resolved.id, name: resolved.name, url: resolved.siteUrl ?? null, agentName: resolved.agentName ?? resolved.persona },
        page: { id: page.id, path: page.path, title: page.title, summary: page.summary ?? '' },
        service: service ? { serviceId: service.serviceId, title: service.title, path: service.path } : null,
        matched: true,
        path: page.path,
        informedPath: informed || null,
      };
    }
    const fallback = informed ? null : defaultPage(resolved.id);
    return {
      site: { id: resolved.id, name: resolved.name, url: resolved.siteUrl ?? null, agentName: resolved.agentName ?? resolved.persona },
      page: fallback ? { id: fallback.id, path: fallback.path, title: fallback.title, summary: fallback.summary ?? '' } : informed ? { id: null, path: informed, title: 'página não catalogada', summary: '' } : null,
      service: null,
      matched: Boolean(fallback),
      path: fallback ? fallback.path : informed,
      informedPath: informed || null,
    };
  }

  return {
    site,
    siteDir,
    knowledgeFor,
    refreshIfStale,
    allowedRoutes,
    canNavigate,
    resolvePage,
    defaultPage,
    currentContext,
    list: () => siteKit?.list?.() ?? [],
    _cache: knowledgeCache,
  };
}
