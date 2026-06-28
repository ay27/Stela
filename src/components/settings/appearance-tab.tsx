import { Monitor, Moon, Sun } from "lucide-react";

import { useLocale } from "@/i18n/context";
import { localeOptions } from "@/i18n";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import type { ThemeMode } from "@/contracts/settings";
import { cn } from "@/lib/utils";
import { Section, TabContainer } from "./atoms";

const OPTIONS: {
  value: ThemeMode;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "light", labelKey: "appearance.theme.light", icon: Sun },
  { value: "dark", labelKey: "appearance.theme.dark", icon: Moon },
  { value: "system", labelKey: "appearance.theme.system", icon: Monitor },
];

export function AppearanceTab() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const mode = useSettings((s) => s.settings.appearance.theme);
  const patch = useSettings((s) => s.patch);
  return (
    <TabContainer>
      <Section
        title={t("appearance.title")}
        description={t("appearance.description")}
      >
        <h4 className="mb-2 text-[12px] font-medium text-foreground">
          {t("appearance.theme.title")}
        </h4>
        <div className="grid grid-cols-3 gap-3">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  void patch({ appearance: { theme: opt.value } })
                }
                className={cn(
                  "flex flex-col items-center gap-2 rounded-md border px-4 py-4 text-sm transition-colors",
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card/40 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                <Icon className="h-5 w-5" />
                <span>{t(opt.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title={t("appearance.language.title")}
        description={t("appearance.language.description")}
      >
        <div className="grid grid-cols-3 gap-3">
          {localeOptions.map((opt) => {
            const active = locale === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => void setLocale(opt)}
                className={cn(
                  "rounded-md border px-4 py-3 text-sm transition-colors",
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card/40 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {t(`appearance.language.${opt}`)}
              </button>
            );
          })}
        </div>
      </Section>
    </TabContainer>
  );
}
