#!/usr/bin/env node
/**
 * teste-instalacao-existente.mjs — regressão do conflito de instalação (REV4.2).
 *
 * Cenário real que quebrou na REV4.1: Gateway antigo ativo + SIWC autenticado +
 * distribuição nova em OUTRA pasta + chaves divergentes -> a pasta nova gerava
 * chave aleatória e tudo dava 401.
 *
 * Usa um Gateway FALSO local (porta efêmera, nunca a 1455) que aceita uma chave.
 * Não toca em nenhum processo nem em nenhuma instalação real.
 *
 * Também confere que todo .cmd é CRLF e ASCII puro (LF-only + acento causava
 * "'cho' não é reconhecido" no cmd.exe).
 *
 * Uso: node tools/teste-instalacao-existente.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DETECTOR = join(RAIZ, 'tools', 'detectar-instalacao.mjs');
const falhas = [];
const passou = (t) => console.log(`  PASS  ${t}`);
const falhou = (t) => {
  falhas.push(t);
  console.log(`  FALHA ${t}`);
};
const confere = (cond, t) => (cond ? passou(t) : falhou(t));

const CHAVE_ATIVA = 'A'.repeat(20) + 'chave-valida-do-gateway-ativo-1';
const CHAVE_OUTRA = 'B'.repeat(20) + 'chave-aleatoria-da-pasta-nova-2';

function gatewayFalso(chaveAceita) {
  const servidor = createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', authenticated: true }));
    const ok = req.headers.authorization === `Bearer ${chaveAceita}`;
    res.statusCode = ok ? 200 : 401;
    res.end('{}');
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok(servidor)));
}

function instalacaoFalsa(base, nome, chave) {
  const g = join(base, nome, 'Gateway');
  mkdirSync(g, { recursive: true });
  writeFileSync(join(g, 'package.json'), JSON.stringify({ name: 'kirana-chatgpt-gateway', version: '0.4.1' }));
  if (chave) writeFileSync(join(g, '.env'), `HOST=127.0.0.1\nGATEWAY_API_KEY=${chave}\n`);
  return g;
}

/**
 * Roda o detector a partir de uma RAIZ temporaria (o detector deduz a raiz do proprio
 * caminho). `chaveDaRaiz` cria Gateway/.env nessa raiz; sem ela, a pasta e "nova".
 */
function rodar(url, procurarEm, nomeRaiz, chaveDaRaiz) {
  // spawn assincrono: o Gateway falso vive neste processo e precisa responder enquanto o detector roda.
  const raiz = join(base, nomeRaiz);
  mkdirSync(join(raiz, 'tools'), { recursive: true });
  writeFileSync(join(raiz, 'tools', 'detectar-instalacao.mjs'), readFileSync(DETECTOR));
  if (chaveDaRaiz) instalacaoFalsa(raiz, '.', chaveDaRaiz);
  return new Promise((ok) => {
    const p = spawn(process.execPath, [join(raiz, 'tools', 'detectar-instalacao.mjs'), '--url', url], {
      env: { ...process.env, KIRANA_PROCURAR_EM: procurarEm },
    });
    let saida = '';
    p.stdout.on('data', (d) => (saida += d));
    p.stderr.on('data', (d) => (saida += d));
    const timer = setTimeout(() => p.kill(), 30_000);
    p.on('close', (codigo) => {
      clearTimeout(timer);
      ok({ codigo, saida });
    });
  });
}

const base = mkdtempSync(join(tmpdir(), 'kirana-teste-'));
try {
  const servidor = await gatewayFalso(CHAVE_ATIVA);
  const url = `http://127.0.0.1:${servidor.address().port}`;

  console.log('\n[1] Gateway ativo + instalacao antiga com a chave aceita + pasta nova sem .env');
  instalacaoFalsa(base, 'antiga', CHAVE_ATIVA);
  let r = await rodar(url, join(base, 'antiga'), 'nova1');
  confere(r.codigo === 0, 'sai com 0');
  confere(r.saida.includes(`CHAVE:${CHAVE_ATIVA}`), 'adota exatamente a chave aceita pelo Gateway ativo');
  confere(!r.saida.replace(`CHAVE:${CHAVE_ATIVA}`, '').includes(CHAVE_ATIVA), 'a chave so aparece na linha CHAVE: (nao nas mensagens)');

  console.log('\n[2] Gateway ativo + so ha chave DIVERGENTE (a que a REV4.1 geraria)');
  rmSync(join(base, 'antiga'), { recursive: true, force: true });
  instalacaoFalsa(base, 'outra', CHAVE_OUTRA);
  r = await rodar(url, join(base, 'outra'), 'nova2');
  confere(r.codigo === 2, 'sai com 2 (conflito) e o instalador para');
  confere(!r.saida.includes('CHAVE:'), 'NAO adota nem gera chave');
  confere(!r.saida.includes(CHAVE_OUTRA) && !r.saida.includes(CHAVE_ATIVA), 'nenhum segredo impresso');
  confere(/CONFLITO/.test(r.saida) && /SIWC/.test(r.saida), 'explica o conflito e o risco para o SIWC');

  console.log('\n[3] Nenhum Gateway ativo (porta fechada)');
  servidor.close();
  r = await rodar(url, join(base, 'outra'), 'nova3');
  confere(r.codigo === 0 && !r.saida.includes('CHAVE:'), 'segue o fluxo normal (gera chave nova), sem adotar nada');

  console.log('\n[4] Pasta ja tem chave propria, mas o Gateway ativo a recusa');
  const servidor2 = await gatewayFalso(CHAVE_ATIVA);
  const url2 = `http://127.0.0.1:${servidor2.address().port}`;
  const rr = await rodar(url2, join(base, 'vazio'), 'nova4', CHAVE_OUTRA);
  confere(rr.codigo === 0 && !rr.saida.includes('CHAVE:'), 'preserva a chave existente (nao sobrescreve)');
  confere(/RECUSOU/.test(rr.saida) && !rr.saida.includes(CHAVE_OUTRA), 'avisa que o Gateway ativo recusou, sem imprimir segredo');
  servidor2.close();
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log('\n[5] Scripts .cmd: CRLF e ASCII puro');
for (const nome of readdirSync(RAIZ).filter((n) => n.toLowerCase().endsWith('.cmd'))) {
  const b = readFileSync(join(RAIZ, nome));
  const cr = b.filter((x) => x === 13).length;
  const lf = b.filter((x) => x === 10).length;
  confere(cr === lf && lf > 0, `${nome}: todo LF tem CR`);
  confere(!b.some((x) => x > 127), `${nome}: so ASCII`);
}

console.log(falhas.length ? `\nRESULTADO: ${falhas.length} falha(s)` : '\nRESULTADO: tudo PASS');
process.exit(falhas.length ? 1 : 0);
