/**
 * Base de conhecimento do site (Fase 4).
 *
 * Escolha técnica: **recuperação estruturada + BM25 sobre Markdown**, sem
 * dependências novas e sem serviço pago. Por quê:
 *
 *  - o conteúdo do site é pequeno (dezenas de páginas, ~15 KB de texto), onde
 *    busca léxica supera embeddings em custo e previsibilidade;
 *  - a resposta precisa ser **rastreável**: cada trecho carrega `source` (URL) e
 *    `capturedAt`, e o prompt exige citar a página de origem;
 *  - quando a resposta não existe na base, o certo é dizer que não está
 *    publicado — não aproximar de um vizinho semântico.
 *
 * O formato é Markdown com front matter simples (id, title, source, serviceId,
 * tags, capturedAt). O mesmo diretório é lido por `scripts/site-sync.mjs`, que
 * compara o conhecimento com o site publicado e avisa o que mudou.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Palavras vazias — normalizadas na criação.
 *
 * Detalhe que custou caro: a lista acima é escrita com acentos ("você", "não"),
 * mas o tokenizador remove acentos. Comparar token sem acento contra lista com
 * acento nunca casa, e "você/vocês" sobreviviam como termo de busca — o que
 * fazia QUALQUER pergunta casar com o mesmo trecho genérico. A lista é
 * normalizada com a mesma função do texto.
 */
const RAW_STOPWORDS =
  'a o as os um uma uns umas de do da dos das em no na nos nas por para com sem que se e ou ' +
  'ao aos à às é são ser está estão foi era como qual quais quando onde quem quanto quantos ' +
  'sobre entre mais menos muito pouco já não sim isso isto aquilo eu você vocês nós eles elas ' +
  'me te lhe nos vos the of and to in is are for you we it';

