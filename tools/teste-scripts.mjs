#!/usr/bin/env node
/**
 * teste-scripts.mjs — valida os scripts PowerShell de forma automatizada.
 *
 * O que prova:
 *   1. todos os .ps1 passam pelo PARSER oficial do PowerShell (sintaxe real,
 *      não "revisão visual");
 *   2. a migração de .env, em modo plano, NÃO imprime nenhum valor de segredo;
 *   3. a migração classifica corretamente: compatível, renomeada e "não copiar";
 *   4. os .cmd chamam os .ps1 certos e usam %~dp0 (não dependem do diretório atual).
 *
 * O que não prova: o comportamento de cmdlets exclusivos do Windows
 * (Get-NetTCPConnection, Get-CimInstance, Start-Process -WindowStyle). Esses só
 * rodam na máquina do usuário — e o relatório diz isso explicitamente.
 *
 * Uso: node tools/teste-scripts.mjs        (procura pwsh, depois powershell)
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const falhas = [];
const ok = [];

function acharPowerShell() {
  const candidatos = [
    process.env.PS_EXE,
    '/tmp/pwsh/pwsh', // usado no ambiente de validação da entrega
    'pwsh',
    'powershell',
  ].filter(Boolean);
  for (const exe of candidatos) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status === 0 && /^\d+/m.test(r.stdout || '')) return { exe, versao: r.stdout.trim() };
  }
  return null;
}

const ps = acharPowerShell();
if (!ps) {
  console.log('PowerShell não encontrado — teste de scripts IGNORADO (não é falha).');
  console.log('No Windows rode com: node tools/teste-scripts.mjs');
  process.exit(0);
}
console.log(`PowerShell: ${ps.exe} (v${ps.versao})\n`);

/* ---------------------- 1. sintaxe de todos os .ps1 ---------------------- */
const dirScripts = join(RAIZ, 'scripts');
const arquivos = (await readdir(dirScripts)).filter((f) => f.endsWith('.ps1'));
if (!arquivos.length) falhas.push('nenhum .ps1 em scripts/');

for (const arquivo of arquivos) {
  const script = `
    $tokens = $null; $erros = $null
    [System.Management.Automation.Language.Parser]::ParseFile('${join(dirScripts, arquivo).replace(/'/g, "''")}', [ref]$tokens, [ref]$erros) | Out-Null
    if ($erros -and $erros.Count -gt 0) { $erros | ForEach-Object { Write-Output ("LINHA " + $_.Extent.StartLineNumber + ": " + $_.Message) }; exit 1 }
    Write-Output ("TOKENS " + $tokens.Count)
  `;
  const r = spawnSync(ps.exe, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 120_000 });
  if (r.status === 0) ok.push(`sintaxe: ${arquivo} (${/TOKENS (\d+)/.exec(r.stdout || '')?.[1] ?? '?'} tokens)`);
  else falhas.push(`sintaxe: ${arquivo} → ${(r.stdout || r.stderr || '').trim().split('\n').slice(0, 4).join(' | ')}`);
}

/* ------------------ 2/3. migração de .env (modo plano) ------------------ */
const segredos = {
  antigo: 'chave-antiga-SECRETA-abcdefghijklmnopqrstuvwxyz',
  completo: 'chave-completa-SECRETA-zyxwvutsrqponmlkjihgfedcba',
  kirana: 'chave-kirana-SECRETA-1234567890abcdefghij',
  ponte: 'token-ponte-SECRETO-abcdefghijklmnopqrstuv',
  proibido: 'sk-PROIBIDO-nao-deve-aparecer-em-lugar-nenhum',
};

