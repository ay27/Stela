import assert from "node:assert/strict";
import { AgentHarness, Session, InMemorySessionStorage } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { AiSettings } from "@shared/types";
import { createAgentTools } from "./agent-tools";
import { ToolRepairBudget } from "./tool-repair";

const model: Model<"openai-completions"> = { id: "fixture", name: "fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://offline.invalid",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const models = createModels();
let generation = 0;
models.streamSimple = () => {
  const index = generation++;
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    stopReason: index < 7 ? "toolUse" : "stop",
    content: index < 7 ? [{ type: "toolCall", id: `call-${index}`, name: "ask_user", arguments: {
      question: "Which scope?", options: index < 6 ? [{ label: "aaa" }] : ["aaa", "all"],
    } }] : [{ type: "text", text: "Unable to ask; report missing scope." }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  assert.ok(index < 8, "no extra generations");
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
  stream.end(message);
  return stream;
};
const repairBudget = new ToolRepairBudget();
let questions = 0;
const tools = createAgentTools({ ctx: {
  vaultPath: "/unused", connectionName: null, connection: null, aiSettings: {} as AiSettings, mode: "normal", skills: [],
  connector: { listKinds: () => [], listDatabases: async () => [], listTables: async () => [], execute: async () => { throw new Error("No database use"); } },
  sqlIndex: { query: async () => [] }, recordRun: async () => {},
  run: { runId: "repair", notePath: null, questionsAsked: 0, toolFailureStreak: new Map(), repairBudget },
}, requestProposal: async () => { questions++; return "aaa"; } }).filter(tool => tool.name === "ask_user");
const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: process.cwd() }), session: new Session(new InMemorySessionStorage()), models, model, tools });
const errors: string[] = [];
harness.subscribe(event => {
  if (event.type !== "tool_execution_end") return;
  const hint = repairBudget.observeHarnessResult(event.toolName, event.toolCallId, event.isError);
  const content: Array<{ type: string; text?: string }> = event.result.content;
  errors.push(content.filter(block => block.type === "text").map(block => block.text).join("\n") + (hint ?? ""));
});
harness.on("context", event => ({ messages: [...event.messages, { role: "user", content: repairBudget.contextHint(), timestamp: Date.now() }] }));
await harness.prompt("Offline schema repair regression");
assert.equal(questions, 0, "six pre-dispatch schema failures block the following valid call");
assert.equal(errors.length, 7);
assert.match(errors[0]!, /schema_validation/);
assert.match(errors[1]!, /change the source/);
assert.match(errors[6]!, /budget exhausted/);
console.log("pre-dispatch schema repair integration passed");
