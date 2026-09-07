import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Works on rsync deployments without .git. Never reads env/secrets/results. */
export async function sourceFingerprint(root: string): Promise<string> {
  const files = ["package.json", "package-lock.json"];
  const extensions = new Set([".ts", ".tsx", ".mjs", ".cjs", ".py", ".json", ".md"]);
  async function visit(relative: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "out", "__pycache__"].includes(entry.name)) continue;
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(next);
    }
  }
  for (const dir of ["electron", "src", "plugins", "resources/playbooks", "scripts/eval"]) await visit(dir);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const content = await fs.readFile(path.join(root, file));
    hash.update(file).update("\0").update(String(content.length)).update("\0").update(content);
  }
  return hash.digest("hex");
}
