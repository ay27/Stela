import { useSettings } from "@/state/settings";
import { Select } from "@/components/ui/select";
import { useT } from "@/i18n/use-t";
import { Row, Section, TabContainer } from "./atoms";

export function ExecutionTab() {
  const t = useT();
  const onError = useSettings((s) => s.settings.execution.onError);
  const maxRows = useSettings((s) => s.settings.execution.maxRows);
  const patch = useSettings((s) => s.patch);
  const onErrorOptions = [
    { value: "continue", label: t("execution.onError.continue"), labelText: t("execution.onError.continue") },
    { value: "stop", label: t("execution.onError.stop"), labelText: t("execution.onError.stop") },
  ] as const;
  const writePolicyOptions = [
    { value: "allow", label: t("execution.writePolicy.allow"), labelText: t("execution.writePolicy.allow") },
    { value: "block", label: t("execution.writePolicy.block"), labelText: t("execution.writePolicy.block") },
  ] as const;
  return (
    <TabContainer>
      <Section title={t("execution.title")}>
        <Row
          label={t("execution.onError")}
          description={t("execution.onError.description")}
        >
          <Select<"continue" | "stop">
            value={onError}
            onValueChange={(v) =>
              void patch({ execution: { onError: v } })
            }
            options={onErrorOptions}
          />
        </Row>
        <Row
          label={t("execution.maxRows")}
          description={t("execution.maxRows.description")}
        >
          <input
            type="number"
            min={0}
            value={maxRows}
            onChange={(e) =>
              void patch({
                execution: { maxRows: Math.max(0, Number(e.target.value) || 0) },
              })
            }
            className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
        </Row>
      </Section>

      <Section
        title={t("execution.advanced.title")}
        description={t("execution.advanced.description")}
      >
        <Row
          label={t("execution.concurrency")}
          description={t("execution.concurrency.description")}
          disabled
        >
          <input
            type="number"
            value={1}
            disabled
            className="w-20 rounded-md border border-border bg-muted px-2 py-1 text-sm text-muted-foreground"
          />
        </Row>
        <Row
          label={t("execution.timeout")}
          description={t("execution.timeout.description")}
          disabled
        >
          <input
            type="number"
            value={60}
            disabled
            className="w-20 rounded-md border border-border bg-muted px-2 py-1 text-sm text-muted-foreground"
          />
        </Row>
        <Row
          label={t("execution.writePolicy")}
          description={t("execution.writePolicy.description")}
          disabled
        >
          <Select<"allow" | "block">
            value="allow"
            onValueChange={() => {}}
            options={writePolicyOptions}
            disabled
          />
        </Row>
      </Section>
    </TabContainer>
  );
}
