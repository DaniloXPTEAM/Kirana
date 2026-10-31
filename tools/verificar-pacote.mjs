#!/usr/bin/env node
/**
 * verificar-pacote.mjs — valida a CONSISTÊNCIA da distribuição, sem Windows.
 *
 * Por que existe: a distribuição anterior dizia "Gateway v0.4.1" e entregava
 * `Gateway/` na v0.4.0, com um ZIP v0.4.1 (que também era 0.4.0) guardado em
 * `Kirana/integrations`. Ninguém percebeu porque nenhuma verificação comparava
 * o nome com o conteúdo. Este script compara: pasta, version, código e rotas.
 *
 * Uso:
 *   node tools/verificar-pacote.mjs            # verificação estrutural
 *   node tools/verificar-pacote.mjs --testes   # + executa as duas suítes
 *
 * Sai com código 1 se algo estiver incoerente (serve para instalador e CI).
 */
import { readFile, readdir, stat, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const comTestes = process.argv.includes('--testes');
/**
 * Dois modos, com regras diferentes de propósito:
 *   --release      (padrão) o ZIP que eu entrego: proíbe .env, node_modules,
 *                  .local-state e data — são segredo/dependência/dado do usuário.
 *   --instalacao   a pasta JÁ USADA pelo usuário: esses quatro caminhos são
 *                  legítimos e passam a ser VALIDADOS em vez de proibidos.
 * O instalador usa --instalacao; por isso ele deixa de se bloquear na segunda
 * execução na mesma pasta (rodada anterior abortava aqui).
 */
const modoInstalacao = process.argv.includes('--instalacao');
const modoRelease = !modoInstalacao;

const falhas = [];
const avisos = [];
const ok = [];
const registrarOk = (texto) => ok.push(texto);
const falhar = (texto) => falhas.push(texto);
const avisar = (texto) => avisos.push(texto);

const existe = async (caminho) => {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
};
const ler = (caminho) => readFile(caminho, 'utf8');
const json = async (caminho) => JSON.parse(await ler(caminho));

/** Versão declarada + presença de um marcador de código real. */
async function verificarComponente({ nome, pasta, versaoEsperada, marcadores }) {
  const dir = join(RAIZ, pasta);
  if (!(await existe(dir))) {
    falhar(`${nome}: pasta "${pasta}/" não existe`);
    return null;
  }
  let pkg;
  try {
    pkg = await json(join(dir, 'package.json'));
  } catch {
    falhar(`${nome}: ${pasta}/package.json ausente ou inválido`);
    return null;
  }
  if (pkg.version !== versaoEsperada) {
    falhar(`${nome}: package.json declara ${pkg.version}, esperado ${versaoEsperada}`);
  } else {
    registrarOk(`${nome}: package.json = ${pkg.version}`);
  }
  for (const { arquivo, contem } of marcadores) {
    const alvo = join(dir, arquivo);
    if (!(await existe(alvo))) {
      falhar(`${nome}: falta ${pasta}/${arquivo} (código da versão esperada)`);
      continue;
    }
    const texto = await ler(alvo);
    const faltando = contem.filter((t) => !texto.includes(t));
    if (faltando.length) {
      falhar(`${nome}: ${pasta}/${arquivo} não contém ${faltando.map((f) => `"${f}"`).join(', ')}`);
    } else {
      registrarOk(`${nome}: ${arquivo} contém os marcadores de ${versaoEsperada}`);
    }
  }
  return pkg;
}

console.log(`Verificando distribuição em ${RAIZ}\n`);

/* ---------------------------- 1. versões --------------------------------- */
await verificarComponente({
  nome: 'Kirana',
  pasta: 'Kirana',
  versaoEsperada: '0.5.5',
  marcadores: [
    { arquivo: 'src/server.js', contem: ['createGatewayBridge', '/api/gateway'] },
    { arquivo: 'src/gateway-bridge.js', contem: ['bridge_route_not_exposed', 'bridge_https_required', 'tailscale-user-login'] },
    { arquivo: 'src/config.js', contem: ['validateBridgeConfig', 'requireHttps'] },
  ],
});

await verificarComponente({
  nome: 'Gateway',
  pasta: 'Gateway',
  versaoEsperada: '0.4.1',
  marcadores: [
    // Se engine.js não existir, é v0.4.0 com outro nome — o erro exato que ocorreu.
    { arquivo: 'src/engine.js', contem: ['selectChain', 'executeChain', 'CircuitBreaker', 'CapabilityCatalog'] },
    { arquivo: 'src/gateway.js', contem: ["/v1/engine", "/v1/runs", 'identity_verified'] },
    { arquivo: 'src/responses.js', contem: ['modelReported'] },
    { arquivo: 'config/models.json', contem: ['models'] },
  ],
});

/* ------------------------ 2. duplicação indevida -------------------------- */
const integracoes = join(RAIZ, 'Kirana', 'integrations');
if (await existe(integracoes)) {
  const itens = await readdir(integracoes);
  const zips = itens.filter((i) => /^Kirana-ChatGPT-Gateway.*\.zip$/i.test(i));
  if (zips.length) {
    falhar(
      `Kirana/integrations contém ${zips.join(', ')} — é exatamente a duplicação que causou a divergência. ` +
        'A pasta Gateway/ é a única cópia executável.',
    );
  } else {
    registrarOk('Kirana/integrations sem ZIP do Gateway (sem duplicação)');
  }
}

/* ------------- 3. limpeza do pacote OU sanidade da instalação ------------ */
const { lstat, readdir: listarPasta } = await import('node:fs/promises');
const CAMINHOS_OPERACIONAIS = ['node_modules', '.env', '.local-state', 'data'];

if (modoRelease) {
  for (const proibido of CAMINHOS_OPERACIONAIS) {
    for (const pasta of ['Kirana', 'Gateway']) {
      const caminho = join(RAIZ, pasta, proibido);
      let info = null;
      try {
        info = await lstat(caminho);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) {
        // Link não entra no ZIP; é só como a validação usa dependências externas.
        avisar(`${pasta}/${proibido} é link simbólico (dependência externa, não vai no pacote)`);
        continue;
      }
      falhar(`${pasta}/${proibido} presente no pacote — não deve ser distribuído (segredo, dependência ou dado do usuário)`);
    }
  }
  if (!falhas.some((f) => f.includes('não deve ser distribuído'))) {
    registrarOk('sem node_modules, .env, .local-state ou data embutidos (modo release)');
  }
} else {
  // Instalação operacional: nada disso é erro. O que importa é que o pacote
  // esteja CONSISTENTE — versões, motor e scripts — e que o que existe seja
  // coerente (dependências instaladas, chaves iguais). Nada é apagado aqui.
  const { lerEnv } = await import('./configurar.mjs');
  let presentes = 0;
  for (const nome of CAMINHOS_OPERACIONAIS) {
    for (const pasta of ['Kirana', 'Gateway']) {
      try {
        await lstat(join(RAIZ, pasta, nome));
        presentes++;
      } catch {
        /* ausente: normal em instalação nova */
      }
    }
  }
  registrarOk(`modo instalação: ${presentes} caminho(s) de execução encontrados (permitidos, nada é apagado)`);

  for (const [rotulo, pasta] of [['Kirana', 'Kirana'], ['Gateway', 'Gateway']]) {
    try {
      const conteudo = await listarPasta(join(RAIZ, pasta, 'node_modules'));
      if (conteudo.length === 0) falhar(`${pasta}/node_modules existe mas está vazio — rode a instalação novamente`);
      else registrarOk(`${pasta}/node_modules com ${conteudo.length} itens`);
    } catch {
      avisar(`${pasta}/node_modules ausente — o instalador vai criar (etapa de dependências)`);
    }
  }

  const envGw = lerEnv(join(RAIZ, 'Gateway', '.env'));
  const envKi = lerEnv(join(RAIZ, 'Kirana', '.env'));
  const chaveGw = envGw.GATEWAY_API_KEY || '';
  const chaveKi = envKi.KIRANA_GATEWAY_API_KEY || '';
  if (!chaveGw && !chaveKi) avisar('nenhuma chave gravada ainda — o instalador cria e alinha');
  else if (chaveGw && chaveKi && chaveGw === chaveKi) registrarOk('chaves locais presentes e idênticas (valores não lidos aqui)');
  else if (chaveGw && !chaveKi) avisar('Kirana/.env ainda sem KIRANA_GATEWAY_API_KEY — o instalador alinha');
  // Divergência aqui é AVISO, de propósito: alinhar a chave é justamente o
  // trabalho da etapa seguinte do instalador (tools/configurar.mjs). Quem
  // bloqueia de verdade é o pré-voo (tools/checar-config.mjs), que roda DEPOIS
  // do alinhamento. Bloquear antes criava um impasse: o instalador não
  // conseguia consertar o que ele mesmo acusava.
  else avisar('chaves locais divergentes agora — o instalador alinha na etapa seguinte e o pré-voo confere');
}

/* --------------------------- 4. scripts raiz ---------------------------- */
for (const arquivo of ['INSTALAR-WINDOWS.cmd', 'INICIAR-TUDO.cmd', 'PARAR-TUDO.cmd', 'DIAGNOSTICO.cmd', 'README.md']) {
  if (await existe(join(RAIZ, arquivo))) registrarOk(`raiz: ${arquivo}`);
  else falhar(`raiz: falta ${arquivo}`);
}
for (const arquivo of ['Comum.ps1', 'Instalar.ps1', 'Iniciar-Tudo.ps1', 'Parar-Tudo.ps1', 'Diagnostico.ps1', 'Migrar-Env.ps1']) {
  if (await existe(join(RAIZ, 'scripts', arquivo))) registrarOk(`scripts/${arquivo}`);
  else falhar(`scripts/${arquivo} ausente`);
}

/* ------------- 5. os scripts .cmd apontam para os .ps1 certos ----------- */
const pares = [
  ['INSTALAR-WINDOWS.cmd', 'Instalar.ps1'],
  ['INICIAR-TUDO.cmd', 'Iniciar-Tudo.ps1'],
  ['PARAR-TUDO.cmd', 'Parar-Tudo.ps1'],
  ['DIAGNOSTICO.cmd', 'Diagnostico.ps1'],
];
for (const [cmd, ps1] of pares) {
  const caminho = join(RAIZ, cmd);
  if (!(await existe(caminho))) continue;
  const texto = await ler(caminho);
  if (!texto.includes(ps1)) falhar(`${cmd} não chama scripts/${ps1}`);
  else registrarOk(`${cmd} → scripts/${ps1}`);
  if (!/%~dp0/i.test(texto)) avisar(`${cmd} não usa %~dp0 (pode depender do diretório atual)`);
}

/* --------------- 6. documentação obrigatória --------------------------- */
for (const doc of [
  'docs/CAUSA-RAIZ-E-CORRECAO.md',
  'docs/INSTALACAO-LIMPA.md',
  'docs/MIGRACAO-ENV-E-SIWC.md',
  'docs/TESTES-EXECUTADOS.md',
  'docs/TESTES-E-EVIDENCIAS.md',
  'docs/REVISAO-2.md',
  'docs/REVISAO-3.md',
  'docs/REVISAO-4.md',
  'docs/REVISAO-4.1.md',
  'docs/TAMA_T03_B0_BLOQUEIO_SIWC.md',
  'docs/GATEWAY_REV3_ACESSO_PRIVADO_STATUS.md',
  'docs/validacao/LEIA-ME.txt',
  'VERSAO-DISTRIBUICAO.txt',
  'VALIDAR-MODELOS-REAIS.cmd',
  'tools/validar-modelos-reais.mjs',
  'tools/duble-gateway-autorizado.mjs',
  'tools/contrato-chat.mjs',
  'tools/teste-verificador.mjs',
]) {
  if (await existe(join(RAIZ, doc))) registrarOk(doc);
  else falhar(`documentação ausente: ${doc}`);
}

/* ------------- 6b. ferramentas citadas nas mensagens existem ------------- */
// Um erro que manda rodar "tools\x.mjs" quando x.mjs não está no pacote custa
// a confiança inteira da mensagem. Aqui isso vira falha de verificação.
{
  const citados = new Set();
  for (const arquivo of ['Kirana/src/errors.js', 'Kirana/src/model-choice.js', 'Kirana/src/agent.js']) {
    const caminho = join(RAIZ, arquivo);
    if (!(await existe(caminho))) continue;
    const texto = await ler(caminho);
    for (const m of texto.matchAll(/tools[\\/]([A-Za-z0-9._-]+\.mjs)/g)) citados.add(m[1]);
  }
  for (const ferramenta of citados) {
    if (await existe(join(RAIZ, 'tools', ferramenta))) registrarOk(`mensagem cita tools/${ferramenta}, que existe`);
    else falhar(`mensagem cita tools/${ferramenta}, que NÃO existe no pacote`);
  }
}

/* ---------------------------- 7. suítes --------------------------------- */
async function rodarSuite(nome, dir) {
  /**
   * Lista explícita de `test/*.test.js`.
   *
   * Por que não `node --test` solto: a Kirana tem `test/browser/*.mjs`
   * (Playwright) que falhariam por falta de navegador — não fazem parte da
   * suíte de aceitação e não dizem nada sobre o pacote.
   */
  const diretorioTestes = join(dir, 'test');
  let arquivosTests = [];
  try {
    arquivosTests = (await readdir(diretorioTestes))
      .filter((f) => f.endsWith('.test.js'))
      .sort()
      .map((f) => join('test', f));
  } catch {
    falhar(`${nome}: pasta test/ ausente`);
    return false;
  }
  if (!arquivosTests.length) {
    falhar(`${nome}: nenhum test/*.test.js encontrado`);
    return false;
  }
  const resultado = spawnSync(process.execPath, ['--test', ...arquivosTests], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 1_500_000,
    env: { ...process.env, npm_config_cache: process.env.npm_config_cache || undefined },
  });
  const saida = `${resultado.stdout || ''}${resultado.stderr || ''}`;
  const passou = /^# pass (\d+)/m.exec(saida)?.[1];
  const falhou = /^# fail (\d+)/m.exec(saida)?.[1];
  if (resultado.status === 0 && falhou === '0') {
    registrarOk(`${nome}: ${passou} testes passaram`);
    return true;
  }
  falhar(`${nome}: suíte falhou (pass=${passou ?? '?'} fail=${falhou ?? '?'})`);
  return false;
}

if (comTestes) {
  console.log('Executando as duas suítes (pode levar alguns minutos)...\n');
  for (const [nome, pasta] of [['Gateway', 'Gateway'], ['Kirana', 'Kirana']]) {
    const dir = join(RAIZ, pasta);
    if (!(await existe(join(dir, 'node_modules')))) {
      avisar(`${nome}: node_modules ausente — rode a instalação antes de testar (etapa ignorada)`);
      continue;
    }
    await rodarSuite(nome, dir);
  }
}

/* ----------------------------- relatório -------------------------------- */
console.log('OK:');
for (const linha of ok) console.log(`  ✔ ${linha}`);
if (avisos.length) {
  console.log('\nAvisos:');
  for (const linha of avisos) console.log(`  ! ${linha}`);
}
if (falhas.length) {
  console.log('\nFALHAS:');
  for (const linha of falhas) console.log(`  ✘ ${linha}`);
  console.log(`\nRESULTADO: ${falhas.length} falha(s). O pacote NÃO deve ser distribuído assim.`);
  process.exit(1);
}
console.log(`\nRESULTADO: pacote coerente (${ok.length} verificações OK${comTestes ? ', suítes executadas' : ''}).`);
