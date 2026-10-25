#!/usr/bin/env node
/**
 * Gateway simulado — APENAS PARA TESTES E DEMONSTRAÇÃO.
 *
 * Não substitui o Kirana-ChatGPT-Gateway real: imita o contrato HTTP mínimo
 * (GET /health, GET /v1/models, POST /v1/chat/completions com SSE) para
 * desenvolver e testar a Kirana sem consumir a conta ChatGPT.
 *
 * Uso:
 *   node scripts/mock-gateway.js [--port 1455] [--key local-mock]
 *
 * Cenários automáticos (pela última mensagem do usuário):
 *   - contém "serviço"  -> chamada de ferramenta consultar_servicos
 *   - contém "interesse"-> chamada de registrar_interesse_comercial (ação de escrita)
 *   - demais            -> resposta em texto, com streaming palavra a palavra
 */
import http from 'node:http';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const PORT = Number(getArg('port', process.env.MOCK_PORT || 1455));
const HOST = getArg('host', process.env.MOCK_HOST || '127.0.0.1');
const KEY = getArg('key', process.env.MOCK_KEY || 'local-mock');
const DELAY = Number(getArg('delay', process.env.MOCK_DELAY_MS || 25));

const MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

// Mesmo contrato do Gateway v0.2.0: campos fora desta lista recebem HTTP 400
// `unsupported_parameter`. Serve para pegar regressões cedo no modo demonstração.
const ALLOWED_FIELDS = ['model', 'messages', 'stream', 'tools'];
const OPTIONAL_FIELDS = ['tool_choice'];
const REJECT_EXTRA = getArg('strict', 'true') !== 'false';

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return String(messages[i].content || '');
  }
  return '';
}

function toolResultFor(messages, name) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'tool') return String(messages[i].content || '');
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: 'mock', uptime: Math.round(process.uptime()) }));
    return;
  }

  const authorized = (req.headers.authorization || '') === `Bearer ${KEY}`;
  if (!authorized) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Chave inválida no gateway simulado.', type: 'unauthorized' } }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readBody(req);

    if (REJECT_EXTRA) {
      const rejected = Object.keys(body).filter((field) => !ALLOWED_FIELDS.includes(field) && !OPTIONAL_FIELDS.includes(field));
      if (rejected.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'unsupported_parameter',
              message: `Unsupported request field: ${rejected[0]}. This gateway only forwards validated ChatGPT-plan-compatible fields.`,
            },
          }),
        );
        console.log(`[mock-gateway] 400 unsupported_parameter: ${rejected.join(', ')}`);
        return;
      }
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = lastUserText(messages);
    const tools = Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name) : [];
    const alreadyCalledTool = messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    const wantsServices = /servi[cç]o/i.test(userText) && tools.includes('consultar_servicos');
    const wantsInterest = /interesse|contato comercial|falar com a equipe/i.test(userText) && tools.includes('registrar_interesse_comercial');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const id = `chatcmpl-mock-${Date.now()}`;

    if (!alreadyCalledTool && (wantsServices || wantsInterest)) {
      const name = wantsServices ? 'consultar_servicos' : 'registrar_interesse_comercial';
      const toolArgs = wantsServices
        ? { consulta: userText.slice(0, 120) }
        : {
            nome: 'Ana Demo',
            canal_tipo: 'email',
            canal_valor: 'ana.demo@exemplo.com',
            interesse: 'Atendimento digital no WhatsApp',
            mensagem: 'Preciso responder dúvidas repetidas fora do horário comercial.',
            empresa: 'Empresa Demonstração',
            consentimento: true,
          };
      await sleep(DELAY);
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      sse(res, {
        id,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(toolArgs) } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const toolResult = toolResultFor(messages);
    let answer;
    if (toolResult) {
      let parsed = null;
      try {
        parsed = JSON.parse(toolResult);
      } catch {
        parsed = null;
      }
      if (parsed?.status === 'aguardando_confirmacao') {
        answer = 'Preparei o registro do seu interesse e deixei tudo pronto. Só preciso da sua confirmação na tela para concluir — nada é gravado antes disso.';
      } else if (parsed?.ok && parsed?.dados?.protocolo) {
        answer = `Pronto, o interesse foi registrado localmente com o protocolo ${parsed.dados.protocolo}. A equipe da Opportunity AI dará continuidade ao contato.`;
      } else if (parsed?.ok) {
        const servicos = parsed?.dados?.servicos || parsed?.dados?.servico;
        const nomes = Array.isArray(servicos) ? servicos.map((s) => s.nome).join(', ') : servicos?.nome || 'os serviços consultados';
        answer = `Consultei o catálogo. Encontrei: ${nomes}. Posso detalhar qualquer um deles e, se fizer sentido, registrar um pedido de contato com a equipe.`;
      } else {
        answer = 'A consulta não retornou dados úteis nesta tentativa. Quer reformular o pedido?';
      }
    } else {
      answer = `Recebi sua mensagem: "${userText.slice(0, 160)}". (Resposta do gateway simulado, usada apenas para testar a interface e o streaming — nenhum modelo real foi chamado.)`;
    }

    const tokens = answer.split(/(\s+)/).filter((token) => token.length);
    for (const token of tokens) {
      await sleep(DELAY);
      sse(res, {
        id,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
      });
    }
    sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: tokens.length, total_tokens: 100 + tokens.length } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Rota não encontrada no gateway simulado.' } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-gateway] ouvindo em http://${HOST}:${PORT} (chave: ${KEY})`);
  console.log('[mock-gateway] NÃO é o gateway real. Use apenas para testes locais.');
});
