/**
 * vault-fs `importFile` 自运行测试。
 *
 * 行为约束：
 *   - 越界目标目录（不在 vault 内）→ ensureWithinVault 抛 outside_vault
 *   - 同名文件 → 自动加 ` (1)` / ` (2)` 后缀，不覆盖既有内容
 *   - 源不是普通文件（目录）→ not_a_file
 *
 * 项目暂未接入 vitest，沿用 local-fs.test.ts 的轻量 expect() 风格。
 *
 *     npx tsx electron/services/vault-fs.test.ts
 */

import {
  mkdir,
  mkdtemp,
  readFile as fsReadFile,
  rm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTACHMENTS_DIR_NAME,
  importFile,
  readBinary,
  sanitizeAttachmentName,
  saveAttachment,
} from "./vault-fs";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

async function makeFixture(): Promise<{
  vaultDir: string;
  outsideDir: string;
  cleanup: () => Promise<void>;
}> {
  const vaultDir = await mkdtemp(path.join(tmpdir(), "stela-vaultfs-vault-"));
  const outsideDir = await mkdtemp(
    path.join(tmpdir(), "stela-vaultfs-outside-"),
  );
  return {
    vaultDir,
    outsideDir,
    cleanup: async () => {
      await rm(vaultDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    },
  };
}

async function runOutsideVaultRejected(): Promise<Check[]> {
  const { vaultDir, outsideDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const src = path.join(outsideDir, "src.txt");
    await fsWriteFile(src, "hi");
    let rejected = false;
    let code: string | undefined;
    try {
      // destDir 落在 vault 外部
      await importFile(vaultDir, src, outsideDir);
    } catch (err) {
      code = (err as { code?: string }).code;
      rejected = code === "outside_vault";
    }
    out.push(
      expect(
        "destDir outside vault rejected",
        rejected,
        `expected code=outside_vault, got code=${code ?? "<none>"}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runDuplicateNameSuffix(): Promise<Check[]> {
  const { vaultDir, outsideDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const subDir = path.join(vaultDir, "imports");
    await mkdir(subDir);

    const src1 = path.join(outsideDir, "foo.png");
    await fsWriteFile(src1, "first");
    const r1 = await importFile(vaultDir, src1, subDir);
    out.push(
      expect(
        "first import keeps original name",
        path.basename(r1) === "foo.png",
        `got: ${r1}`,
      ),
    );

    const src2 = path.join(outsideDir, "foo.png"); // 同名复制
    const r2 = await importFile(vaultDir, src2, subDir);
    out.push(
      expect(
        "second import → foo (1).png",
        path.basename(r2) === "foo (1).png",
        `got: ${r2}`,
      ),
    );

    const src3 = path.join(outsideDir, "foo.png");
    const r3 = await importFile(vaultDir, src3, subDir);
    out.push(
      expect(
        "third import → foo (2).png",
        path.basename(r3) === "foo (2).png",
        `got: ${r3}`,
      ),
    );

    // 内容不被覆盖：r1 还是 "first"
    const r1Content = await fsReadFile(r1, "utf-8");
    out.push(
      expect(
        "original content preserved",
        r1Content === "first",
        `got: ${r1Content}`,
      ),
    );

    // 没扩展名的文件：suffix 直接拼到末尾
    const srcBare = path.join(outsideDir, "README");
    await fsWriteFile(srcBare, "x");
    const rb1 = await importFile(vaultDir, srcBare, subDir);
    const rb2 = await importFile(vaultDir, srcBare, subDir);
    out.push(
      expect(
        "extensionless dup → README (1)",
        path.basename(rb1) === "README" && path.basename(rb2) === "README (1)",
        `got: ${rb1} / ${rb2}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runSourceMustBeFile(): Promise<Check[]> {
  const { vaultDir, outsideDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const subDir = path.join(vaultDir, "imports");
    await mkdir(subDir);
    const srcDir = path.join(outsideDir, "subdir");
    await mkdir(srcDir);
    let code: string | undefined;
    try {
      await importFile(vaultDir, srcDir, subDir);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    out.push(
      expect(
        "source dir rejected as not_a_file",
        code === "not_a_file",
        `got code=${code ?? "<none>"}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

function runSanitizeAttachmentName(): Check[] {
  const out: Check[] = [];
  out.push(
    expect(
      "sanitize keeps benign name",
      sanitizeAttachmentName("foo.png") === "foo.png",
      `got: ${sanitizeAttachmentName("foo.png")}`,
    ),
  );
  out.push(
    expect(
      "sanitize collapses path traversal to basename",
      sanitizeAttachmentName("../etc/passwd") === "passwd" &&
        sanitizeAttachmentName("/abs/foo.png") === "foo.png",
      `got: ${sanitizeAttachmentName("../etc/passwd")} / ${sanitizeAttachmentName(
        "/abs/foo.png",
      )}`,
    ),
  );
  out.push(
    expect(
      "sanitize replaces unsafe chars",
      sanitizeAttachmentName('a:b*c?"d<>|.png') === "a_b_c__d___.png",
      `got: ${sanitizeAttachmentName('a:b*c?"d<>|.png')}`,
    ),
  );
  out.push(
    expect(
      "sanitize empty falls back to image",
      sanitizeAttachmentName("   ") === "image",
      `got: ${sanitizeAttachmentName("   ")}`,
    ),
  );
  out.push(
    expect(
      "ATTACHMENTS_DIR_NAME 是 vault 根 'assets'",
      ATTACHMENTS_DIR_NAME === "assets",
      `got: ${ATTACHMENTS_DIR_NAME}`,
    ),
  );
  return out;
}

async function runSaveAttachmentHappyPath(): Promise<Check[]> {
  const { vaultDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const noteDir = path.join(vaultDir, "notes");
    await mkdir(noteDir);
    const notePath = path.join(noteDir, "report.md");
    await fsWriteFile(notePath, "hi");

    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEXgRX1yAAAACklEQVQYV2NgAAAAAgABc3UBGAAAAABJRU5ErkJggg==";
    const r1 = await saveAttachment(vaultDir, notePath, "shot.png", png);
    out.push(
      expect(
        "subdir note → relPath 用 ../assets/...",
        r1.relPath === "../assets/shot.png",
        `got: ${r1.relPath}`,
      ),
    );
    // macOS realpath 会把 /var 解成 /private/var，所以这里用 endsWith
    const assetsSuffix = `${path.sep}assets`;
    out.push(
      expect(
        "absPath 落在 <vault>/assets/",
        path.isAbsolute(r1.absPath) &&
          (await fsStat(r1.absPath)).isFile() &&
          path.dirname(r1.absPath).endsWith(assetsSuffix),
        `absPath: ${r1.absPath}`,
      ),
    );

    // 同名 → 后缀
    const r2 = await saveAttachment(vaultDir, notePath, "shot.png", png);
    out.push(
      expect(
        "duplicate attachment name → ` (1)` suffix",
        r2.relPath === "../assets/shot (1).png",
        `got: ${r2.relPath}`,
      ),
    );

    // 空名 → fallback "image"
    const r3 = await saveAttachment(vaultDir, notePath, "   ", png);
    out.push(
      expect(
        "empty fileName falls back to 'image'",
        r3.relPath === "../assets/image",
        `got: ${r3.relPath}`,
      ),
    );

    // fileName 里的路径穿越被 sanitize，仍落在 <vault>/assets/
    const r4 = await saveAttachment(
      vaultDir,
      notePath,
      "../../evil.png",
      png,
    );
    out.push(
      expect(
        "path traversal in fileName is sanitized into <vault>/assets/",
        path.dirname(r4.absPath).endsWith(assetsSuffix) &&
          !r4.absPath.includes(".." + path.sep) &&
          r4.relPath.startsWith("../assets/"),
        `got: relPath=${r4.relPath}, absPath=${r4.absPath}`,
      ),
    );

    // vault 根 note → relPath 不再带 ../
    const rootNote = path.join(vaultDir, "root.md");
    await fsWriteFile(rootNote, "hi");
    const r5 = await saveAttachment(vaultDir, rootNote, "top.png", png);
    out.push(
      expect(
        "vault-root note → relPath = assets/top.png",
        r5.relPath === "assets/top.png",
        `got: ${r5.relPath}`,
      ),
    );

    // 嵌套两层 → 走 ../../
    const deepDir = path.join(vaultDir, "a", "b");
    await mkdir(deepDir, { recursive: true });
    const deepNote = path.join(deepDir, "deep.md");
    await fsWriteFile(deepNote, "hi");
    const r6 = await saveAttachment(vaultDir, deepNote, "deep.png", png);
    out.push(
      expect(
        "深层 note → ../../assets/deep.png",
        r6.relPath === "../../assets/deep.png",
        `got: ${r6.relPath}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runSaveAttachmentRejectsBigOrEmpty(): Promise<Check[]> {
  const { vaultDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const notePath = path.join(vaultDir, "n.md");
    await fsWriteFile(notePath, "hi");

    let emptyCode: string | undefined;
    try {
      await saveAttachment(vaultDir, notePath, "x.png", "");
    } catch (err) {
      emptyCode = (err as { code?: string }).code;
    }
    out.push(
      expect(
        "empty attachment rejected",
        emptyCode === "invalid_attachment",
        `got code=${emptyCode ?? "<none>"}`,
      ),
    );

    let escapeCode: string | undefined;
    try {
      // notePath outside vault → should fail at ensureWithinVault
      await saveAttachment(
        vaultDir,
        path.join(path.dirname(vaultDir), "outside.md"),
        "x.png",
        "aGVsbG8=",
      );
    } catch (err) {
      escapeCode = (err as { code?: string }).code;
    }
    out.push(
      expect(
        "note outside vault rejected",
        escapeCode === "outside_vault" || escapeCode === "invalid_path",
        `got code=${escapeCode ?? "<none>"}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function runReadBinaryRoundtrip(): Promise<Check[]> {
  const { vaultDir, cleanup } = await makeFixture();
  const out: Check[] = [];
  try {
    const notePath = path.join(vaultDir, "rb.md");
    await fsWriteFile(notePath, "hi");
    const b64 = "aGVsbG8gd29ybGQ="; // "hello world"
    const r = await saveAttachment(vaultDir, notePath, "msg.bin", b64);
    const round = await readBinary(r.absPath);
    out.push(
      expect(
        "readBinary round-trips bytes via base64",
        round === b64,
        `got: ${round}`,
      ),
    );

    // Reading a directory should error (not_a_file)
    let code: string | undefined;
    try {
      await readBinary(path.dirname(r.absPath));
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    out.push(
      expect(
        "readBinary on directory rejected",
        code === "not_a_file",
        `got code=${code ?? "<none>"}`,
      ),
    );
  } finally {
    await cleanup();
  }
  return out;
}

async function main(): Promise<void> {
  const checks: Check[] = [
    ...(await runOutsideVaultRejected()),
    ...(await runDuplicateNameSuffix()),
    ...(await runSourceMustBeFile()),
    ...runSanitizeAttachmentName(),
    ...(await runSaveAttachmentHappyPath()),
    ...(await runSaveAttachmentRejectsBigOrEmpty()),
    ...(await runReadBinaryRoundtrip()),
  ];
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`[ok]   ${c.name}`);
    } else {
      failed += 1;
      console.log(`[FAIL] ${c.name}${c.detail ? `\n       ${c.detail}` : ""}`);
    }
  }
  if (failed > 0) {
    console.error(`\nvault-fs importFile tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void main();
}
