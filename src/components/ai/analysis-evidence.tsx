import type { IAnalysisSnapshot } from "@shared/analysis-contract";
import { useT } from "@/i18n/use-t";

export function AnalysisEvidence({ snapshot }: { snapshot: IAnalysisSnapshot | null }) {
  const t = useT();
  if (!snapshot) return null;
  const unresolved = [...snapshot.claims.filter((c) => !c.sourceResolved).map((c) => c.field),
    ...snapshot.checks.filter((c) => !c.sourceResolved).map((c) => c.name)];
  const coverage = snapshot.coverage;
  return <div className="stela-analysis-evidence space-y-1 py-2 text-xs text-muted-foreground">
    <div className="font-medium text-foreground">{t("agent.analysis.title")} · v{snapshot.version}</div>
    <div>{t("agent.analysis.coverage")}: {t(`agent.analysis.${coverage.state}`)} · {coverage.processed} / {coverage.total ?? "?"}</div>
    {coverage.reason && <div>{t(`agent.analysis.reason.${coverage.reason}`)}</div>}
    {snapshot.operationCoverage && <div>{t("agent.analysis.operation", snapshot.operationCoverage)}</div>}
    {snapshot.missingClaims.length > 0 && <div>{t("agent.analysis.missing")}: {snapshot.missingClaims.join(", ")}</div>}
    {snapshot.failedChecks.length > 0 && <div>{t("agent.analysis.failed")}: {snapshot.failedChecks.join(", ")}</div>}
    {unresolved.length > 0 && <div>{t("agent.analysis.unresolved")}: {unresolved.join(", ")}</div>}
    <div>{t("agent.analysis.caveat")}</div>
  </div>;
}
