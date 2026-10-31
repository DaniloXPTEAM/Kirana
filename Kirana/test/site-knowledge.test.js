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

import { loadKnowledge, tokenize, stem, parseFrontMatter, chunkBody, buildKnowledgePrompt } from '../src/knowledge/index.js';

const KNOWLEDGE_DIR = path.join('sites', 'opportunity-ai', 'knowledge');
const site = {
  id: 'opportunity-ai',
  name: 'Opportunity AI',
  siteUrl: 'https://opportunity.ia.br',
  agentName: 'Kirana',
  pages: [],
};

test('a base do site existe, tem os 17 documentos e todos citam fonte e data', () => {
  const knowledge = loadKnowledge({ dir: KNOWLEDGE_DIR });
  assert.equal(knowledge.docs.length, 17, 'documentos esperados: 17 (11 iniciais + soluções, privacidade, termos, sites e sistemas, estrutura do site e conceitos)');
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
  assert.match(knowledge.doc('privacidade').body, /Cloudflare/);
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
