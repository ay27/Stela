/** Adapt Pi lanes to Stela's existing run lifecycle, without replaying tools. */
import {
  AgentHarness as NativeHarness, BACKGROUND_CONTEXT as context, DEFAULT_COMPACTION_SETTINGS,
  getOrThrow, type AgentHarnessOptions, type AgentTool, type AgentMessage,
  type HarnessEvent, type HookMap, type HookHandler, type AgentLane,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, TextContent, ImageContent } from '@earendil-works/pi-ai';
import { Session, JsonlSessionStorage } from './pi-session';

interface IOptions extends Omit<AgentHarnessOptions, 'session' | 'tools'> {
  session: Session;
  tools?: AgentTool[];
  env?: unknown;
}
type Event = Exclude<HarnessEvent, { type: 'tool_start' | 'tool_end' | 'message_update' }>
  | (Omit<Extract<HarnessEvent, {type: 'tool_start'}>, 'type'> & {type: 'tool_execution_start'})
  | (Omit<Extract<HarnessEvent, {type: 'tool_end'}>, 'type'> & {type: 'tool_execution_end'})
  | (Extract<HarnessEvent, {type: 'message_update'}> & {assistantMessageEvent: Extract<HarnessEvent, {type: 'message_update'}>['event']});
export class AgentHarness {
  private ready?: Promise<{ harness: NativeHarness; lane: AgentLane }>;
  private listeners = new Set<(event: Event) => void | Promise<void>>();
  private hooks: ((harness: NativeHarness) => () => void)[] = [];
  private cancelled = false;
  private eventsDone: Promise<void> = Promise.resolve();
  constructor(private readonly options: IOptions) {}
  private initialize() {
    return this.ready ??= (async () => {
      const { session, tools = [], env: _env, ...options } = this.options;
      const native = await session.ready;
      const { harness, open } = await NativeHarness.create({ ...options, session: native,
        models: new Proxy(options.models, { get(target, key) {
          if (key === 'getModel') return (provider: string, id: string) => provider === options.model.provider && id === options.model.id
            ? options.model : target.getModel(provider, id);
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } }),
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
        streamOptions: { ...options.streamOptions, maxRetries: 0 },
        entryProjectors: session.options.entryProjectors,
        tools: tools.map(tool => ({ ...tool, replay: 'never',
          execute: async (id, params, onUpdate, _toolContext, _invocation, ctx) => {
            await this.eventsDone;
            ctx.abortSignal?.throwIfAborted();
            return tool.execute(id, params, ctx.abortSignal, onUpdate);
          },
        })),
      }, context);
      const lane = await harness.lane('main', context);
      // Opening a conversation never authorizes resuming an interrupted effect.
      if (open.some(operation => operation.lane === 'main')) getOrThrow(await lane.abort(context));
      await lane.setModel({ provider: options.model.provider, modelId: options.model.id }, context);
      await lane.setThinkingLevel(options.thinkingLevel ?? 'off', context);
      await lane.setActiveTools(tools.map(tool => tool.name), context);
      session.lane = lane;
      if (session.storage instanceof JsonlSessionStorage) session.storage.lane = lane;
      harness.hooks.on('transform_context', event => {
        let entries = event.messages.map((message, index) => ({ type: 'message' as const, id: String(index), parentId: null, seq: index, timestamp: Date.now(), message }));
        for (const transform of session.options.entryTransforms ?? []) entries = transform(entries).filter((entry): entry is typeof entries[number] => entry.type === 'message');
        return { messages: entries.map(entry => entry.message) };
      });
      for (const hook of this.hooks) hook(harness);
      // Pi emits while holding its lane command barrier. Awaiting Stela history
      // writes there would deadlock. Drain at effect boundaries, outside that barrier.
      const deliver = (event: Event) => {
        this.eventsDone = this.eventsDone.then(async () => { for (const listener of this.listeners) await listener(event); });
        void this.eventsDone.catch(() => {});
      };
      harness.hooks.on('before_request', async () => { await this.eventsDone; return undefined; });
      for (const type of ['turn_start', 'turn_end', 'message_start', 'message_end'] as const)
        harness.events.on(type, event => deliver(event));
      harness.events.on('message_update', event => deliver({ ...event, assistantMessageEvent: event.event }));
      harness.events.on('tool_start', event => deliver({ ...event, type: 'tool_execution_start' }));
      harness.events.on('tool_end', event => deliver({ ...event, type: 'tool_execution_end' }));
      return { harness, lane };
    })();
  }
  subscribe(listener: (event: Event) => void | Promise<void>) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  on(name: 'context', handler: HookHandler<'transform_context'>): () => void;
  on(name: 'before_provider_payload', handler: HookHandler<'before_payload'>): () => void;
  on(name: 'tool_result', handler: (event: HookMap['after_tool']['event'] & {input: Record<string, unknown>}) => HookMap['after_tool']['result'] | Promise<HookMap['after_tool']['result']>): () => void;
  on(name: 'context' | 'before_provider_payload' | 'tool_result', handler: unknown) {
    let active = true; let unsubscribe: (() => void) | undefined;
    const install = (harness: NativeHarness) => {
      if (!active || unsubscribe) return () => {};
      if (name === 'context') unsubscribe = harness.hooks.on('transform_context', handler as HookHandler<'transform_context'>);
      else if (name === 'before_provider_payload') unsubscribe = harness.hooks.on('before_payload', handler as HookHandler<'before_payload'>);
      else unsubscribe = harness.hooks.on('after_tool', (event) => (handler as (event: HookMap['after_tool']['event'] & {input: Record<string, unknown>}) => HookMap['after_tool']['result'])({ ...event, input: event.args }));
      return unsubscribe;
    };
    this.hooks.push(install);
    if (this.ready) void this.ready.then(({ harness }) => install(harness));
    return () => { active = false; unsubscribe?.(); };
  }
  async abort() { this.cancelled = true; if (this.ready) { const { lane } = await this.ready; await lane.abort(context); } }
  async compact(customInstructions?: string) {
    const { lane } = await this.initialize();
    return getOrThrow(await lane.compact({ customInstructions }, context));
  }
  async prompt(prompt: string | (TextContent | ImageContent)[]): Promise<AssistantMessage> {
    const { lane } = await this.initialize();
    if (this.cancelled) throw new Error('Agent cancelled before model execution.');
    const message: AgentMessage = { role: 'user', content: typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt, timestamp: Date.now() };
    const result = getOrThrow(await lane.prompt(message, context));
    await this.eventsDone;
    const last = (await lane.findEntries({ type: 'message', order: 'newestFirst' }, context))
      .find(entry => entry.type === 'message' && entry.message.role === 'assistant');
    if (!last || last.type !== 'message' || last.message.role !== 'assistant') throw new Error('Agent finished without an assistant response');
    if (result.status === 'failed') return { ...last.message, stopReason: 'error', errorMessage: result.error?.message ?? 'Agent failed' };
    if (result.status === 'aborted') return { ...last.message, stopReason: 'aborted' };
    return last.message;
  }
}
