import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureSemanticGrantRoot, hasSemanticGrant, saveSemanticGrant, semanticGrantEpoch,
  semanticGrantSignal, revokeSemanticGrants } from "./semantic-grants";
import { DEFAULT_SEMANTIC_BUDGET } from "../../shared/semantic";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "stela-semantic-grants-"));
try {
  configureSemanticGrantRoot(root);
  const vault = "/test-vault", recipient = "provider/endpoint/model";
  assert.equal(await hasSemanticGrant(vault, recipient, DEFAULT_SEMANTIC_BUDGET), false);
  const epoch = semanticGrantEpoch(vault);
  await saveSemanticGrant(vault, recipient, DEFAULT_SEMANTIC_BUDGET, epoch);
  assert.equal(await hasSemanticGrant(vault, recipient, DEFAULT_SEMANTIC_BUDGET), true);
  assert.equal(await hasSemanticGrant("/another-vault", recipient, DEFAULT_SEMANTIC_BUDGET), false);
  assert.equal(await hasSemanticGrant(vault, "another/model", DEFAULT_SEMANTIC_BUDGET), false);
  assert.equal(await hasSemanticGrant(vault, recipient, { ...DEFAULT_SEMANTIC_BUDGET, tokens: 300000 }), false);
  const signal = semanticGrantSignal(vault);
  await revokeSemanticGrants(vault);
  assert.equal(signal.aborted, true);
  assert.equal(await hasSemanticGrant(vault, recipient, DEFAULT_SEMANTIC_BUDGET), false);
  await assert.rejects(saveSemanticGrant(vault, recipient, DEFAULT_SEMANTIC_BUDGET, epoch), /revoked/);
  assert.equal(semanticGrantSignal(vault).aborted, false);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
console.log("semantic grant tests passed");
