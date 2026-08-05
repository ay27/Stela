/** Agent replies are read-only; executable RunSQL semantics belong only to vault notes. */
export function normalizeAgentMarkdownCodeLanguage(language: string): string {
  return language.toLowerCase() === "runsql" ? "sql" : language;
}