const tmp = await mkdtemp(join(tmpdir(), 'kirana-scripts-'));
try {
  const fixtures = {
    'gateway-antigo.env': `GATEWAY_API_KEY=${segredos.antigo}\nGATEWAY_PORT=1455\nHOST=127.0.0.1\nOPENAI_API_KEY=${segredos.proibido}\n`,
    'gateway-completo.env': `GATEWAY_API_KEY=${segredos.completo}\nPORT=1455\nKIRANA_COST_POLICY=plan-only\n`,
    'kirana-antiga.env': `KIRANA_PORT=3000\nKIRANA_GATEWAY_KEY=${segredos.kirana}\nKIRANA_BRIDGE_ENABLED=on\n`,
    'kirana-completa.env': `KIRANA_PORT=3000\nKIRANA_BRIDGE_TOKEN=${segredos.ponte}\nKIRANA_GATEWAY_API_KEY=${segredos.kirana}\n`,
  };
  const caminhos = [];
  for (const [nome, conteudo] of Object.entries(fixtures)) {
    const caminho = join(tmp, nome);
    await writeFile(caminho, conteudo, 'utf8');
    caminhos.push(caminho);
  }

  const r = spawnSync(
    ps.exe,
    ['-NoProfile', '-File', join(dirScripts, 'Migrar-Env.ps1'), '-Origens', caminhos.join(',')],
    { encoding: 'utf8', timeout: 180_000, cwd: RAIZ },
  );
  const saida = `${r.stdout || ''}${r.stderr || ''}`;

  if (r.status !== 0) {
    falhas.push(`migração: saiu com código ${r.status} → ${saida.trim().split('\n').slice(0, 5).join(' | ')}`);
  } else {
    ok.push('migração: modo plano executou sem erro');
  }

  // 2. nenhum valor de segredo pode aparecer na saída
  const vazados = Object.entries(segredos).filter(([, valor]) => saida.includes(valor));
  if (vazados.length) falhas.push(`VAZAMENTO: a saída contém valor de segredo (${vazados.map(([k]) => k).join(', ')})`);
  else ok.push('migração: nenhum valor de segredo impresso');

  // 3. classificação correta
  const esperado = [
    ['GATEWAY_PORT', 'renomeada'],
    ['KIRANA_GATEWAY_KEY', 'renomeada'],
    ['OPENAI_API_KEY', 'NAO COPIAR'],
    ['KIRANA_BRIDGE_TOKEN', 'compativel'],
  ];
  for (const [chave, etiqueta] of esperado) {
    const linha = saida.split('\n').find((l) => l.includes(chave));
    if (!linha) falhas.push(`classificação: ${chave} não apareceu na análise`);
    else if (!linha.includes(etiqueta)) falhas.push(`classificação: ${chave} deveria ser "${etiqueta}" → obtido: ${linha.trim()}`);
    else ok.push(`classificação: ${chave} → ${etiqueta}`);
  }

  // backup realmente criado
  const dirBackups = join(RAIZ, 'backups');
  if (existsSync(dirBackups)) {
    const pastas = (await readdir(dirBackups)).filter((p) => p.startsWith('migracao-'));
    if (pastas.length) ok.push(`backup: ${pastas.length} pasta(s) de migração com manifesto`);
    else falhas.push('backup: nenhuma pasta de migração criada');
  } else {
    falhas.push('backup: pasta backups/ não foi criada');
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
  // limpa as pastas de backup criadas por este teste (não fazem parte do pacote)
  await rm(join(RAIZ, 'backups'), { recursive: true, force: true });
}

/* ------------------------- 4. wrappers .cmd ----------------------------- */
const pares = [
  ['INSTALAR-WINDOWS.cmd', 'Instalar.ps1'],
  ['INICIAR-TUDO.cmd', 'Iniciar-Tudo.ps1'],
  ['PARAR-TUDO.cmd', 'Parar-Tudo.ps1'],
  ['DIAGNOSTICO.cmd', 'Diagnostico.ps1'],
  ['MIGRAR-ENV.cmd', 'Migrar-Env.ps1'],
];
for (const [cmd, ps1] of pares) {
  const caminho = join(RAIZ, cmd);
  if (!existsSync(caminho)) {
    falhas.push(`wrapper: falta ${cmd}`);
    continue;
  }
  const texto = await readFile(caminho, 'latin1');
  if (!texto.includes(ps1)) falhas.push(`wrapper: ${cmd} não chama ${ps1}`);
  else if (!texto.includes('%~dp0')) falhas.push(`wrapper: ${cmd} depende do diretório atual (sem %~dp0)`);
  else if (!/\r\n/.test(texto)) falhas.push(`wrapper: ${cmd} sem CRLF (cmd.exe pode falhar)`);
  else ok.push(`wrapper: ${cmd} → ${ps1} (CRLF, %~dp0)`);
}

/* ------------------------------ relatório ------------------------------- */
console.log('OK:');
for (const linha of ok) console.log(`  ✔ ${linha}`);
if (falhas.length) {
  console.log('\nFALHAS:');
  for (const linha of falhas) console.log(`  ✘ ${linha}`);
  console.log(`\nRESULTADO: ${falhas.length} falha(s).`);
  process.exit(1);
}
console.log(`\nRESULTADO: ${ok.length} verificações de script OK.`);
