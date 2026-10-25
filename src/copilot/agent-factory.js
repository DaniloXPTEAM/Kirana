/**
 * Agente Kirana dentro do CopilotKit (BuiltInAgent modo "custom").
 *
 * O CopilotKit cuida do ciclo do run (RUN_STARTED/RUN_FINISHED, SSE, abort);
 * nós cuidamos do que é nosso: sessão, LangGraph, gateway, ferramentas.
 * Nada de autenticação, streaming ou execução é duplicado.
 */
import { BuiltInAgent } from '@copilotkit/runtime/v2';

import { createAgUiTranslator, describeSharedState, lastUserText, toolResultsFromMessages } from './agui-events.js';
import { sanitizeSharedState } from './tool-schema.js';
import { DEFAULT_SITE_ID } from './site-kit.js';

/** Nota de sistema com estado da página + resultados devolvidos pelo navegador. */
function buildContextNote(input, site) {
  const parts = [];
  const note = describeSharedState(sanitizeSharedState(input?.state));
  if (note) parts.push(note);

  const results = toolResultsFromMessages(input);
  if (results.length) {
    parts.push(
      `Resultados de ações executadas no navegador nesta conversa:\n${results
        .map((r) => `- ${r.content}`.slice(0, 400))
        .join('\n')}`,
    );
  }

  if (site?.identity?.company) {
    parts.push(`Site integrado: ${site.name} (${site.identity.company}).`);
  }
  return parts.join('\n\n');
}

export function createKiranaAgent({ agent, sessions, siteKit, logger }) {
  const log = logger?.child?.('copilot-agent') ?? logger;

  return new BuiltInAgent({
    type: 'custom',
    factory: async function* factory({ input, abortSignal }) {
      const runId = input?.runId || `run_${Date.now()}`;
      const translator = createAgUiTranslator({ runId });

      const siteId = String(input?.forwardedProps?.siteId || input?.forwardedProps?.site || DEFAULT_SITE_ID).slice(0, 64);
      const site = siteKit?.get(siteId) ?? null;
      const scopedSite = site?.id || 'default';

      const text = lastUserText(input);
      if (!text) {
        yield { type: 'RUN_ERROR', message: 'Nenhuma mensagem do usuário no pedido.', code: 'empty_message' };
        return;
      }

      if (siteKit && !siteKit.originAllowed(scopedSite, input?.forwardedProps?.origin)) {
        yield { type: 'RUN_ERROR', message: 'Origem não autorizada para este site.', code: 'forbidden_origin' };
        return;
      }

      const sessionId = siteKit ? siteKit.sessionIdFor(scopedSite, input.threadId) : null;
      const session = (sessionId && sessions.get(sessionId)) || sessions.create({ id: sessionId || undefined, title: text.slice(0, 60) });

      const externalTools = siteKit ? siteKit.buildExternalTools(scopedSite, input?.tools ?? []) : [];
      const contextNote = buildContextNote(input, site);

      // Fila -> iterador: transforma o callback do agente em stream AG-UI.
      const queue = [];
      let wake = null;
      const emit = (event) => {
        queue.push(event);
        if (wake) {
          const resume = wake;
          wake = null;
          resume();
        }
      };

      const turn = agent
        .runTurn({ session, text, emit, signal: abortSignal, externalTools, contextNote })
        .then((result) => {
          if (result?.ok === false && result.error) emit({ type: 'error', error: result.error });
          else if (result?.aborted) emit({ type: 'done', aborted: true });
          emit({ type: '__complete__' });
        })
        .catch((error) => {
          emit({ type: 'error', error: { code: error?.code || 'turn_error', message: error?.message || 'Falha no turno.' } });
          emit({ type: '__complete__' });
        });

      try {
        for (;;) {
          if (queue.length === 0) {
            await new Promise((resolve) => {
              wake = resolve;
              setTimeout(resolve, 120_000);
            });
            if (queue.length === 0) {
              if (abortSignal?.aborted) break;
              continue;
            }
          }
          const event = queue.shift();
          if (event.type === '__complete__') break;
          for (const aguiEvent of translator.translate(event)) yield aguiEvent;
        }

        await turn.catch(() => {});
        for (const event of translator.close(abortSignal?.aborted ? 'aborted' : 'completed')) yield event;
      } catch (error) {
        log?.error?.('Falha no turno CopilotKit', { message: error?.message });
        for (const event of translator.translate({ type: 'error', error })) yield event;
      }
    },
  });
}
