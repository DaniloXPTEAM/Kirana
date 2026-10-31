/**
 * Runtime HTTP do CopilotKit montado no servidor Node existente.
 *
 * - Não cria gateway paralelo: o agente registrado é a Kirana.
 * - Não pede chave nova: serviceAdapter vazio (nenhum provedor de LLM do
 *   CopilotKit é usado; quem fala com o modelo é o gateway da Kirana).
 */
import { CopilotRuntime, ExperimentalEmptyAdapter, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime';

import { createKiranaAgent } from './agent-factory.js';

export function createCopilotHandler({ agent, sessions, siteKit, logger, basePath = '/api/copilot' }) {
  const kirana = createKiranaAgent({ agent, sessions, siteKit, logger });
  const runtime = new CopilotRuntime({ agents: { kirana } });
  const Adapter = ExperimentalEmptyAdapter ?? CopilotRuntime.EmptyAdapter;

  const handler = copilotRuntimeNodeHttpEndpoint({
    runtime,
    serviceAdapter: new Adapter(),
    baseUrl: basePath,
  });

  return { handler, runtime, agentName: 'kirana' };
}
