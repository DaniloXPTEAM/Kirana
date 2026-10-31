#!/usr/bin/env node
/**
 * teste-correcoes.mjs — testes de regressão das correções desta entrega.
 *
 * Roda sem dependências externas (node puro) e sem credenciais.
 * Uso:  node tools\teste-correcoes.mjs
 * Saída: 0 = todos passaram; 1 = alguma falha.
 *
 * Cobre:
 *   1. parser SSE do Gateway: frame terminal sem linha em branco final
 *      (regressão do "a conversa recebeu texto e não concluiu");
 *   2. parser SSE: caractere multi-byte partido entre dois chunks (acento);
 *   3. escolha de modelo diante do catálogo real anunciado;
 *   4. fusão de .env preservando comentários, ordem e CRLF;
 *   5. verificador: modo release × modo instalação.
 */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, appendFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let passou = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    fn();
    passou++;
    console.log(`  ok   ${nome}`);
  } catch (e) {
    falhas.push(`${nome}: ${e.message}`);
    console.log(`  FAIL ${nome}`);
    console.log(`       ${e.message}`);
  }
}
const igual = (a, b, rotulo = '') => {
  if (a !== b) throw new Error(`${rotulo} esperado ${JSON.stringify(b)}, recebido ${JSON.stringify(a)}`);
};
const verdade = (v, rotulo = '') => {
  if (!v) throw new Error(`${rotulo} esperado verdadeiro`);
};

/* ============================ 1 e 2. parser SSE ========================== */
const { parseSse } = await import(join(RAIZ, 'Gateway', 'src', 'responses.js'));

/** Monta um ReadableStream a partir de pedaços de texto, com encoding controlado. */
function streamDeTexto(pedacos) {
  const partes = pedacos.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p));
  return new ReadableStream({
    start(controller) {
      for (const parte of partes) controller.enqueue(parte);
      controller.close();
    },
  });
}

async function coletar(stream) {
  const saida = [];
  for await (const evt of parseSse(stream)) saida.push(evt);
  return saida;
}

console.log('\n1-2. Parser SSE do Gateway');

await teste('frame terminal comparece mesmo sem linha em branco final', async () => {
  // Este é o caso real: o provedor fecha o stream logo depois do último evento.
  const stream = streamDeTexto([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Olá"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-x"}}',
  ]);
  const eventos = await coletar(stream);
  const tipos = eventos.map((e) => e.type);
  verdade(tipos.includes('response.output_text.delta'), 'delta');
  verdade(tipos.includes('response.completed'), 'completed (sem \n\n final)');
});

await teste('frame terminal único e sem "type" herda o nome do evento', async () => {
  const stream = streamDeTexto(['event: response.completed\ndata: {"response":{"model":"gpt-x"}}']);
  const eventos = await coletar(stream);
  igual(eventos.length, 1, 'eventos');
  igual(eventos[0].event, 'response.completed', 'evento herdado');
});

await teste('acento partido entre dois chunks não corrompe o texto', async () => {
  const corpo = 'data: {"type":"response.output_text.delta","delta":"coração e ação"}\n\n';
  const bytes = new TextEncoder().encode(corpo);
  // Corta no meio de um byte multi-byte (o "ç" e o "ã" são 2 bytes em UTF-8).
  const posicao = bytes.indexOf(0xc3) + 1;
  const stream = streamDeTexto([bytes.slice(0, posicao), bytes.slice(posicao)]);
  const eventos = await coletar(stream);
  igual(eventos.length, 1, 'eventos');
  igual(eventos[0].delta, 'coração e ação', 'texto decodificado');
});

await teste('stream vazio termina sem lançar', async () => {
  const eventos = await coletar(streamDeTexto([]));
  igual(eventos.length, 0, 'eventos');
});

await teste('comentário/keep-alive é ignorado', async () => {
  const stream = streamDeTexto([': keep-alive\n\n', 'data: {"type":"x"}\n\n']);
  const eventos = await coletar(stream);
  igual(eventos.length, 1, 'eventos');
});

