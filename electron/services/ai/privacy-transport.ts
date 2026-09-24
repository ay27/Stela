import { createAssistantMessageEventStream, type AssistantMessage, type Models } from '@earendil-works/pi-ai';
import type { PrivacySession } from './privacy-session';

/** Wrap every Models generation method, including Pi's native summarizer. */
export function withPrivacy<T extends Models>(models: T, privacy: PrivacySession): T {
  if (!privacy.enabled && !privacy.state.entries.length) return models;
  const wrap = (method: 'stream' | 'streamSimple'): Models['streamSimple'] => (model, context, options) => {
    const output = createAssistantMessageEventStream();
    let dispatched = false;
    void (async () => {
      const safe = await privacy.context(context, options?.signal);
      dispatched = true;
      const stream = method === 'streamSimple' ? models.streamSimple(model, safe, options) : models.stream(model, safe, options);
      for await (const event of stream) output.push(event);
      output.end(await stream.result());
    })().catch(() => {
      const error: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: options?.signal?.aborted ? 'aborted' : 'error',
        errorMessage: dispatched ? 'AI request failed after privacy processing.' : 'Privacy processing failed; the request was not sent. Reduce the input or retry.',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: 'error', reason: error.stopReason === 'aborted' ? 'aborted' : 'error', error }); output.end(error);
    });
    return output;
  };
  const stream = wrap('stream') as Models['stream'], simple = wrap('streamSimple');
  return new Proxy(models, { get(target, key) {
    if (key === 'stream') return stream;
    if (key === 'streamSimple') return simple;
    if (key === 'complete') return (...args: Parameters<Models['stream']>) => stream(...args).result();
    if (key === 'completeSimple') return (...args: Parameters<Models['streamSimple']>) => simple(...args).result();
    const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
