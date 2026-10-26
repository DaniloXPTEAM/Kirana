/**
 * Ferramentas do site integrado (Fase 4, §6 do pedido).
 *
 * Cada ferramenta tem handler REAL. O que significa "real" aqui:
 *
 *  | Categoria  | O que a ferramenta faz de verdade                        |
 *  |------------|----------------------------------------------------------|
 *  | leitura    | consulta a configuração e o conhecimento do site          |
 *  | navegação  | valida a rota contra a allowlist e devolve uma DIRETIVA    |
 *  | efeito     | vira ação pendente e só executa após confirmação na tela  |
 *
 * A navegação é a única com efeito do lado do navegador: o servidor autoriza e
 * o cliente executa (`public/site-agent.js`). O handler não finge ter navegado —
 * devolve `siteAction` e o texto confirma isso ao modelo.
 *
 * `request_file_upload` NÃO é registrada: o site não tem endpoint seguro de
 * upload. Em vez de simular, `get_site_context` informa a limitação e a Kirana
 * diz ao visitante que o envio é pelo canal oficial.
 */

const MAX_ITEMS = 10;

const short = (text, max = 220) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Primeiro parágrafo útil do documento (para resumos). */
function lead(body) {
  const line = String(body ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#') && !item.startsWith('-') && !item.startsWith('|'));
  return short(line ?? '', 240);
}

/** Seções do documento, por cabeçalho (usado por `explain_service`). */
function sections(body) {
  const out = {};
  let current = 'resumo';
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      current = heading[1]
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      out[current] = out[current] ?? [];
      continue;
    }
    if (!line.trim()) continue;
    out[current] = out[current] ?? [];
    out[current].push(line.trim());
  }
  return out;
}

