import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { I18nextProvider } from "react-i18next";

import { loadUserCache, patchUserCache } from "@/services/user-cache";
import { i18n, resolveLocale } from "./index";

import type { LocaleMode } from "@shared/types";

interface I18nState {
  locale: LocaleMode;
  setLocale: (locale: LocaleMode) => Promise<void>;
}

const I18nContext = createContext<I18nState | null>(null);

export function StelaI18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleMode>("system");

  useEffect(() => {
    let cancelled = false;
    void loadUserCache().then((cache) => {
      if (cancelled) return;
      setLocaleState(cache.locale);
      void i18n.changeLanguage(resolveLocale(cache.locale));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (locale !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => void i18n.changeLanguage(resolveLocale("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [locale]);

  const value = useMemo<I18nState>(
    () => ({
      locale,
      async setLocale(next) {
        setLocaleState(next);
        void i18n.changeLanguage(resolveLocale(next));
        try {
          const updated = await patchUserCache({ locale: next });
          setLocaleState(updated.locale);
          void i18n.changeLanguage(resolveLocale(updated.locale));
        } catch (err) {
          console.error("[stela] patch locale failed", err);
        }
      },
    }),
    [locale],
  );

  return (
    <I18nContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </I18nContext.Provider>
  );
}

export function useLocale(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useLocale must be used within StelaI18nProvider");
  }
  return ctx;
}
