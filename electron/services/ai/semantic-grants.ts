import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../atomic-write";
import { semanticBudgetSchema, type SemanticBudget } from "../../shared/semantic";

let root: string | null = null;
const epochs = new Map<string, number>();
const controllers = new Map<string, AbortController>();
export function semanticGrantSignal(vault: string): AbortSignal {
  let controller = controllers.get(vault);
  if (!controller || controller.signal.aborted) { controller = new AbortController(); controllers.set(vault, controller); }
  return controller.signal;
}
export function configureSemanticGrantRoot(value: string): void { root = value; }
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function directory(vault: string): string {
  if (!root) throw new Error("Semantic grant storage is unavailable");
  return path.join(root, hash(vault));
}
export function semanticGrantEpoch(vault: string): number { return epochs.get(vault) ?? 0; }
export async function hasSemanticGrant(vault: string, identity: string, budget: SemanticBudget): Promise<boolean> {
  try {
    const found = semanticBudgetSchema.parse(JSON.parse(await fs.readFile(path.join(directory(vault), hash(identity) + ".json"), "utf8")));
    return found.records >= budget.records && found.requests >= budget.requests && found.tokens >= budget.tokens;
  } catch { return false; }
}
export async function saveSemanticGrant(vault: string, identity: string, budget: SemanticBudget, epoch: number): Promise<void> {
  if (semanticGrantEpoch(vault) !== epoch) throw new Error("Semantic authorization was revoked");
  const dir = directory(vault);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, hash(identity) + ".json"), JSON.stringify(semanticBudgetSchema.parse(budget)));
  if (semanticGrantEpoch(vault) !== epoch) {
    await fs.unlink(path.join(dir, hash(identity) + ".json")).catch(() => {});
    throw new Error("Semantic authorization was revoked");
  }
}
export async function revokeSemanticGrants(vault: string): Promise<void> {
  controllers.get(vault)?.abort("Semantic grants revoked");
  epochs.set(vault, semanticGrantEpoch(vault) + 1);
  const dir = directory(vault);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => fs.unlink(path.join(dir, name))));
}
