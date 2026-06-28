import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import zh from "./locales/zh.json";

import type { LocaleMode } from "@shared/types";

export type ResolvedLocale = "zh" | "en";

export function resolveLocale(mode: LocaleMode): ResolvedLocale {
  if (mode === "zh" || mode === "en") return mode;
  const lang =
    typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  return lang.startsWith("zh") ? "zh" : "en";
}

export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: resolveLocale("system"),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export const localeOptions: LocaleMode[] = ["system", "zh", "en"];
