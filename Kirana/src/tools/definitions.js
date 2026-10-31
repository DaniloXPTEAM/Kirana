/**
 * Definições das ferramentas da Fase 1.
 *
 * Leitura  (rodam direto):    consultar_servicos, consultar_produtos,
 *                             consultar_status_projeto, consultar_memoria
 * Escrita  (exigem confirmação na interface):
 *                             registrar_interesse_comercial, salvar_memoria,
 *                             apagar_memoria
 */
import { rankItems, normalizeText } from './search.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^\+?[0-9][0-9\s().-]{7,19}$/;

const clampList = (items, max) => items.slice(0, max);

export function createToolDefinitions({ catalog, memory, interests, logger }) {
  return [
    {
      name: 'consultar_servicos',
      title: 'Consultar serviços',
      kind: 'read',
      description:
        'Consulta o catálogo oficial de serviços da Opportunity AI (fontes do site). Use sempre que o usuário perguntar o que a empresa faz, se algum serviço atende ao problema dele ou pedir detalhes de uma frente de trabalho.',
      parameters: {
        type: 'object',
        properties: {
          consulta: {
            type: 'string',
            maxLength: 200,
            description: 'Texto livre com o que o usuário procura (ex.: "atendimento no WhatsApp"). Vazio devolve a lista completa.',
          },
          servico_id: {
            type: 'string',
            maxLength: 60,
            description: 'Identificador exato do serviço, quando já conhecido (ex.: agentes-ia, atendimento, crm-vendas, automacao, relatorios, voz).',
          },
        },
        additionalProperties: false,
      },
      handler: ({ consulta, servico_id }) => {
        if (servico_id) {
          const found = catalog.services.find((s) => s.id === normalizeText(servico_id));
          if (!found) return { encontrado: false, mensagem: `Serviço "${servico_id}" não existe no catálogo.` };
          return { encontrado: true, servico: shapeService(found), fonte: catalog.meta.sources };
        }
        const ranked = consulta ? rankItems(catalog.services, consulta) : catalog.services.map((item) => ({ item, score: 0 }));
        const selected = clampList(ranked, 6).map(({ item }) => shapeService(item));
        return {
          encontrados: selected.length,
          consulta: consulta || null,
          servicos: selected,
          observacao:
            'Estes são os seis serviços publicados no site. Escopo, prazos e valores são definidos caso a caso — não há preço público confirmado.',
          fonte: catalog.meta.sources,
        };
      },
    },

    {
      name: 'consultar_produtos',
      title: 'Consultar produtos e projetos do Labs',
      kind: 'read',
      description:
        'Consulta os produtos/projetos publicados pela Opportunity AI (Opportunity Labs) com o estágio real informado no site. Use antes de afirmar qualquer característica, estágio ou disponibilidade de produto.',
      parameters: {
        type: 'object',
        properties: {
          consulta: { type: 'string', maxLength: 200, description: 'Texto livre do que o usuário procura.' },
          produto_id: {
            type: 'string',
            maxLength: 60,
            description: 'Identificador exato (ex.: opportunity-crm, cineforma, kirana, opportunity-creators).',
          },
        },
        additionalProperties: false,
      },
      handler: ({ consulta, produto_id }) => {
        if (produto_id) {
          const found = catalog.products.find((p) => p.id === normalizeText(produto_id));
          if (!found) return { encontrado: false, mensagem: `Produto "${produto_id}" não existe no catálogo.` };
          return { encontrado: true, produto: found };
        }
        const ranked = consulta ? rankItems(catalog.products, consulta) : catalog.products.map((item) => ({ item, score: 0 }));
        return {
          encontrados: ranked.length ? clampList(ranked, 5).length : 0,
          produtos: clampList(ranked, 5).map(({ item }) => item),
          observacao:
            'Estágio conforme publicado no site. Não há planos, licenças ou preços comerciais confirmados neste sistema.',
          fonte: 'https://opportunity.ia.br/labs/',
        };
      },
    },

    {
      name: 'consultar_status_projeto',
      title: 'Consultar status de projeto',
      kind: 'read',
      description:
        'Consulta o andamento de um projeto pelo identificador ou pelo nome. ATENÇÃO: nesta fase os dados são SIMULADOS (demonstração). Ao responder, deixe claro que é um exemplo simulado.',
      parameters: {
        type: 'object',
        properties: {
          projeto_id: { type: 'string', maxLength: 40, description: 'Identificador do projeto, ex.: PRJ-001.' },
          consulta: { type: 'string', maxLength: 120, description: 'Nome ou trecho do nome do projeto.' },
        },
        additionalProperties: false,
      },
      validate: (args) => (args.projeto_id || args.consulta ? [] : ['informe projeto_id ou consulta']),
      handler: ({ projeto_id, consulta }) => {
        const all = catalog.projects;
        if (projeto_id) {
          const found = all.find((p) => p.id.toLowerCase() === String(projeto_id).trim().toLowerCase());
          if (!found) {
            return {
              encontrado: false,
              dados_simulados: true,
              mensagem: 'Projeto não encontrado.',
              projetos_disponiveis: all.map((p) => ({ id: p.id, nome: p.nome })),
            };
          }
          return { encontrado: true, dados_simulados: true, projeto: found };
        }
        const ranked = rankItems(all, consulta, { fields: ['nome', 'etapa_atual', 'status'], keywordsField: 'etapas_concluidas' });
        return {
          encontrado: ranked.length > 0,
          dados_simulados: true,
          consulta,
          projetos: clampList(ranked, 3).map(({ item }) => item),
          projetos_disponiveis: ranked.length ? undefined : all.map((p) => ({ id: p.id, nome: p.nome })),
          aviso: 'Dados simulados para demonstração da arquitetura de ferramentas.',
        };
      },
    },

    {
      name: 'consultar_memoria',
      title: 'Consultar memória',
      kind: 'read',
      description:
        'Lista as informações que o próprio usuário autorizou guardar nesta instalação. Use quando ele perguntar o que você lembra sobre ele.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => {
        const items = memory.list();
        return {
          total: items.length,
          itens: items.map(({ id, key, value, category, updatedAt }) => ({ id, chave: key, valor: value, categoria: category, atualizado_em: updatedAt })),
        };
      },
    },

    {
      name: 'registrar_interesse_comercial',
      title: 'Registrar interesse comercial',
      kind: 'write',
      description:
        'Prepara e registra uma solicitação de contato comercial. Só é executada depois que o usuário confirma na interface. NÃO diga que o contato foi enviado: o registro fica local, pendente de envio à equipe.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 80, description: 'Nome do usuário.' },
          canal_tipo: { type: 'string', enum: ['email', 'whatsapp'], description: 'Tipo de canal de retorno.' },
          canal_valor: { type: 'string', minLength: 8, maxLength: 80, description: 'E-mail ou número de WhatsApp.' },
          interesse: { type: 'string', minLength: 3, maxLength: 200, description: 'Tema principal do interesse (ex.: "atendimento no WhatsApp").' },
          mensagem: { type: 'string', maxLength: 1000, description: 'Detalhe livre do que a pessoa precisa.' },
          empresa: { type: 'string', maxLength: 100, description: 'Empresa do usuário, se ele informou.' },
          consentimento: {
            type: 'boolean',
            description: 'Deve ser true apenas se o usuário concordou explicitamente em ser contatado.',
          },
        },
        required: ['nome', 'canal_tipo', 'canal_valor', 'interesse', 'consentimento'],
        additionalProperties: false,
      },
      validate: (args) => {
        const errors = [];
        if (args.consentimento !== true) errors.push('o usuário precisa concordar explicitamente em ser contatado');
        if (args.canal_tipo === 'email' && !EMAIL_RE.test(String(args.canal_valor || '').trim())) errors.push('e-mail em formato inválido');
        if (args.canal_tipo === 'whatsapp' && !PHONE_RE.test(String(args.canal_valor || '').trim())) errors.push('WhatsApp deve conter apenas números, espaços, +, ( ) e -, com DDD');
        return errors;
      },
      summarize: (args) =>
        [
          `Registrar interesse comercial de ${args.nome}${args.empresa ? ` (${args.empresa})` : ''}.`,
          `Contato: ${args.canal_tipo === 'email' ? 'e-mail' : 'WhatsApp'} ${args.canal_valor}.`,
          `Interesse: ${args.interesse}.`,
          args.mensagem ? `Mensagem: ${String(args.mensagem).slice(0, 180)}` : null,
        ]
          .filter(Boolean)
          .join(' '),
      handler: (args) => {
        const record = interests.create({
          nome: String(args.nome).trim().slice(0, 80),
          empresa: args.empresa ? String(args.empresa).trim().slice(0, 100) : null,
          canal_tipo: args.canal_tipo,
          canal_valor: String(args.canal_valor).trim().slice(0, 80),
          interesse: String(args.interesse).trim().slice(0, 200),
          mensagem: args.mensagem ? String(args.mensagem).trim().slice(0, 1000) : null,
          consentimento: true,
        });
        return {
          registrado: true,
          protocolo: record.protocolo,
          criado_em: record.criadoEm,
          status: 'gravado localmente, pendente de envio à equipe',
          envio_externo: false,
          aviso:
            'Nada foi enviado por e-mail, WhatsApp ou CRM. Este é um registro local da Fase 1. Diga ao usuário que o pedido foi registrado localmente e que a equipe fará o contato.',
          contato_oficial: catalog.institution?.organizacao?.whatsapp ?? null,
        };
      },
    },

    {
      name: 'salvar_memoria',
      title: 'Guardar informação autorizada',
      kind: 'write',
      description:
        'Guarda uma informação que o usuário pediu explicitamente para você lembrar. Exige confirmação na interface. Nunca guarde senhas, documentos, cartões ou dados sensíveis.',
      parameters: {
        type: 'object',
        properties: {
          chave: { type: 'string', minLength: 2, maxLength: 80, description: 'Rótulo curto, ex.: "nome", "empresa", "prefere contato por".' },
          valor: { type: 'string', minLength: 1, maxLength: 400, description: 'Conteúdo a guardar.' },
          categoria: {
            type: 'string',
            enum: ['preferencia', 'contexto', 'contato'],
            description: 'Categoria da informação.',
          },
        },
        required: ['chave', 'valor'],
        additionalProperties: false,
      },
      summarize: (args) => `Guardar na memória: "${args.chave}" = ${String(args.valor).slice(0, 120)}`,
      handler: (args, ctx) => {
        const item = ctx.memory.upsert({
          key: args.chave,
          value: args.valor,
          category: args.categoria || 'contexto',
          source: 'confirmado pelo usuário na interface',
          consent: true,
        });
        return { salvo: true, item: { id: item.id, chave: item.key, valor: item.value }, observacao: 'O usuário pode ver, corrigir ou apagar isso no painel Memória.' };
      },
    },

    {
      name: 'apagar_memoria',
      title: 'Apagar informação da memória',
      kind: 'write',
      description: 'Apaga uma informação guardada na memória. Exige confirmação na interface.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 40, description: 'Identificador do item (preferencial).' },
          chave: { type: 'string', maxLength: 80, description: 'Ou o rótulo do item, se o id não for conhecido.' },
        },
        additionalProperties: false,
      },
      validate: (args) => (args.id || args.chave ? [] : ['informe id ou chave']),
      summarize: (args) => `Apagar da memória o item ${args.id || `"${args.chave}"`}.`,
      handler: (args, ctx) => {
        const items = ctx.memory.list();
        const target = args.id
          ? items.find((item) => item.id === args.id)
          : items.find((item) => normalizeText(item.key) === normalizeText(args.chave));
        if (!target) return { apagado: false, mensagem: 'Não encontrei esse item na memória.' };
        ctx.memory.remove(target.id);
        return { apagado: true, item: { id: target.id, chave: target.key } };
      },
    },
  ];
}

function shapeService(service) {
  return {
    id: service.id,
    nome: service.nome,
    problema: service.problema,
    aplicacao: service.aplicacao,
    pagina: service.url,
  };
}