await teste('[DONE] não vira evento', async () => {
  const stream = streamDeTexto(['data: [DONE]\n\n']);
  igual((await coletar(stream)).length, 0, 'eventos');
});

/* ======================= 3. escolha de modelo ============================ */
const { escolherModelo, primeiroModeloDeConversa } = await import(join(RAIZ, 'Kirana', 'src', 'model-choice.js'));

console.log('\n3. Escolha de modelo pelo catálogo real');

await teste('primário no catálogo é usado', () => {
  const r = escolherModelo({ models: ['a', 'gpt-6-luna'], primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol' });
  igual(r.active, 'gpt-6-luna');
  igual(r.auto, false);
});

await teste('primário fora, fallback dentro → usa fallback', () => {
  const r = escolherModelo({ models: ['gpt-6.1-sol'], primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol' });
  igual(r.active, 'gpt-6.1-sol');
  igual(r.degraded, true);
});

await teste('NENHUM dos configurados no catálogo → escolhe do catálogo (bug antigo mantinha o primário)', () => {
  const r = escolherModelo({ models: ['gpt-5.1', 'gpt-5-mini'], primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol' });
  verdade(['gpt-5.1', 'gpt-5-mini'].includes(r.active), `ativo ${r.active}`);
  igual(r.auto, true);
  // revisão 2: a nota não promete compatibilidade — diz que o catálogo foi a fonte
  verdade(/escolhido/.test(r.note) && /catálogo|lista anunciada/.test(r.note), `aviso: ${r.note}`);
  igual(r.verificado, false, 'sem metadados não há verificação');
});

await teste('escolha é determinística (mesma entrada, mesma saída)', () => {
  const modelos = ['zeta', 'alfa-gpt', 'beta-gpt'];
  const a = escolherModelo({ models: modelos, primary: 'x', fallback: 'y' }).active;
  const b = escolherModelo({ models: [...modelos].reverse(), primary: 'x', fallback: 'y' }).active;
  igual(a, b, 'ordem não deve influenciar');
});

await teste('embeddings/whisper/tts são descartados', () => {
  const escolhido = primeiroModeloDeConversa(['text-embedding-3-small', 'whisper-1', 'tts-1', 'gpt-4o-mini']);
  igual(escolhido, 'gpt-4o-mini');
});

await teste('catálogo vazio → mantém o configurado e avisa (não inventa)', () => {
  const r = escolherModelo({ models: [], primary: 'gpt-6-luna', fallback: 'gpt-6.1-sol' });
  igual(r.active, 'gpt-6-luna');
  igual(r.auto, false);
  verdade(/não anunciou nenhum modelo/i.test(r.note), 'aviso de catálogo vazio');
});

/* ====================== 4. fusão de .env ================================= */
const { lerEnv, definirVariavel } = await import(join(RAIZ, 'tools', 'configurar.mjs'));

console.log('\n4. Fusão de .env');

await teste('alinhar a chave preserva comentários, ordem e CRLF', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'env-'));
  const arquivo = join(pasta, '.env');
  const original = '# título\r\n# comentário\r\nOUTRA=1\r\nKIRANA_GATEWAY_API_KEY=antiga\r\nFIM=2\r\n';
  writeFileSync(arquivo, original);
  definirVariavel(arquivo, 'KIRANA_GATEWAY_API_KEY', 'nova-chave-de-32-caracteres-abcdefghij');
  const depois = readFileSync(arquivo, 'utf8');
  verdade(depois.includes('# título') && depois.includes('# comentário'), 'comentários');
  verdade(depois.includes('OUTRA=1') && depois.includes('FIM=2'), 'outras variáveis');
  verdade(!depois.includes('antiga'), 'valor antigo substituído');
  verdade(depois.includes('\r\n'), 'CRLF preservado');
  igual(lerEnv(arquivo).KIRANA_GATEWAY_API_KEY, 'nova-chave-de-32-caracteres-abcdefghij');
  rmSync(pasta, { recursive: true, force: true });
});

await teste('variável ausente é acrescentada uma única vez', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'env-'));
  const arquivo = join(pasta, '.env');
  writeFileSync(arquivo, 'A=1\n');
  definirVariavel(arquivo, 'NOVA', 'v');
  definirVariavel(arquivo, 'NOVA', 'v2');
  const linhas = readFileSync(arquivo, 'utf8').split('\n').filter((l) => l.startsWith('NOVA='));
  igual(linhas.length, 1, 'linhas NOVA');
  igual(linhas[0], 'NOVA=v2');
  rmSync(pasta, { recursive: true, force: true });
});

