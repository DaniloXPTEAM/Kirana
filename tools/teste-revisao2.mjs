#!/usr/bin/env node
/**
 * teste-revisao2.mjs — regressões da SEGUNDA revisão (29/10/2026).
 *
 * Roda sem dependências externas e sem credenciais. Cobre exatamente os defeitos
 * apontados na revisão, um bloco por defeito:
 *
 *   A. PowerShell 5.1: RNG criptográfico (New-TokenAleatorio) e conversão de
 *      parâmetro Preparar-Env (OrderedDictionary -> IDictionary).
 *   B. Reuso de processo: só com propriedade comprovada (§4).
 *   C. Parada segura: fail-closed (§5).
 *   D. Streaming: código de erro real chega à Kirana e a mensagem é distinta (§6).
 *   E. Modelos: catálogo × capacidade declarada, sem prometer o que não se sabe (§7).
 *
 * Os blocos B e C testam as funções puras de decisão (Get-DecisaoReuso /
 * Get-DecisaoParada) executadas por um PowerShell de verdade (pwsh 7 aqui).
 * A chamada real às APIs do Windows (Get-NetTCPConnection, CIM) NÃO roda neste
 * ambiente e está marcada como pendente de homologação no Windows.
 *
 * Uso:  node tools\teste-revisao2.mjs
 */
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const execFileAsync = promisify(execFile);
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_KIRANA = join(RAIZ, 'Kirana', 'src');
let passou = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passou++; console.log(`  ok   ${nome}`); },
        (e) => { falhas.push(`${nome}: ${e.message}`); console.log(`  FAIL ${nome}\n       ${e.message}`); }
      );
    }
    passou++;
    console.log(`  ok   ${nome}`);
  } catch (e) {
    falhas.push(`${nome}: ${e.message}`);
    console.log(`  FAIL ${nome}\n       ${e.message}`);
  }
}
const igual = (a, b, rotulo = '') => {
  if (a !== b) throw new Error(`${rotulo} esperado ${JSON.stringify(b)}, recebido ${JSON.stringify(a)}`);
};
const contem = (texto, trecho, rotulo = '') => {
  if (!String(texto).includes(trecho)) throw new Error(`${rotulo} deveria conter ${JSON.stringify(trecho)}; recebido ${JSON.stringify(texto)}`);
};
const diferente = (a, b, rotulo = '') => {
  if (a === b) throw new Error(`${rotulo} deveria ser diferente, mas os dois são ${JSON.stringify(a)}`);
};

