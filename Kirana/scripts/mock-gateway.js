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
/**
 * `--namespaced` imita o Gateway REAL v0.4.x: devolve o nome da ferramenta como
 * `gateway.<nome>` (ver `toNamespacedTools`/`displayToolName` no pacote de
 * `integrations/`). Serve para testar o caminho que o Windows usa de verdade —
 * o mock sem essa flag devolve o nome cru e escondia o defeito da v0.5.1.
 */
const NAMESPACED = args.includes('--namespaced') || process.env.MOCK_NAMESPACED === 'true';
const toolName = (name) => (NAMESPACED ? `gateway.${name}` : name);
/**
 * `--unknown-tool=<nome>` faz o roteiro pedir uma ferramenta que NÃO existe.
 *
 * Serve para verificar de ponta a ponta o caminho `unknown_tool`: o modelo
 * pede (ex.: `pesquisar_na_web`, que a Kirana nunca teve), a Kirana recusa com
 * mensagem acionável e a interface precisa mostrar FALHA — não "ok". Sem essa
 * opção é impossível reproduzir a falha com um mock: ele só pede ferramentas
 * que existem.
 */
const UNKNOWN_TOOL_ARG = args.find((arg) => arg.startsWith('--unknown-tool'));
const UNKNOWN_TOOL = UNKNOWN_TOOL_ARG
  ? (UNKNOWN_TOOL_ARG.includes('=') ? UNKNOWN_TOOL_ARG.split('=')[1] : 'pesquisar_na_web')
  : process.env.MOCK_UNKNOWN_TOOL || '';

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
    // Mesma forma do Gateway real: `authenticated` diz se a conta está
    // autorizada. `MOCK_UNAUTHENTICATED=1` simula o Gateway sem consentimento.
    res.end(
      JSON.stringify({
        status: 'ok',
        mode: 'mock',
        authenticated: process.env.MOCK_UNAUTHENTICATED !== '1',
        version: 'mock',
        uptime: Math.round(process.uptime()),
      }),
    );
    return;
  }

  const authorized = (req.headers.authorization || '') === `Bearer ${KEY}`;
  if (!authorized) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Chave inválida no gateway simulado.', type: 'unauthorized' } }));
    return;
  }

  /* Endpoints que o Gateway real expõe e que o preflight consulta. */
  if (req.method === 'GET' && url.pathname === '/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        authenticated: process.env.MOCK_UNAUTHENTICATED !== '1',
        grantedScopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        capabilities: [
          { id: 'text.chat' },
          { id: 'files.create' },
          { id: 'files.upload' },
          { id: 'images.analyze' },
          { id: 'images.generate' },
          { id: 'video.analyze' },
          { id: 'audio.transcribe' },
          { id: 'audio.synthesize' },
        ],
      }),
    );
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
    // Gatilho exclusivo do `scripts/preflight-gateway.mjs`: valida o contrato de
    // ferramenta (nome + round-trip) sem depender de um modelo real.
    const wantsProjectStatus =
      /verificacao-contrato|status do projeto/i.test(userText) && tools.includes('consultar_status_projeto');
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

    if (UNKNOWN_TOOL && !alreadyCalledTool) {
      const toolCall = {
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: { name: toolName(UNKNOWN_TOOL), arguments: '{}' },
      };
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [toolCall] } }] });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      sse(res, '[DONE]');
      res.end();
      console.log(`[mock-gateway] ferramenta inexistente solicitada: ${toolName(UNKNOWN_TOOL)}`);
      return;
    }

    // Gatilho genérico de teste: força UMA chamada a uma ferramenta nomeada.
    // Uso: MOCK_FORCE_TOOL=navigate_to_page. Serve para exercitar as diretivas
    // de site (site_action) sem depender de um modelo real.
    const FORCE_TOOL = process.env.MOCK_FORCE_TOOL || '';
    if (FORCE_TOOL && !alreadyCalledTool && tools.includes(FORCE_TOOL)) {
      const forced = {
        index: 0,
        id: `call_${Date.now()}`,
        type: 'function',
        function: {
          name: toolName(FORCE_TOOL),
          arguments: JSON.stringify(
            FORCE_TOOL === 'navigate_to_page'
              ? { path: /contato/i.test(userText) ? '/contato' : '/solucoes/' }
              : FORCE_TOOL === 'explain_current_page'
                ? {}
                : {},
          ),
        },
      };
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      sse(res, {
        id,
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { tool_calls: [forced] } }],
      });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      sse(res, '[DONE]');
      res.end();
      console.log(`[mock-gateway] ferramenta forçada pelo teste: ${FORCE_TOOL}`);
      return;
    }

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
        function: { name: toolName(call.name), arguments: JSON.stringify(call.args) },
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

    /**
     * Fase 5 — gatilhos das ferramentas operacionais.
     *
     * O mock não tem memória: o id da solicitação é lido do próprio histórico
     * da conversa (o resultado da ferramenta anterior está nas mensagens). É o
     * suficiente para exercitar o caminho real sem inventar estado.
     */
    const historico = JSON.stringify(messages);
    const requestId = (historico.match(/REQ-\d{4}-[A-Z0-9]{6}/) ?? [])[0] ?? null;
    const fase5 = {
      start: tools.includes('start_service_request') && /colocar uma ia|contratar|quero um (agente|site)|implantar/i.test(userText),
      validate: tools.includes('validate_service_request') && /validar|est[aá] completo|falta/i.test(userText),
      fill: tools.includes('fill_site_form') && /preench|formul[aá]rio/i.test(userText) && !/enviar|envie/i.test(userText),
      upload: tools.includes('request_file_upload') && /anexar|arquivo|briefing|documento/i.test(userText),
      submit: tools.includes('submit_service_request') && /(pode|quero|vamos) enviar|envie|manda/i.test(userText),
      status: tools.includes('get_request_status') && /andamento|status|como est[aá]/i.test(userText),
      cancel: tools.includes('cancel_service_request') && /cancelar|desistir|deixa pra depois/i.test(userText),
    };

    if (!alreadyCalledTool && Object.values(fase5).some(Boolean)) {
      const call = fase5.start
        ? {
            name: 'start_service_request',
            args: {
              serviceId: serviceGuess,
              dados: {
                nome: 'Ana Demo',
                email: 'ana.demo@exemplo.com',
                interesse: 'Agentes de IA',
                mensagem: 'Quero um agente no meu site para qualificar contatos.',
                consent: true,
                endereco_site: 'https://exemplo.com',
                funcao_do_agente: 'Responder dúvidas e encaminhar orçamentos',
              },
            },
          }
        : fase5.fill
          ? { name: 'fill_site_form', args: { form: 'contato' } }
          : fase5.upload
            ? { name: 'request_file_upload', args: { motivo: 'Envie o briefing do projeto em PDF.' } }
            : fase5.validate
              ? { name: 'validate_service_request', args: {} }
              : fase5.submit
                ? { name: 'submit_service_request', args: { requestId: requestId ?? 'REQ-0000-000000' } }
                : fase5.status
                  ? { name: 'get_request_status', args: {} }
                  : { name: 'cancel_service_request', args: { motivo: 'pedido do visitante' } };

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
                { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: toolName(call.name), arguments: JSON.stringify(call.args) } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[mock-gateway] ferramenta operacional: ${call.name}`);
      return;
    }

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
                { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: toolName(call.name), arguments: JSON.stringify(call.args) } },
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

    if (!alreadyCalledTool && wantsProjectStatus) {
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
                {
                  index: 0,
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: { name: toolName('consultar_status_projeto'), arguments: JSON.stringify({ projeto: 'verificacao-contrato' }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      sse(res, { id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      console.log(`[mock-gateway] ferramenta de contrato: ${toolName('consultar_status_projeto')}`);
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
                // toolName(): o Gateway real prefixa TODAS as chamadas, não só as de site.
                { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: toolName(name), arguments: JSON.stringify(toolArgs) } },
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
      } else if (dados?.solicitacao) {
        // Fase 5: a resposta do mock repete o estado REAL devolvido pela
        // ferramenta — inclusive quando ela diz que nada foi enviado.
        const sol = dados.solicitacao;
        answer = `Solicitação ${sol.id} (${sol.serviceTitle || sol.serviceId}) no estado ${sol.estado}. ${dados.mensagem || ''}`.trim();
      } else if (dados?.siteAction?.type === 'fill_form') {
        answer = `Preenchi ${dados.camposPreenchidos?.length ?? 0} campo(s) do formulário ${dados.form}. O envio continua com você — nada foi submetido.`;
      } else if (dados?.siteAction?.type === 'request_upload') {
        answer = 'Deixei o botão de anexo na tela. Escolha o arquivo quando quiser; o servidor confere tipo, tamanho e conteúdo antes de guardar.';
      } else if (dados?.completo === true) {
        answer = 'Validei os dados: está tudo preenchido. Posso pedir sua confirmação para enviar.';
      } else if (dados?.completo === false) {
        answer = `Ainda falta: ${(dados.faltando ?? []).join('; ') || 'alguns campos'}. Quer completar agora?`;
      } else if (dados?.enviado === false) {
        answer = dados.erro || 'Não foi possível enviar. A solicitação continua como rascunho nesta conversa.';
      } else if (dados?.cancelada) {
        answer = `Solicitação ${dados.requestId} cancelada. Nada havia sido enviado.`;
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
