/**
 * configurar.mjs — alinha a chave LOCAL do Gateway entre os dois processos.
 *
 * Portado de tools/configurar.mjs da distribuição v0.5.3, com três mudanças
 * deliberadas: (a) preserva comentários e a ordem do .env em vez de reescrever
 * o arquivo; (b) NÃO procura .env de pastas vizinhas (evita pegar credencial de
 * outro projeto); (c) faz backup antes de qualquer escrita.
 *
 * Regra da chave:
 *   - Gateway/.env  é a AUTORIDADE (é ele quem valida o Bearer);
 *   - se GATEWAY_API_KEY não existir, é gerada pelo keygen do próprio Gateway
 *     (32 bytes aleatórios, criptograficamente seguros);
 *   - se existir e tiver 32+ caracteres, é PRESERVADA;
 *   - Kirana/.env recebe a MESMA chave em KIRANA_GATEWAY_API_KEY, sempre.
 *
 * Isto não tem relação com o SIWC: token do ChatGPT é outro, vive em memória no
 * Gateway e nunca é tocado aqui.
 *
 * Uso: node tools/configurar.mjs [--silencioso]
 * Saída: 0 = configurado e conferido; 1 = não foi possível configurar.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_GATEWAY = join(RAIZ, 'Gateway');
const DIR_KIRANA = join(RAIZ, 'Kirana');
const ENV_GATEWAY = join(DIR_GATEWAY, '.env');
const ENV_KIRANA = join(DIR_KIRANA, '.env');
export const CHAVE_MINIMA = 32;

const silencioso = process.argv.includes('--silencioso');
const falhas = [];
const ok = (t) => !silencioso && console.log(`  OK   ${t}`);
const aviso = (t) => console.log(`  !    ${t}`);
const erro = (t) => console.log(`  X    ${t}`);
const info = (t) => !silencioso && console.log(t);

/** Lê .env em pares chave→valor, ignorando comentários. Não interpreta aspas. */
export function lerEnv(caminho) {
  const mapa = {};
  if (!existsSync(caminho)) return mapa;
  const texto = readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');
  for (const linha of texto.split(/\r?\n/)) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const i = limpa.indexOf('=');
    if (i <= 0) continue;
    const nome = limpa.slice(0, i).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome)) mapa[nome] = limpa.slice(i + 1).trim();
  }
  return mapa;
}

/**
 * Grava uma variável preservando o resto do arquivo byte a byte: comentários,
 * ordem, linhas desconhecidas e o tipo de quebra de linha (CRLF no Windows).
 * Se a variável existir em mais de uma linha, todas são alinhadas com o mesmo
 * valor (nunca fica valor duplicado e divergente).
 */
export function definirVariavel(caminho, nome, valor) {
  const original = existsSync(caminho) ? readFileSync(caminho, 'utf8') : '';
  const crlf = original.includes('\r\n');
  const linhas = original.length ? original.split(/\r?\n/) : [];
  const padrao = new RegExp(`^\\s*${nome}\\s*=`);
  let achou = false;
  for (let i = 0; i < linhas.length; i++) {
    if (padrao.test(linhas[i])) {
      linhas[i] = `${nome}=${valor}`;
      achou = true;
    }
  }
  if (!achou) {
    if (linhas.length && linhas[linhas.length - 1] === '') linhas.splice(linhas.length - 1, 0, `${nome}=${valor}`);
    else linhas.push(`${nome}=${valor}`);
  }
  const conteudo = linhas.join(crlf ? '\r\n' : '\n');
  writeFileSync(caminho, conteudo, { encoding: 'utf8' });
  try {
    chmodSync(caminho, 0o600);
  } catch {
    /* Windows: permissão é herdada; não é falha */
  }
  return conteudo;
}

