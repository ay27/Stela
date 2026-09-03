import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

import { isStelaFilePath } from "@/core/stela-file";

export type WorkspaceFileMode =
  "markdown" | "source" | "analysis" | "unsupported";

const PLAIN_TEXT_EXTENSIONS = new Set([
  "csv",
  "env",
  "jsonl",
  "log",
  "ndjson",
  "properties",
  "text",
  "tsv",
  "txt",
]);

const PLAIN_TEXT_FILENAMES = new Set([
  ".dockerignore",
  ".env",
  ".gitattributes",
  ".gitignore",
  ".npmignore",
  ".prettierignore",
  ".stylelintignore",
  "dockerfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

export function sourceLanguageForPath(
  path: string,
): LanguageDescription | null {
  const fileName = basename(path);
  return (
    LanguageDescription.matchFilename(languages, fileName) ??
    LanguageDescription.matchFilename(languages, fileName.toLowerCase())
  );
}

export function isExplicitPlainTextPath(path: string): boolean {
  const fileName = basename(path).toLowerCase();
  return (
    PLAIN_TEXT_FILENAMES.has(fileName) ||
    PLAIN_TEXT_EXTENSIONS.has(extensionOf(fileName))
  );
}

export function resolveWorkspaceFileMode(path: string): WorkspaceFileMode {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stela.canvas")) return "analysis";
  if (isStelaFilePath(path)) return "markdown";
  if (sourceLanguageForPath(path) || isExplicitPlainTextPath(path)) {
    return "source";
  }
  return "unsupported";
}

/**
 * Extension routing prevents most binary files from reaching the text reader.
 * This second gate catches mislabeled files without rejecting ordinary tabs,
 * newlines, carriage returns, form feeds, or backspaces used in text fixtures.
 */
export function looksLikeBinaryText(text: string): boolean {
  let suspiciousControls = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) return true;
    if (
      code < 32 &&
      code !== 8 &&
      code !== 9 &&
      code !== 10 &&
      code !== 12 &&
      code !== 13
    ) {
      suspiciousControls += 1;
    }
  }
  return suspiciousControls > Math.max(2, Math.floor(text.length * 0.01));
}

export function detectLineSeparator(text: string): "\n" | "\r\n" {
  const firstLf = text.indexOf("\n");
  return firstLf > 0 && text[firstLf - 1] === "\r" ? "\r\n" : "\n";
}