/* ================= 5. verificador release × instalação =================== */
console.log('\n5. Verificador: release × instalação');

function montarPacoteFalso() {
  const base = mkdtempSync(join(tmpdir(), 'pacote-'));
  const copiar = (rel) => {
    mkdirSync(join(base, dirname(rel)), { recursive: true });
    writeFileSync(join(base, rel), readFileSync(join(RAIZ, rel)));
  };
  // mínimo para o verificador rodar: package.json, motor, marcadores e scripts
  for (const rel of [
    'Gateway/package.json',
    'Gateway/src/engine.js',
    'Gateway/src/gateway.js',
    'Gateway/src/responses.js',
    'Gateway/config/models.json',
    'Kirana/package.json',
    'Kirana/src/server.js',
    'Kirana/src/config.js',
    'Kirana/src/gateway-bridge.js',
    'tools/configurar.mjs',
    'README.md',
    'INSTALAR-WINDOWS.cmd',
    'INICIAR-TUDO.cmd',
    'PARAR-TUDO.cmd',
    'DIAGNOSTICO.cmd',
    // arquivos da consolidação REV4 que o verificador passou a exigir
    'VALIDAR-MODELOS-REAIS.cmd',
    'VERSAO-DISTRIBUICAO.txt',
  ]) {
    try {
      copiar(rel);
    } catch {
      /* arquivo opcional ausente: o verificador tem as próprias checagens */
    }
  }
  // docs/ e tools/ inteiros: o verificador passou a exigir a documentação nova e a
  // existência das ferramentas citadas nas mensagens de erro. Copiar a pasta real
  // mantém este teste fiel ao pacote, sem lista que envelhece.
  for (const pasta of ['docs', 'tools']) {
    let nomes = [];
    try {
      nomes = readdirSync(join(RAIZ, pasta));
    } catch {
      continue;
    }
    for (const nome of nomes) {
      if (pasta === 'tools' && nome === 'teste-correcoes.mjs') continue;
      // cpSync copia subpastas (docs/validacao/), não só arquivos soltos:
      // sem isso o pacote falso ficaria sem a pasta de relatórios da REV4.
      try {
        cpSync(join(RAIZ, pasta, nome), join(base, pasta, nome), { recursive: true });
      } catch {
        /* item opcional */
      }
    }
  }
  for (const rel of [
    'scripts/Comum.ps1', 'scripts/Instalar.ps1', 'scripts/Iniciar-Tudo.ps1',
    'scripts/Parar-Tudo.ps1', 'scripts/Diagnostico.ps1', 'scripts/Migrar-Env.ps1',
    'docs/CAUSA-RAIZ-E-CORRECAO.md', 'docs/INSTALACAO-LIMPA.md',
    'docs/MIGRACAO-ENV-E-SIWC.md', 'docs/TESTES-EXECUTADOS.md',
  ]) {
    try {
      copiar(rel);
    } catch {
      /* idem */
    }
  }
  writeFileSync(join(base, 'tools', 'verificar-pacote.mjs'), readFileSync(join(RAIZ, 'tools', 'verificar-pacote.mjs')));
  writeFileSync(join(base, 'tools', 'checar-config.mjs'), readFileSync(join(RAIZ, 'tools', 'checar-config.mjs')));
  return base;
}