/** Backup verificável antes de escrever. Devolve o caminho ou ''. */
export function fazerBackup(arquivos) {
  const pasta = join(RAIZ, 'backups', `env-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
  const existentes = arquivos.filter((f) => existsSync(f));
  if (!existentes.length) return '';
  mkdirSync(pasta, { recursive: true });
  for (const arquivo of existentes) {
    const destino = join(pasta, `${arquivo.split(/[\\/]/).slice(-2).join('-')}.bak`);
    writeFileSync(destino, readFileSync(arquivo));
    // Verifica o backup relendo: backup que não abre não serve de backup.
    if (readFileSync(destino).length !== readFileSync(arquivo).length) {
      throw new Error(`backup inconsistente: ${destino}`);
    }
  }
  return pasta;
}

/** Gera chave com o keygen do Gateway (mesma entropia do `npm run keygen`). */
export function gerarChaveDoGateway() {
  const saida = execFileSync(process.execPath, ['src/keygen.js'], {
    cwd: DIR_GATEWAY,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (!saida || saida.length < CHAVE_MINIMA) throw new Error('keygen do Gateway devolveu valor inválido');
  return saida;
}

function principal() {
  info('');
  info('Configuração da chave local (Gateway ↔ Kirana)');
  info('');

  for (const [rotulo, dir] of [['Gateway', DIR_GATEWAY], ['Kirana', DIR_KIRANA]]) {
    if (!existsSync(join(dir, 'package.json'))) {
      erro(`pasta ${rotulo}\\ ausente ou incompleta`);
      info('        extraia o ZIP inteiro antes de rodar o instalador');
      process.exit(2);
    }
  }

  const envGw = lerEnv(ENV_GATEWAY);
  const envKi = lerEnv(ENV_KIRANA);
  let chave = envGw.GATEWAY_API_KEY || '';

  if (!chave) {
    try {
      chave = gerarChaveDoGateway();
      ok('GATEWAY_API_KEY não existia: gerada pelo keygen do Gateway (valor não exibido)');
    } catch (e) {
      erro(`não consegui gerar a chave: ${String(e?.message || e).slice(0, 120)}`);
      process.exit(1);
    }
  } else if (chave.length < CHAVE_MINIMA) {
    aviso(`GATEWAY_API_KEY tinha ${chave.length} caracteres (mínimo ${CHAVE_MINIMA}); gerando nova`);
    try {
      chave = gerarChaveDoGateway();
    } catch (e) {
      erro(`não consegui gerar a chave: ${String(e?.message || e).slice(0, 120)}`);
      process.exit(1);
    }
  } else {
    ok(`GATEWAY_API_KEY preservada (${chave.length} caracteres, valor não exibido)`);
  }

  const kiranaIgual = envKi.KIRANA_GATEWAY_API_KEY === chave;
  if (envKi.KIRANA_GATEWAY_API_KEY && !kiranaIgual) {
    aviso('KIRANA_GATEWAY_API_KEY estava diferente da do Gateway — será alinhada');
  }

  // Backup só quando há o que perder.
  if (existsSync(ENV_GATEWAY) || existsSync(ENV_KIRANA)) {
    try {
      const pasta = fazerBackup([ENV_GATEWAY, ENV_KIRANA]);
      if (pasta) {
        const rel = pasta.slice(RAIZ.length).replace(/[\\/]/g, '\\').replace(/^\\/, '');
        ok(`backup dos .env em ${rel} (verificado por releitura)`);
      }
    } catch (e) {
      erro(`backup falhou, nada será gravado: ${String(e?.message || e).slice(0, 120)}`);
      process.exit(1);
    }
  }

  // Autossuficiência: se o .env ainda não existe, nasce do .env.example. Assim
  // este utilitário também funciona sozinho, sem depender da ordem do instalador.
  for (const [rotulo, destino] of [['Gateway', ENV_GATEWAY], ['Kirana', ENV_KIRANA]]) {
    if (existsSync(destino)) continue;
    const exemplo = destino.replace(/\.env$/, '.env.example');
    if (existsSync(exemplo)) {
      writeFileSync(destino, readFileSync(exemplo));
      ok(rotulo + '\\.env criado a partir de ' + rotulo + '\\.env.example');
    } else {
      erro(`${rotulo}\\.env e ${rotulo}\\.env.example não existem — pacote incompleto`);
      process.exit(1);
    }
  }

  definirVariavel(ENV_GATEWAY, 'GATEWAY_API_KEY', chave);
  definirVariavel(ENV_KIRANA, 'KIRANA_GATEWAY_API_KEY', chave);
  definirVariavel(ENV_KIRANA, 'KIRANA_GATEWAY_URL', 'http://127.0.0.1:1455');

  // A Kirana espera até KIRANA_REQUEST_TIMEOUT_MS; o Gateway espera 180 s por
  // tentativa. Se a Kirana desistir antes, ela corta uma resposta que o Gateway
  // ainda estava entregando — sintoma: texto aparece e a conversa "não conclui".
  const timeoutKirana = Number(lerEnv(ENV_KIRANA).KIRANA_REQUEST_TIMEOUT_MS || 120000);
  const timeoutGateway = Number(lerEnv(ENV_GATEWAY).KIRANA_ENGINE_TIMEOUT_MS || 180000);
  const minimo = timeoutGateway + 20000;
  if (Number.isFinite(timeoutKirana) && timeoutKirana < minimo) {
    definirVariavel(ENV_KIRANA, 'KIRANA_REQUEST_TIMEOUT_MS', String(minimo));
    aviso(`KIRANA_REQUEST_TIMEOUT_MS era ${timeoutKirana} ms e o Gateway espera ${timeoutGateway} ms por tentativa; ajustado para ${minimo} ms`);
  } else {
    ok(`KIRANA_REQUEST_TIMEOUT_MS=${timeoutKirana} ms (≥ Gateway ${timeoutGateway} ms + margem)`);
  }

  // Conferência relendo do disco — o que vale é o arquivo, não a variável.
  const confGw = lerEnv(ENV_GATEWAY);
  const confKi = lerEnv(ENV_KIRANA);
  if (!confGw.GATEWAY_API_KEY) falhas.push('GATEWAY_API_KEY não está no Gateway/.env após a escrita');
  if (!confKi.KIRANA_GATEWAY_API_KEY) falhas.push('KIRANA_GATEWAY_API_KEY não está no Kirana/.env após a escrita');
  if (confGw.GATEWAY_API_KEY && confKi.KIRANA_GATEWAY_API_KEY && confGw.GATEWAY_API_KEY !== confKi.KIRANA_GATEWAY_API_KEY) {
    falhas.push('as duas chaves ficaram diferentes após a escrita');
  }
  if (confGw.GATEWAY_API_KEY && confGw.GATEWAY_API_KEY.length < CHAVE_MINIMA) {
    falhas.push(`GATEWAY_API_KEY com menos de ${CHAVE_MINIMA} caracteres`);
  }

  info('');
  if (falhas.length) {
    for (const f of falhas) erro(f);
    process.exit(1);
  }
  ok('as duas chaves estão gravadas e são idênticas (relido do disco)');
  if (!envKi.KIRANA_GATEWAY_API_KEY) ok('Kirana/.env recebeu KIRANA_GATEWAY_API_KEY pela primeira vez');
  info('');
  info('A chave não é exibida em lugar nenhum. Ela está em Gateway\\.env e Kirana\\.env.');
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('configurar.mjs')) {
  process.exit(principal());
}