function deaccent(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const STOPWORDS = new Set(RAW_STOPWORDS.split(/\s+/).map(deaccent).filter(Boolean));

/** Normaliza para comparação: sem acento, minúsculo, tokens úteis. */
export function tokenize(text) {
  return deaccent(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Radical simples para português.
 *
 * Por que existe: o visitante escreve "como vocês trabalham?" e a base guarda
 * "trabalho". Sem radical, a busca léxica perde exatamente as flexões de verbo
 * mais comuns em pergunta. Aqui não há stemmer completo (não vale a
 * dependência): é uma lista curta de sufixos, aplicada só quando sobra um
 * radical de 4+ letras. Indexação e consulta passam pela MESMA função, então
 * qualquer colisão acontece dos dois lados e não cria falso positivo sozinha.
 */
const DERIVATIONAL = ['amentos', 'amento', 'imentos', 'imento', 'mente', 'ndo', 'ado', 'ada', 'ido', 'ida', 'cao', 'oes'];

export function stem(token) {
  let word = String(token ?? '');
  if (word.length < 6) return word;

  // Plural primeiro: "contatos" e "contato" precisam cair no mesmo radical.
  if (word.endsWith('oes')) word = `${word.slice(0, -3)}ao`;
  else if (word.endsWith('s') && !word.endsWith('ss') && word.length >= 6) word = word.slice(0, -1);

  for (const suffix of DERIVATIONAL) {
    if (word.length >= suffix.length + 4 && word.endsWith(suffix)) {
      word = word.slice(0, -suffix.length);
      break;
    }
  }

  // Terminações verbais comuns em pergunta ("trabalham", "trabalhar") e o "o"
  // final de substantivo longo ("trabalho", "contato"), só com radical de 5+.
  if (word.length >= 7 && /[aeo]$/.test(word)) word = word.slice(0, -1);
  else if (/(?:am|em|ar|er|ir)$/.test(word) && word.length >= 7) word = word.slice(0, -2);

  return word.length >= 4 ? word : String(token ?? '');
}

/** Front matter mínimo: `---` ... `---` no topo, `chave: valor` por linha. */
export function parseFrontMatter(raw) {
  const text = String(raw ?? '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    meta[key] = value;
  }
  return { meta, body: text.slice(match[0].length) };
}

/** Quebra o corpo em trechos por cabeçalho (o que a busca devolve). */
export function chunkBody(body, { maxChars = 1200 } = {}) {
  const blocks = [];
  let current = { heading: '', lines: [] };
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^#{1,4}\s+/.test(line)) {
      if (current.lines.join('').trim()) blocks.push(current);
      current = { heading: line.replace(/^#{1,4}\s+/, '').trim(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.join('').trim()) blocks.push(current);
  return blocks.map((block) => {
    const text = block.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    return { heading: block.heading, text };
  });
}

/**
 * Índice BM25 sobre os trechos.
 *
 * BM25 é usado (e não TF-IDF puro) porque satura a repetição de termos e
 * normaliza pelo tamanho do trecho: numa base pequena isso evita que um
 * documento longo "ganhe" só por ter mais palavras.
 */
function buildIndex(chunks) {
  const docFreq = new Map();
  const tokenized = chunks.map((chunk) => {
    const tokens = tokenize(`${chunk.title} ${chunk.heading} ${chunk.text}`).map(stem);
    for (const token of new Set(tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    return tokens;
  });
  const avgLen = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / (tokenized.length || 1);
  return { docFreq, tokenized, avgLen, total: chunks.length };
}

function bm25Score(index, chunkIndex, queryTokens, { k1 = 1.4, b = 0.7 } = {}) {
  const tokens = index.tokenized[chunkIndex];
  if (!tokens?.length) return 0;
  const freq = new Map();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    const tf = freq.get(token) ?? 0;
    if (!tf) continue;
    const df = index.docFreq.get(token) ?? 0;
    const idf = Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / index.avgLen)));
  }
  return score;
}

/**
 * Carrega um diretório de conhecimento.
 *
 * Devolve uma instância imutável com busca e consultas estruturadas. `reload()`
 * existe para a atualização automática: o servidor pode recarregar sem reiniciar.
 */
export function loadKnowledge({ dir, logger } = {}) {
  const docs = [];
  const warnings = [];

  if (dir && fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        const { meta, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
        const id = meta.id || entry.name.replace(/\.md$/, '');
        const title = meta.title || id;
        const chunks = chunkBody(body).map((chunk, position) => ({
          docId: id,
          title,
          source: meta.source || null,
          capturedAt: meta.capturedAt || null,
          serviceId: meta.serviceId || null,
          path: meta.path || null,
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          heading: chunk.heading,
          text: chunk.text,
          position,
          file: entry.name,
          mtimeMs: stat.mtimeMs,
        }));
        docs.push({
          id,
          title,
          source: meta.source || null,
          capturedAt: meta.capturedAt || null,
          serviceId: meta.serviceId || null,
          path: meta.path || null,
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          body: body.trim(),
          file: entry.name,
          chunks,
        });
      } catch (error) {
        warnings.push(`${entry.name}: ${error?.message}`);
        logger?.warn?.('Falha ao ler conhecimento', { file: entry.name, message: error?.message });
      }
    }
  } else {
    warnings.push('diretório de conhecimento ausente');
  }

  const chunks = docs.flatMap((doc) => doc.chunks);
  const index = buildIndex(chunks);

  const api = {
    dir: dir ?? null,
    docs,
    chunks,
    warnings,
    get empty() {
      return docs.length === 0;
    },

    /** Busca por relevância. Devolve trechos com a fonte. */
    search(query, { limit = 4, minScore = 0.05 } = {}) {
      const queryTokens = tokenize(query).map(stem);
      if (!queryTokens.length || !chunks.length) return [];
      const scored = chunks
        .map((chunk, position) => ({ chunk, score: bm25Score(index, position, queryTokens) }))
        .filter((entry) => entry.score > minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return scored.map(({ chunk, score }) => ({
        docId: chunk.docId,
        title: chunk.title,
        heading: chunk.heading,
        text: chunk.text,
        source: chunk.source,
        capturedAt: chunk.capturedAt,
        serviceId: chunk.serviceId,
        score: Number(score.toFixed(3)),
      }));
    },

    /** Documento inteiro (usado por `explain_*`). */
    doc(id) {
      return docs.find((doc) => doc.id === id) ?? null;
    },

    /** Documento da solução pelo id do serviço. */
    serviceDoc(serviceId) {
      return docs.find((doc) => doc.serviceId === serviceId) ?? null;
    },

    /** Lista de soluções (id, título, caminho), na ordem do diretório. */
    services() {
      return docs
        .filter((doc) => doc.serviceId)
        .map((doc) => ({
          serviceId: doc.serviceId,
          title: doc.title,
          path: doc.path,
          source: doc.source,
        }));
    },

    /** Resumo curto de todas as soluções, para o prompt. */
    listServicesText() {
      return api
        .services()
        .map((service) => {
          const doc = api.serviceDoc(service.serviceId);
          const firstLine = doc?.body.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? '';
          return `- ${service.title} (${service.serviceId}) — ${firstLine}`;
        })
        .join('\n');
    },
  };

  return api;
}

/**
 * Bloco de conhecimento para o prompt de sistema.
 *
 * Deliberadamente curto: o modelo recebe o essencial e usa as ferramentas
 * (`list_services`, `explain_service`, busca) para o resto. Despejar 15 KB de
 * Markdown no prompt encareceria cada turno e aumentaria a chance de o modelo
 * citar algo que a ferramenta não confirmou.
 */
export function buildKnowledgePrompt(knowledge, site, { maxServices = 8 } = {}) {
  if (!knowledge || knowledge.empty) return '';
  const services = knowledge.services().slice(0, maxServices);
  const limites = knowledge.doc('limites');
  const lines = [
    `## Conhecimento do site (${site?.name ?? 'site'})`,
    '',
    `Você é ${site?.agentName ?? 'a assistente'} dentro de ${site?.siteUrl ?? site?.name ?? 'um site'}.`,
    'Use as ferramentas do site para consultar o conteúdo real antes de afirmar algo.',
    'Nunca invente preço, prazo, cliente ou funcionalidade.',
    '',
    'Soluções cadastradas:',
    ...services.map((service) => {
      const doc = knowledge.serviceDoc(service.serviceId);
      const resumo = doc?.body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))[0] ?? '';
      return `- ${service.serviceId}: ${service.title} — ${resumo.slice(0, 150)}`;
    }),
  ];
  if (limites) {
    lines.push('', 'Limites conhecidos: sem preços publicados, sem prazos publicados, sem casos de clientes publicados.');
  }
  return lines.join('\n');
}
