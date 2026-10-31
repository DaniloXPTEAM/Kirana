/**
 * Requisitos por serviço — leitura e validação de dados (Fase 5).
 *
 * Princípio: **o que o site publica, e só isso**. O arquivo
 * `<site>/requirements.json` separa dois blocos, e a separação é visível para o
 * visitante:
 *
 *   `requisitosPublicados` — o que a página do serviço diz. Hoje todas as
 *      entradas estão com `disponivel: false` porque as páginas de solução
 *      descrevem problema/proposta/entregáveis, mas **não** publicam lista de
 *      requisitos. A ferramenta informa a lacuna em vez de inventar exigência.
 *
 *   `camposDeCaso` — o que a operação precisa saber para orçar o trabalho
 *      (ex.: endereço do site). Vêm marcados com `origem: "operacional"` e a
 *      resposta da ferramenta diz `confirmadoNoSite: false`.
 *
 * `camposDoFormulario` são os campos do formulário real de `/contato`
 * (verificados no HTML publicado: nome, email, whatsapp, empresa, interesse,
 * mensagem, consent).
 */
import fs from 'node:fs';
import path from 'node:path';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+()\d\s-]{8,20}$/;

export const FIELD_TYPES = Object.freeze(['texto', 'email', 'telefone', 'mensagem', 'opcao', 'booleano']);

/** Normaliza rótulos de campo do formulário do site para o esquema interno. */
const FORM_FIELDS = Object.freeze({
  nome: { rotulo: 'Nome', tipo: 'texto', obrigatorio: true },
  email: { rotulo: 'E-mail', tipo: 'email', obrigatorio: true },
  whatsapp: { rotulo: 'WhatsApp', tipo: 'telefone', obrigatorio: false },
  empresa: { rotulo: 'Empresa', tipo: 'texto', obrigatorio: false },
  interesse: { rotulo: 'Interesse', tipo: 'opcao', obrigatorio: true },
  mensagem: { rotulo: 'Mensagem', tipo: 'mensagem', obrigatorio: true },
  consent: { rotulo: 'Consentimento para contato (LGPD)', tipo: 'booleano', obrigatorio: true },
});

export function loadRequirements({ dir, logger } = {}) {
  const file = path.join(dir ?? '', 'requirements.json');
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    logger?.warn?.('Requisitos não carregados', { file, message: error?.message });
    return null;
  }
  const services = new Map((raw.servicos ?? []).map((service) => [service.serviceId, service]));
  return {
    file,
    siteId: raw.siteId ?? null,
    capturedAt: raw.capturedAt ?? null,
    limiteTamanhoArquivoMb: raw.limiteTamanhoArquivoMb ?? 5,
    maximoArquivos: raw.maximoArquivos ?? 5,
    services,
    has: (serviceId) => services.has(serviceId),
    get: (serviceId) => services.get(serviceId) ?? null,
    list: () => [...services.values()],
  };
}

/**
 * Requisitos de um serviço, prontos para a ferramenta.
 *
 * A saída separa o que está publicado do que é operacional — é o que permite a
 * Kirana dizer "o site não publica requisitos deste serviço" sem deixar o
 * visitante sem caminho.
 */
export function requirementsFor(requirements, serviceId) {
  if (!requirements) {
    return { ok: false, erro: 'Cadastro de requisitos indisponível neste site.' };
  }
  const entry = requirements.get(serviceId);
  if (!entry) {
    return {
      ok: false,
      erro: `Não há requisitos cadastrados para o serviço "${serviceId}".`,
      servicosComRequisitos: requirements.list().map((service) => service.serviceId),
    };
  }

  const published = entry.requisitosPublicados ?? { disponivel: false, motivo: 'Não publicado no site.' };
  const formFields = (entry.camposDoFormulario ?? [])
    .filter((name) => FORM_FIELDS[name])
    .map((name) => ({ nome: name, ...FORM_FIELDS[name], origem: 'formulario-do-site' }));
  const caseFields = (entry.camposDeCaso ?? []).map((field) => ({
    nome: field.nome,
    rotulo: field.rotulo,
    tipo: FIELD_TYPES.includes(field.tipo) ? field.tipo : 'texto',
    obrigatorio: field.obrigatorio === true,
    origem: field.origem ?? 'operacional',
  }));

  return {
    ok: true,
    serviceId,
    titulo: entry.titulo ?? null,
    caminho: entry.path ?? null,
    requisitosPublicados: {
      disponivel: published.disponivel === true,
      motivo: published.disponivel === true ? null : published.motivo ?? 'O site não publica requisitos deste serviço.',
      fonte: published.fonte ?? null,
      confirmadoNoSite: published.disponivel === true,
    },
    camposObrigatorios: [...formFields, ...caseFields].filter((field) => field.obrigatorio).map((field) => field.nome),
    campos: [...formFields, ...caseFields],
    camposDoFormulario: formFields.map((field) => field.nome),
    camposDeCaso: caseFields.map((field) => field.nome),
    arquivos: entry.arquivos ?? { necessarios: false, aceitos: [], observacao: null },
    aviso:
      published.disponivel === true
        ? null
        : 'O site não publica a lista de requisitos deste serviço. Os campos abaixo são do formulário oficial e do que a operação precisa saber para orçar — nada aqui é uma exigência publicada.',
  };
}