function rodarVerificador(base, modo) {
  try {
    const saida = execFileSync(process.execPath, [join(base, 'tools', 'verificar-pacote.mjs'), modo], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { codigo: 0, saida };
  } catch (e) {
    return { codigo: e.status ?? 1, saida: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

await teste('release aprova pacote limpo', () => {
  const base = montarPacoteFalso();
  const r = rodarVerificador(base, '--release');
  verdade(r.codigo === 0, `código ${r.codigo}\n${r.saida.slice(-600)}`);
  rmSync(base, { recursive: true, force: true });
});

await teste('release REPROVA quando há node_modules/.env/.local-state/data', () => {
  const base = montarPacoteFalso();
  for (const rel of ['Kirana/node_modules/x', 'Gateway/node_modules/y', 'Kirana/data/s.json', 'Gateway/.local-state/z.json']) {
    mkdirSync(join(base, dirname(rel)), { recursive: true });
    writeFileSync(join(base, rel), '{}');
  }
  writeFileSync(join(base, 'Gateway', '.env'), 'GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=1455\n');
  writeFileSync(join(base, 'Kirana', '.env'), 'KIRANA_GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nKIRANA_PORT=3000\n');
  const r = rodarVerificador(base, '--release');
  verdade(r.codigo !== 0, 'release deveria reprovar');
  verdade(/não deve ser distribuído/.test(r.saida), 'mensagem de reprovação');
  rmSync(base, { recursive: true, force: true });
});

await teste('instalação APROVA a mesma pasta já usada (defeito nº 1)', () => {
  const base = montarPacoteFalso();
  for (const rel of ['Kirana/node_modules/x', 'Gateway/node_modules/y', 'Kirana/data/s.json', 'Gateway/.local-state/z.json']) {
    mkdirSync(join(base, dirname(rel)), { recursive: true });
    writeFileSync(join(base, rel), '{}');
  }
  writeFileSync(join(base, 'Gateway', '.env'), 'GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=1455\n');
  writeFileSync(join(base, 'Kirana', '.env'), 'KIRANA_GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nKIRANA_PORT=3000\nKIRANA_GATEWAY_URL=http://127.0.0.1:1455\n');
  const r = rodarVerificador(base, '--instalacao');
  verdade(r.codigo === 0, `código ${r.codigo}\n${r.saida.slice(-800)}`);
  rmSync(base, { recursive: true, force: true });
});

await teste('instalação avisa (não bloqueia) quando chaves divergem', () => {
  const base = montarPacoteFalso();
  mkdirSync(join(base, 'Gateway', 'node_modules'), { recursive: true });
  writeFileSync(join(base, 'Gateway', 'node_modules', 'x'), '{}');
  mkdirSync(join(base, 'Kirana', 'node_modules'), { recursive: true });
  writeFileSync(join(base, 'Kirana', 'node_modules', 'x'), '{}');
  writeFileSync(join(base, 'Gateway', '.env'), 'GATEWAY_API_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nPORT=1455\n');
  writeFileSync(join(base, 'Kirana', '.env'), 'KIRANA_GATEWAY_API_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nKIRANA_PORT=3000\n');
  const r = rodarVerificador(base, '--instalacao');
  verdade(r.codigo === 0, `não deveria bloquear o instalador (código ${r.codigo})`);
  verdade(/divergentes/.test(r.saida), 'aviso de divergência');
  rmSync(base, { recursive: true, force: true });
});

/* ============================== resultado ================================ */
console.log('');
if (falhas.length) {
  console.log(`RESULTADO: ${passou} passaram, ${falhas.length} falharam.`);
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`RESULTADO: ${passou}/${passou} testes passaram.`);
process.exit(0);
