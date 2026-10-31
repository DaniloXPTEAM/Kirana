/**
 * Upload de arquivos para a solicitação (Fase 5, item 5.4).
 *
 * Política aplicada — e por quê
 * -----------------------------
 *  - **lista de tipos permitida** (extensão + tipo declarado + assinatura do
 *    arquivo). Só extensão não basta: `virus.exe` renomeado para `.pdf` cai na
 *    checagem de assinatura;
 *  - **limite de tamanho** por arquivo e por solicitação, conferido no corpo
 *    antes de gravar;
 *  - **nome saneado** e nenhum caminho vindo do visitante vira caminho de disco;
 *  - **nada é executado**: o arquivo é gravado como bytes opacos, sem
 *    interpretação, e servido depois como download (`attachment`), nunca inline;
 *  - **isolamento**: pasta por solicitação, e a leitura sempre passa pela
 *    verificação de dono da solicitação (`sessionId`);
 *  - **expiração**: cada arquivo carrega `expiresAt` (política de retenção) e
 *    `purgeExpired()` apaga o que venceu. A Fase 5 usa 30 dias, declarado em
 *    `site.json → uploads.retentionDays`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Tipos aceitos: extensão → { mime, assinaturas possíveis }. */
export const ALLOWED_TYPES = Object.freeze({
  pdf: { mimes: ['application/pdf'], magic: [[0x25, 0x50, 0x44, 0x46]] }, // %PDF
  png: { mimes: ['image/png'], magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mimes: ['image/jpeg'], magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mimes: ['image/jpeg'], magic: [[0xff, 0xd8, 0xff]] },
  webp: { mimes: ['image/webp'], magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF
  txt: { mimes: ['text/plain'], magic: null },
  csv: { mimes: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], magic: null },
  docx: {
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    magic: [[0x50, 0x4b, 0x03, 0x04]], // ZIP
  },
  xlsx: {
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
  },
});

/** Extensões que nunca entram, mesmo com assinatura válida. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'ps1', 'sh', 'js', 'mjs', 'jsx', 'ts', 'php', 'py',
  'jar', 'apk', 'dll', 'so', 'vbs', 'wsf', 'hta', 'cpl', 'reg', 'html', 'htm', 'svg', 'xhtml',
]);

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_FILES = 5;
const DEFAULT_RETENTION_DAYS = 30;

/** Nome seguro para exibição/download — nunca usado como caminho literal. */
export function safeFileName(raw) {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/')).normalize('NFC');
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/^\.+/, '').trim();
  return clean.slice(0, 120) || 'arquivo';
}

export function extensionOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : '';
}

function matchesMagic(buffer, magic) {
  if (!magic) return true;
  return magic.some((bytes) => bytes.every((byte, index) => buffer[index] === byte));
}

/**
 * Valida um upload antes de qualquer gravação.
 *
 * @returns {{ok:true, meta:object} | {ok:false, code:string, message:string}}
 */
