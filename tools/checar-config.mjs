/**
 * checar-config.mjs — pré-voo OBRIGATÓRIO antes de subir qualquer serviço.
 *
 * Portado de tools/checar-config.mjs da v0.5.3. Recusa-se a "subir com sucesso"
 * para descobrir depois que a conversa falha por falta ou divergência de chave.
 *
 * Verifica, sem exibir valores:
 *   - Gateway/.env e Kirana/.env existem;
 *   - GATEWAY_API_KEY e KIRANA_GATEWAY_API_KEY existem e são IGUAIS;
 *   - porta/URL coerentes (1455, 3000, http://127.0.0.1:1455);
 *   - nada de .env na raiz do pacote (local de configuração não é a raiz);
 *   - BOM quebrando a primeira chave;
 *   - versões do pacote (Kirana 0.5.5, Gateway 0.4.1) — falha se divergir.
 *
 * Uso: node tools/checar-config.mjs
 * Saída: 0 = pode iniciar; 1 = NÃO inicie, corrija antes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerEnv, CHAVE_MINIMA } from './configurar.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_GATEWAY = join(RAIZ, 'Gateway', '.env');
const ENV_KIRANA = join(RAIZ, 'Kirana', '.env');
const VERSAO_KIRANA = '0.5.5';
const VERSAO_GATEWAY = '0.4.1';

const problemas = [];
const ok = (t, d = '') => console.log(`  OK   ${t}${d ? ` — ${d}` : ''}`);
const aviso = (t, d = '') => console.log(`  !    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d = '') => {
  console.log(`  X    ${t}${d ? ` — ${d}` : ''}`);
  problemas.push(t);
};

console.log('');
console.log('=== Pré-voo da configuração (nada foi iniciado) ===');

/* ---------------------------------------------------------------- arquivos */
for (const [rotulo, caminho] of [['Gateway', ENV_GATEWAY], ['Kirana', ENV_KIRANA]]) {
  if (!existsSync(caminho)) {
    falha(`${rotulo}\\.env não existe`, 'rode INSTALAR-WINDOWS.cmd');
  } else {
    ok(`${rotulo}\\.env existe`);
    const bruto = readFileSync(caminho);
    if (bruto[0] === 0xef && bruto[1] === 0xbb && bruto[2] === 0xbf) {
      aviso(`${rotulo}\\.env tem BOM`, 'pode quebrar a leitura da primeira variável; salve como UTF-8 sem BOM');
    }
  }
}

/* ----------------------------------------------------------------- versões */
for (const [rotulo, pasta, esperada] of [
  ['Kirana', join(RAIZ, 'Kirana'), VERSAO_KIRANA],
  ['Gateway', join(RAIZ, 'Gateway'), VERSAO_GATEWAY],
]) {
  const arquivo = join(pasta, 'package.json');
  if (!existsSync(arquivo)) {
    falha(`${rotulo}\\package.json ausente`, 'extraia o ZIP inteiro');
    continue;
  }
  try {
    const versao = JSON.parse(readFileSync(arquivo, 'utf8')).version;
    if (versao === esperada) ok(`${rotulo} v${versao}`);
    else falha(`${rotulo} está em v${versao}, esperado v${esperada}`, 'não misture versões de pacotes diferentes');
  } catch {
    falha(`${rotulo}\\package.json ilegível`);
  }
}
if (!existsSync(join(RAIZ, 'Gateway', 'src', 'engine.js'))) {
  falha('Gateway\\src\\engine.js ausente', 'esta pasta não é o Gateway v0.4.1 completo');
}

if (problemas.length) {
  console.log('');
  console.log('  Configuração incompleta. Nada foi iniciado.');
  console.log('  Corrija com:  .\\INSTALAR-WINDOWS.cmd');
  process.exit(1);
}

/* ------------------------------------------------------------------ chaves */
const envGw = lerEnv(ENV_GATEWAY);
const envKi = lerEnv(ENV_KIRANA);
const chaveGw = envGw.GATEWAY_API_KEY || '';
const chaveKi = envKi.KIRANA_GATEWAY_API_KEY || '';

if (!chaveGw) falha('Gateway: GATEWAY_API_KEY vazia', 'o Gateway não sobe sem ela');
else if (chaveGw.length < CHAVE_MINIMA) falha(`Gateway: GATEWAY_API_KEY com ${chaveGw.length} caracteres`, `mínimo ${CHAVE_MINIMA}`);
else ok('Gateway: GATEWAY_API_KEY definida', 'valor não exibido');

if (!chaveKi) falha('Kirana: KIRANA_GATEWAY_API_KEY vazia', 'a Kirana não falaria com o Gateway');
else ok('Kirana: KIRANA_GATEWAY_API_KEY definida', 'valor não exibido');

if (chaveGw && chaveKi) {
  if (chaveGw === chaveKi) ok('as duas chaves são idênticas');
  else falha('as chaves são DIFERENTES', 'o Gateway recusa a Kirana com 401');
}

/* --------------------------------------------------------- porta e endereço */
const portas = [
  ['Kirana', envKi.KIRANA_PORT, '3000'],
  ['Gateway', envGw.PORT, '1455'],
];
for (const [rotulo, valor, esperada] of portas) {
  if (String(valor) === esperada) ok(`${rotulo} na porta ${esperada}`);
  else falha(`${rotulo} em porta inesperada`, `arquivo diz ${valor || 'ausente'}, esperado ${esperada}`);
}
if (envKi.KIRANA_GATEWAY_URL === 'http://127.0.0.1:1455') ok('Kirana aponta para http://127.0.0.1:1455');
else falha('Kirana aponta para outro endereço', envKi.KIRANA_GATEWAY_URL || 'ausente');

/* -------------------------------------------------- ajustes que só avisam */
if (envGw.HOST && envGw.HOST !== '127.0.0.1') {
  falha(`Gateway com HOST=${envGw.HOST}`, 'deve ser 127.0.0.1 (loopback); o app recusa outro bind');
}
const timeoutK = Number(envKi.KIRANA_REQUEST_TIMEOUT_MS || 0);
const timeoutG = Number(envGw.KIRANA_ENGINE_TIMEOUT_MS || 180000);
if (timeoutK && timeoutK < timeoutG) {
  aviso(`KIRANA_REQUEST_TIMEOUT_MS=${timeoutK} ms é menor que o timeout do Gateway (${timeoutG} ms)`, 'a Kirana pode cortar uma resposta ainda em andamento; rode INSTALAR-WINDOWS.cmd para ajustar');
}

/* ---------------------------------------------------- .env na raiz (errado) */
if (existsSync(join(RAIZ, '.env'))) {
  aviso('.env na RAIZ do pacote', 'não é lido por ninguém; o oficial é Kirana\\.env e Gateway\\.env');
}

console.log('');
if (problemas.length) {
  falha(`configuração inválida (${problemas.length} problema(s))`, 'NADA foi iniciado');
  console.log('');
  console.log('  Corrija com:  .\\INSTALAR-WINDOWS.cmd');
  process.exit(1);
}
console.log('  Configuração pronta para iniciar (Kirana :3000 · Gateway :1455).');
process.exit(0);
