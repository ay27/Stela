/**
 * 图片相对路径解析单测。
 *
 *     npx tsx src/editor/image-assets/path-resolver.test.ts
 */

import { fileURLToPath } from "node:url";

import { isExternalUrl, resolveImageSrc } from "./path-resolver";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

function expect(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function eq<T>(a: T, b: T): boolean {
  return a === b;
}

function run(): Check[] {
  const out: Check[] = [];
  const note = "/v/foo/report.md";
  const vault = "/v";

  out.push(
    expect(
      "external http URL untouched",
      resolveImageSrc("https://example.com/x.png", note, vault) === null,
    ),
  );
  out.push(
    expect(
      "data URL untouched",
      resolveImageSrc("data:image/png;base64,xxx", note, vault) === null,
    ),
  );
  out.push(
    expect(
      "blob URL untouched",
      resolveImageSrc("blob:abc", note, vault) === null,
    ),
  );

  out.push(
    expect(
      "relative path resolves against note dir",
      eq(
        resolveImageSrc("report.assets/foo.png", note, vault),
        "/v/foo/report.assets/foo.png",
      ),
    ),
  );
  out.push(
    expect(
      "absolute path returned as-is",
      eq(
        resolveImageSrc("/v/elsewhere/x.png", note, vault),
        "/v/elsewhere/x.png",
      ),
    ),
  );
  out.push(
    expect(
      "file:// stripped to abs path",
      eq(
        resolveImageSrc("file:///v/foo/x.png", note, vault),
        "/v/foo/x.png",
      ),
    ),
  );
  out.push(
    expect(
      "../ collapses",
      eq(
        resolveImageSrc("../assets/x.png", note, vault),
        "/v/assets/x.png",
      ),
    ),
  );

  out.push(
    expect(
      "no note path → falls back to vault root",
      eq(
        resolveImageSrc("foo.png", null, vault),
        "/v/foo.png",
      ),
    ),
  );

  out.push(
    expect(
      "no note and no vault → null",
      eq(resolveImageSrc("foo.png", null, null), null),
    ),
  );

  out.push(
    expect(
      "isExternalUrl true on https/mailto",
      isExternalUrl("https://x.com") && isExternalUrl("mailto:a@b.com"),
    ),
  );
  out.push(
    expect(
      "isExternalUrl false on relative / file://",
      !isExternalUrl("foo.png") && !isExternalUrl("file:///abs/x.png"),
    ),
  );

  return out;
}

function main(): void {
  const checks = run();
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
    console.error(`\nimage-assets/path-resolver tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
