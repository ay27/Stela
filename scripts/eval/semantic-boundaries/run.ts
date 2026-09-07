/** Small semantic calibration set, not DAB and not an accuracy guarantee.
 * Default self-check is offline. --run-model explicitly authorizes fixture transmission. */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { SemanticExecution } from "../../../electron/services/ai/semantic-execution";
import { semanticRequestSchema } from "../../../electron/shared/semantic";
import { createTransportForProfile } from "../../../electron/services/ai/provider";
import { assistantText } from "../../../electron/services/ai/agent-prompt";
import { requireCredentials, buildEvalSettings, evalReasoningEffort } from "../env";
import { sourceFingerprint } from "../source-fingerprint";

const rowSchema = z.object({ id: z.string(), split: z.enum(["dev", "test"]), kind: z.enum(["classify", "extract", "resolve"]),
  data: z.record(z.unknown()), expected: z.object({ status: z.enum(["success", "unresolved"]), value: z.unknown() }) });
const contents = await fs.readFile(new URL("./fixtures.json", import.meta.url), "utf8");
const fixtures = z.array(rowSchema).parse(JSON.parse(contents));
assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length);
// Human-readable fixture IDs can reveal expected labels; only opaque positions reach the model.
const requests = fixtures.map((f, index) => semanticRequestSchema.parse({ operation: f.kind, records: [{ id: String(index), data: f.data }],
  instructions: f.kind === "classify" ? "Classify primary subject. Company financial performance is business even for technology companies. Use unresolved when no subject can be established."
    : f.kind === "extract" ? "Use header to identify capital/disaster. Extract actual paid USD, convert million to units; exclude proposed/approved but unpaid amounts. Explicitly no payment means zero. Undisclosed payments or currency are unresolved."
      : "Match legal entities using registration IDs and country. Different registration IDs establish different entities; a shared name alone is insufficient. Leave uncertain pairs unresolved.",
  ...(f.kind === "classify" ? { labels: { sports: "sporting competition", business: "company finance/economy", science: "scientific discovery or research" } }
    : f.kind === "extract" ? { requiredFields: ["text", "header"], schema: { type: "object", properties: { type: { type: "string", enum: ["capital", "disaster"] }, paid_usd: { type: "integer" } }, required: ["type", "paid_usd"], additionalProperties: false } } : {}),
}));
if (!process.argv.includes("--run-model")) {
  for (const [index, request] of requests.entries()) {
    assert.ok(!("expected" in request) && !JSON.stringify(request).includes('"split"'));
    assert.ok(!JSON.stringify(request).includes(fixtures[index]!.id), "descriptive fixture IDs must not leak label hints");
  }
  console.log(`离线校验通过：${fixtures.length} 个合成边界样本；未调用模型，不代表准确率通过。`);
} else {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const split = z.enum(["dev", "test"]).parse(arg("--split") ?? "dev");
  const output = arg("--output");
  if (!output) throw new Error("--run-model requires --output <new-directory>");
  // Fail before spending or overwriting a previous trial.
  await fs.mkdir(path.resolve(output));
  const credentials = requireCredentials();
  const transport = createTransportForProfile(buildEvalSettings(credentials.model, credentials.baseUrl, evalReasoningEffort(arg("--reasoning-effort"))), credentials.apiKey, "eval");
  const execution = new SemanticExecution({ identity: JSON.stringify([transport.model.id, transport.reasoning.effective]),
    signal: AbortSignal.timeout(15 * 60_000), budget: { records: 100, requests: 50, tokens: 200000 }, authorize: async () => true,
    complete: async (systemPrompt, content, maxTokens, signal) => {
      const message = await transport.models.completeSimple(transport.model, { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] },
        { signal, maxTokens, maxRetries: 0, reasoning: transport.reasoning.effective });
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? message.stopReason);
      return { text: assistantText(message), tokens: message.usage.totalTokens };
    },
  });
  const manifest = { split, model: transport.model.id, reasoning: transport.reasoning.effective,
    sourceFingerprint: await sourceFingerprint(process.cwd()), fixtureHash: createHash("sha256").update(contents).digest("hex"),
    endpointHash: createHash("sha256").update(credentials.baseUrl).digest("hex"), generatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  const scores = [];
  for (const [i, fixture] of fixtures.entries()) {
    if (fixture.split !== split) continue;
    const response = await execution.execute(JSON.stringify(requests[i]));
    const actual = response.rows[0]!;
    let correct = false;
    try { assert.deepEqual({ status: actual.status, value: actual.value }, fixture.expected); correct = true; } catch { /* score only */ }
    const row = { id: fixture.id, kind: fixture.kind, correct, actual, expected: fixture.expected, usage: response.usage };
    scores.push(row);
    await fs.appendFile(path.join(output, "results.jsonl"), JSON.stringify(row) + "\n");
  }
  const report = { ...manifest, correct: scores.filter((r) => r.correct).length, total: scores.length, usage: execution.usage,
    limitation: "合成边界集，仅用于语义契约校准；不是 DAB 分数，也不能替代真实业务保留集。" };
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`语义边界集 ${split}：${report.correct}/${report.total}，结果：${output}`);
}