/**
 * Valida os dados coletados contra os requisitos.
 *
 * Devolve sempre a mesma forma (validos/ausentes/erros/proximaAcao) para o
 * modelo não precisar interpretar texto livre — e para o teste poder afirmar o
 * resultado exato.
 */
export function validateRequestData({ requirements, serviceId, data = {}, files = [] }) {
  const spec = requirementsFor(requirements, serviceId);
  if (!spec.ok) return { ok: false, erro: spec.erro, ...emptyReport() };

  const validos = {};
  const ausentes = [];
  const erros = [];

  for (const field of spec.campos) {
    const raw = data[field.nome];
    const value = typeof raw === 'string' ? raw.trim() : raw;

    if (value == null || value === '' || (field.tipo === 'booleano' && value !== true)) {
      if (field.obrigatorio) ausentes.push({ campo: field.nome, rotulo: field.rotulo, motivo: 'obrigatório' });
      continue;
    }
    if (field.tipo === 'email' && !EMAIL_RE.test(String(value))) {
      erros.push({ campo: field.nome, rotulo: field.rotulo, motivo: 'e-mail inválido' });
      continue;
    }
    if (field.tipo === 'telefone' && !PHONE_RE.test(String(value))) {
      erros.push({ campo: field.nome, rotulo: field.rotulo, motivo: 'telefone deve ter DDD e apenas números, espaços, +, ( ) e -' });
      continue;
    }
    if (field.tipo === 'texto' && String(value).length > 200) {
      erros.push({ campo: field.nome, rotulo: field.rotulo, motivo: 'texto longo demais (máx. 200)' });
      continue;
    }
    if (field.tipo === 'mensagem' && String(value).length > 2000) {
      erros.push({ campo: field.nome, rotulo: field.rotulo, motivo: 'mensagem longa demais (máx. 2000)' });
      continue;
    }
    validos[field.nome] = field.tipo === 'booleano' ? true : value;
  }

  // Campos extras informados pelo visitante são preservados (não são erro).
  const conhecidos = new Set(spec.campos.map((field) => field.nome));
  for (const [key, value] of Object.entries(data)) {
    if (!conhecidos.has(key) && value != null && value !== '') validos[key] = value;
  }

  const arquivosNecessarios = spec.arquivos?.necessarios === true;
  const temArquivo = Array.isArray(files) && files.length > 0;
  if (arquivosNecessarios && !temArquivo) {
    ausentes.push({ campo: 'arquivos', rotulo: 'Arquivo necessário para este serviço', motivo: 'nenhum arquivo anexado' });
  }

  const completo = ausentes.length === 0 && erros.length === 0;
  return {
    ok: true,
    serviceId,
    completo,
    validos: Object.keys(validos),
    dados: validos,
    ausentes,
    erros,
    proximaAcao: proximoPasso({ completo, ausentes, erros, arquivosNecessarios, temArquivo }),
    proximoCampo: ausentes[0]?.campo ?? null,
    requisitos: spec,
  };
}

function proximoPasso({ completo, ausentes, erros, arquivosNecessarios, temArquivo }) {
  if (erros.length) return 'corrigir_dados';
  if (ausentes.length) {
    if (arquivosNecessarios && !temArquivo && ausentes.every((item) => item.campo === 'arquivos')) {
      return 'solicitar_arquivo';
    }
    return 'coletar_dados';
  }
  if (completo) return 'pedir_confirmacao';
  return 'coletar_dados';
}

function emptyReport() {
  return { completo: false, validos: [], dados: {}, ausentes: [], erros: [], proximaAcao: 'coletar_dados', proximoCampo: null };
}

/** Campos que faltam, em linguagem de conversa (para o pedido progressivo). */
export function missingFieldsText(report) {
  const parts = [];
  for (const item of report.ausentes ?? []) parts.push(item.rotulo ?? item.campo);
  for (const item of report.erros ?? []) parts.push(`${item.rotulo ?? item.campo} (${item.motivo})`);
  return parts;
}
