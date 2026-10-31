/**
 * Memória persistente opcional.
 *
 * Regras de projeto:
 * - Só guarda o que o usuário autorizou explicitamente (consentimento obrigatório).
 * - Permite consulta, correção (upsert pela chave) e exclusão.
 * - Não armazena dados sensíveis: há uma lista de bloqueio para chaves/valores
 *   que aparentem conter senha, documento, cartão ou token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BLOCKED_PATTERNS = [
  /\bsenha\b/i,
  /\bpassword\b/i,
  /\bcpf\b/i,
  /\bcnpj\b/i,
  /\bcart[ãa]o\b/i,
  /\bcvv\b/i,
  /\btoken\b/i,
  /\bapi[_-]?key\b/i,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
];

export class MemoryError extends Error {
  constructor(message, code = 'memory_error') {
    super(message);
    this.code = code;
  }
}

const normalizeKey = (key) => String(key || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);

export function createMemoryStore({ dataDir, limits = {}, logger } = {}) {
  const file = path.join(dataDir, 'memory.json');
  const maxItems = limits.maxItems ?? 40;
  const maxValueChars = 400;

  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch {
      return { version: 1, items: [] };
    }
  };

  let state = load();

  const persist = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  };

  const assertSafe = (key, value) => {
    const haystack = `${key} ${value}`;
    if (BLOCKED_PATTERNS.some((re) => re.test(haystack))) {
      throw new MemoryError('Não guardo esse tipo de informação (parece dado sensível como senha, documento ou cartão).', 'sensitive_blocked');
    }
  };

  return {
    file,

    list() {
      return state.items.map((item) => ({ ...item }));
    },

    upsert({ key, value, category = 'preferencia', source = 'user', consent = false }) {
      if (consent !== true) {
        throw new MemoryError('É necessário consentimento explícito para guardar esta informação.', 'consent_required');
      }
      const k = normalizeKey(key);
      const v = String(value ?? '').trim();
      if (!k) throw new MemoryError('Informe a chave da informação.', 'invalid_key');
      if (!v) throw new MemoryError('Informe o conteúdo da informação.', 'invalid_value');
      if (v.length > maxValueChars) throw new MemoryError(`Conteúdo acima de ${maxValueChars} caracteres.`, 'value_too_long');
      assertSafe(k, v);

      const existing = state.items.find((item) => item.key === k);
      const now = new Date().toISOString();
      if (existing) {
        existing.value = v;
        existing.category = category;
        existing.source = source;
        existing.updatedAt = now;
        persist();
        return { ...existing };
      }

      if (state.items.length >= maxItems) {
        throw new MemoryError(`Limite de ${maxItems} informações atingido. Apague algo antes de adicionar.`, 'limit_reached');
      }

      const item = {
        id: `mem_${randomUUID().slice(0, 8)}`,
        key: k,
        value: v,
        category,
        source,
        createdAt: now,
        updatedAt: now,
      };
      state.items.push(item);
      persist();
      return { ...item };
    },

    remove(id) {
      const before = state.items.length;
      state.items = state.items.filter((item) => item.id !== id);
      if (state.items.length === before) return false;
      persist();
      return true;
    },

    clear() {
      state.items = [];
      persist();
    },

    /** Bloco de memória para o prompt, com orçamento de caracteres. */
    promptItems(budgetChars = 2000) {
      const items = [];
      let used = 0;
      for (const item of state.items) {
        const cost = item.key.length + item.value.length + 4;
        if (used + cost > budgetChars) break;
        items.push(item);
        used += cost;
      }
      return items;
    },
  };
}
