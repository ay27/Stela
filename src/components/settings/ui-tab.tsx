import { AlignCenter, Maximize2 } from "lucide-react";

import type { EditorWidth } from "@/contracts/settings";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/use-t";
import { useSettings } from "@/state/settings";
import { FormHint, Row, Section, TabContainer } from "./atoms";

const EDITOR_WIDTH_OPTIONS: {
  value: EditorWidth;
  labelKey: string;
  hintKey: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    value: "narrow",
    labelKey: "ui.editorWidth.narrow",
    hintKey: "ui.editorWidth.narrowHint",
    icon: AlignCenter,
  },
  {
    value: "wide",
    labelKey: "ui.editorWidth.wide",
    hintKey: "ui.editorWidth.wideHint",
    icon: Maximize2,
  },
];

export function UITab() {
  const t = useT();
  const pageSize = useSettings((s) => s.settings.ui.defaultPageSize);
  const editorWidth = useSettings((s) => s.settings.ui.editorWidth);
  const patch = useSettings((s) => s.patch);
  return (
    <TabContainer>
      <Section title={t("settings.tabs.ui")}>
        <Row
          label={t("ui.resultPageSize")}
          description={t("ui.resultPageSize.description")}
        >
          <input
            type="number"
            min={50}
            step={50}
            value={pageSize}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isNaN(n) && n >= 10) {
                void patch({ ui: { defaultPageSize: n } });
              }
            }}
            className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
          />
        </Row>
        <FormHint>{t("ui.resultPageSize.hint")}</FormHint>
      </Section>

      <Section
        title={t("ui.editorWidth.title")}
        description={t("ui.editorWidth.description")}
      >
        <div className="grid grid-cols-2 gap-3">
          {EDITOR_WIDTH_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = editorWidth === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  void patch({ ui: { editorWidth: opt.value } })
                }
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-md border px-4 py-3 text-left text-sm transition-colors",
                  active
                    ? "border-primary bg-primary/5 text-foreground"
                    : "border-border bg-card/40 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
                aria-pressed={active}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{t(opt.labelKey)}</span>
                </div>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {t(opt.hintKey)}
                </span>
              </button>
            );
          })}
        </div>
        <FormHint>
          {t("ui.editorWidth.hint")}
        </FormHint>
      </Section>
    </TabContainer>
  );
}
