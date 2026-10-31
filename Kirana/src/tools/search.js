/** Busca textual simples, sem dependências, tolerante a acentos. */
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const tokenize = (text) =>
  normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);

/**
 * Pontua itens por proximidade com a consulta.
 * Compara nome, descrição, categoria e palavras-chave.
 */
export function rankItems(items, query, { fields = ['nome', 'descricao', 'categoria'], keywordsField = 'palavras_chave' } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return items.map((item) => ({ item, score: 0 }));

  return items
    .map((item) => {
      const haystacks = fields.map((field) => normalizeText(item[field]));
      const keywords = (item[keywordsField] || []).map(normalizeText);
      let score = 0;
      for (const token of tokens) {
        for (const hay of haystacks) {
          if (!hay) continue;
          if (hay === token) score += 6;
          else if (hay.includes(token)) score += 3;
        }
        for (const keyword of keywords) {
          if (keyword === token) score += 5;
          else if (keyword.includes(token) || token.includes(keyword)) score += 2;
        }
      }
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
}
