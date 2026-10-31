import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createZip } from './zip.js';

export const FILE_FORMATS = Object.freeze({
  txt: { extension: '.txt', mimeType: 'text/plain; charset=utf-8' },
  md: { extension: '.md', mimeType: 'text/markdown; charset=utf-8' },
  json: { extension: '.json', mimeType: 'application/json; charset=utf-8' },
  csv: { extension: '.csv', mimeType: 'text/csv; charset=utf-8' },
  pdf: { extension: '.pdf', mimeType: 'application/pdf' },
  docx: { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { extension: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
});

export const DEFAULT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_FILE_TTL_SECONDS = 60 * 60;

function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function xmlEscape(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function safeFilename(name, format, requiredExtension = FILE_FORMATS[format]?.extension) {
  if (!requiredExtension) throw fail(400, 'unsupported_file_format', 'Filename extension is not configured for this format.');
  if (name === undefined || name === null || name === '') return `document${requiredExtension}`;
  if (typeof name !== 'string' || name.length > 180 || /[\u0000-\u001f\u007f]/.test(name) || /[\\/]/.test(name) || name === '.' || name === '..') throw fail(400, 'invalid_filename', 'filename must be a simple filename without path separators or control characters.');
  const ext = extname(name).toLowerCase();
  if (ext !== requiredExtension) throw fail(400, 'filename_extension_mismatch', `filename must use the ${requiredExtension} extension.`);
  if (name.startsWith('.')) throw fail(400, 'invalid_filename', 'Hidden filenames are not accepted.');
  return name;
}
function textContent(value, label = 'content') {
  if (typeof value !== 'string') throw fail(400, 'invalid_file_content', `${label} must be a string.`);
  return value;
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Prevent spreadsheet formula execution for generated CSV values.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length > 50_000) throw fail(400, 'invalid_rows', 'rows must be an array with no more than 50000 rows.');
  if (!rows.length) return [];
  let matrix;
  if (rows.every(Array.isArray)) matrix = rows;
  else if (rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (headers.length > 500) throw fail(400, 'too_many_columns', 'A spreadsheet may contain at most 500 columns.');
    matrix = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))];
  } else throw fail(400, 'invalid_rows', 'rows must contain only arrays or only plain objects.');
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  if (width > 500 || matrix.some((row) => row.length > 500)) throw fail(400, 'too_many_columns', 'A spreadsheet may contain at most 500 columns.');
  for (const row of matrix) for (const cell of row) {
    if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) throw fail(400, 'invalid_cell', 'Spreadsheet cells must be strings, numbers, booleans, or null.');
    if (typeof cell === 'number' && !Number.isFinite(cell)) throw fail(400, 'invalid_cell', 'Spreadsheet numbers must be finite.');
  }
  return matrix;
}
function csvBuffer(rows) { return Buffer.from(normalizeRows(rows).map((row) => row.map(csvCell).join(',')).join('\r\n') + (rows.length ? '\r\n' : ''), 'utf8'); }
function columnName(zeroBased) {
  let value = zeroBased + 1; let result = '';
  while (value > 0) { const r = (value - 1) % 26; result = String.fromCharCode(65 + r) + result; value = Math.floor((value - 1) / 26); }
  return result;
}
function xlsxBuffer(rows) {
  const matrix = normalizeRows(rows);
  const sheetRows = matrix.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      if (typeof value === 'number') return `<c r="${ref}" t="n"><v>${String(value)}</v></c>`;
      if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      const text = value === null || value === undefined ? '' : String(value);
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  return createZip(entries);
}
function docxBuffer(content) {
  const paragraphs = content.split(/\r?\n/).map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join('');
  return createZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`],
  ]);
}

const CP1252_SPECIAL = new Map([[0x20ac,0x80],[0x201a,0x82],[0x0192,0x83],[0x201e,0x84],[0x2026,0x85],[0x2020,0x86],[0x2021,0x87],[0x02c6,0x88],[0x2030,0x89],[0x0160,0x8a],[0x2039,0x8b],[0x0152,0x8c],[0x017d,0x8e],[0x2018,0x91],[0x2019,0x92],[0x201c,0x93],[0x201d,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],[0x02dc,0x98],[0x2122,0x99],[0x0161,0x9a],[0x203a,0x9b],[0x0153,0x9c],[0x017e,0x9e],[0x0178,0x9f]]);
function winAnsiHex(text) {
  let hex = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const byte = CP1252_SPECIAL.get(cp) ?? (cp <= 0xff ? cp : 0x3f);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.toUpperCase();
}
function pdfLines(content) {
  const result = [];
  for (const line of content.replace(/\r/g, '').split('\n')) {
    let remaining = line;
    while (remaining.length > 100) {
      let split = remaining.lastIndexOf(' ', 100);
      if (split < 1) split = 100;
      result.push(remaining.slice(0, split)); remaining = remaining.slice(split).trimStart();
    }
    result.push(remaining);
  }
  return result;
}
function pdfBuffer(content) {
  const lines = pdfLines(content);
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += 48) pages.push(lines.slice(i, i + 48));
  const objects = [null, ''];
  const kids = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  for (let i = 0; i < pages.length; i++) {
    const pageId = 3 + i * 2; const streamId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${streamId} 0 R >>`;
    const commands = ['BT', '/F1 11 Tf', '50 760 Td', '14 TL', ...pages[i].map((line, index) => `${index ? 'T* ' : ''}<${winAnsiHex(line)}> Tj`), 'ET'].join('\n');
    objects[streamId] = `<< /Length ${Buffer.byteLength(commands, 'ascii')} >>\nstream\n${commands}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  objects[3 + pages.length * 2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  let pdf = '%PDF-1.4\n%Kirana local document\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets[i] = Buffer.byteLength(pdf, 'ascii'); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export function createFilePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_file_request', 'File request must be a JSON object.');
  const allowed = new Set(['format', 'filename', 'content', 'data', 'rows']);
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) throw fail(400, 'unsupported_parameter', `Unsupported file field: ${unknown}.`);
  const format = typeof body.format === 'string' ? body.format.toLowerCase().replace(/^\./, '') : '';
  if (!Object.hasOwn(FILE_FORMATS, format)) throw fail(400, 'unsupported_file_format', `Supported formats: ${Object.keys(FILE_FORMATS).join(', ')}.`);
  const filename = safeFilename(body.filename, format);
  let buffer;
  if (format === 'csv' || format === 'xlsx') {
    if (!Array.isArray(body.rows)) throw fail(400, 'invalid_rows', 'CSV and XLSX creation require rows (array-of-arrays or array-of-objects).');
    buffer = format === 'csv' ? csvBuffer(body.rows) : xlsxBuffer(body.rows);
  } else if (format === 'json') {
    let value;
    if (typeof body.content === 'string') { try { value = JSON.parse(body.content); } catch { throw fail(400, 'invalid_json_content', 'content must contain valid JSON.'); } }
    else if (Object.hasOwn(body, 'data')) value = body.data;
    else throw fail(400, 'invalid_file_content', 'JSON creation requires a JSON string in content or a value in data.');
    buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } else {
    const content = textContent(body.content);
    buffer = format === 'docx' ? docxBuffer(content) : format === 'pdf' ? pdfBuffer(content) : Buffer.from(content, 'utf8');
  }
  return { filename, mimeType: FILE_FORMATS[format].mimeType, buffer, format };
}

const UPLOAD_TYPES = new Map([
  ...Object.entries(FILE_FORMATS).map(([format, meta]) => [meta.mimeType.split(';')[0], { format, extension: meta.extension, mimeType: meta.mimeType }]),
  ['image/png',{format:'png',extension:'.png',mimeType:'image/png'}],
  ['image/jpeg',{format:'jpg',extension:'.jpg',mimeType:'image/jpeg'}],
  ['image/webp',{format:'webp',extension:'.webp',mimeType:'image/webp'}],
  ['image/gif',{format:'gif',extension:'.gif',mimeType:'image/gif'}],
  ['audio/mpeg',{format:'mp3',extension:'.mp3',mimeType:'audio/mpeg'}],
  ['audio/wav',{format:'wav',extension:'.wav',mimeType:'audio/wav'}],
  ['audio/ogg',{format:'ogg',extension:'.ogg',mimeType:'audio/ogg'}],
  ['audio/mp4',{format:'m4a',extension:'.m4a',mimeType:'audio/mp4'}],
  ['audio/webm',{format:'webm',extension:'.webm',mimeType:'audio/webm'}],
  ['video/mp4',{format:'mp4',extension:'.mp4',mimeType:'video/mp4'}],
  ['video/quicktime',{format:'mov',extension:'.mov',mimeType:'video/quicktime'}],
  ['video/webm',{format:'webm',extension:'.webm',mimeType:'video/webm'}],
]);
export const UPLOAD_MIME_TYPES = Object.freeze([...UPLOAD_TYPES.keys()]);
function hasSignature(format, buffer) {
  const starts = (...bytes) => buffer.length >= bytes.length && bytes.every((byte, i) => buffer[i] === byte);
  if (format === 'pdf') return buffer.subarray(0, 8).toString('ascii').startsWith('%PDF-');
  if (format === 'docx' || format === 'xlsx') return starts(0x50,0x4b,0x03,0x04);
  if (format === 'png') return starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a);
  if (format === 'jpg') return starts(0xff,0xd8,0xff);
  if (format === 'webp') return buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP';
  if (format === 'gif') return ['GIF87a','GIF89a'].includes(buffer.toString('ascii',0,6));
  if (format === 'mp3') return buffer.toString('ascii',0,3)==='ID3' || (buffer.length >= 2 && buffer[0]===0xff && (buffer[1]&0xe0)===0xe0);
  if (format === 'wav') return buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WAVE';
  if (format === 'ogg') return buffer.toString('ascii',0,4)==='OggS';
  if (format === 'm4a' || format === 'mp4' || format === 'mov') return buffer.length >= 12 && buffer.toString('ascii',4,8)==='ftyp';
  if (format === 'webm') return starts(0x1a,0x45,0xdf,0xa3);
  return true;
}
function validateUpload(buffer, filename, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw fail(400, 'invalid_upload', 'Upload content is invalid.');
  const baseMime = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const spec = UPLOAD_TYPES.get(baseMime);
  if (!spec) throw fail(415, 'unsupported_media_type', 'Upload MIME type is not in the supported file-format list.');
  const name = safeFilename(filename, spec.format, spec.extension);
  if (!hasSignature(spec.format, buffer)) throw fail(400, 'file_signature_mismatch', 'File bytes do not match the declared MIME type signature.');
  if (baseMime.startsWith('text/') || baseMime === 'application/json') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw fail(400, 'invalid_text_encoding', 'Text uploads must be valid UTF-8.'); }
    if (baseMime === 'application/json') { try { JSON.parse(text); } catch { throw fail(400, 'invalid_json_content', 'JSON upload content is invalid.'); } }
  }
  return { filename: name, mimeType: spec.mimeType, format: spec.format };
}

export class TemporaryFileStore {
  constructor({ directory, maxFileBytes = DEFAULT_FILE_LIMIT_BYTES, maxTotalBytes = 50 * 1024 * 1024, maxFiles = 50, ttlSeconds = DEFAULT_FILE_TTL_SECONDS, now = Date.now } = {}) {
    if (typeof directory !== 'string' || !directory) throw new TypeError('Temporary file directory is required.');
    if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1 || !Number.isInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes || !Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60) throw new TypeError('Invalid temporary file limits.');
    this.directory = resolve(directory); this.maxFileBytes = maxFileBytes; this.maxTotalBytes = maxTotalBytes;
    this.maxFiles = maxFiles; this.ttlSeconds = ttlSeconds; this.now = now; this.files = new Map();
    this.reservedBytes = 0; this.reservedFiles = 0; this.indexPath = join(this.directory, 'index.json');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Temporary file directory must not be a symbolic link.');
    try { chmodSync(this.directory, 0o700); } catch { /* Windows ACLs are inherited from the user profile. */ }
    this.loadPersistedIndex();
    this.removeOrphanedFiles();
    this.sweepExpired();
    this.persistIndex();
    this.cleanupTimer = setInterval(() => { try { this.sweepExpired(); } catch { /* next API call or startup retries cleanup */ } }, Math.min(60_000, this.ttlSeconds * 1000));
    this.cleanupTimer.unref?.();
  }

  loadPersistedIndex() {
    let entries;
    try { entries = JSON.parse(readFileSync(this.indexPath, 'utf8')).files; } catch { entries = []; }
    if (!Array.isArray(entries)) return;
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(item.id) || typeof item.filename !== 'string' || typeof item.format !== 'string' || typeof item.created_at !== 'string' || typeof item.expires_at !== 'string' || !Number.isFinite(Date.parse(item.expires_at))) continue;
      const spec = FILE_FORMATS[item.format] || [...UPLOAD_TYPES.values()].find((candidate) => candidate.format === item.format && candidate.mimeType === item.mime_type);
      if (!spec || item.mime_type !== spec.mimeType) continue;
      try {
        const filename = safeFilename(item.filename, item.format, spec.extension);
        const path = join(this.directory, item.id); const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size_bytes || stat.size > this.maxFileBytes || Date.parse(item.expires_at) <= this.now()) continue;
        this.files.set(item.id, Object.freeze({ id: item.id, filename, mime_type: spec.mimeType, format: item.format, size_bytes: stat.size, created_at: item.created_at, expires_at: item.expires_at }));
        if (this.files.size >= this.maxFiles) break;
      } catch { /* malformed or missing persisted entries are ignored and cleaned below */ }
    }
  }

  removeOrphanedFiles() {
    const ids = new Set(this.files.keys());
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === 'index.json') continue;
      if (/^[A-Za-z0-9_-]{32}$/.test(entry.name) && !ids.has(entry.name)) { try { rmSync(join(this.directory, entry.name), { force: true }); } catch { /* next cleanup pass retries */ } }
      if (/^index-[A-Za-z0-9_-]+\.tmp$/.test(entry.name)) { try { rmSync(join(this.directory, entry.name), { force: true }); } catch { /* next startup retries */ } }
    }
  }

  persistIndex() {
    const temporary = join(this.directory, `index-${randomBytes(8).toString('hex')}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, files: [...this.files.values()] }), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.indexPath);
      try { chmodSync(this.indexPath, 0o600); } catch { /* Windows ACLs are inherited from the user profile. */ }
    } catch {
      try { rmSync(temporary, { force: true }); } catch { /* cleanup on next startup */ }
      throw fail(500, 'file_storage_error', 'Could not persist temporary file metadata.');
    }
  }

  get formats() { return Object.entries(FILE_FORMATS).map(([format, spec]) => ({ format, extension: spec.extension, mime_type: spec.mimeType })); }
  get uploadMimeTypes() { return [...UPLOAD_MIME_TYPES]; }

  async create(body) {
    const file = createFilePayload(body);
    return this.put(file.buffer, file.filename, file.mimeType, file.format);
  }

  async upload({ filename, mimeType, buffer }) {
    const validated = validateUpload(buffer, filename, mimeType);
    return this.put(buffer, validated.filename, validated.mimeType, validated.format);
  }

  async put(buffer, filename, mimeType, format) {
    this.sweepExpired();
    if (buffer.length > this.maxFileBytes) throw fail(413, 'file_too_large', `File exceeds the ${this.maxFileBytes} byte limit.`);
    const current = [...this.files.values()].reduce((sum, f) => sum + f.size_bytes, 0);
    if (this.files.size + this.reservedFiles >= this.maxFiles || current + this.reservedBytes + buffer.length > this.maxTotalBytes) throw fail(413, 'temporary_storage_limit', 'Temporary file storage limit reached; download or delete an existing file.');
    this.reservedBytes += buffer.length; this.reservedFiles++;
    const id = randomBytes(24).toString('base64url');
    const path = join(this.directory, id);
    try { await writeFile(path, buffer, { flag: 'wx', mode: 0o600 }); }
    catch { try { rmSync(path, { force: true }); } catch { /* cleanup will remove any orphan on restart */ } throw fail(500, 'file_storage_error', 'Could not store the temporary file.'); }
    finally { this.reservedBytes -= buffer.length; this.reservedFiles--; }
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are inherited from the user profile. */ }
    const createdAt = this.now();
    const metadata = Object.freeze({ id, filename, mime_type: mimeType, format, size_bytes: buffer.length, created_at: new Date(createdAt).toISOString(), expires_at: new Date(createdAt + this.ttlSeconds * 1000).toISOString() });
    this.files.set(id, metadata);
    try { this.persistIndex(); }
    catch (error) { this.files.delete(id); try { rmSync(path, { force: true }); } catch { /* cleanup on startup */ } throw error; }
    return metadata;
  }

  async get(id) {
    this.sweepExpired();
    const metadata = this.files.get(id);
    if (!metadata) return null;
    try { return { metadata, buffer: await readFile(join(this.directory, id)) }; }
    catch { this.files.delete(id); return null; }
  }

  async delete(id) {
    const metadata = this.files.get(id);
    if (!metadata) return false;
    this.files.delete(id);
    try { rmSync(join(this.directory, id), { force: true }); this.persistIndex(); }
    catch { throw fail(500, 'file_storage_error', 'Could not delete the temporary file.'); }
    return true;
  }

  sweepExpired() {
    const now = this.now(); let changed = false;
    for (const [id, metadata] of this.files) {
      if (Date.parse(metadata.expires_at) <= now) {
        this.files.delete(id); changed = true;
        try { rmSync(join(this.directory, id), { force: true }); } catch { /* expiration remains effective in metadata */ }
      }
    }
    if (changed) this.persistIndex();
  }

  close() { clearInterval(this.cleanupTimer); }
}

export function safeDownloadHeaders(filename, mimeType, size) {
  const ascii = basename(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'content-type': mimeType,
    'content-length': String(size),
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
}