function sectionText(map, prefixes) {
  for (const [key, value] of Object.entries(map)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      return value
        .map((line) => line.replace(/^-\s*/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '';
}

export function createSiteTools({ siteContext, logger, defaultSiteId = null } = {}) {
  if (!siteContext) throw new Error('createSiteTools exige siteContext');

  /** Site ativo do turno: ctx.siteId (sessão) → default. */
  const siteOf = (ctx) => siteContext.site(ctx?.siteId ?? defaultSiteId ?? '');

  const serviceFrom = (knowledge, raw) => {
    const wanted = String(raw ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    if (!wanted) return null;
    const services = knowledge.services();
    const exact = services.find((service) => service.serviceId === wanted);
    if (exact) return exact;
    const byTitle = services.find((service) => service.title.toLowerCase().includes(wanted) || wanted.includes(service.serviceId));
    if (byTitle) return byTitle;
    // Sinônimos usados pelo público (o site muda de nome, o visitante não).
    const synonyms = {
      whatsapp: 'atendimento',
      atendimento: 'atendimento',
      agentes: 'agentes-ia',
      agente: 'agentes-ia',
      crm: 'crm-vendas',
      vendas: 'crm-vendas',
      automacao: 'automacao',
      workflow: 'automacao',
      relatorio: 'relatorios',
      relatorios: 'relatorios',
      voz: 'voz',
      android: 'voz',
    };
    const key = Object.keys(synonyms).find((word) => wanted.includes(word));
    if (key) return services.find((service) => service.serviceId === synonyms[key]) ?? null;
    return null;
  };

  const tools = [
    /* ------------------------------ leitura ------------------------------ */
    {
      name: 'get_site_context',
      title: 'Contexto do site',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description:
        'Informa em qual site você está atendendo e qual página o visitante está vendo agora (página, caminho e serviço em foco). Use antes de afirmar "nesta página" ou antes de navegar.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_args, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const current = siteContext.currentContext(site.id, ctx?.siteState ?? {});
        const knowledge = siteContext.knowledgeFor(site.id);
        return {
          ok: true,
          site: { id: site.id, name: site.name, url: site.siteUrl ?? null, agente: site.agentName ?? site.persona },
          paginaAtual: current.page,
          servicoEmFoco: current.service,
          paginaConhecida: current.matched,
          rotasPermitidas: siteContext.allowedRoutes(site).length,
          conhecimento: { documentos: knowledge?.docs?.length ?? 0, atualizadoEm: knowledge?.docs?.[0]?.capturedAt ?? null },
          uploads: {
            disponivel: false,
            motivo: site.permissions?.deniedReasons?.request_file_upload ?? 'sem endpoint seguro de upload neste site',
          },
        };
      },
    },
    {
      name: 'list_site_pages',
      title: 'Listar páginas do site',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description: 'Lista as páginas e rotas conhecidas do site, com título e resumo. Use quando o visitante perguntar o que existe no site ou pedir para escolher uma página.',
      parameters: {
        type: 'object',
        properties: { grupo: { type: 'string', enum: ['todas', 'solucoes', 'labs', 'institucional'] } },
        additionalProperties: false,
      },
      handler: ({ grupo = 'todas' } = {}, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const inGroup = (page) => {
          if (grupo === 'todas') return true;
          if (grupo === 'solucoes') return page.path.startsWith('/solucoes');
          if (grupo === 'labs') return page.path.startsWith('/labs');
          return ['/', '/sobre', '/tecnologia', '/contato', '/privacidade', '/termos'].includes(page.path);
        };
        const pages = (site.pages ?? []).filter(inGroup).slice(0, 24);
        return {
          ok: true,
          grupo,
          total: pages.length,
          paginas: pages.map((page) => ({ id: page.id, caminho: page.path, titulo: page.title, resumo: short(page.summary, 160) })),
        };
      },
    },
    {
      name: 'explain_current_page',
      title: 'Explicar a página atual',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description: 'Explica o conteúdo da página em que o visitante está, usando o conhecimento publicado do site.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_args, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const current = siteContext.currentContext(site.id, ctx?.siteState ?? {});
        if (!current.page || !current.matched) {
          return {
            ok: true,
            pagina: current.page,
            conhecida: false,
            mensagem: 'Não tenho esta página catalogada. Posso listar as páginas do site e abrir a que você quiser.',
          };
        }
        const knowledge = siteContext.knowledgeFor(site.id);
        const doc =
          knowledge?.doc(current.service?.serviceId ? `servico-${current.service.serviceId}` : '') ??
          knowledge?.docs.find((item) => item.path && current.page.path.startsWith(item.path.replace(/\/$/, ''))) ??
          knowledge?.docs.find((item) => item.tags?.includes(current.page.id)) ??
          null;
        const hits = doc ? [] : knowledge?.search(`${current.page.title} ${current.page.summary}`, { limit: 3 }) ?? [];
        return {
          ok: true,
          pagina: current.page,
          conhecida: true,
          resumo: current.page.summary,
          detalhes: doc ? short(doc.body, 1400) : hits.map((hit) => ({ titulo: hit.title, trecho: short(hit.text, 400), fonte: hit.source })),
          fonte: doc?.source ?? current.page.path,
          servicoEmFoco: current.service,
        };
      },
    },
    {
      name: 'list_services',
      title: 'Listar soluções',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description: 'Apresenta as soluções da Opportunity AI com um resumo de cada uma. Use quando o visitante perguntar o que a empresa oferece.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: (_args, ctx) => {
        const site = siteOf(ctx);
        const knowledge = siteContext.knowledgeFor(site?.id);
        if (!knowledge || knowledge.empty) return { ok: false, erro: 'conhecimento do site indisponível' };
        const services = knowledge.services().slice(0, MAX_ITEMS).map((service) => {
          const doc = knowledge.serviceDoc(service.serviceId);
          return {
            serviceId: service.serviceId,
            nome: service.title,
            caminho: service.path,
            resumo: lead(doc?.body),
            fonte: service.source,
          };
        });
        return {
          ok: true,
          total: services.length,
          servicos: services,
          observacao: 'Escopo é definido caso a caso. Não há preços nem prazos publicados no site.',
        };
      },
    },
    {
      name: 'explain_service',
      title: 'Explicar uma solução',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description:
        'Detalha uma solução específica: situação comum, proposta, entregáveis e limitações. Use serviceId do catálogo (agentes-ia, atendimento, crm-vendas, automacao, relatorios, voz).',
      parameters: {
        type: 'object',
        properties: { serviceId: { type: 'string', maxLength: 40 } },
        required: ['serviceId'],
        additionalProperties: false,
      },
      handler: ({ serviceId, servico, solucao }, ctx) => {
        // Apelidos aceitos: o schema pede `serviceId`, mas um modelo pode
        // traduzir o campo. Não custa nada e evita "solução não existe".
        const wanted = serviceId ?? servico ?? solucao;
        const site = siteOf(ctx);
        const knowledge = siteContext.knowledgeFor(site?.id);
        if (!knowledge || knowledge.empty) return { ok: false, erro: 'conhecimento do site indisponível' };
        const service = serviceFrom(knowledge, wanted);
        if (!service) {
          return {
            ok: false,
            encontrado: false,
            erro: `Solução "${short(wanted, 40)}" não existe no catálogo.`,
            disponiveis: knowledge.services().map((item) => item.serviceId),
          };
        }
        const doc = knowledge.serviceDoc(service.serviceId);
        const map = sections(doc?.body);
        return {
          ok: true,
          encontrado: true,
          serviceId: service.serviceId,
          nome: service.title,
          caminho: service.path,
          resumo: lead(doc?.body),
          situacaoComum: sectionText(map, ['situacao']) || null,
          proposta: sectionText(map, ['proposta']) || null,
          entregaveis: sectionText(map, ['entregaveis']) || null,
          limitacoes: sectionText(map, ['limitacoes']) || null,
          fonte: doc?.source ?? service.source,
        };
      },
    },
    {
      name: 'request_user_input',
      title: 'Pedir dados ao visitante',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description:
        'Pede ao visitante as informações que faltam para uma tarefa (nome, e-mail, interesse…). Não envia nada: apenas apresenta os campos na tela. Use antes de qualquer ação de contato.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', maxLength: 200 },
          campos: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                nome: { type: 'string', maxLength: 40 },
                rotulo: { type: 'string', maxLength: 80 },
                tipo: { type: 'string', enum: ['texto', 'email', 'telefone', 'opcao', 'mensagem'] },
                obrigatorio: { type: 'boolean' },
              },
              required: ['nome', 'rotulo'],
              additionalProperties: false,
            },
          },
        },
        required: ['motivo', 'campos'],
        additionalProperties: false,
      },
      handler: ({ motivo, campos = [] }) => ({
        ok: true,
        // Diretiva para a interface: renderiza o formulário no chat.
        siteAction: {
          type: 'request_input',
          motivo: short(motivo, 200),
          campos: campos.slice(0, 6).map((campo) => ({
            nome: String(campo.nome).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
            rotulo: short(campo.rotulo, 80),
            tipo: campo.tipo ?? 'texto',
            obrigatorio: campo.obrigatorio === true,
          })),
        },
        mensagem: 'Campos apresentados ao visitante. Aguarde o preenchimento — nada foi enviado.',
      }),
    },

    /* ----------------------------- navegação ----------------------------- */
    {
      name: 'navigate_to_page',
      title: 'Abrir página do site',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description:
        'Abre uma página interna autorizada do site. Informe `path` (ex.: /solucoes/crm-vendas) ou `pageId` (ex.: solucoes, contato). Rotas fora da lista permitida são recusadas.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', maxLength: 120 }, pageId: { type: 'string', maxLength: 60 } },
        additionalProperties: false,
      },
      handler: ({ path: rawPath, pageId }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const page = siteContext.resolvePage(site.id, { pageId, path: rawPath });
        const target = page?.path ?? rawPath;
        if (!target) {
          return { ok: false, navegou: false, erro: 'Informe path ou pageId de uma página do site.' };
        }
        const check = siteContext.canNavigate(site.id, target);
        if (!check.ok) {
          return {
            ok: false,
            navegou: false,
            motivo: check.reason,
            erro:
              check.reason === 'not_allowed'
                ? `A rota ${check.path} não está na lista de páginas autorizadas deste site.`
                : `Não posso abrir ${check.path}: ${check.reason}.`,
            paginasPermitidas: siteContext.allowedRoutes(site).slice(0, 30),
          };
        }
        return {
          ok: true,
          navegou: true, // autorizado no servidor; executado pelo navegador
          caminho: check.path,
          pagina: page ? { id: page.id, titulo: page.title, resumo: short(page.summary, 200) } : { id: null, titulo: check.path },
          siteAction: { type: 'navigate', path: check.path, pageId: page?.id ?? null, title: page?.title ?? null },
          mensagem: `Abrindo ${page?.title ?? check.path}. Confirme com o visitante o que ele está vendo.`,
        };
      },
    },
    {
      name: 'open_service_page',
      title: 'Abrir página de uma solução',
      kind: 'read',
      expose: true, // o resultado pode ir para a interface (conteúdo público do site)
      description: 'Abre a página de uma solução específica no site (ex.: serviceId "crm-vendas").',
      parameters: {
        type: 'object',
        properties: { serviceId: { type: 'string', maxLength: 40 } },
        required: ['serviceId'],
        additionalProperties: false,
      },
      handler: ({ serviceId, servico, solucao }, ctx) => {
        const wanted = serviceId ?? servico ?? solucao;
        const site = siteOf(ctx);
        const knowledge = siteContext.knowledgeFor(site?.id);
        if (!site || !knowledge) return { ok: false, erro: 'site desconhecido' };
        const service = serviceFrom(knowledge, wanted);
        if (!service) {
          return {
            ok: false,
            navegou: false,
            erro: `Solução "${short(wanted, 40)}" não existe no catálogo.`,
            disponiveis: knowledge.services().map((item) => item.serviceId),
          };
        }
        const check = siteContext.canNavigate(site.id, service.path);
        if (!check.ok) {
          return { ok: false, navegou: false, motivo: check.reason, erro: `A página desta solução (${service.path}) não está autorizada.` };
        }
        return {
          ok: true,
          navegou: true,
          caminho: check.path,
          serviceId: service.serviceId,
          nome: service.title,
          siteAction: { type: 'navigate', path: check.path, serviceId: service.serviceId, title: service.title },
          mensagem: `Abrindo a página de ${service.title}.`,
        };
      },
    },

    /* ------------------------------ efeito ------------------------------- */
    {
      name: 'show_confirmation',
      title: 'Pedir confirmação',
      kind: 'write', // passa pelo fluxo de ação pendente já existente (HITL)
      requiresConfirmation: true,
      description:
        'Pede autorização do visitante, na tela, antes de uma ação com efeito (ex.: enviar o formulário de contato). Nada é executado sem confirmação explícita. Não use para leitura nem para navegação.',
      parameters: {
        type: 'object',
        properties: {
          acao: { type: 'string', maxLength: 120 },
          resumo: { type: 'string', maxLength: 400 },
        },
        required: ['acao', 'resumo'],
        additionalProperties: false,
      },
      handler: ({ acao, resumo }, ctx) => {
        // Só chega aqui depois do "aprovar" na tela. Não há envio externo:
        // registra a autorização para a interface continuar o fluxo.
        const site = siteOf(ctx);
        logger?.info?.('Confirmação autorizada pelo visitante', { acao: short(acao, 60), site: site?.id ?? null });
        return {
          ok: true,
          confirmado: true,
          acao: short(acao, 120),
          resumo: short(resumo, 400),
          executado: false,
          motivo: 'A execução final acontece na interface do site (formulário). Nada foi enviado pelo servidor.',
          siteAction: { type: 'confirmation_granted', action: short(acao, 120) },
        };
      },
    },
  ];

  /**
   * Fase 4 — isolamento por site.
   *
   * O registro de ferramentas é único para o processo, mas cada site declara
   * quais usa (`site.json → tools[]`). Sem esta guarda, uma sessão de um site de
   * demonstração herdaria as ferramentas do site de produção (e o conhecimento
   * dele). A verificação é por CHAMADA, com o site da sessão — não na criação,
   * porque o site é resolvido no turno.
   */
  function guard(tool) {
    const inner = tool.handler;
    return {
      ...tool,
      handler: (args, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido: nenhuma ferramenta de site disponível' };
        const allowed = new Set((site.tools ?? []).map((item) => item.name));
        if (!allowed.has(tool.name)) {
          return { ok: false, erro: `A ferramenta ${tool.name} não está habilitada para este site.` };
        }
        return inner(args, ctx);
      },
    };
  }

  /** Ferramentas declaradas na config do site, na ordem em que aparecem. */
  function enabledFor(siteId) {
    const site = siteContext.site(siteId);
    const enabled = new Set((site?.tools ?? []).map((tool) => tool.name));
    return tools.filter((tool) => enabled.has(tool.name));
  }

  const guarded = tools.map(guard);
  return { tools: guarded, enabledFor };
}
