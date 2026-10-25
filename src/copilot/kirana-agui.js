/**
 * Adaptador AG-UI da Kirana.
 *
 * Recebe um `RunAgentInput` (protocolo AG-UI), roda um turno normal da Kirana
 * (LangGraph -> gateway -> ferramentas) e devolve o stream traduzido para
 * eventos AG-UI. Não reimplementa nada do agente: só faz a ponte.
 */
import { AGUI, createAgUiTranslator, describeSharedState, lastUserText } from './agui-events.js';
import { sanitizeSharedState } from './tool-schema.js';

/**
 * Executa um turno e devolve os eventos AG-UI em ordem.
 *
 * @param {object} params
 * @param {object} params.agent      agente Kirana (createAgent)
 * @param {object} params.sessions   store de sessões
 * @param {object} params.siteKit    resolvedor de sites
 * @param {object} params.logger
 * @param {object} params.input      RunAgentInput
 * @param {string} [params.siteId]   site identificado pelo widget/cabeçalho
 * @param {AbortSignal} [params.signal]
 * @returns {AsyncGenerator<object>}
 */
export async function* runKiranaTurn({ agent, sessions, siteKit, logger, input, siteId, signal }) {
  const threadId = String(input?.threadId || 'anonymous');
  const runId = String(input?.runId || `run_${Date.now()}`);
  const translator = createAgUiTranslator({ threadId, runId });

  const site = siteKit?.get(siteId) ?? null;
  const scopedSiteId = site?.id ?? 'default';

  yield { type: AGUI.RUN_STARTED, threadId, runId };

  try {
    const text = lastUserText(input);
    if (!text) {
      for (const event of translator.fail('Nenhuma mensagem do usuário no pedido.', 'empty_message')) yield event;
      return;
    }

    const sessionId = siteKit ? siteKit.sessionIdFor(scopedSiteId, threadId) : null;
    // Sessão determinística (site + thread): o histórico sobrevive entre runs.
    const session = (sessionId && sessions.get(sessionId)) || sessions.create({ id: sessionId || undefined, title: text.slice(0, 60), model: null });

    // Estado compartilhado: sanitizado antes de virar contexto do modelo.
    const sharedState = site?.features.sharedState === false ? {} : sanitizeSharedState(input?.state);
    const stateNote = describeSharedState(sharedState);

    // Ferramentas de frontend: interseção entre o que o widget anunciou e o
    // que o site permite. O modelo só vê o que é permitido neste site.
    const externalTools = siteKit ? siteKit.buildExternalTools(scopedSiteId, input?.tools ?? []) : [];

    const queue = [];
    let notify = null;
    const emit = (event) => {
      queue.push(event);
      if (notify) {
        const resume = notify;
        notify = null;
        resume();
      }
    };

    const turnPromise = agent
      .runTurn({
        session,
        text,
        emit,
        signal,
        externalTools,
        contextNote: stateNote || null,
      })
      .then((result) => {
        if (result && result.ok === false && result.error) {
          emit({ type: 'error', error: result.error });
        } else if (result && result.aborted) {
          emit({ type: 'done', aborted: true });
        }
        emit({ type: '__turn_complete__' });
      })
      .catch((error) => {
        emit({ type: 'error', error: { code: error?.code || 'turn_error', message: error?.message || 'Falha no turno.' } });
        emit({ type: '__turn_complete__' });
      });

    // Drena a fila conforme o agente emite (streaming real, sem buffer).
    let complete = false;
    while (!complete) {
      if (queue.length === 0) {
        await new Promise((resolve) => {
          notify = resolve;
          // Segurança: nunca esperar para sempre (turno travado não prende a conexão).
          setTimeout(resolve, 120_000);
        });
        if (queue.length === 0 && signal?.aborted) break;
        if (queue.length === 0) continue;
      }

      const event = queue.shift();
      if (event.type === '__turn_complete__') {
        complete = true;
        break;
      }
      if (event.type === 'done') {
        // garante que o done não seja engolido se o turno devolver antes
      }
      for (const aguiEvent of translator.translate(event)) yield aguiEvent;
    }

    await Promise.resolve(turnPromise).catch(() => {});

    if (!translator.finished) {
      for (const event of translator.close({ reason: signal?.aborted ? 'aborted' : 'completed' })) yield event;
    }
  } catch (error) {
    logger?.error?.('Falha no adaptador AG-UI', { message: error?.message, code: error?.code });
    for (const event of translator.fail(error?.message || 'Erro interno no adaptador.', error?.code || 'adapter_error')) {
      yield event;
    }
  }
}

/** Serializa um evento AG-UI em uma linha SSE (`data: {...}`). */
export function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}
