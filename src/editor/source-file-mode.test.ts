import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";

import {
  detectLineSeparator,
  isExplicitPlainTextPath,
  looksLikeBinaryText,
  resolveWorkspaceFileMode,
  sourceLanguageForPath,
} from "./source-file-mode";

assert.equal(resolveWorkspaceFileMode("/vault/report.md"), "markdown");
assert.equal(resolveWorkspaceFileMode("/vault/report.MD"), "markdown");
assert.equal(
  resolveWorkspaceFileMode("/vault/report.stela.canvas"),
  "analysis",
);
assert.equal(resolveWorkspaceFileMode("/vault/query.sql"), "source");
assert.equal(resolveWorkspaceFileMode("/vault/script.PY"), "source");
assert.equal(resolveWorkspaceFileMode("/vault/data.jsonl"), "source");
assert.equal(resolveWorkspaceFileMode("/vault/service.log"), "source");
assert.equal(resolveWorkspaceFileMode("/vault/Dockerfile"), "source");
assert.equal(resolveWorkspaceFileMode("/vault/image.png"), "unsupported");
assert.equal(resolveWorkspaceFileMode("/vault/archive.unknown"), "unsupported");

assert.equal(sourceLanguageForPath("query.sql")?.name, "SQL");
assert.equal(sourceLanguageForPath("script.py")?.name, "Python");
assert.equal(sourceLanguageForPath("Dockerfile")?.name, "Dockerfile");
assert.equal(isExplicitPlainTextPath("events.log"), true);
assert.equal(isExplicitPlainTextPath(".gitignore"), true);

assert.equal(looksLikeBinaryText("SELECT 1;\n\n-- ok\n"), false);
assert.equal(looksLikeBinaryText("a\tb\r\nc\f"), false);
assert.equal(looksLikeBinaryText("abc\0def"), true);
assert.equal(
  looksLikeBinaryText(`abc${String.fromCharCode(1, 2, 3)}def`),
  true,
);

assert.equal(detectLineSeparator("SELECT 1;\nSELECT 2;\n"), "\n");
assert.equal(detectLineSeparator("SELECT 1;\r\nSELECT 2;\r\n"), "\r\n");
assert.equal(detectLineSeparator("single line"), "\n");

const crlf = "SELECT 1;\r\n\r\nSELECT 2;\r\n";
const crlfState = EditorState.create({
  doc: crlf,
  extensions: [EditorState.lineSeparator.of(detectLineSeparator(crlf))],
});
assert.equal(crlfState.sliceDoc(), crlf);

const exactText = "\ufeffa\tb\n\nlast line\n";
const exactState = EditorState.create({ doc: exactText });
assert.equal(exactState.sliceDoc(), exactText);

console.log("source-file-mode tests passed");
