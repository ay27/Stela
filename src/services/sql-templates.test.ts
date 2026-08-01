/**
 * SQL Template 的 Markdown 契约和 CodeMirror snippet 编译单测。
 *
 *     npx tsx src/services/sql-templates.test.ts
 */
import {
  SQL_TEMPLATE_DIRECTORY,
  SQL_TEMPLATE_TYPE,
  createSqlTemplateDocument,
  parseSqlTemplate,
  templateSlug,
  validateTemplateMetadata,
} from "./sql-templates";
import * as sqlTemplateSnippet from "@/editor/runsql/sql-template-snippet";
import {
  applyTemplateVariableValue,
  createTemplateVariableSession,
} from "@/editor/runsql/sql-template-snippet";
import { matchesModAltPhysicalKey } from "@/editor/runsql/cm-hotkeys";
import { matchesTemplateCommandTarget } from "@/editor/runsql/template-command-target";
import { templateMultiSelectionExtension } from "@/editor/runsql/template-variable-session";
import { EditorSelection, EditorState } from "@codemirror/state";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: Check[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
}

const raw = `---
type: ${SQL_TEMPLATE_TYPE}
name: Daily active users
description: Count active users for a day
connection_name: analytics
---

Notes are allowed before SQL.

\`\`\`runsql
SELECT {{field}}, count(*)
FROM {{table}}
WHERE dt = {{date}} OR snapshot_dt = {{date}}
\`\`\`
`;

{
  const template = parseSqlTemplate(
    raw,
    `${SQL_TEMPLATE_DIRECTORY}/daily-active-users.md`,
  );
  check(
    "parses template metadata and first RunSQL block",
    template?.name === "Daily active users" &&
      template.description === "Count active users for a day" &&
      template.connectionName === "analytics" &&
      template.sql.includes("snapshot_dt = {{date}}"),
    JSON.stringify(template),
  );
}

{
  check(
    "rejects non-template markdown",
    parseSqlTemplate("```runsql\nSELECT 1\n```", "other.md") === null,
  );
}

{
  check(
    "rejects a template without RunSQL",
    parseSqlTemplate(
      `---\ntype: ${SQL_TEMPLATE_TYPE}\nname: Broken\n---\n\nNo SQL here.`,
      `${SQL_TEMPLATE_DIRECTORY}/broken.md`,
    ) === null,
  );
}

{
  check(
    "metadata rejects blank and multiline values",
    validateTemplateMetadata("", "Description") !== null &&
      validateTemplateMetadata("Name", "line one\nline two") !== null,
  );
}

{
  const document = createSqlTemplateDocument({
    name: "Daily active users",
    description: "Count active users for a day",
  });
  check(
    "creates editable template Markdown skeleton",
    document.includes(`type: ${SQL_TEMPLATE_TYPE}`) &&
      document.includes("name: Daily active users") &&
      document.includes("```runsql"),
    document,
  );
}

{
  check(
    "slug is stable, lowercase, and safe for the template filename",
    templateSlug(" Daily Active Users! ") === "daily-active-users",
  );
}

{
  const session = createTemplateVariableSession(
    "SELECT {{field}} FROM {{table}} WHERE dt = {{date}} OR snapshot_dt = {{date}}",
  );
  check(
    "keeps visible placeholders and groups repeated variables",
    session.text ===
      "SELECT {{field}} FROM {{table}} WHERE dt = {{date}} OR snapshot_dt = {{date}}" &&
      session.fields.map((field) => field.name).join("|") === "field|table|date" &&
      session.fields[2]?.ranges.length === 2,
    JSON.stringify(session),
  );
}

{
  type CreateTemplateInsertion = (
    text: string,
    from: number,
    to: number,
    sql: string,
  ) => {
    text: string;
    fields: Array<{
      name: string;
      ranges: Array<{ from: number; to: number }>;
    }>;
  };
  const createTemplateInsertion = Reflect.get(
    sqlTemplateSnippet,
    "createTemplateInsertion",
  ) as CreateTemplateInsertion | undefined;
  const insertion = createTemplateInsertion?.(
    "SELECT old\nWHERE active = 1",
    7,
    10,
    "{{field}} FROM {{table}} WHERE copy = {{field}}",
  );
  check(
    "builds one authoritative document replacement with absolute linked ranges",
    insertion?.text ===
      "SELECT {{field}} FROM {{table}} WHERE copy = {{field}}\nWHERE active = 1" &&
      insertion.fields[0]?.ranges.length === 2 &&
      insertion.fields[0]?.ranges[0]?.from === 7 &&
      insertion.fields[0]?.ranges[1]?.from ===
        insertion.text.lastIndexOf("{{field}}"),
    JSON.stringify(insertion),
  );
}

{
  const session = createTemplateVariableSession(
    "WHERE dt = {{date}} OR snapshot_dt = {{date}}",
  );
  const date = session.fields[0]!;
  let state = EditorState.create({
    doc: session.text,
    extensions: [templateMultiSelectionExtension],
    selection: EditorSelection.create(
      date.ranges.map((range) => EditorSelection.range(range.from, range.to)),
    ),
  });
  state = state.update(state.replaceSelection("2026-07-31")).state;
  check(
    "CodeMirror multi-selection edits every linked occurrence",
    state.doc.toString() ===
      "WHERE dt = 2026-07-31 OR snapshot_dt = 2026-07-31",
    state.doc.toString(),
  );
}

{
  const session = createTemplateVariableSession(
    "SELECT {{field}} FROM {{table}} WHERE dt = {{date}} OR snapshot_dt = {{date}}",
  );
  check(
    "replacing a variable updates every occurrence",
    applyTemplateVariableValue(session, 2, "2026-07-31") ===
      "SELECT {{field}} FROM {{table}} WHERE dt = 2026-07-31 OR snapshot_dt = 2026-07-31",
  );
}

{
  const session = createTemplateVariableSession(
    "SELECT '${literal}' AS example, #{also_literal}, {{value}}",
  );
  check(
    "preserves existing snippet-like SQL text",
    session.text === "SELECT '${literal}' AS example, #{also_literal}, {{value}}",
    session.text,
  );
}

{
  check(
    "macOS Option altered key still matches physical Mod+Alt+T",
    matchesModAltPhysicalKey(
      { code: "KeyT", key: "†", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false },
      "KeyT",
      true,
    ),
  );
}

{
  check(
    "SQL without variables remains unchanged",
    createTemplateVariableSession("SELECT 1").text === "SELECT 1",
  );
}

{
  const target = {
    tabId: "tab-1",
    blockId: null,
    blockIndex: 2,
    text: "",
  };
  check(
    "remounted empty RunSQL block remains a valid template target",
    matchesTemplateCommandTarget(target, { ...target, connected: true }),
  );
  check(
    "template target rejects a matching block in another tab",
    !matchesTemplateCommandTarget(target, {
      ...target,
      tabId: "tab-2",
      connected: true,
    }),
  );
}

let failed = 0;
for (const result of results) {
  if (result.ok) {
    console.log(`  ok  ${result.name}`);
  } else {
    failed += 1;
    console.log(`  !!! ${result.name}${result.detail ? ` → ${result.detail}` : ""}`);
  }
}
console.log(
  `\nsql-templates.test.ts: ${results.length - failed}/${results.length} passed`,
);
if (failed > 0) process.exit(1);
