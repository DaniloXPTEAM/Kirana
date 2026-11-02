/**
 * Solicitações de serviço (Fase 5) — rascunho, estado e histórico.
 *
 * Por que um store separado da sessão
 * -----------------------------------
 * A sessão guarda a conversa; a solicitação guarda **a tarefa**. São ciclos de
 * vida diferentes: a conversa continua depois que a solicitação é enviada ou
 * cancelada, e a solicitação sobrevive a recarregar a página (o navegador pode
 * informar só o `sessionId`).
 *
 * Garantias implementadas aqui (todas testadas):
 *  - **isolamento por sessão**: `get(id, sessionId)` devolve `null` se o dono não
 *    confere — nenhuma rota consegue ler rascunho de outra sessão;
 *  - **uma solicitação ativa por sessão**: `create` rejeita a segunda enquanto a
 *    primeira não estiver `submitted`/`cancelled`/`failed`;
 *  - **máquina de estados explícita**: transição fora do mapa é recusada;
 *  - **prevenção de envio duplicado**: `submitting` é exclusivo e `submitted` é
 *    final; dois `submit` simultâneos não viram dois envios;
 *  - **histórico auditável**: cada ação autorizada entra em `history` com hora.
 *
 * Persistência: um JSON por solicitação em `<dataDir>/requests`. A mesma
 * disciplina do resto do projeto (I/O síncrono, arquivos pequenos, escrita
 * atômica via rename).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Estados da tarefa (item 7 do briefing). */
export const REQUEST_STATES = Object.freeze({
  draft: 'draft',
  collecting: 'collecting_information',
  waitingUpload: 'waiting_for_upload',
  validating: 'validating',
  waitingApproval: 'waiting_for_approval',
  submitting: 'submitting',
  submitted: 'submitted',
  failed: 'failed',
  cancelled: 'cancelled',
});

export const ALL_STATES = Object.freeze(Object.values(REQUEST_STATES));

/** Id de sessão aceitável — mesma regra usada em todo o store. */
export const isSessionId = (value) => SESSION_RE.test(String(value ?? ''));

/**
 * Transições permitidas.
 *
 * Ler a tabela responde "o que pode acontecer agora?" — e é o que impede, por
 * exemplo, `submitted` voltar para `draft` e ser reenviado.
 */
const TRANSITIONS = Object.freeze({
  draft: ['collecting_information', 'waiting_for_upload', 'validating', 'cancelled'],
  collecting_information: ['collecting_information', 'waiting_for_upload', 'validating', 'cancelled'],
  waiting_for_upload: ['collecting_information', 'waiting_for_upload', 'validating', 'cancelled'],
  validating: ['validating', 'waiting_for_approval', 'collecting_information', 'cancelled'],
  waiting_for_approval: ['waiting_for_approval', 'submitting', 'collecting_information', 'cancelled'],
  submitting: ['submitted', 'failed'],
  submitted: ['cancelled'], // só com operação externa real (ver submit/cancel)
  // Depois de uma falha, tentar de novo é legítimo (inclusive reenviar).
  failed: ['validating', 'collecting_information', 'waiting_for_approval', 'submitting', 'cancelled'],
  cancelled: [], // final
});

/** Estados em que a solicitação ainda pode ser alterada. */
const EDITABLE = new Set([
  REQUEST_STATES.draft,
  REQUEST_STATES.collecting,
  REQUEST_STATES.waitingUpload,
  REQUEST_STATES.validating,
  REQUEST_STATES.waitingApproval,
  REQUEST_STATES.failed,
]);

const ACTIVE = new Set([
  REQUEST_STATES.draft,
  REQUEST_STATES.collecting,
  REQUEST_STATES.waitingUpload,
  REQUEST_STATES.validating,
  REQUEST_STATES.waitingApproval,
]);

const ID_RE = /^REQ-\d{4}-[A-Z0-9]{6}$/;
const SESSION_RE = /^s_[A-Za-z0-9-]{6,64}$/;