/* ----------------------------- utilidades ----------------------------- */
function acharPwsh() {
  for (const candidato of [process.env.PWSH, '/tmp/pwsh/pwsh', 'pwsh', 'powershell']) {
    if (!candidato) continue;
    try {
      execFileSync(candidato, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe' });
      return candidato;
    } catch { /* tenta o próximo */ }
  }
  return null;
}

const PWSH = acharPwsh();
const COMUM = join(RAIZ, 'scripts', 'Comum.ps1');
const INSTALAR = join(RAIZ, 'scripts', 'Instalar.ps1');

function rodarPs(script) {
  const dir = mkdtempSync(join(tmpdir(), 'kirana-ps-'));
  const arquivo = join(dir, 'driver.ps1');
  writeFileSync(arquivo, script, 'utf8');
  try {
    const saida = execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', arquivo], { encoding: 'utf8', stdio: 'pipe' });
    return saida;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ================================ A ================================ */
console.log('\nA. Windows PowerShell 5.1 — RNG e conversão de parâmetros');

const codigoComum = readFileSync(COMUM, 'utf8');

teste('A1. New-TokenAleatorio não usa o estático RandomNumberGenerator::Fill', () => {
  // Fill(Span<byte>) só existe no .NET Core 3.0+; no .NET Framework do PS 5.1
  // não existe, e o instalador morreria em tempo de execução.
  const semComentarios = codigoComum
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  if (/RandomNumberGenerator\]::Fill\s*\(/.test(semComentarios)) {
    throw new Error('ainda usa RandomNumberGenerator::Fill fora de comentário');
  }
});

teste('A2. New-TokenAleatorio usa instância + GetBytes(byte[]) + Dispose em finally', () => {
  const corpo = codigoComum.slice(codigoComum.indexOf('function New-TokenAleatorio'));
  const fim = corpo.indexOf('\nfunction ', 10);
  const bloco = fim > 0 ? corpo.slice(0, fim) : corpo;
  contem(bloco, 'RandomNumberGenerator]::Create()', 'criação da instância');
  contem(bloco, '.GetBytes($bytes)', 'GetBytes(byte[])');
  contem(bloco, 'finally', 'bloco finally');
  contem(bloco, '.Dispose()', 'descarte da instância');
  if (/Get-Random|New-Guid|\[guid\]/.test(bloco)) throw new Error('caiu para gerador fraco (Get-Random/GUID)');
});

teste('A3. New-TokenAleatorio produz 32 bytes em base64url (43 chars) e valores distintos', () => {
  if (!PWSH) return console.log('       (sem PowerShell: pulado)');
  const saida = rodarPs(`. "${COMUM}"
$t = @()
for ($i = 0; $i -lt 200; $i++) { $t += New-TokenAleatorio }
$unicos = ($t | Sort-Object -Unique).Count
$primeiro = $t[0]
$charsetOk = $primeiro -match '^[A-Za-z0-9_-]+$'
$bytes = [Convert]::FromBase64String(($primeiro.Replace('-','+').Replace('_','/') + ('=' * ((4 - $primeiro.Length % 4) % 4))))
Write-Output ("{0}|{1}|{2}|{3}" -f $primeiro.Length, $bytes.Length, $unicos, $charsetOk)`);
  const [tamanho, bytes, unicos, charset] = saida.trim().split('|');
  igual(Number(tamanho), 43, 'comprimento base64url');
  igual(Number(bytes), 32, 'bytes de entropia');
  igual(Number(unicos), 200, 'tokens distintos em 200');
  igual(charset, 'True', 'charset base64url');
});

teste('A4. Preparar-Env aceita IDictionary (OrderedDictionary do chamador)', () => {
  const trecho = readFileSync(INSTALAR, 'utf8');
  if (/\[hashtable\]\$Padroes/.test(trecho)) {
    throw new Error('Preparar-Env ainda declara [hashtable]; no PS 5.1 [ordered]@{} não converte');
  }
  contem(trecho, '[System.Collections.IDictionary]$Padroes', 'tipo do parâmetro');
  contem(trecho, '-Padroes ([ordered]@{', 'chamada com ordered (preservada)');
});

teste('A5. Preparar-Env roda nos dois ramos (.env ausente e .env presente) e preserva chaves', () => {
  if (!PWSH) return console.log('       (sem PowerShell: pulado)');
  const dir = mkdtempSync(join(tmpdir(), 'kirana-env-'));
  try {
    const gw = join(dir, 'Gateway');
    const kr = join(dir, 'Kirana');
    execFileSync(PWSH, ['-NoProfile', '-Command', `
      New-Item -ItemType Directory -Force -Path '${gw}' | Out-Null
      New-Item -ItemType Directory -Force -Path '${kr}' | Out-Null
      Set-Content -Path '${gw}/.env.example' -Value 'GATEWAY_API_KEY=generate-with-npm-run-keygen','HOST=127.0.0.1','PORT=1455'
      Set-Content -Path '${kr}/.env.example' -Value 'KIRANA_GATEWAY_API_KEY=','KIRANA_BRIDGE_TOKEN=','KIRANA_PORT=3000'
    `], { stdio: 'pipe' });

    // Extrai só a função Preparar-Env do Instalar.ps1 para exercitá-la isolada.
    const fonte = readFileSync(INSTALAR, 'utf8');
    const ini = fonte.indexOf('function Preparar-Env');
    const fim = fonte.indexOf('\n$tokenPonte', ini);
    const funcao = fonte.slice(ini, fim);
    const driver = join(dir, 'drv.ps1');
    writeFileSync(driver, `. "${COMUM}"
${funcao}
$envBackup = '${dir}/backups'
New-Item -ItemType Directory -Force -Path $envBackup | Out-Null
Preparar-Env -Pasta '${gw}' -Nome 'Gateway' -Padroes ([ordered]@{ 'GATEWAY_API_KEY' = (New-TokenAleatorio); 'HOST' = '127.0.0.1' })
Preparar-Env -Pasta '${kr}' -Nome 'Kirana' -Padroes ([ordered]@{ 'KIRANA_GATEWAY_API_KEY' = (New-TokenAleatorio); 'KIRANA_PORT' = '3000' })
# segunda passada: .env agora existe (ramo "preservado")
Preparar-Env -Pasta '${gw}' -Nome 'Gateway' -Padroes ([ordered]@{ 'GATEWAY_API_KEY' = 'NAO-DEVE-SUBSTITUIR' })
Write-Output 'FIM'`, 'utf8');
    const saida = execFileSync(PWSH, ['-NoProfile', '-File', driver], { encoding: 'utf8', stdio: 'pipe' });
    contem(saida, 'FIM', 'conclusão do driver');

    const envGw = readFileSync(join(gw, '.env'), 'utf8');
    const envKr = readFileSync(join(kr, '.env'), 'utf8');
    const chaveGw = (envGw.match(/^GATEWAY_API_KEY=(.*)$/m) || [])[1] || '';
    const chaveKr = (envKr.match(/^KIRANA_GATEWAY_API_KEY=(.*)$/m) || [])[1] || '';
    if (chaveGw.length !== 43) throw new Error(`chave do Gateway com ${chaveGw.length} chars`);
    if (chaveKr.length !== 43) throw new Error(`chave da Kirana com ${chaveKr.length} chars`);
    if (chaveGw === 'NAO-DEVE-SUBSTITUIR') throw new Error('segunda passada sobrescreveu a chave existente');
    contem(envGw, 'HOST=127.0.0.1', 'valor não-segredo preservado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ================================ B e C ================================ */
console.log('\nB/C. Propriedade de processo — reuso e parada segura');

const PASTA = 'C:\\Kirana\\dist';
const CMDLINE_PROPRIO = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Kirana\\dist\\Gateway\\src\\main.js"';
const CMDLINE_OUTRO = '"C:\\Program Files\\nodejs\\node.exe" "D:\\outra-instalacao\\Gateway\\src\\main.js"';

function decidirReuso(cenario) {
  const script = `. "${COMUM}"
$estado = [ordered]@{
  Porta = ${cenario.porta ?? 1455}
  Ocupada = ${cenario.ocupada ? '$true' : '$false'}
  Pid = ${cenario.pidDono ?? '$null'}
  Processo = 'node.exe'
  Executavel = 'C:\\Program Files\\nodejs\\node.exe'
  LinhaDeComando = ${cenario.linha ? `'${cenario.linha.replace(/'/g, "''")}'` : '$null'}
}
$pidFile = ${cenario.pidFile ? `[pscustomobject]@{ pid = ${cenario.pidFile.pid}; pastaTrabalho = '${(cenario.pidFile.pasta || PASTA).replace(/'/g, "''")}' }` : '$null'}
$d = Get-DecisaoReuso -EstadoPorta $estado -PidFile $pidFile -PastaEsperada '${PASTA}' -Arquivo 'main.js' -VersaoEsperada '0.4.1' -VersaoAtiva '${cenario.versao ?? '0.4.1'}'
Write-Output ("{0}|{1}" -f $d.Acao, $d.Motivo)`;
  const saida = rodarPs(script).trim();
  const [acao, motivo] = saida.split('|');
  return { acao, motivo };
}

function decidirParada(cenario) {
  const script = `. "${COMUM}"
$dados = ${cenario.dados ? `[pscustomobject]@{ pid = ${cenario.dados.pid}; pastaTrabalho = '${(cenario.dados.pasta || PASTA).replace(/'/g, "''")}' }` : '$null'}
$d = Get-DecisaoParada -Dados $dados -ProcessoVivo ${cenario.vivo ? '$true' : '$false'} -LinhaDeComando ${cenario.linha ? `'${cenario.linha.replace(/'/g, "''")}'` : '$null'} -PidDonoPorta ${cenario.pidDono === undefined || cenario.pidDono === null ? '$null' : cenario.pidDono} -Arquivo 'main.js' -PastaTrabalho '${PASTA}'
Write-Output ("{0}|{1}" -f $d.Acao, $d.Motivo)`;
  const saida = rodarPs(script).trim();
  const [acao, motivo] = saida.split('|');
  return { acao, motivo };
}

const B = [
  ['B1. porta livre inicia', { ocupada: false }, 'iniciar'],
  ['B2. mesma versão em OUTRA pasta (sem pid file) NÃO é reutilizada', { ocupada: true, pidDono: 4242, versao: '0.4.1', pidFile: null }, 'parar'],
  ['B3. processo desta distribuição, identidade completa → reutiliza', { ocupada: true, pidDono: 4242, linha: CMDLINE_PROPRIO, versao: '0.4.1', pidFile: { pid: 4242 } }, 'reusar'],
  ['B4. processo estranho que responde /health com a mesma versão → para', { ocupada: true, pidDono: 999, linha: CMDLINE_OUTRO, versao: '0.4.1', pidFile: { pid: 999 } }, 'parar'],
  ['B5. PID reutilizado (pid file 1234, porta do 4242) → para', { ocupada: true, pidDono: 4242, linha: CMDLINE_PROPRIO, versao: '0.4.1', pidFile: { pid: 1234 } }, 'parar'],
  ['B6. linha de comando ilegível (CIM falhou) → para', { ocupada: true, pidDono: 4242, linha: null, versao: '0.4.1', pidFile: { pid: 4242 } }, 'parar'],
  ['B7. mesma pasta, versão divergente → para', { ocupada: true, pidDono: 4242, linha: CMDLINE_PROPRIO, versao: '0.4.0', pidFile: { pid: 4242 } }, 'parar'],
  ['B8. pid file escrito para outra pasta → para', { ocupada: true, pidDono: 4242, linha: CMDLINE_PROPRIO, versao: '0.4.1', pidFile: { pid: 4242, pasta: 'D:\\outra-instalacao' } }, 'parar'],
];

if (PWSH) {
  for (const [nome, cenario, esperado] of B) {
    teste(`B. ${nome}`, () => {
      const r = decidirReuso(cenario);
      igual(r.acao, esperado, `ação (${r.motivo})`);
    });
  }
} else {
  console.log('  --   bloco B pulado: nenhum PowerShell disponível neste ambiente');
}

const C = [
  ['C1. pid file ausente → não encerra', { dados: null, vivo: false }, 'ignorar'],
  ['C2. processo já morreu → limpa o pid file', { dados: { pid: 1234 }, vivo: false }, 'limpar'],
  ['C3. linha de comando indisponível (CIM falhou) → fail-closed', { dados: { pid: 1234 }, vivo: true, linha: null, pidDono: 1234 }, 'ignorar'],
  ['C4. PID virou outro main.js de outro diretório → não encerra', { dados: { pid: 1234 }, vivo: true, linha: CMDLINE_OUTRO, pidDono: 1234 }, 'ignorar'],
  ['C5. porta pertence a outro PID → não encerra', { dados: { pid: 1234 }, vivo: true, linha: CMDLINE_PROPRIO, pidDono: 999 }, 'ignorar'],
  ['C6. processo próprio iniciado pelo launcher → encerra', { dados: { pid: 1234 }, vivo: true, linha: CMDLINE_PROPRIO, pidDono: 1234 }, 'encerrar'],
  ['C7. processo próprio com a porta já livre → encerra (identidade pela linha de comando)', { dados: { pid: 1234 }, vivo: true, linha: CMDLINE_PROPRIO, pidDono: null }, 'encerrar'],
];

if (PWSH) {
  for (const [nome, cenario, esperado] of C) {
    teste(`C. ${nome}`, () => {
      const r = decidirParada(cenario);
      igual(r.acao, esperado, `ação (${r.motivo})`);
    });
  }
} else {
  console.log('  --   bloco C pulado: nenhum PowerShell disponível neste ambiente');
}

teste('C8. Parar-Tudo não tem caminho que encerre com linha de comando nula', () => {
  const fonte = readFileSync(join(RAIZ, 'scripts', 'Parar-Tudo.ps1'), 'utf8');
  // o antigo: "if ($linha -and ...)" deixava passar quando $linha era $null
  if (/\$linha\s+-and\s+\$linha\s+-notlike/.test(fonte)) {
    throw new Error('ainda usa a guarda antiga que aceita linha de comando nula');
  }
  contem(fonte, 'Get-DecisaoParada', 'uso da decisão fail-closed');
});

teste('C9. Iniciar-Tudo não reutiliza serviço só por /health (sem prova de dono)', () => {
  const fonte = readFileSync(join(RAIZ, 'scripts', 'Iniciar-Tudo.ps1'), 'utf8');
  if (/\$versaoAtiva\s+-eq\s+\$VersaoEsperada\)\s*\{[\s\S]{0,400}?return\s+\$true/.test(fonte)) {
    throw new Error('ainda existe ramo que segue só porque a versão confere');
  }
  contem(fonte, 'Get-DecisaoReuso', 'uso da decisão com prova de propriedade');
});

/* ================================ D ================================ */
console.log('\nD. Streaming — código real do erro até a mensagem na tela');

const { createGatewayClient, codigoDeErroDoGateway } = await import(join(SRC_KIRANA, 'gateway.js'));
const { mapError, MENSAGENS_ERRO } = await import(join(SRC_KIRANA, 'errors.js'));

function servidorSse(roteiro) {
  return new Promise((resolve) => {
    const servidor = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      roteiro(res);
    });
    servidor.listen(0, '127.0.0.1', () => resolve({ servidor, porta: servidor.address().port }));
  });
}

async function consumir(porta, eventos) {
  const cliente = createGatewayClient({
    config: {
      gateway: { url: `http://127.0.0.1:${porta}`, apiKey: 'chave-de-teste', firstTokenTimeoutMs: 3000, requestTimeoutMs: 5000 },
      agent: { temperature: 0.2, maxTokens: 100 },
    },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
  const deltas = [];
  try {
    const r = await cliente.chatStream({
      messages: [{ role: 'user', content: 'oi' }],
      model: 'gpt-5',
      onDelta: (t) => deltas.push(t),
      ...eventos,
    });
    return { ok: true, ...r, deltas };
  } catch (error) {
    return { ok: false, error, deltas };
  }
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

await teste('D1. delta parcial + erro stream_interrupted: código preservado até a mensagem', async () => {
  const { servidor, porta } = await servidorSse((res) => {
    res.write(frame({ choices: [{ delta: { content: 'Coração e ' } }] }));
    res.write(frame({ error: { message: 'Responses stream ended without response.completed.', type: 'gateway_error', code: 'stream_interrupted' } }));
    res.end();
  });
  try {
    const r = await consumir(porta);
    igual(r.ok, false, 'deveria falhar');
    contem(r.deltas.join(''), 'Coração', 'texto parcial entregue ao cliente');
    igual(r.error.code, 'stream_interrupted', 'código do erro');
    const mapeado = mapError(r.error, { gateway: { url: 'http://127.0.0.1:1455' } });
    igual(mapeado.code, 'stream_interrupted', 'código mapeado');
    contem(mapeado.message, 'interrompida', 'mensagem de interrupção');
    diferente(mapeado.message, MENSAGENS_ERRO.unauthorized.message, 'mensagem ≠ chave local');
    diferente(mapeado.message, MENSAGENS_ERRO.gateway_auth.message, 'mensagem ≠ SIWC');
    diferente(mapeado.message, MENSAGENS_ERRO.model_not_available.message, 'mensagem ≠ modelo');
  } finally {
    servidor.close();
  }
});

await teste('D2. texto + response.completed + [DONE] conclui normalmente', async () => {
  const { servidor, porta } = await servidorSse((res) => {
    res.write(frame({ choices: [{ delta: { content: 'Olá, ' } }] }));
    res.write(frame({ choices: [{ delta: { content: 'tudo bem?' } }] }));
    res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 12 } }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const r = await consumir(porta);
    igual(r.ok, true, `não deveria falhar (${r.error?.code || ''})`);
    igual(r.text, 'Olá, tudo bem?', 'texto final');
  } finally {
    servidor.close();
  }
});

await teste('D3. código desconhecido vira genérico (nunca texto cru do upstream)', async () => {
  const { servidor, porta } = await servidorSse((res) => {
    res.write(frame({ error: { message: '<script>alerta</script>coisa\nrara', code: 'codigo_inventado' } }));
    res.end();
  });
  try {
    const r = await consumir(porta);
    igual(r.ok, false, 'deveria falhar');
    igual(r.error.code, 'gateway_stream_error', 'código genérico');
    if (/[<>\n]/.test(r.error.detail || '')) throw new Error(`detalhe não sanitizado: ${r.error.detail}`);
    contem(r.error.detail, 'coisa rara', 'texto técnico preservado e limpo');
  } finally {
    servidor.close();
  }
});

await teste('D4. aliases do provedor são traduzidos para códigos conhecidos', () => {
  igual(codigoDeErroDoGateway('invalid_api_key'), 'gateway_unauthorized_upstream', 'invalid_api_key');
  igual(codigoDeErroDoGateway('model_not_found'), 'model_not_available', 'model_not_found');
  igual(codigoDeErroDoGateway('sign_in_required'), 'gateway_auth', 'sign_in_required');
  igual(codigoDeErroDoGateway('response_incomplete'), 'response_incomplete', 'código já canônico');
  igual(codigoDeErroDoGateway(''), 'gateway_stream_error', 'vazio');
});

teste('D5. mapError: chave local, SIWC, modelo e resposta parcial têm textos distintos', () => {
  const textos = {
    local: mapError({ code: 'unauthorized' }).message,
    siwc: mapError({ code: 'gateway_auth' }).message,
    modelo: mapError({ code: 'model_not_available' }).message,
    parcial: mapError({ code: 'stream_interrupted' }).message,
  };
  const unicos = new Set(Object.values(textos));
  igual(unicos.size, 4, 'quatro mensagens diferentes');
  contem(textos.local, 'chave LOCAL', 'chave local se identifica');
  contem(textos.siwc, '/auth/start', 'SIWC aponta a autorização');
  contem(textos.parcial, 'incompleto', 'parcial avisa que está incompleto');
});

teste('D6. mapError não tem código duplicado nem cita ferramenta inexistente', () => {
  const fonte = readFileSync(join(SRC_KIRANA, 'errors.js'), 'utf8');
  const chaves = [...fonte.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
  const repetidas = chaves.filter((c, i) => chaves.indexOf(c) !== i);
  igual(repetidas.length, 0, `códigos repetidos: ${repetidas.join(',')}`);
  const citados = [...fonte.matchAll(/tools[\\/]([a-z-]+\.mjs)/g)].map((m) => m[1]);
  for (const arquivo of new Set(citados)) {
    const caminho = join(RAIZ, 'tools', arquivo);
    let existe = true;
    try { readFileSync(caminho); } catch { existe = false; }
    if (!existe) throw new Error(`mensagem cita tools/${arquivo}, que não existe no pacote`);
  }
});

/* ================================ E ================================ */
console.log('\nE. Modelos — catálogo anunciado × capacidade declarada');

const { escolherModelo, normalizarModelo } = await import(join(SRC_KIRANA, 'model-choice.js'));

teste('E1. primário anunciado é mantido (sem inventar nada)', () => {
  const r = escolherModelo({ models: ['gpt-5', 'gpt-5-mini'], primary: 'gpt-5', fallback: 'gpt-5-mini' });
  igual(r.active, 'gpt-5', 'modelo ativo');
  igual(r.auto, false, 'não foi escolha automática');
  igual(r.motivo, 'primario_anunciado', 'motivo');
});

teste('E2. primário fora, fallback anunciado → fallback marcado como degradado', () => {
  const r = escolherModelo({ models: ['gpt-5-mini'], primary: 'gpt-6-luna', fallback: 'gpt-5-mini' });
  igual(r.active, 'gpt-5-mini', 'modelo ativo');
  igual(r.degraded, true, 'degradado');
  igual(r.motivo, 'fallback_anunciado', 'motivo');
});

teste('E3. só modelos de áudio/imagem/embedding → não escolhe nenhum deles', () => {
  const r = escolherModelo({
    models: ['text-embedding-3-large', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-image-1'],
    primary: 'gpt-6-luna',
    fallback: 'gpt-6-sol',
  });
  igual(r.motivo, 'sem_candidato', 'motivo');
  igual(r.auto, false, 'não escolheu automaticamente');
  igual(r.active, 'gpt-6-luna', 'mantém o configurado');
  igual(r.verificado, false, 'não afirma compatibilidade');
});

teste('E4. catálogo vazio → motivo próprio e orientação de autorizar', () => {
  const r = escolherModelo({ models: [], primary: 'gpt-6-luna', fallback: 'gpt-6-sol' });
  igual(r.motivo, 'catalogo_vazio', 'motivo');
  contem(r.note, '/auth/start', 'aponta a autorização');
  igual(r.active, 'gpt-6-luna', 'mantém o configurado');
});

teste('E5. falha de descoberta tem motivo e mensagem DIFERENTES de catálogo vazio', () => {
  const falha = escolherModelo({ models: [], primary: 'x', fallback: 'y', descobertaFalhou: true });
  const vazio = escolherModelo({ models: [], primary: 'x', fallback: 'y' });
  igual(falha.motivo, 'descoberta_falhou', 'motivo da falha');
  diferente(falha.note, vazio.note, 'mensagem');
});

teste('E6. capacidade declarada manda: tools:false é descartado quando há ferramentas', () => {
  const catalogo = [
    { id: 'modelo-sem-tools', capabilities: { chat: true, tools: false } },
    { id: 'modelo-com-tools', capabilities: { chat: true, tools: true, streaming: true } },
  ];
  const r = escolherModelo({ models: catalogo, primary: 'inexistente', fallback: 'inexistente2', requerFerramentas: true });
  igual(r.active, 'modelo-com-tools', 'escolheu o que declara tools');
  igual(r.verificado, true, 'declarado = verificado');
});

teste('E7. chat:false nunca é escolhido, mesmo sendo o primeiro da lista', () => {
  const catalogo = [
    { id: 'aaa-nao-conversa', capabilities: { chat: false } },
    { id: 'zzz-conversa', capabilities: { chat: true } },
  ];
  const r = escolherModelo({ models: catalogo, primary: 'x', fallback: 'y', requerFerramentas: true });
  igual(r.active, 'zzz-conversa', 'modelo escolhido');
});

teste('E8. sem metadados de capacidade a escolha é hipótese, não promessa', () => {
  const r = escolherModelo({ models: ['gpt-5', 'gpt-5-mini'], primary: 'modelo-antigo', fallback: 'outro-antigo' });
  igual(r.verificado, false, 'não afirma verificação');
  contem(r.note, 'confirmada na primeira resposta', 'explica como será confirmada');
  igual(r.motivo, 'escolhido_do_catalogo', 'motivo');
});

teste('E9. escolha é determinística (mesma entrada → mesmo resultado)', () => {
  const entrada = { models: ['z-model', 'b-model', 'a-model'], primary: 'p', fallback: 'f' };
  const a = escolherModelo(entrada);
  const b = escolherModelo({ ...entrada, models: ['a-model', 'b-model', 'z-model'] });
  igual(a.active, b.active, 'ordem do catálogo não muda a escolha');
});

teste('E10. normalizarModelo lê capacidades das três formas aceitas', () => {
  igual(normalizarModelo({ id: 'a', capabilities: { chat: true } }).capacidades.chat, true, 'objeto');
  igual(normalizarModelo({ id: 'b', capabilities_list: ['chat', 'streaming'] }).capacidades.chat, true, 'lista');
  igual(normalizarModelo({ id: 'c', supported_parameters: ['tools'] }).capacidades.tools, true, 'supported_parameters');
  igual(normalizarModelo('d').capacidades, null, 'string sem metadado');
});

await teste('E11. ferramenta de diagnóstico existe, é executável e não imprime a chave', async () => {
  const caminho = join(RAIZ, 'tools', 'diagnosticar-modelos.mjs');
  const fonte = readFileSync(caminho, 'utf8');
  if (/console\.log\([^)]*chaveGateway\s*\)/.test(fonte)) throw new Error('imprime a chave');
  if (/\$\{chaveGateway\}|'\s*\+\s*chaveGateway/.test(fonte)) throw new Error('interpola a chave na saída');
  // exit 1 é esperado quando há problema (sem .env/sem Gateway): o conteúdo é o mesmo
  let saida = '';
  try {
    saida = execFileSync(process.execPath, [caminho, '--json'], { encoding: 'utf8', stdio: 'pipe', cwd: RAIZ });
  } catch (e) {
    saida = e.stdout || '';
  }
  const json = JSON.parse(saida);
  if (!('chaveLocal' in json)) throw new Error('não reporta estado da chave local');
  if (JSON.stringify(json).includes('Bearer')) throw new Error('vazou cabeçalho de autorização');
});

/* ========================= F. diagnóstico ========================= */
console.log('\nF. Diagnóstico de modelos — causas diferentes, mensagens diferentes');

/** Sobe um Gateway falso com o comportamento pedido e roda a ferramenta contra ele. */
async function rodarDiagnostico({ health, modelsStatus, modelsBody }) {
  const servidor = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(health));
    }
    if (req.url === '/v1/models') {
      res.writeHead(modelsStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(modelsBody));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  try {
    // execFile ASSÍNCRONO de propósito: com execFileSync o event loop do teste
    // ficaria travado e o servidor falso não responderia (deadlock de 8 s).
    const { stdout } = await execFileAsync(process.execPath, [join(RAIZ, 'tools', 'diagnosticar-modelos.mjs'), '--json'], {
      encoding: 'utf8',
      cwd: RAIZ,
      env: { ...process.env, KIRANA_GATEWAY_URL: `http://127.0.0.1:${porta}` },
    });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(e.stdout || '{}');
  } finally {
    servidor.close();
  }
}

await teste('F1. 401 por chave local e 401 por falta de SIWC geram diagnósticos DIFERENTES', async () => {
  const local = await rodarDiagnostico({
    health: { status: 'ok', version: '0.4.1', authenticated: false },
    modelsStatus: 401,
    modelsBody: { error: { message: 'Missing or invalid gateway bearer key.', code: 'invalid_api_key' } },
  });
  const siwc = await rodarDiagnostico({
    health: { status: 'ok', version: '0.4.1', authenticated: false },
    modelsStatus: 401,
    modelsBody: { error: { message: 'Run the local Sign in with ChatGPT flow first.', code: 'authentication_required' } },
  });
  const textoLocal = local.diagnosticos.map((d) => d.texto).join(' ');
  const textoSiwc = siwc.diagnosticos.map((d) => d.texto).join(' ');
  contem(textoLocal, 'CHAVE LOCAL', '401 de chave local');
  contem(textoSiwc, 'auth/start', '401 de SIWC aponta a autorização');
  if (/CHAVE LOCAL/.test(textoSiwc)) throw new Error('401 de SIWC foi rotulado como chave local');
  const acoesLocal = JSON.stringify(local.escolha?.motivo);
  const acoesSiwc = JSON.stringify(siwc.escolha?.motivo);
  if (acoesLocal !== acoesSiwc) throw new Error('a escolha de modelo divergiu onde deveria ser igual');
});

await teste('F2. catálogo autenticado: a ferramenta mostra o modelo que a Kirana usaria', async () => {
  const r = await rodarDiagnostico({
    health: { status: 'ok', version: '0.4.1', authenticated: true },
    modelsStatus: 200,
    modelsBody: { object: 'list', data: [{ id: 'gpt-5' }, { id: 'text-embedding-3-small' }] },
  });
  igual(r.modelos.length, 2, 'modelos listados');
  if (!r.escolha || !r.escolha.active) throw new Error('não informou a escolha');
  igual(r.escolha.verificado, false, 'sem metadados não afirma verificação');
  contem(JSON.stringify(r.diagnosticos.map((d) => d.texto)), 'não declara capacidades', 'aviso de capacidade');
});

await teste('F3. lista vazia é reportada como falta de autorização, não como "sem modelos"', async () => {
  const r = await rodarDiagnostico({
    health: { status: 'ok', version: '0.4.1', authenticated: true },
    modelsStatus: 200,
    modelsBody: { object: 'list', data: [] },
  });
  const textos = r.diagnosticos.map((d) => d.texto).join(' ');
  contem(textos, 'VAZIA', 'lista vazia');
  contem(textos, 'autoriza', 'aponta a autorização');
});

/* ------------------------------ resumo ------------------------------ */
console.log('');
if (falhas.length) {
  console.log(`RESULTADO: ${falhas.length} falha(s), ${passou} teste(s) passaram.`);
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`RESULTADO: ${passou}/${passou} testes passaram.`);
