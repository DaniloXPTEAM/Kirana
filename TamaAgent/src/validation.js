/**
 * Validador mínimo de JSON Schema para argumentos de ferramentas.
 * Suporta: type, required, properties, additionalProperties, enum,
 * minLength/maxLength, pattern, minimum/maximum, items, minItems/maxItems.
 */
export function validateJsonSchema(schema, value, path = 'args') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  const typeOk = (expected) => {
    switch (expected) {
      case 'object':
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'array':
        return Array.isArray(value);
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return Number.isInteger(value);
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'null':
        return value === null;
      default:
        return true;
    }
  };

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(typeOk)) {
      errors.push({ path, message: `esperado ${types.join('|')}, recebido ${describe(value)}` });
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `valor deve ser um de: ${schema.enum.join(', ')}` });
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (schema.minLength !== undefined && trimmed.length < schema.minLength) {
      errors.push({ path, message: `mínimo de ${schema.minLength} caracteres` });
    }
    if (schema.maxLength !== undefined && trimmed.length > schema.maxLength) {
      errors.push({ path, message: `máximo de ${schema.maxLength} caracteres` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(trimmed)) {
      errors.push({ path, message: 'formato inválido' });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `mínimo ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `máximo ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `mínimo de ${schema.minItems} itens` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `máximo de ${schema.maxItems} itens` });
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateJsonSchema(schema.items, item, `${path}[${index}]`)));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === '') {
        errors.push({ path: `${path}.${key}`, message: 'campo obrigatório' });
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) errors.push(...validateJsonSchema(subSchema, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push({ path: `${path}.${key}`, message: 'campo não permitido' });
      }
    }
  }

  return errors;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
