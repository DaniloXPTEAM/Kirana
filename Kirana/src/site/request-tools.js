/**
 * Ferramentas operacionais (Fase 5) — a Kirana executa tarefas, não só explica.
 *
 * Regra que vale para todas as ferramentas deste arquivo:
 *   se não há como fazer, a ferramenta **diz** que não há como fazer.
 *
 * Concretamente:
 *  - `submit_service_request` só envia quando existe endpoint autorizado
 *    (`site.json → endpoints.submitRequest` ou `KIRANA_REQUEST_ENDPOINT`). Sem
 *    isso, a solicitação **continua rascunho** e a resposta diz `enviado: false`;
 *  - `get_request_status` devolve o estado gravado, nunca um andamento estimado;
 *  - `cancel_service_request` recusa cancelar algo já enviado sem operação real;
 *  - `request_file_upload` só habilita o envio se a política de upload estiver
 *    ligada no `site.json`; se não estiver, informa a limitação.
 *
 * Permissões: as ferramentas que mudam estado local reversível (rascunho,
 * coleta) são de leitura; as que tiram a solicitação do controle do visitante
 * (`submit_service_request`, `cancel_service_request`) são de escrita e passam
 * pelo HITL já existente.
 */
import { requirementsFor, validateRequestData, missingFieldsText } from '../requests/requirements.js';
import { REQUEST_STATES } from '../requests/store.js';

const short = (value, max) => String(value ?? '').slice(0, max);

/** Serviço do catálogo real a partir de id/sinônimo (mesma regra da Fase 4). */
function resolveService(knowledge, raw) {
  const wanted = String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!wanted) return null;
  const services = knowledge.services();
  const exact = services.find((service) => service.serviceId === wanted);
  if (exact) return exact;
  const byTitle = services.find(
    (service) => service.title.toLowerCase().includes(wanted) || wanted.includes(service.serviceId),
  );
  if (byTitle) return byTitle;
  const synonyms = {
    site: 'agentes-ia',
    agente: 'agentes-ia',
    agentes: 'agentes-ia',
    chatbot: 'agentes-ia',
    whatsapp: 'atendimento',
    atendimento: 'atendimento',
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
  return key ? services.find((service) => service.serviceId === synonyms[key]) ?? null : null;
}

