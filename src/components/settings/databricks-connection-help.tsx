import { useT } from "@/i18n/use-t";

export function DatabricksConnectionHelp() {
  const t = useT();
  return (
    <div className="stela-databricks-connection-help mb-3 text-xs leading-relaxed text-muted-foreground">
      <p>{t("connections.databricks.help.intro")}</p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-foreground hover:text-primary">
          {t("connections.databricks.help.title")}
        </summary>
        <ol className="mt-2 list-decimal space-y-3 pl-5">
          <li>
            <p className="font-medium text-foreground">{t("connections.databricks.help.warehouseTitle")}</p>
            <p>{t("connections.databricks.help.warehouseSteps")}</p>
          </li>
          <li>
            <p className="font-medium text-foreground">{t("connections.databricks.help.tokenTitle")}</p>
            <p>{t("connections.databricks.help.tokenSteps")}</p>
            <button type="button" className="mt-1 text-primary hover:underline" onClick={() => void window.stela.shell.openExternal("https://docs.databricks.com/aws/en/dev-tools/auth/pat")}>
              {t("connections.databricks.help.tokenGuide")}
            </button>
          </li>
          <li>
            <p className="font-medium text-foreground">{t("connections.databricks.help.defaultsTitle")}</p>
            <p>{t("connections.databricks.help.defaultsSteps")}</p>
          </li>
        </ol>
      </details>
    </div>
  );
}
