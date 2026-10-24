/**
 * Registro de ferramentas da Kirana.
 *
 * Regras aplicadas aqui (servidor, nunca no modelo):
 * - schemas explícitos e validação de todos os argumentos;
 * - separação entre ferramentas de leitura e de escrita;
 * - ferramentas de escrita NÃO rodam direto: geram uma ação pendente que
 *   precisa de confirmação do usuário na interface;
 * - timeout por ferramenta e resultados sempre estruturados.
 */
import { validateJsonSchema } from '../validation.js';

export class ToolError extends Error {
  constructor(message, code = 'tool_error') {
    super(message);
    this.code = code;
  }
}

export function createToolRegistry({ tools = [], logger } = {}) {
  const byName = new Map();
  for (const tool of tools) {
    if (!tool?.name || typeof tool.handler !== 'function') {
      throw new Error('Ferramenta inválida: nome e handler são obrigatórios.');
    }
    if (byName.has(tool.name)) throw new Error(`Ferramenta duplicada: ${tool.name}`);
    byName.set(tool.name, {
      kind: 'read',
      timeoutMs: 8000,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      ...tool,
    });
  }

  const list = () => [...byName.values()];

  const api = {
    list,
    has: (name) => byName.has(name),
    get: (name) => byName.get(name) ?? null,
    readTools: () => list().filter((t) => t.kind === 'read'),
    writeTools: () => list().filter((t) => t.kind === 'write'),

    openAISchemas({ kind } = {}) {
      return list()
        .filter((tool) => (kind ? tool.kind === kind : true))
        .map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
    },

    /** Valida e normaliza argumentos de uma chamada vinda do modelo. */
    validate(name, rawArgs) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, errors: [{ path: 'tool', message: `ferramenta desconhecida: ${name}` }] };

      let args = rawArgs;
      if (typeof args === 'string') {
        try {
          args = args.trim() ? JSON.parse(args) : {};
        } catch {
          return { ok: false, errors: [{ path: 'args', message: 'argumentos não são um JSON válido' }] };
        }
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, errors: [{ path: 'args', message: 'argumentos devem ser um objeto JSON' }] };
      }

      const errors = validateJsonSchema(tool.parameters, args);
      if (tool.validate) {
        for (const extra of tool.validate(args) || []) errors.push({ path: 'args', message: extra });
      }
      return errors.length ? { ok: false, errors } : { ok: true, args };
    },

    /** Executa uma ferramenta de leitura (sempre validando os argumentos). */
    async runRead(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, error: { code: 'unknown_tool', message: `Ferramenta desconhecida: ${name}` } };
      if (tool.kind !== 'read') {
        return { ok: false, error: { code: 'confirmation_required', message: 'Esta ferramenta exige confirmação do usuário.' } };
      }
      const validation = api.validate(name, args);
      if (!validation.ok) {
        return { ok: false, error: { code: 'invalid_args', message: 'Argumentos inválidos.', details: validation.errors } };
      }
      return execute(tool, validation.args, ctx, logger);
    },

    /**
     * Executa de fato uma ferramenta de escrita.
     * Só deve ser chamada após confirmação explícita do usuário.
     */
    async runWrite(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool) return { ok: false, error: { code: 'unknown_tool', message: `Ferramenta desconhecida: ${name}` } };
      if (tool.kind !== 'write') {
        return { ok: false, error: { code: 'not_write_tool', message: 'Esta ferramenta não é de escrita.' } };
      }
      const validation = api.validate(name, args);
      if (!validation.ok) {
        return { ok: false, error: { code: 'invalid_args', message: 'Argumentos inválidos.', details: validation.errors } };
      }
      return execute(tool, validation.args, ctx, logger);
    },

    /** Descrição humana da ação pendente, mostrada na confirmação. */
    describe(name, args) {
      const tool = byName.get(name);
      if (!tool) return `Ação desconhecida: ${name}`;
      if (typeof tool.summarize === 'function') {
        try {
          return tool.summarize(args);
        } catch {
          return tool.description;
        }
      }
      return tool.description;
    },
  };

  return api;
}

async function execute(tool, args, ctx, logger) {
  const startedAt = Date.now();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ToolError('A ferramenta excedeu o tempo limite.', 'tool_timeout')), tool.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const result = await Promise.race([Promise.resolve(tool.handler(args, ctx)), timeout]);
    logger?.debug?.('Ferramenta executada', { tool: tool.name, kind: tool.kind, ms: Date.now() - startedAt, ok: true });
    return { ok: true, data: result ?? null, meta: { tool: tool.name, kind: tool.kind, ms: Date.now() - startedAt } };
  } catch (error) {
    const code = error?.code || 'tool_failed';
    const message = error instanceof ToolError ? error.message : 'A ferramenta falhou ao executar.';
    logger?.warn?.('Falha na ferramenta', { tool: tool.name, code, message, ms: Date.now() - startedAt });
    return { ok: false, error: { code, message }, meta: { tool: tool.name, kind: tool.kind, ms: Date.now() - startedAt } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