export function createRequestTools({ siteContext, requests, files, logger, defaultSiteId = null, config = null } = {}) {
  if (!siteContext) throw new Error('createRequestTools exige siteContext');
  if (!requests?.store) throw new Error('createRequestTools exige o store de solicitações');

  const store = requests.store;
  const requirements = requests.requirements;
  const siteOf = (ctx) => siteContext.site(ctx?.siteId ?? defaultSiteId ?? '');
  const knowledgeOf = (site) => (site ? siteContext.knowledgeFor(site.id) : null);

  /** Endpoint de envio: só existe se estiver configurado para o site. */
  function submitEndpoint(site) {
    const fromConfig = config?.requests?.endpoint ?? null;
    const fromSite = site?.endpoints?.submitRequest ?? null;
    const url = fromConfig || fromSite;
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  }

  function uploadPolicy(site) {
    const policy = site?.uploads ?? {};
    return {
      enabled: policy.enabled === true,
      maxMb: policy.maxMb ?? files?.maxBytes / 1024 / 1024 ?? 5,
      maxFiles: policy.maxFiles ?? files?.maxFiles ?? 5,
      retentionDays: policy.retentionDays ?? files?.retentionDays ?? 30,
      allowed: policy.allowed ?? files?.allowedExtensions ?? [],
      motivo: policy.enabled === true ? null : policy.reason ?? 'Upload não habilitado para este site.',
    };
  }

  /** Solicitação do turno: a informada, a ativa da sessão, ou nenhuma. */
  function requestOf(ctx, requestId) {
    if (requestId) return store.get(requestId, ctx?.sessionId);
    return store.activeFor(ctx?.sessionId);
  }

  /**
   * Leva a solicitação até `target` pelo caminho mais curto permitido.
   *
   * A tabela de transições é pequena e estrita (`draft → collecting →
   * validating → waiting_for_approval`), então as ferramentas não devem pular
   * etapas à mão: elas pedem o destino e este helper percorre os passos, um por
   * um, respeitando `store.transition`. Sem caminho, nada muda.
   */
  function advance(request, target) {
    if (request.state === target) return { ok: true, request };
    const queue = [[request.state]];
    const seen = new Set([request.state]);
    while (queue.length) {
      const pathStates = queue.shift();
      for (const next of store.transitionsFor(pathStates[pathStates.length - 1])) {
        if (seen.has(next)) continue;
        if (next === target) {
          let current = request;
          for (const step of [...pathStates.slice(1), next]) {
            const moved = store.transition(current, step, { actor: 'kirana' });
            if (!moved.ok) return moved;
            current = moved.request;
          }
          return { ok: true, request: current };
        }
        seen.add(next);
        queue.push([...pathStates, next]);
      }
    }
    return { ok: false, error: { code: 'no_path', message: `Sem caminho de ${request.state} para ${target}.` } };
  }

  function historyEntry(request, action, extra = {}) {
    request.history = Array.isArray(request.history) ? request.history : [];
    request.history.push({ at: new Date().toISOString(), action, actor: 'kirana', ...extra });
  }

  const tools = [
    /* ---------------------------- 5.1 requisitos ---------------------------- */
    {
      name: 'get_service_requirements',
      title: 'Consultar requisitos do serviço',
      kind: 'read',
      expose: true,
      description:
        'Consulta os requisitos reais de um serviço: campos do formulário oficial, informações de caso necessárias e arquivos aceitos. Se o site não publicar requisitos, a ferramenta diz isso — nunca invente exigências.',
      parameters: {
        type: 'object',
        properties: { serviceId: { type: 'string', maxLength: 40 } },
        required: ['serviceId'],
        additionalProperties: false,
      },
      handler: ({ serviceId }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const knowledge = knowledgeOf(site);
        const service = knowledge ? resolveService(knowledge, serviceId) : null;
        if (!service) {
          return { ok: false, erro: `Serviço "${short(serviceId, 40)}" não existe no catálogo do site.`, disponiveis: knowledge?.services().map((item) => item.serviceId) ?? [] };
        }
        const spec = requirementsFor(requirements, service.serviceId);
        if (!spec.ok) {
          return {
            ok: false,
            erro: spec.erro,
            serviceId: service.serviceId,
            aviso: 'Sem cadastro de requisitos: não afirme o que é exigido. Oriente o contato pelo formulário oficial.',
          };
        }
        return {
          ok: true,
          ...spec,
          identificacao: { serviceId: service.serviceId, nome: service.title, caminho: service.path },
          upload: uploadPolicy(site),
        };
      },
    },

    /* --------------------------- 5.2 criar rascunho ------------------------- */
    {
      name: 'start_service_request',
      title: 'Iniciar solicitação',
      kind: 'read', // cria estado local da sessão; não envia nada para fora
      expose: true,
      localWrite: true,
      description:
        'Cria (ou retoma) o rascunho de solicitação de serviço desta conversa. Não envia nada a ninguém: só registra o pedido localmente com identificador, serviço e estado. Use quando o visitante demonstrar que quer contratar/algo concreto.',
      parameters: {
        type: 'object',
        properties: {
          serviceId: { type: 'string', maxLength: 40 },
          dados: { type: 'object', description: 'Dados já conhecidos (nome, email, mensagem…).' },
        },
        required: ['serviceId'],
        additionalProperties: false,
      },
      handler: ({ serviceId, dados }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const knowledge = knowledgeOf(site);
        const service = knowledge ? resolveService(knowledge, serviceId) : null;
        if (!service) return { ok: false, erro: `Serviço "${short(serviceId, 40)}" não existe no catálogo do site.` };
        if (!ctx?.sessionId) return { ok: false, erro: 'sessão ausente: não é possível associar a solicitação' };

        const existing = store.activeFor(ctx.sessionId);
        if (existing) {
          // Retomar é o comportamento certo: uma atividade por vez.
          if (dados) store.update(existing.id, ctx.sessionId, { data: dados });
          const current = store.get(existing.id, ctx.sessionId);
          return {
            ok: true,
            retomada: true,
            solicitacao: shape(current),
            mensagem: `A conversa já tem a solicitação ${current.id} em andamento (${current.state}). Continuando nela.`,
            enviado: false,
          };
        }

        const created = store.create({ sessionId: ctx.sessionId, siteId: site.id, serviceId: service.serviceId, serviceTitle: service.title });
        if (!created.ok) return { ok: false, erro: created.error.message, codigo: created.error.code };
        let request = created.request;
        if (dados && typeof dados === 'object') {
          const updated = store.update(request.id, ctx.sessionId, {
            data: dados,
            state: REQUEST_STATES.collecting,
          });
          if (updated.ok) request = updated.request;
        }
        return {
          ok: true,
          retomada: false,
          solicitacao: shape(request),
          mensagem:
            'Rascunho criado. Nada foi enviado à Opportunity AI: os dados ficam nesta conversa até o visitante autorizar o envio.',
          enviado: false,
        };
      },
    },

    /* --------------------------- 5.5 preencher form ------------------------- */
    {
      name: 'fill_site_form',
      title: 'Preencher formulário do site',
      kind: 'read',
      description:
        'Preenche campos de formulários reais do site com os dados já coletados na solicitação. Não envia o formulário e não executa código no navegador: apenas escreve nos campos mapeados pelo site.',
      parameters: {
        type: 'object',
        properties: {
          form: { type: 'string', maxLength: 60, description: 'Formulário alvo (ex.: contato).' },
          requestId: { type: 'string', maxLength: 20 },
        },
        required: ['form'],
        additionalProperties: false,
      },
      handler: ({ form, requestId }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const forms = site.forms ?? {};
        const formConfig = forms[form] ?? forms[`/${form}`];
        if (!formConfig) {
          return { ok: false, erro: `O site não tem o formulário "${short(form, 40)}" mapeado.`, formularios: Object.keys(forms) };
        }
        const request = requestOf(ctx, requestId);
        if (!request) return { ok: false, erro: 'Não há solicitação com dados para preencher. Inicie a solicitação primeiro.' };
        if (!store.canEdit(request)) {
          return { ok: false, erro: `A solicitação ${request.id} está em ${request.state} e não aceita mais preenchimento.` };
        }

        const fields = [];
        const usados = [];
        for (const [field, selector] of Object.entries(formConfig.fields ?? {})) {
          const value = request.data?.[field];
          if (value == null || value === '') continue;
          fields.push({ field, selector, value: String(value).slice(0, 2000) });
          usados.push(field);
        }
        if (!fields.length) {
          return { ok: false, erro: 'Ainda não há dados coletados para preencher o formulário.', faltando: missingFieldsText(validateRequestData({ requirements, serviceId: request.serviceId, data: request.data, files: request.files })) };
        }
        historyEntry(request, 'form_filled', { form, fields: usados });
        // Preencher não aprova nada: se os dados estão completos a solicitação
        // entra em validação; se não, segue em coleta.
        const report = validateRequestData({ requirements, serviceId: request.serviceId, data: request.data, files: request.files });
        advance(store.get(request.id, ctx.sessionId) ?? request, report.completo ? REQUEST_STATES.validating : REQUEST_STATES.collecting);
        return {
          ok: true,
          requestId: request.id,
          form,
          camposPreenchidos: usados,
          siteAction: { type: 'fill_form', form, target: formConfig.target ?? null, fields },
          mensagem: 'Campos preenchidos na tela. O envio continua dependendo do visitante — nada foi submetido.',
          enviado: false,
        };
      },
    },

    /* ----------------------------- 5.4 upload ------------------------------ */
    {
      name: 'request_file_upload',
      title: 'Solicitar arquivo ao visitante',
      kind: 'read',
      description:
        'Pede ao visitante que anexe um arquivo à solicitação (a escolha é dele, no navegador). Informa tipos e limite aceitos. Só funciona se o upload estiver habilitado no site.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', maxLength: 200 },
          requestId: { type: 'string', maxLength: 20 },
        },
        required: ['motivo'],
        additionalProperties: false,
      },
      handler: ({ motivo, requestId }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const policy = uploadPolicy(site);
        if (!policy.enabled) {
          return {
            ok: false,
            erro: `Upload não está disponível: ${policy.motivo}`,
            alternativa: 'Oriente o envio pelo formulário oficial do site ou pelo WhatsApp publicado.',
          };
        }
        const request = requestOf(ctx, requestId);
        if (!request) return { ok: false, erro: 'Inicie a solicitação antes de pedir arquivo.' };
        if (!store.canEdit(request)) return { ok: false, erro: `A solicitação ${request.id} está em ${request.state} e não aceita arquivos.` };
        if ((request.files?.length ?? 0) >= policy.maxFiles) {
          return { ok: false, erro: `Limite de ${policy.maxFiles} arquivos atingido nesta solicitação.` };
        }
        store.update(request.id, ctx.sessionId, { state: REQUEST_STATES.waitingUpload, note: 'arquivo solicitado' });
        return {
          ok: true,
          requestId: request.id,
          arquivosAtuais: (request.files ?? []).map((file) => ({ id: file.id, nome: file.name, tamanho: file.size })),
          siteAction: {
            type: 'request_upload',
            requestId: request.id,
            accept: policy.allowed.map((ext) => `.${ext}`).join(','),
            maxMb: policy.maxMb,
            maxFiles: policy.maxFiles,
            motivo: short(motivo, 200),
          },
          mensagem:
            'O visitante escolhe o arquivo no navegador. O servidor valida tipo, tamanho e assinatura do conteúdo, e o arquivo fica ligado a esta solicitação — nada é executado.',
        };
      },
    },

    /* ---------------------------- 5.6 validação ---------------------------- */
    {
      name: 'validate_service_request',
      title: 'Validar solicitação',
      kind: 'read',
      expose: true,
      description:
        'Confere se os dados da solicitação estão completos e válidos. Devolve campos válidos, ausentes, erros e a próxima ação permitida. Use antes de pedir confirmação ao visitante.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string', maxLength: 20 } },
        additionalProperties: false,
      },
      handler: ({ requestId }, ctx) => {
        const request = requestOf(ctx, requestId);
        if (!request) return { ok: false, erro: 'Não há solicitação em andamento nesta conversa.' };
        const report = validateRequestData({
          requirements,
          serviceId: request.serviceId,
          data: request.data,
          files: request.files,
        });
        if (!report.ok) return { ok: false, erro: report.erro };

        // O estado acompanha o resultado: completo → aguardando aprovação.
        if (store.canEdit(request)) {
          if (report.completo) {
            // validating é etapa real do fluxo: valida, depois aguarda aprovação.
            advance(request, REQUEST_STATES.waitingApproval);
          } else if (request.state === REQUEST_STATES.waitingApproval || request.state === REQUEST_STATES.validating) {
            // Voltou a faltar dado (o visitante corrigiu algo): volta a coletar.
            advance(store.get(request.id, ctx.sessionId) ?? request, REQUEST_STATES.collecting);
          }
        }

        return {
          ok: true,
          requestId: request.id,
          serviceId: request.serviceId,
          completo: report.completo,
          camposValidos: report.validos,
          camposAusentes: report.ausentes,
          erros: report.erros,
          proximaAcao: report.proximaAcao,
          proximoCampo: report.proximoCampo,
          faltando: missingFieldsText(report),
          dadosAtuais: request.data,
          arquivos: (request.files ?? []).map((file) => ({ id: file.id, nome: file.name, tamanho: file.size })),
        };
      },
    },

    /* ------------------------------ 5.8 envio ------------------------------ */
    {
      name: 'submit_service_request',
      title: 'Enviar solicitação',
      kind: 'write', // HITL: só executa depois do "aprovar" na tela
      requiresConfirmation: true,
      description:
        'Envia a solicitação validada para a Opportunity AI. Só executa com dados válidos, autorização do visitante e endpoint autorizado configurado. Sem endpoint, a solicitação permanece rascunho — e a resposta diz isso.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string', maxLength: 20 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      summarize: (args) => `Enviar a solicitação ${args.requestId} para a Opportunity AI.`,
      handler: async ({ requestId }, ctx) => {
        const site = siteOf(ctx);
        if (!site) return { ok: false, erro: 'site desconhecido' };
        const request = store.get(requestId, ctx.sessionId);
        if (!request) return { ok: false, erro: 'Solicitação não encontrada nesta conversa.' };

        // 1. dados válidos
        const report = validateRequestData({ requirements, serviceId: request.serviceId, data: request.data, files: request.files });
        if (!report.ok || !report.completo) {
          return {
            ok: false,
            enviado: false,
            erro: 'A solicitação ainda não está completa.',
            camposAusentes: report.ausentes,
            erros: report.erros,
            estado: request.state,
          };
        }

        // 2. autorização do visitante: chegar aqui já significa "aprovado" (HITL),
        //    mas o estado precisa confirmar — defesa contra chamada direta.
        if (request.state !== REQUEST_STATES.waitingApproval && request.state !== REQUEST_STATES.failed) {
          return {
            ok: false,
            enviado: false,
            erro: `A solicitação precisa estar aguardando aprovação (estado atual: ${request.state}).`,
          };
        }

        // 3. destino cadastrado e permitido
        const endpoint = submitEndpoint(site);
        if (!endpoint) {
          return {
            ok: false,
            enviado: false,
            motivo: 'endpoint_nao_configurado',
            estado: request.state,
            erro:
              'Não há endpoint autorizado da Opportunity AI configurado para receber solicitações. A solicitação continua como rascunho nesta conversa — nada foi enviado.',
            alternativa: 'O contato oficial é o formulário do site (/contato) ou o WhatsApp publicado.',
          };
        }

        // 4. envio real (uma vez só: `beginSubmit` reserva o estado)
        const started = store.beginSubmit(request.id, ctx.sessionId);
        if (!started.ok) {
          return { ok: false, enviado: false, erro: started.error.message, codigo: started.error.code };
        }
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(config?.requests?.token ? { Authorization: `Bearer ${config.requests.token}` } : {}) },
            body: JSON.stringify({
              requestId: request.id,
              siteId: site.id,
              serviceId: request.serviceId,
              data: request.data,
              files: (request.files ?? []).map((file) => ({ id: file.id, name: file.name, size: file.size, contentType: file.contentType })),
              consent: request.data?.consent === true,
              createdAt: request.createdAt,
            }),
            signal: AbortSignal.timeout(config?.requests?.timeoutMs ?? 10000),
          });
          if (!response.ok) {
            store.failSubmit(request.id, ctx.sessionId, { code: `http_${response.status}`, message: `O backend respondeu ${response.status}.` });
            return {
              ok: false,
              enviado: false,
              erro: `O backend recusou o envio (HTTP ${response.status}). A solicitação ficou marcada como falha e pode ser reenviada.`,
            };
          }
          const payload = await response.json().catch(() => ({}));
          const done = store.completeSubmit(request.id, ctx.sessionId, { externalId: payload?.protocolo ?? payload?.id ?? null });
          return {
            ok: true,
            enviado: true,
            requestId: request.id,
            protocolo: payload?.protocolo ?? payload?.id ?? null,
            estado: done.ok ? done.request.state : REQUEST_STATES.submitted,
            mensagem: 'Solicitação enviada e confirmada pelo backend.',
          };
        } catch (error) {
          const code = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
          store.failSubmit(request.id, ctx.sessionId, { code, message: error?.message ?? 'falha de rede' });
          logger?.warn?.('Falha no envio da solicitação', { requestId: request.id, code });
          return {
            ok: false,
            enviado: false,
            erro: `Não foi possível concluir o envio (${code}). A solicitação não foi enviada e pode ser tentada novamente.`,
          };
        }
      },
    },

    /* ------------------------------ 5.9 status ----------------------------- */
    {
      name: 'get_request_status',
      title: 'Consultar andamento',
      kind: 'read',
      expose: true,
      description:
        'Consulta o estado real da solicitação (rascunho, coleta, validação, aguardando aprovação, enviada, falha, cancelada) e o histórico de ações. Nunca estime prazo nem invente andamento.',
      parameters: {
        type: 'object',
        properties: { requestId: { type: 'string', maxLength: 20 } },
        additionalProperties: false,
      },
      handler: ({ requestId }, ctx) => {
        const request = requestOf(ctx, requestId);
        if (!request) {
          return { ok: true, encontrada: false, mensagem: 'Não há solicitação em andamento nesta conversa.', solicitacoes: store.list(ctx?.sessionId).map((item) => ({ id: item.id, estado: item.state })) };
        }
        const report = validateRequestData({ requirements, serviceId: request.serviceId, data: request.data, files: request.files });
        return {
          ok: true,
          encontrada: true,
          solicitacao: shape(request),
          faltando: missingFieldsText(report),
          proximaAcao: report.proximaAcao,
          podeEditar: store.canEdit(request),
          envioDisponivel: Boolean(submitEndpoint(siteOf(ctx))),
          historico: (request.history ?? []).slice(-10),
          observacao:
            'Este é o estado gravado nesta instalação. Não há acompanhamento de prazo publicado pela Opportunity AI.',
        };
      },
    },

    /* ---------------------------- 5.10 cancelar ---------------------------- */
    {
      name: 'cancel_service_request',
      title: 'Cancelar solicitação',
      kind: 'write', // HITL: descartar um pedido em andamento exige confirmação
      requiresConfirmation: true,
      description:
        'Cancela a solicitação em andamento nesta conversa. Rascunhos são descartados de verdade (dados e arquivos). Solicitações já enviadas só podem ser canceladas com operação real no backend, que hoje não existe.',
      parameters: {
        type: 'object',
        properties: {
          requestId: { type: 'string', maxLength: 20 },
          motivo: { type: 'string', maxLength: 200 },
        },
        additionalProperties: false,
      },
      summarize: (args) => `Cancelar a solicitação ${args.requestId ?? 'em andamento'} e descartar os dados coletados.`,
      handler: ({ requestId, motivo }, ctx) => {
        const request = requestOf(ctx, requestId);
        if (!request) return { ok: false, erro: 'Não há solicitação em andamento nesta conversa.' };
        const result = store.cancel(request.id, ctx.sessionId, { reason: motivo ?? null });
        if (!result.ok) return { ok: false, erro: result.error.message, codigo: result.error.code, estado: request.state };
        if (files) files.removeAll(request.id);
        return {
          ok: true,
          cancelada: true,
          requestId: request.id,
          estado: result.request.state,
          mensagem: 'Solicitação cancelada e arquivos removidos. Nada havia sido enviado à Opportunity AI.',
        };
      },
    },
  ];

  /** Forma pública da solicitação (sem sessionId, sem caminhos de disco). */
  function shape(request) {
    return {
      id: request.id,
      serviceId: request.serviceId,
      serviceTitle: request.serviceTitle,
      estado: request.state,
      criadaEm: request.createdAt,
      atualizadaEm: request.updatedAt,
      enviadaEm: request.submittedAt,
      externalId: request.externalId,
      dados: request.data,
      arquivos: (request.files ?? []).map((file) => ({ id: file.id, nome: file.name, tamanho: file.size, expiraEm: file.expiresAt })),
    };
  }

  return { tools, shape, uploadPolicy, submitEndpoint };
}
