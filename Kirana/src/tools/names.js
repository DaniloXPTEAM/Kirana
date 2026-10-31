/**
 * Nomes de ferramentas — normalização entre o que o modelo devolve e o que a
 * Kirana registrou.
 *
 * Por que este arquivo existe
 * ---------------------------
 * O Gateway ChatGPT local (v0.4.x) NÃO repassa as ferramentas do cliente
 * "soltas": ele as envolve em um namespace e devolve o nome da chamada como
 * `gateway.<nome>`.
 *
 * Evidência (código do Gateway, em `integrations/`):
 *
 *   function toNamespacedTools(tools) {
 *     ...
 *     return functions.length ? [{ type: 'namespace', name: 'gateway', ... }] : [];
 *   }
 *   function displayToolName(namespace, name) { return namespace ? `${namespace}.${name}` : name; }
 *
 * Até a v0.5.1 a Kirana procurava o nome **exato** no registro, então
 * `gateway.list_services` não era encontrado e TODA ferramenta virava
 * `unknown_tool` — com a interface mostrando "ok", porque a pílula olhava só o
 * fim do transporte.
 *
 * Regra da normalização (deliberadamente estreita):
 *  - remove **apenas** o prefixo `gateway.` — o namespace que o Gateway impõe;
 *  - qualquer outro namespace é preservado (não é nosso, não mexemos);
 *  - o resultado só é usado se existir no registro de ferramentas. Nome
 *    desconhecido continua sendo nome desconhecido: nada de "adivinhar" a
 *    ferramenta e executar a coisa errada.
 */

/** Namespace imposto pelo Gateway local. */
export const GATEWAY_NAMESPACE = 'gateway';

/**
 * Remove o namespace `gateway.` de um nome de ferramenta.
 * @param {unknown} raw nome recebido do modelo
 * @returns {string} nome canônico (o mesmo texto, se não houver prefixo nosso)
 */
export function canonicalToolName(raw) {
  const name = typeof raw === 'string' ? raw : '';
  if (!name) return '';
  const dot = name.indexOf('.');
  if (dot <= 0) return name;
  const namespace = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  // Só o namespace exato `gateway` é removido — `gatewayx.foo` fica intacto.
  return namespace === GATEWAY_NAMESPACE && rest ? rest : name;
}

/** `true` quando o nome veio com o prefixo do Gateway. */
export function isNamespaced(raw) {
  const name = typeof raw === 'string' ? raw : '';
  return name !== canonicalToolName(name);
}
