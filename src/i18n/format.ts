import { resolveLocale } from "./index";

import type { LocaleMode } from "@shared/types";

export function formatDateTime(value: number | Date, locale: LocaleMode): string {
  return new Intl.DateTimeFormat(resolveLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value instanceof Date ? value : new Date(value));
}