export function isValidRequestId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function newId() {
  return `REQ-${new Date().getFullYear()}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/** Remove chaves perigosas e limita tamanho — dados vêm do visitante. */
export function sanitizeData(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-z0-9_]{2,40}$/i.test(key)) continue; // sem `__proto__`, sem espaço
    if (value == null) continue;
    if (typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      const clean = value.trim();
      if (clean) out[key] = clean.slice(0, 2000);
    }
  }
  return out;
}

export function createRequestStore({ dataDir, logger, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('createRequestStore exige dataDir');
  const dir = path.join(dataDir, 'requests');
  fs.mkdirSync(dir, { recursive: true });
  const log = logger?.child?.('requests') ?? logger;
  const fileFor = (id) => path.join(dir, `${id}.json`);

  const persist = (request) => {
    request.updatedAt = now().toISOString();
    const tmp = `${fileFor(request.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(request, null, 2), 'utf8');
    fs.renameSync(tmp, fileFor(request.id));
    return request;
  };

  const read = (id) => {
    if (!isValidRequestId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
    } catch {
      return null;
    }
  };

  const history = (request, entry) => {
    request.history = Array.isArray(request.history) ? request.history : [];
    request.history.push({ at: now().toISOString(), ...entry });
    // Histórico não é log de depuração: guarda a decisão, não o conteúdo bruto.
    if (request.history.length > 60) request.history = request.history.slice(-60);
    return request;
  };

  const api = {
    dir,

    /**
     * Cria um rascunho.
     *
     * `sessionId` é obrigatório: sem dono não há isolamento. A regra de uma
     * solicitação ativa por sessão existe para o visitante não terminar com dois
     * pedidos concorrentes sem saber qual está preenchendo.
     */
    create({ sessionId, siteId, serviceId, serviceTitle = null }) {
      if (!SESSION_RE.test(String(sessionId ?? ''))) {
        return { ok: false, error: { code: 'invalid_session', message: 'Sessão inválida.' } };
      }
      if (!serviceId || typeof serviceId !== 'string') {
        return { ok: false, error: { code: 'invalid_service', message: 'Informe o serviço.' } };
      }
      const existing = api.activeFor(sessionId);
      if (existing) {
        return {
          ok: false,
          error: {
            code: 'request_already_active',
            message: `Já existe uma solicitação em andamento nesta conversa (${existing.id}). Continue nela ou cancele antes de abrir outra.`,
          },
          request: api.get(existing.id, sessionId),
        };
      }
      const at = now().toISOString();
      const request = {
        id: newId(),
        sessionId,
        siteId: siteId ?? null,
        serviceId,
        serviceTitle,
        state: REQUEST_STATES.draft,
        data: {},
        files: [],
        history: [],
        createdAt: at,
        updatedAt: at,
        submittedAt: null,
        externalId: null,
        lastError: null,
      };
      history(request, { action: 'created', to: REQUEST_STATES.draft, actor: 'kirana' });
      persist(request);
      log?.info?.('Rascunho de solicitação criado', { id: request.id, siteId: request.siteId, serviceId });
      return { ok: true, request };
    },

    /** Leitura com verificação de dono — nunca devolve rascunho de outra sessão. */
    get(id, sessionId) {
      const request = read(id);
      if (!request) return null;
      if (sessionId !== undefined && request.sessionId !== sessionId) return null;
      return request;
    },

    /** Solicitação ativa da sessão (se houver). */
    activeFor(sessionId) {
      if (!SESSION_RE.test(String(sessionId ?? ''))) return null;
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return null;
      }
      for (const name of names) {
        const request = read(name.replace(/\.json$/, ''));
        if (!request || request.sessionId !== sessionId) continue;
        if (ACTIVE.has(request.state)) return request;
      }
      return null;
    },

    list(sessionId) {
      if (!SESSION_RE.test(String(sessionId ?? ''))) return [];
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
      } catch {
        return [];
      }
      return names
        .map((name) => read(name.replace(/\.json$/, '')))
        .filter((request) => request && request.sessionId === sessionId)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    /**
     * Atualiza dados preservando o que já existe.
     *
     * `replace` serve para correção: o visitante disse o e-mail errado e o novo
     * valor precisa sobrescrever, sem apagar o resto.
     */
    update(id, sessionId, { data, replace = false, state, note = null } = {}) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada nesta conversa.' } };
      if (!EDITABLE.has(request.state)) {
        return { ok: false, error: { code: 'request_closed', message: `A solicitação está em ${request.state} e não aceita mais alterações.` } };
      }
      if (data) {
        const clean = sanitizeData(data);
        request.data = replace ? clean : { ...request.data, ...clean };
        history(request, { action: 'data_updated', fields: Object.keys(clean), actor: 'kirana' });
      }
      if (state && state !== request.state) {
        const moved = api.transition(request, state, { actor: 'kirana', note });
        if (!moved.ok) return moved;
        return { ok: true, request: moved.request };
      }
      persist(request);
      return { ok: true, request };
    },

    /** Transição validada pela tabela. */
    transition(request, to, { actor = 'kirana', note = null } = {}) {
      if (!ALL_STATES.includes(to)) {
        return { ok: false, error: { code: 'invalid_state', message: `Estado desconhecido: ${to}` } };
      }
      const allowed = TRANSITIONS[request.state] ?? [];
      if (!allowed.includes(to)) {
        return {
          ok: false,
          error: {
            code: 'invalid_transition',
            message: `Não é possível passar de ${request.state} para ${to}.`,
            allowed,
          },
        };
      }
      const from = request.state;
      request.state = to;
      history(request, { action: 'state_changed', from, to, actor, ...(note ? { note } : {}) });
      persist(request);
      return { ok: true, request };
    },

    /** Estado "reservado" para envio — garante que dois envios não coexistam. */
    beginSubmit(id, sessionId) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada nesta conversa.' } };
      if (request.state === REQUEST_STATES.submitted) {
        return { ok: false, error: { code: 'already_submitted', message: 'Esta solicitação já foi enviada.', request } };
      }
      if (request.state === REQUEST_STATES.submitting) {
        return { ok: false, error: { code: 'submit_in_progress', message: 'O envio desta solicitação já está em andamento.' } };
      }
      if (request.state !== REQUEST_STATES.waitingApproval && request.state !== REQUEST_STATES.failed) {
        return {
          ok: false,
          error: { code: 'not_ready', message: `Só é possível enviar uma solicitação validada (estado atual: ${request.state}).` },
        };
      }
      return api.transition(request, REQUEST_STATES.submitting, { actor: 'sistema', note: 'envio autorizado pelo visitante' });
    },

    completeSubmit(id, sessionId, { externalId = null } = {}) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada.' } };
      const moved = api.transition(request, REQUEST_STATES.submitted, { actor: 'sistema', note: 'backend confirmou o envio' });
      if (!moved.ok) return moved;
      moved.request.submittedAt = now().toISOString();
      moved.request.externalId = externalId;
      persist(moved.request);
      return { ok: true, request: moved.request };
    },

    failSubmit(id, sessionId, error) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada.' } };
      const moved = api.transition(request, REQUEST_STATES.failed, { actor: 'sistema', note: error?.code ?? 'falha' });
      if (!moved.ok) return moved;
      moved.request.lastError = { code: error?.code ?? 'submit_failed', message: String(error?.message ?? 'Falha no envio.').slice(0, 300) };
      persist(moved.request);
      return { ok: true, request: moved.request };
    },

    cancel(id, sessionId, { reason = null } = {}) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada nesta conversa.' } };
      if (request.state === REQUEST_STATES.cancelled) {
        return { ok: true, request, alreadyCancelled: true };
      }
      if (request.state === REQUEST_STATES.submitting) {
        return { ok: false, error: { code: 'submit_in_progress', message: 'O envio está em andamento; aguarde o resultado.' } };
      }
      if (request.state === REQUEST_STATES.submitted) {
        return {
          ok: false,
          error: {
            code: 'cancel_needs_backend',
            message: 'A solicitação já foi enviada. Cancelar depois do envio exige uma operação no backend da Opportunity AI, que não está configurada.',
          },
        };
      }
      const moved = api.transition(request, REQUEST_STATES.cancelled, { actor: 'visitante', note: reason });
      if (!moved.ok) return moved;
      // Cancelar descarta de verdade: os dados do visitante e a lista de
      // arquivos saem do registro (o disco é limpo por quem chamou). O
      // histórico guarda o que aconteceu, não o conteúdo.
      moved.request.data = {};
      moved.request.files = [];
      history(moved.request, { action: 'data_discarded', actor: 'sistema' });
      persist(moved.request);
      return moved;
    },

    /**
     * Anexa um arquivo já validado pelo `fileStore`.
     *
     * O store não lê bytes: só guarda metadados (id, nome, tamanho, expiração).
     * O caminho em disco nunca é exposto — a leitura sempre reconstitui o
     * caminho a partir do id.
     */
    addFile(id, sessionId, file) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada nesta conversa.' } };
      if (!EDITABLE.has(request.state)) {
        return { ok: false, error: { code: 'request_closed', message: `A solicitação está em ${request.state} e não aceita arquivos.` } };
      }
      if (!file?.id) return { ok: false, error: { code: 'invalid_file', message: 'Arquivo sem identificador.' } };
      request.files = [...(request.files ?? []), file];
      history(request, { action: 'file_added', fileId: file.id, name: file.name, size: file.size, actor: 'visitante' });
      if (request.state !== REQUEST_STATES.waitingUpload && (TRANSITIONS[request.state] ?? []).includes(REQUEST_STATES.waitingUpload)) {
        const from = request.state;
        request.state = REQUEST_STATES.waitingUpload;
        history(request, { action: 'state_changed', from, to: REQUEST_STATES.waitingUpload, actor: 'sistema' });
      }
      persist(request);
      return { ok: true, request };
    },

    removeFile(id, sessionId, fileId) {
      const request = api.get(id, sessionId);
      if (!request) return { ok: false, error: { code: 'request_not_found', message: 'Solicitação não encontrada nesta conversa.' } };
      if (!EDITABLE.has(request.state)) {
        return { ok: false, error: { code: 'request_closed', message: `A solicitação está em ${request.state} e não aceita alterações.` } };
      }
      const file = (request.files ?? []).find((item) => item.id === fileId);
      if (!file) return { ok: false, error: { code: 'file_not_found', message: 'Arquivo não encontrado nesta solicitação.' } };
      request.files = request.files.filter((item) => item.id !== fileId);
      history(request, { action: 'file_removed', fileId, actor: 'visitante' });
      persist(request);
      return { ok: true, request, file };
    },

    canEdit: (request) => Boolean(request && EDITABLE.has(request.state)),
    isActive: (request) => Boolean(request && ACTIVE.has(request.state)),
    transitionsFor: (state) => [...(TRANSITIONS[state] ?? [])],
  };

  return api;
}
