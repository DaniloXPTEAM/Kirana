/**
 * Registro local de interesses comerciais.
 *
 * Importante: nesta fase NÃO há envio para CRM, e-mail ou WhatsApp.
 * O registro é gravado localmente e marcado como "pendente_de_envio".
 * A Kirana nunca deve dizer que o contato foi enviado.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createInterestStore({ dataDir, logger }) {
  const file = path.join(dataDir, 'interests.jsonl');

  const ensureDir = () => fs.mkdirSync(dataDir, { recursive: true });

  const protocolFor = () => {
    const year = new Date().getFullYear();
    return `INT-${year}-${randomUUID().slice(0, 6).toUpperCase()}`;
  };

  return {
    file,

    create(entry) {
      ensureDir();
      const record = {
        protocolo: protocolFor(),
        criadoEm: new Date().toISOString(),
        status: 'registrado_localmente_pendente_de_envio',
        envio_externo: false,
        ...entry,
      };
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      logger?.info?.('Interesse comercial registrado localmente', { protocolo: record.protocolo });
      return record;
    },

    list() {
      try {
        return fs
          .readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    },

    count() {
      return this.list().length;
    },
  };
}
