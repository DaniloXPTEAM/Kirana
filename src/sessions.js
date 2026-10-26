/**
 * Sessões e histórico.
 *
 * Persistência local simples: um arquivo JSON por sessão em <dataDir>/sessions.
 * I/O síncrono de propósito: arquivos pequenos, uso local, sem corrida de escrita.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_TITLE = 70;

function makeTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Nova conversa';
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

export function createSessionStore({ dataDir, logger }) {
  const sessionsDir = path.join(dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const fileFor = (id) => path.join(sessionsDir, `${id}.json`);

  const safeId = (id) => (typeof id === 'string' && /^s_[A-Za-z0-9-]{6,64}$/.test(id) ? id : null);

  const persist = (session) => {
    session.updatedAt = new Date().toISOString();
    const tmp = `${fileFor(session.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmp, fileFor(session.id));
    return session;
  };

  const store = {
    dir: sessionsDir,

    create({ id, title, model, siteId: optsSiteId } = {}) {
      const now = new Date().toISOString();
      // `id` explícito permite sessões estáveis por thread/site (V2 CopilotKit),
      // sem alterar o comportamento de quem cria sessão aleatória.
      const explicitId = typeof id === 'string' && /^s_[A-Za-z0-9-]{6,64}$/.test(id) ? id : null;
      const session = {
        id: explicitId || `s_${randomUUID()}`,
        title: title ? makeTitle(title) : 'Nova conversa',
        createdAt: now,
        updatedAt: now,
        model: model || null,
        messages: [],
        pendingAction: null,
        // Fase 4: em qual site esta conversa acontece e qual página o visitante
        // está vendo. Persistido para o contexto sobreviver a recarregar a página.
        siteId: typeof optsSiteId === 'string' ? optsSiteId : null,
        siteState: null,
        stats: { turns: 0, aborted: 0, errors: 0, toolCalls: 0, ttftMs: [], totalMs: [] },
      };
      persist(session);
      return session;
    },

    get(id) {
      const clean = safeId(id);
      if (!clean) return null;
      try {
        const raw = fs.readFileSync(fileFor(clean), 'utf8');
        const session = JSON.parse(raw);
        session.stats = { turns: 0, aborted: 0, errors: 0, toolCalls: 0, ttftMs: [], totalMs: [], ...(session.stats || {}) };
        session.messages = Array.isArray(session.messages) ? session.messages : [];
        session.pendingAction = session.pendingAction || null;
        session.siteId = typeof session.siteId === 'string' ? session.siteId : null;
        session.siteState = session.siteState && typeof session.siteState === 'object' ? session.siteState : null;
        return session;
      } catch {
        return null;
      }
    },

    getOrCreate(id, opts = {}) {
      return store.get(id) || store.create(opts);
    },

    save(session) {
      return persist(session);
    },

    delete(id) {
      const clean = safeId(id);
      if (!clean) return false;
      try {
        fs.unlinkSync(fileFor(clean));
        return true;
      } catch {
        return false;
      }
    },

    list() {
      let files = [];
      try {
        files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      } catch {
        return [];
      }
      const summaries = [];
      for (const file of files) {
        try {
          const session = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
          if (!session?.id) continue;
          summaries.push({
            id: session.id,
            title: session.title || 'Nova conversa',
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: Array.isArray(session.messages) ? session.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length : 0,
            hasPendingAction: Boolean(session.pendingAction),
          });
        } catch {
          logger?.warn?.('Sessão ilegível ignorada', { file });
        }
      }
      return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    append(session, message) {
      const entry = {
        id: `m_${randomUUID().slice(0, 8)}`,
        at: new Date().toISOString(),
        ...message,
      };
      session.messages.push(entry);
      if (entry.role === 'user' && (session.title === 'Nova conversa' || !session.title)) {
        session.title = makeTitle(entry.content);
      }
      persist(session);
      return entry;
    },

    recordMetrics(session, { ttftMs, totalMs, aborted, error, toolCalls }) {
      session.stats.turns += 1;
      if (aborted) session.stats.aborted += 1;
      if (error) session.stats.errors += 1;
      if (toolCalls) session.stats.toolCalls += toolCalls;
      if (Number.isFinite(ttftMs)) session.stats.ttftMs.push(Math.round(ttftMs));
      if (Number.isFinite(totalMs)) session.stats.totalMs.push(Math.round(totalMs));
      session.stats.ttftMs = session.stats.ttftMs.slice(-100);
      session.stats.totalMs = session.stats.totalMs.slice(-100);
      persist(session);
    },
  };

  return store;
}

/**
 * Prepara o histórico para envio ao modelo:
 * - mantém apenas as últimas N mensagens;
 * - remove mensagens `tool` órfãs e chamadas de ferramenta sem resultado;
 * - garante que o contexto comece com uma mensagem de usuário.
 */
export function buildContextMessages(messages, limit = 24) {
  const visible = (Array.isArray(messages) ? messages : []).filter((m) => !m.hidden);
  const slice = visible.slice(-Math.max(2, limit));

  // Índices das chamadas de ferramenta que possuem resultado correspondente.
  const answeredIds = new Set(slice.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => m.toolCallId));

  const repaired = [];
  for (let i = 0; i < slice.length; i += 1) {
    const msg = slice[i];
    if (msg.role === 'tool') {
      if (!msg.toolCallId || !answeredIds.has(msg.toolCallId)) continue;
      const previous = repaired[repaired.length - 1];
      if (!previous || previous.role !== 'assistant' || !previous.toolCalls?.length) continue;
      repaired.push(msg);
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const allAnswered = msg.toolCalls.every((call) => answeredIds.has(call.id));
      if (!allAnswered) continue; // chamada pendente/sem resultado: fora do contexto
    }
    repaired.push(msg);
  }

  // O contexto precisa começar com usuário (depois da mensagem de sistema).
  while (repaired.length && repaired[0].role !== 'user') repaired.shift();
  return repaired;
}
