/**
 * Envio do formulário do site de demonstração.
 *
 * Regra de HITL no servidor (não só na tela):
 *  - `prepare` valida os dados e emite um token LIGADO ao hash dos valores.
 *    Nada é gravado.
 *  - `submit` exige token + os mesmos valores; o token é consumido no
 *    primeiro uso. Reutilizar, trocar dados ou expirar exige nova confirmação.
 */
import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60_000;
const FIELDS = ['nome', 'email', 'whatsapp', 'empresa', 'interesse', 'mensagem'];
const REQUIRED = ['nome', 'email', 'interesse', 'mensagem'];

const hashValues = (values) =>
  createHash('sha256').update(FIELDS.map((f) => `${f}=${String(values?.[f] ?? '').trim()}`).join('|')).digest('hex');

export function createDemoContact({ interests, logger, now = () => Date.now() } = {}) {
  const tokens = new Map();

  function validate(values) {
    const errors = REQUIRED.filter((k) => !String(values?.[k] ?? '').trim()).map((k) => ({ path: k, message: 'campo obrigatório' }));
    const email = String(values?.email ?? '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push({ path: 'email', message: 'e-mail inválido' });
    if (String(values?.mensagem ?? '').length > 2000) errors.push({ path: 'mensagem', message: 'mensagem longa demais' });
    return { ok: errors.length === 0, errors };
  }

  function prepare({ values } = {}) {
    const check = validate(values);
    if (!check.ok) return { ok: false, status: 400, error: 'invalid_values', message: 'Dados incompletos ou inválidos.', errors: check.errors };
    for (const [key, entry] of tokens) if (entry.expiresAt < now() || entry.used) tokens.delete(key);
    const token = `ct_${randomUUID().replace(/-/g, '')}`;
    const expiresAt = now() + TTL_MS;
    tokens.set(token, { hash: hashValues(values), expiresAt, used: false });
    logger?.debug?.('Autorização de envio preparada');
    return { ok: true, token, expiresAt, confirmationRequired: true };
  }

  function submit({ token, values } = {}) {
    const entry = typeof token === 'string' ? tokens.get(token) : null;
    if (!entry) return { ok: false, status: 409, error: 'authorization_required', message: 'É preciso uma confirmação nova para enviar este pedido.' };
    if (entry.expiresAt < now()) {
      tokens.delete(token);
      return { ok: false, status: 410, error: 'authorization_expired', message: 'A confirmação expirou. Revise os dados e confirme de novo.' };
    }
    if (entry.hash !== hashValues(values)) {
      tokens.delete(token);
      return { ok: false, status: 409, error: 'authorization_mismatch', message: 'Os dados mudaram desde a confirmação. Confirme novamente.' };
    }
    const check = validate(values);
    if (!check.ok) return { ok: false, status: 400, error: 'invalid_values', message: 'Dados incompletos ou inválidos.', errors: check.errors };

    tokens.delete(token); // uso único, consumido antes de gravar
    const record = interests.create({
      nome: String(values.nome).trim().slice(0, 80),
      empresa: values.empresa ? String(values.empresa).trim().slice(0, 100) : null,
      canal_tipo: values.whatsapp ? 'whatsapp' : 'email',
      canal_valor: String(values.whatsapp || values.email).trim().slice(0, 80),
      email: String(values.email).trim().slice(0, 160),
      interesse: String(values.interesse).trim().slice(0, 200),
      mensagem: values.mensagem ? String(values.mensagem).trim().slice(0, 1000) : null,
      consentimento: true,
      origem: 'site_demonstracao_copilotkit',
    });
    return { ok: true, protocolo: record.protocolo, criadoEm: record.criadoEm, stored: true };
  }

  return { prepare, submit, validate };
}
