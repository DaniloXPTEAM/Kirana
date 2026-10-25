/**
 * Validação das ferramentas de frontend e saneamento do estado compartilhado.
 *
 * O modelo propõe argumentos; o navegador executa. Antes de entregar a
 * chamada, validamos contra o JSON Schema declarado pelo site.
 * Subconjunto suportado: object/string/number/integer/boolean/array,
 * enum, required, min/maxLength, pattern, additionalProperties.
 */

export const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;

export function aguiToolToOpenAi(tool) {
  if (!tool || typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) return null;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: String(tool.description || '').slice(0, 500) || `Ação "${tool.name}" disponível na interface.`,
      parameters:
        tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    },
  };
}

function matchesType(expected, value) {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    default: return true;
  }
}

function validateValue(schema, value, path, errors, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push({ path, message: `esperado ${types.join('|')}, recebido ${Array.isArray(value) ? 'array' : typeof value}` });
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, message: `valor fora da lista permitida (${schema.enum.join(', ')})` });
    return;
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push({ path, message: `mínimo de ${schema.minLength} caracteres` });
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push({ path, message: `máximo de ${schema.maxLength} caracteres` });
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push({ path, message: 'formato inválido' });
      } catch { /* padrão inválido na config: ignora */ }
    }
  }

  if (schema.type === 'object' || (schema.properties && value && typeof value === 'object')) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (value?.[key] === undefined || value?.[key] === null || value?.[key] === '') {
        errors.push({ path: path ? `${path}.${key}` : key, message: 'campo obrigatório' });
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value && value[key] !== undefined) validateValue(child, value[key], path ? `${path}.${key}` : key, errors, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value || {})) {
        if (!(key in properties)) errors.push({ path: path ? `${path}.${key}` : key, message: 'campo não previsto' });
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(schema.items, item, `${path}[${i}]`, errors, depth + 1));
  }
}

export function validateToolArgs(parameters, rawArgs) {
  let args = rawArgs;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) args = {};
    else {
      try {
        args = JSON.parse(trimmed);
      } catch {
        return { ok: false, args: {}, errors: [{ path: 'args', message: 'argumentos não são um JSON válido' }] };
      }
    }
  }
  if (args === null || args === undefined) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, args: {}, errors: [{ path: 'args', message: 'argumentos devem ser um objeto JSON' }] };
  }
  const errors = [];
  validateValue(parameters || { type: 'object', properties: {} }, args, '', errors);
  return { ok: errors.length === 0, args, errors };
}

const SENSITIVE_KEY_RE = /(token|senha|password|secret|api[-_]?key|authorization|cookie|cpf|cnpj|cartao|card|otp|cvv|email|telefone|whatsapp)/i;

/** Remove do estado da página tudo que não deve ir ao modelo. */
export function sanitizeSharedState(state, { maxKeys = 24, maxBytes = 4096, maxDepth = 3 } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};

  const clean = {};
  let bytes = 0;

  const walk = (value, depth) => {
    if (value === null) return null;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      // Remove e-mails/telefones que apareçam soltos em texto.
      return typeof value === 'string' ? value.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').slice(0, 300) : value;
    }
    if (Array.isArray(value)) return depth >= maxDepth ? [] : value.slice(0, 20).map((v) => walk(v, depth + 1));
    if (typeof value === 'object') {
      if (depth >= maxDepth) return {};
      const nested = {};
      for (const [k, v] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(k)) continue;
        nested[k] = walk(v, depth + 1);
      }
      return nested;
    }
    return undefined;
  };

  for (const [key, value] of Object.entries(state)) {
    if (Object.keys(clean).length >= maxKeys) break;
    if (SENSITIVE_KEY_RE.test(key)) continue;
    const walked = walk(value, 0);
    if (walked === undefined) continue;
    const size = JSON.stringify(walked)?.length ?? 0;
    if (bytes + size > maxBytes) break;
    bytes += size;
    clean[key] = walked;
  }
  return clean;
}