export function validateUpload({
  filename,
  contentType,
  buffer,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  currentCount = 0,
  allowedExtensions = Object.keys(ALLOWED_TYPES),
}) {
  const name = safeFileName(filename);
  const ext = extensionOf(name);

  if (!buffer || !buffer.length) {
    return { ok: false, code: 'empty_file', message: 'O arquivo está vazio.' };
  }
  if (buffer.length > maxBytes) {
    return {
      ok: false,
      code: 'file_too_large',
      message: `O arquivo tem ${(buffer.length / 1024 / 1024).toFixed(1)} MB e o limite é ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    };
  }
  if (currentCount >= maxFiles) {
    return { ok: false, code: 'too_many_files', message: `Limite de ${maxFiles} arquivos por solicitação atingido.` };
  }
  if (!ext) {
    return { ok: false, code: 'missing_extension', message: 'O arquivo precisa ter uma extensão reconhecida (ex.: .pdf, .png).' };
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, code: 'blocked_type', message: `Arquivos .${ext} não são aceitos por segurança.` };
  }
  if (!allowedExtensions.includes(ext)) {
    return {
      ok: false,
      code: 'type_not_allowed',
      message: `Tipo .${ext} não aceito. Aceitos: ${allowedExtensions.join(', ')}.`,
    };
  }
  const type = ALLOWED_TYPES[ext];
  const declared = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (declared && type.mimes.length && !type.mimes.includes(declared)) {
    return {
      ok: false,
      code: 'content_type_mismatch',
      message: `O tipo declarado (${declared}) não corresponde à extensão .${ext}.`,
    };
  }
  if (!matchesMagic(buffer, type.magic)) {
    return {
      ok: false,
      code: 'content_mismatch',
      message: `O conteúdo do arquivo não corresponde a um .${ext} válido.`,
    };
  }
  return {
    ok: true,
    meta: {
      name,
      ext,
      contentType: type.mimes[0],
      size: buffer.length,
    },
  };
}

export function createFileStore({
  dataDir,
  logger,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  retentionDays = DEFAULT_RETENTION_DAYS,
  allowedExtensions = Object.keys(ALLOWED_TYPES),
  now = () => new Date(),
} = {}) {
  if (!dataDir) throw new Error('createFileStore exige dataDir');
  const root = path.join(dataDir, 'uploads');
  fs.mkdirSync(root, { recursive: true });
  const log = logger?.child?.('uploads') ?? logger;

  /** Pasta da solicitação — id já validado pelo store antes de chegar aqui. */
  const dirFor = (requestId) => {
    const safe = String(requestId).replace(/[^A-Za-z0-9-]/g, '');
    return path.join(root, safe);
  };

  const api = {
    root,
    maxBytes,
    maxFiles,
    retentionDays,
    allowedExtensions,

    /** Grava o arquivo e devolve só metadados (o buffer não fica em memória). */
    save(request, { filename, contentType, buffer }) {
      const validation = validateUpload({
        filename,
        contentType,
        buffer,
        maxBytes,
        maxFiles,
        currentCount: request.files?.length ?? 0,
        allowedExtensions,
      });
      if (!validation.ok) {
        log?.warn?.('Upload recusado', { requestId: request.id, code: validation.code });
        return validation;
      }
      const dir = dirFor(request.id);
      fs.mkdirSync(dir, { recursive: true });
      const id = `f_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const stored = path.join(dir, `${id}.${validation.meta.ext}`);
      fs.writeFileSync(stored, buffer, { mode: 0o600 });

      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
      return {
        ok: true,
        file: {
          id,
          name: validation.meta.name,
          ext: validation.meta.ext,
          contentType: validation.meta.contentType,
          size: validation.meta.size,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        path: stored,
      };
    },

    /** Caminho de leitura, sempre reconstruído a partir do id + extensão. */
    resolve(requestId, file) {
      const safeId = String(requestId).replace(/[^A-Za-z0-9-]/g, '');
      const fileId = String(file?.id ?? '').replace(/[^A-Za-z0-9_]/g, '');
      const ext = String(file?.ext ?? '').replace(/[^a-z0-9]/gi, '');
      if (!safeId || !fileId || !ext) return null;
      const target = path.join(root, safeId, `${fileId}.${ext}`);
      const base = path.resolve(root);
      if (!path.resolve(target).startsWith(base + path.sep)) return null;
      return fs.existsSync(target) ? target : null;
    },

    remove(requestId, file) {
      const target = api.resolve(requestId, file);
      if (!target) return false;
      try {
        fs.unlinkSync(target);
        return true;
      } catch {
        return false;
      }
    },

    /** Apaga o diretório inteiro da solicitação (cancelamento/expiração). */
    removeAll(requestId) {
      const dir = dirFor(requestId);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Política de retenção: remove arquivos vencidos.
     * Devolve a contagem por solicitação para o log — sem nomes de arquivo.
     */
    purgeExpired(requests = []) {
      let removed = 0;
      for (const request of requests) {
        for (const file of request.files ?? []) {
          if (!file.expiresAt || new Date(file.expiresAt).getTime() > now().getTime()) continue;
          if (api.remove(request.id, file)) removed += 1;
        }
      }
      if (removed) log?.info?.('Arquivos expirados removidos', { removed });
      return removed;
    },
  };

  return api;
}

export const FILE_LIMITS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxFiles: DEFAULT_MAX_FILES,
  retentionDays: DEFAULT_RETENTION_DAYS,
});
