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
    // Só conta ferramentas chamadas NESTE turno (depois da última mensagem do
    // usuário): o histórico da sessão inclui turnos anteriores.
    const lastUserIndex = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
    const alreadyCalledTool = messages
      .slice(Math.max(lastUserIndex, 0))
      .some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    const wantsServices = /servi[cç]o/i.test(userText) && tools.includes('consultar_servicos');
    const wantsInterest = /interesse|contato comercial|falar com a equipe/i.test(userText) && tools.includes('registrar_interesse_comercial');

    // Ferramentas de FRONTEND (declaradas pelo site via CopilotKit/AG-UI).
    // O mock só as pede quando o site realmente as anunciou.
    const frontend = {
      navigate: tools.includes('navigateToPage') && /abra|abrir|navegue|ir para|v[aá] para/i.test(userText),
      fill: tools.includes('fillContactForm') && /preencha|preencher|preenche/i.test(userText),
      submit: tools.includes('submitContactRequest') && /(envie|enviar|submeta|confirmo|pode enviar)/i.test(userText),
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const id = `chatcmpl-mock-${Date.now()}`;

    if (!alreadyCalledTool && (frontend.navigate || frontend.fill || frontend.submit)) {
      const call = frontend.navigate
        ? { name: 'navigateToPage', args: { page: /contato/i.test(userText) ? 'contato' : 'solucoes' } }
        : frontend.fill
          ? {
              name: 'fillContactForm',
              args: {
                nome: 'Ana Demo',
                email: 'ana.demo@exemplo.com',
                whatsapp: '(85) 99999-0000',
                empresa: 'Empresa Demo',
                interesse: 'Atendimento digital e WhatsApp',
                mensagem: 'Quero conhecer as soluções de inteligência artificial para atendimento de clientes.',
              },
            }
          : { name: 'submitContactRequest', args: {} };

      const toolCall = {
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      };
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      sse(res, '[DONE]');
      res.end();
      console.log(`[mock-gateway] ferramenta de frontend: ${call.name}`);
      return;
    }

    /**
     * Fase 4 — gatilhos das ferramentas do site.
     *
     * O mock só pede uma ferramenta quando ela existe no turno (`tools`) e o
     * texto do visitante casa com um gatilho. É um roteiro fixo, não um modelo:
     * existe para exercitar o caminho real (servidor → ferramenta → diretiva →
     * navegador) no teste de navegador.
     */
    const siteTools = {
      list: tools.includes('list_services') && /servi[cç]os|oferecem|o que voc[eê]s fazem/i.test(userText),
      explain: tools.includes('explain_service') && /detalh|explic|como funciona/i.test(userText) && !/p[aá]gina/i.test(userText),
      openService:
        tools.includes('open_service_page') && /conhecer|abrir|abra|quero ver|me leve/i.test(userText),
      page: tools.includes('explain_current_page') && /p[aá]gina|aqui/i.test(userText),
      input: tools.includes('request_user_input') && /preciso enviar|o que preciso|quais dados|documentos/i.test(userText),
      confirm:
        tools.includes('show_confirmation') &&
        /(pode|quero|vamos) (enviar|registrar)|enviar (o )?formul[aá]rio|confirmo/i.test(userText),
    };
    const serviceGuess = /crm|vendas/i.test(userText)
      ? 'crm-vendas'
      : /voz|[aá]udio/i.test(userText)
        ? 'voz'
        : /whatsapp|atendimento/i.test(userText)
          ? 'atendimento'
          : /relat[oó]rio/i.test(userText)
            ? 'relatorios'
            : /automa[cç][aã]o|workflow/i.test(userText)
              ? 'automacao'
              : 'agentes-ia';

    if (!alreadyCalledTool && (siteTools.list || siteTools.explain || siteTools.openService || siteTools.page || siteTools.input || siteTools.confirm)) {
      const call = siteTools.list
        ? { name: 'list_services', args: {} }
        : siteTools.explain
          ? { name: 'explain_service', args: { serviceId: serviceGuess } }
          : siteTools.openService
            ? { name: 'open_service_page', args: { serviceId: serviceGuess } }
            : siteTools.page
              ? { name: 'explain_current_page', args: {} }
              : siteTools.input
                ? {
                    name: 'request_user_input',
                    args: {
                      motivo: 'iniciar um atendimento',
                      campos: [
                        { nome: 'nome', rotulo: 'Seu nome', tipo: 'texto', obrigatorio: true },
                        { nome: 'email', rotulo: 'E-mail', tipo: 'email', obrigatorio: true },
                      ],
                    },
                  }
                : {
                    name: 'show_confirmation',
                    args: { acao: 'enviar formulário de contato', resumo: 'Enviar nome e e-mail para a Opportunity AI.' },
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
                { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[mock-gateway] ferramenta de site: ${call.name}`);
      return;
    }

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
      const dados = parsed?.dados ?? {};
      if (dados?.servicos?.length) {
        answer = `Temos ${dados.servicos.length} frentes: ${dados.servicos.map((s) => s.nome).join('; ')}. Qual delas você quer conhecer?`;
      } else if (dados?.siteAction?.type === 'navigate') {
        answer = `Abrindo ${dados.siteAction.title || dados.siteAction.path}. Quando carregar, posso explicar o que tem na página.`;
      } else if (dados?.siteAction?.type === 'request_input') {
        answer = 'Deixei os campos na tela. Nada é enviado até você preencher e confirmar no formulário do site.';
      } else if (dados?.siteAction?.type === 'confirmation_granted') {
        answer = 'Autorização registrada. O envio em si acontece no formulário do site — nada saiu do servidor.';
      } else if (dados?.pagina || dados?.serviceId) {
        answer = `Sobre ${dados.nome || dados.pagina?.title || 'esta página'}: ${dados.resumo || dados.pagina?.summary || 'conteúdo do site'}.`;
      } else if (parsed?.status === 'aguardando_confirmacao') {
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
