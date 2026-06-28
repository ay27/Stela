/**
 * 图片附件文件名生成单测。
 *
 *     npx tsx src/editor/image-assets/file-name.test.ts
 */

import { fileURLToPath } from "node:url";

import {
  buildAttachmentFileName,
  extFromMime,
  extOf,
  formatTimestamp,
  sanitizeBaseName,
} from "./file-name";

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
  const fixedDate = new Date(2026, 4, 18, 15, 2, 7); // local time: 2026-05-18 15:02:07
  const out: Check[] = [];

  out.push(
    expect(
      "formatTimestamp pads zeros",
      formatTimestamp(fixedDate) === "20260518-150207",
      `got: ${formatTimestamp(fixedDate)}`,
    ),
  );

  out.push(
    expect(
      "extFromMime maps known image MIME",
      eq(extFromMime("image/png"), ".png") &&
        eq(extFromMime("image/jpeg"), ".jpg") &&
        eq(extFromMime("image/svg+xml"), ".svg"),
    ),
  );
  out.push(
    expect(
      "extFromMime falls back to .bin",
      eq(extFromMime(undefined), ".bin") &&
        eq(extFromMime("application/octet-stream"), ".bin"),
    ),
  );

  out.push(
    expect(
      "extOf returns lower-case ext with dot",
      eq(extOf("Foo.PNG"), ".png") && eq(extOf("nodot"), ""),
    ),
  );

  out.push(
    expect(
      "sanitizeBaseName strips bad chars and trims",
      eq(sanitizeBaseName("  ok.png  "), "ok.png") &&
        eq(sanitizeBaseName("a/b.png"), "a_b.png") &&
        eq(sanitizeBaseName(""), "image"),
    ),
  );

  // buildAttachmentFileName cases
  out.push(
    expect(
      "real name is preserved",
      eq(
        buildAttachmentFileName({
          rawName: "diagram.svg",
          mime: "image/svg+xml",
          now: fixedDate,
        }),
        "diagram.svg",
      ),
    ),
  );

  out.push(
    expect(
      "placeholder image.png → image-<ts>.png",
      eq(
        buildAttachmentFileName({
          rawName: "image.png",
          mime: "image/png",
          now: fixedDate,
        }),
        "image-20260518-150207.png",
      ),
    ),
  );

  out.push(
    expect(
      "missing name uses MIME-derived ext",
      eq(
        buildAttachmentFileName({
          rawName: "",
          mime: "image/jpeg",
          now: fixedDate,
        }),
        "image-20260518-150207.jpg",
      ),
    ),
  );

  out.push(
    expect(
      "missing name AND missing MIME → .bin",
      eq(
        buildAttachmentFileName({
          rawName: "",
          mime: undefined,
          now: fixedDate,
        }),
        "image-20260518-150207.bin",
      ),
    ),
  );

  out.push(
    expect(
      "screenshot placeholder pattern handled",
      eq(
        buildAttachmentFileName({
          rawName: "Screenshot.png",
          mime: "image/png",
          now: fixedDate,
        }),
        "image-20260518-150207.png",
      ),
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
    console.error(`\nimage-assets/file-name tests FAILED (${failed}).`);
    process.exit(1);
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main();
}
