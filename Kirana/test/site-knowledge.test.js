/**
 * Fase 4 — base de conhecimento do site (itens 3, 7 e 12 do briefing).
 *
 * O que estes testes protegem
 * ---------------------------
 * A Kirana só pode afirmar o que está no conhecimento. Então o teste não checa
 * "a resposta parece boa": checa que o conteúdo indexado é o conteúdo real
 * capturado do site (front-matter com fonte e data), que a recuperação acha o
 * trecho certo e que nenhum número inventado (preço, prazo) entra na base.
 *
 * Nada aqui usa rede: o diretório é o do repositório.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { loadKnowledge, tokenize, stem, parseFrontMatter, chunkBody, buildKnowledgePrompt, unwrapSoftBreaks } from '../src/knowledge/index.js';

const KNOWLEDGE_DIR = path.join('sites', 'opportunity-ai', 'knowledge');
const site = {
  id: 'opportunity-ai',
  name: 'Opportunity AI',
  siteUrl: 'https://opportunity.ia.br',
  agentName: 'Kirana',
  pages: [],
};

test('a base do site existe, tem os 22 documentos e todos citam fonte e data', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  assert.equal(knowledge.docs.length, 22, 'documentos esperados: 22 (17 anteriores + perfil, detalhes dos projetos, como trabalhamos, demonstração e guia de atendimento)');
  assert.ok(knowledge.chunks.length >= 20, 'chunks suficientes para recuperação');

  for (const doc of knowledge.docs) {
    assert.match(doc.source, /^https:\/\/opportunity\.ia\.br/, `${doc.id}: fonte deve ser o site`);
    assert.match(doc.capturedAt, /^\d{4}-\d{2}-\d{2}$/, `${doc.id}: data de captura em ISO`);
    assert.ok(doc.title.length > 3, `${doc.id}: título`);
  }
  assert.deepEqual(knowledge.warnings, []);
});

test('o catálogo de serviços é o real: 7 frentes com caminho do site', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  const services = knowledge.services();
  assert.deepEqual(
    services.map((service) => service.serviceId).sort(),
    ['agentes-ia', 'atendimento', 'automacao', 'crm-vendas', 'relatorios', 'sites-sistemas', 'voz'],
  );
  for (const service of services) {
    assert.match(service.path, /^\/solucoes\//, `${service.serviceId}: caminho real`);
    assert.ok(service.title.length > 3);
  }
  assert.match(knowledge.listServicesText(), /CRM/);
});

test('não há preço, prazo, plano nem CNPJ na base (nada inventado)', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  const all = knowledge.docs.map((doc) => doc.body).join('\n');
  assert.equal(/R\$\s?\d/.test(all), false, 'nenhum valor em reais');
  assert.equal(/\d+\s*(dias|semanas|meses)\s+(úteis|para|de implementação)/i.test(all), false, 'nenhum prazo publicado');
  assert.equal(/CNPJ\s*[:：]?\s*[\d./-]{10,}/.test(all), false, 'sem CNPJ (a empresa não publica)');
  assert.equal(/plano\s+(básico|essencial|premium|pro)/i.test(all), false, 'sem planos comerciais');
});

test('a recuperação acha o trecho certo para perguntas reais de visitante', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  const cases = [
    ['atendimento pelo whatsapp', 'servico-atendimento'],
    ['vocês fazem CRM de vendas?', 'servico-crm-vendas'],
    ['agente de voz e android', 'servico-voz'],
    ['vocês têm preço?', 'limites'],
    ['como entro em contato', 'contato'],
    ['posso enviar meus arquivos', 'servico-automacao'],
    // Páginas institucionais (adicionadas na verificação final da Fase 4).
    ['vocês têm CNPJ?', 'limites'],
    ['como vocês tratam meus dados', 'privacidade'],
    ['quais são as sete frentes de trabalho', 'solucoes'],
    ['vocês fazem site ou sistema sob medida?', 'servico-sites-sistemas'],
    ['os projetos do labs estão ativos?', 'labs'],
    ['quais são as seções do site', 'estrutura-do-site'],
    ['mensagem pelo formulário vira contrato?', 'termos'],
    // Dossiê completo (perfil, projetos em detalhe, processo, demonstração, guia).
    ['quais funcionalidades tem o opportunity crm', 'projetos-detalhes'],
    ['o que a gabi faz no android', 'projetos-detalhes'],
    ['o armada nexus funciona sem o mordenrpg', 'projetos-detalhes'],
    ['quais são as etapas de como vocês trabalham', 'como-trabalhamos'],
    ['preciso trocar meus sistemas atuais', 'como-trabalhamos'],
    ['a demonstração do agente adaptativo é de verdade', 'demonstracao'],
    ['quem é o fundador e quais são as três marcas', 'perfil'],
    ['como responder quando perguntam o preço e o prazo', 'guia-atendimento'],
  ];
  for (const [query, expected] of cases) {
    const hits = knowledge.search(query, { limit: 3 });
    assert.ok(hits.length > 0, `sem resultado para: ${query}`);
    const docs = hits.map((hit) => hit.docId);
    assert.ok(docs.includes(expected), `"${query}" deveria trazer ${expected}; veio: ${docs.join(',')}`);
  }
});

test('as páginas institucionais têm documento próprio e explicam sem inventar', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  for (const id of ['solucoes', 'privacidade', 'termos']) {
    const doc = knowledge.doc(id);
    assert.ok(doc, `documento ${id} deve existir`);
    assert.match(doc.source, /^https:\/\/opportunity\.ia\.br\/solucoes\/?$|^https:\/\/opportunity\.ia\.br\/(privacidade|termos)$/);
    assert.ok(doc.body.length > 300, `${id}: conteúdo suficiente`);
  }
  // Fatos que a Kirana pode afirmar, porque estão publicados.
  assert.doesNotMatch(knowledge.doc('termos').body, /possui CNPJ/, 'não afirma situação formal que o site não publica');
  assert.match(knowledge.doc('termos').body, /não criam contrato/);
  assert.match(knowledge.doc('privacidade').body, /provedores de\s+infraestrutura/i);
  assert.match(knowledge.doc('privacidade').body, /não usa cookies/);
  assert.match(knowledge.doc('solucoes').body, /pesquisa e prototipagem/i);
});

test('pergunta fora da base não vira resposta: o melhor trecho é o que declara o limite', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  // Pergunta sobre algo que a empresa NÃO publica (preço). O correto é cair no
  // documento que diz "sem preços publicados" — nunca num número inventado.
  const hits = knowledge.search('zzzz qqqq xyzabc preço do plano premium', { limit: 3 });
  const all = hits.map((hit) => hit.text).join(' ');
  assert.equal(/R\$\s?\d/.test(all), false, 'nenhum valor monetário pode aparecer');
  if (hits.length) {
    assert.equal(hits[0].docId, 'limites', `esperado o doc de limites, veio ${hits[0].docId}`);
    assert.match(hits[0].text, /pre[çc]o|plano/i);
  }
  // E uma pergunta de domínio inexistente devolve nada de relevante.
  const nothing = knowledge.search('receita de bolo de cenoura', { limit: 3, minScore: 3 });
  assert.equal(nothing.length, 0);
});

test('o prompt do conhecimento carrega identidade, serviços e regras de honestidade', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  const prompt = buildKnowledgePrompt(knowledge, site);
  assert.match(prompt, /Opportunity AI/);
  assert.match(prompt, /Kirana/);
  assert.match(prompt, /atendimento/i);
  // Regra dura: não inventar preço/plano/prazo.
  assert.match(prompt, /nunca invente|não invente/i);
  assert.match(prompt, /sem pre[çc]os publicados/i);
  assert.match(prompt, /Limites conhecidos/);
  // Resumo fixo do perfil: marcas, frentes, projetos e contato em todo turno.
  assert.match(prompt, /Perfil da empresa/);
  assert.match(prompt, /Opportunity Labs/);
  assert.match(prompt, /Armada Nexus RPG/);
  assert.match(prompt, /\(85\) 99946-2763/);
  assert.ok(prompt.length < 6000, `prompt do sistema precisa continuar enxuto (${prompt.length} B)`);
});

test('tokenize, radical e front-matter são previsíveis (base da recuperação)', () => {
  assert.deepEqual(tokenize('Atendimento por WhatsApp, 24h!'), ['atendimento', 'whatsapp', '24h']);
  // Stopwords com acento precisam sair (senão "você" casa com tudo).
  assert.deepEqual(tokenize('você vocês não sobre como qual'), []);
  // Flexões de pergunta caem no mesmo radical do texto indexado.
  assert.equal(stem('trabalham'), stem('trabalho'));
  assert.equal(stem('contatos'), stem('contato'));
  assert.equal(stem('precos'), stem('preco'));
  const parsed = parseFrontMatter('---\nid: teste\ntitle: "Título"\ntags: [a, b]\n---\nCorpo do texto.');
  assert.equal(parsed.meta.id, 'teste');
  assert.equal(parsed.meta.title, 'Título');
  assert.deepEqual(parsed.meta.tags, ['a', 'b']);
  assert.equal(parsed.body.trim(), 'Corpo do texto.');
  const chunks = chunkBody('## Um\n\ntexto a\n\n## Dois\n\ntexto b', { maxChars: 1200 });
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ['Um', 'Dois']);
  // Seção longa não é cortada: vira vários trechos com o mesmo título e o texto todo continua buscável.
  const longa = Array.from({ length: 12 }, (_, i) => `- item ${i + 1} com um texto razoavelmente comprido para ocupar espaço`).join('\n');
  const partes = chunkBody(`## Lista\n\n${longa}`, { maxChars: 300 });
  assert.ok(partes.length > 1, 'seção longa divide em mais de um trecho');
  assert.ok(partes.every((parte) => parte.heading === 'Lista' && parte.text.length <= 300));
  assert.match(partes.map((parte) => parte.text).join('\n'), /item 12/, 'o fim da seção não some');
});

test('o conhecimento é recarregado quando o arquivo muda (atualização automática)', async () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), '.tmp-knowledge-'));
  try {
    fs.writeFileSync(path.join(tmp, 'doc.md'), '---\nid: um\ntitle: Um\nsource: https://opportunity.ia.br/x\n---\n## Seção\nconteúdo antigo');
    const first = loadKnowledge({ dir: tmp });
    assert.match(first.chunks[0].text, /antigo/);

    // mtime diferente de propósito: é o que o refreshIfStale observa.
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(path.join(tmp, 'doc.md'), '---\nid: um\ntitle: Um\nsource: https://opportunity.ia.br/x\n---\n## Seção\nconteúdo novo');
    fs.utimesSync(path.join(tmp, 'doc.md'), future, future);

    const second = loadKnowledge({ dir: tmp });
    assert.match(second.chunks[0].text, /novo/);
    assert.ok(second.chunks[0].mtimeMs > first.chunks[0].mtimeMs);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('texto quebrado em ~80 colunas chega inteiro: uma linha por parágrafo e por item', () => {
  const entrada = [
    '# Título',
    '',
    'Um parágrafo que foi',
    'quebrado no meio da frase.',
    '',
    '- item um que continua',
    '  na linha de baixo',
    '- item dois',
    '',
    '| a | b |',
    '| - | - |',
    '',
    '```',
    'linha 1',
    'linha 2',
    '```',
  ].join('\n');
  const saida = unwrapSoftBreaks(entrada).split('\n');
  assert.ok(saida.includes('Um parágrafo que foi quebrado no meio da frase.'));
  assert.ok(saida.includes('- item um que continua na linha de baixo'));
  assert.ok(saida.includes('- item dois'));
  assert.ok(saida.includes('| a | b |') && saida.includes('| - | - |'), 'tabelas ficam intactas');
  assert.ok(saida.includes('linha 1') && saida.includes('linha 2'), 'código fica intacto');
});

test('nenhum documento do conhecimento do site tem frase cortada no meio da linha', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  for (const doc of knowledge.docs) {
    const bruto = fs.readFileSync(path.join(KNOWLEDGE_DIR, doc.file), 'utf8').replace(/^---[\s\S]*?\n---\n?/, '');
    // continuação indentada de item ou linha de texto emendada em outra de texto = quebra mole no arquivo
    const moles = bruto.split('\n').filter((linha, i, todas) => /^ {2,}\S/.test(linha) && i > 0 && todas[i - 1].trim() && !/^\s*```/.test(linha));
    assert.deepEqual(moles, [], `${doc.id}: há quebras de linha no meio de frase (o chat as mostra como <br>)`);
  }
});
